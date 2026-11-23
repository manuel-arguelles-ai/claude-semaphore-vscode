import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SemaphoreState, SessionState } from './types';

export interface CommandCodeProcess { pid: number; startMs: number; cwd?: string }
export interface CommandCodeTranscript { file: string; id: string; cwd: string; headerMs: number; mtimeMs: number; size: number }

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * `ps ... lstart=` prints "Mon Nov 23 08:57:32 2026". Parsed by hand so the
 * result does not depend on the machine's locale.
 */
export function parseLstartMs(text: string): number | undefined {
  const m = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text);
  if (!m) return undefined;
  const month = MONTHS[m[1]];
  if (month === undefined) return undefined;
  const ms = new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** A live Command Code TUI, whatever name the launcher gave it (`command-code`, `cmd`, bare node). */
function isCommandCodeCommand(command: string): boolean {
  const first = command.split(/\s+/)[0] ?? '';
  const base = first.split('/').pop();
  if (base === 'command-code' || base === 'cmd') return true;
  return /\bnode(?:\.exe)?\s+\S*command-code\/dist\/cli\.mjs/.test(command);
}

/** Parses `ps ax -o pid=,lstart=,command=` for live Command Code processes with their start time. */
export function parseCommandCodeProcesses(text: string): CommandCodeProcess[] {
  const out: CommandCodeProcess[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    if (!isCommandCodeCommand(m[8].trim())) continue;
    const month = MONTHS[m[2]];
    if (month === undefined) continue;
    const startMs = new Date(Number(m[7]), month, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
    if (!Number.isFinite(startMs)) continue;
    out.push({ pid: Number(m[1]), startMs });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** Parses `lsof -F pn` output restricted to the cwd descriptor. */
export function parseCommandCodeCwd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  let pending = false;
  for (const line of text.split('\n')) {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); pending = false; continue; }
    if (line === 'fcwd') { pending = true; continue; }
    if (!pending || !line.startsWith('n')) continue;
    const name = line.slice(1);
    if (name.startsWith('/')) out.set(pid, name);
    pending = false;
  }
  return out;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      // lsof exits 1 with no output when there is nothing to report.
      if (err && !(err.code === 1 && !stdout.trim() && !stderr.trim())) return reject(err);
      resolve(stdout);
    });
  });
}

export function discoverCommandCodeProcesses(): Promise<CommandCodeProcess[]> {
  return run('ps', ['ax', '-ww', '-o', 'pid=,lstart=,command=']).then(async (text) => {
    const processes = parseCommandCodeProcesses(text);
    if (!processes.length) return [];
    let cwds = new Map<number, string>();
    try {
      cwds = parseCommandCodeCwd(await run('lsof', ['-n', '-P', '-a', '-p', processes.map(p => p.pid).join(','), '-d', 'cwd', '-F', 'pn']));
    } catch { /* cwd is required for attribution: leave these processes unattributed */ }
    return processes.map(p => ({ ...p, cwd: cwds.get(p.pid) })).filter((p): p is CommandCodeProcess & { cwd: string } => !!p.cwd);
  });
}

export interface CommandCodeTail { state: SemaphoreState; reason: string; at?: number }

/**
 * Lifecycle state from the last recorded message, and nothing else.
 *
 * The transcript is append-only and Command Code keeps no lock or pid file, so
 * the tail is the only honest source: a tool call still open means the turn is
 * in flight, a finished assistant message means the turn ended.
 */
export function inferCommandCodeState(records: unknown[]): CommandCodeTail {
  let last: any;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as any;
    if (r && typeof r === 'object' && r.type === 'message') { last = r; break; }
  }
  if (!last) return { state: 'unknown', reason: 'sin mensajes' };
  const parsedAt = typeof last.timestamp === 'string' ? Date.parse(last.timestamp) : NaN;
  const at = Number.isFinite(parsedAt) ? parsedAt : undefined;
  const message = last.message;
  if (!message || typeof message !== 'object') return { state: 'unknown', reason: 'registro no reconocido', at };
  const content = Array.isArray(message.content) ? message.content.filter((c: unknown) => c && typeof c === 'object') as any[] : [];
  if (message.role === 'assistant') {
    const tools = content.filter((c) => c.type === 'tool_use');
    if (tools.length) {
      const question = tools.find((c) => c.name === 'ask_user_question');
      if (question) return { state: 'needsInput', reason: 'question_pending', at };
      return { state: 'running', reason: 'tool_use', at };
    }
    return { state: 'stopped', reason: 'turn_complete', at };
  }
  if (message.role === 'user') {
    return { state: 'running', reason: message.meta?.source === 'tool' ? 'tool_result' : 'prompt', at };
  }
  return { state: 'unknown', reason: 'rol no reconocido', at };
}

/** Slack for the gap between the process starting and its header/mtime landing on disk. */
const START_TOLERANCE_MS = 5000;

/**
 * Pairs live processes with the transcript each one is writing.
 *
 * Pass 1 matches by start time against the transcript's own creation header: a
 * new session's header is written moments after the process starts. Pass 2
 * handles resumed sessions, whose header keeps the original creation time: any
 * live process in the same cwd that started before the transcript was last
 * written, most recent first.
 */
export function attributeSessions(
  processes: CommandCodeProcess[],
  transcripts: CommandCodeTranscript[],
): { process: CommandCodeProcess; transcript: CommandCodeTranscript }[] {
  const used = new Set<number>();
  const pairs: { process: CommandCodeProcess; transcript: CommandCodeTranscript }[] = [];
  const pending = [...transcripts].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const remaining: CommandCodeTranscript[] = [];

  const shareCwd = (p: CommandCodeProcess, t: CommandCodeTranscript) => p.cwd === t.cwd;

  for (const t of pending) {
    let best: CommandCodeProcess | undefined;
    let bestGap = Infinity;
    for (const p of processes) {
      if (used.has(p.pid) || !shareCwd(p, t)) continue;
      const gap = Math.abs(p.startMs - t.headerMs);
      if (gap <= START_TOLERANCE_MS && gap < bestGap) { best = p; bestGap = gap; }
    }
    if (best) { used.add(best.pid); pairs.push({ process: best, transcript: t }); }
    else remaining.push(t);
  }

  for (const t of remaining) {
    const candidates = processes
      .filter(p => !used.has(p.pid) && shareCwd(p, t) && p.startMs <= t.mtimeMs + START_TOLERANCE_MS)
      .sort((a, b) => b.startMs - a.startMs);
    const chosen = candidates[0];
    if (!chosen) continue;
    used.add(chosen.pid);
    pairs.push({ process: chosen, transcript: t });
  }
  return pairs;
}

const MAX_HEADER_BYTES = 4096;
const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

/**
 * lsof reports resolved paths (`/private/tmp/x`) while a session records the
 * path it was started with (`/tmp/x`). Attribution compares directories, so both
 * sides are reduced to the same real path.
 */
export function realCwd(cwd: string): string {
  try { return fsSync.realpathSync(cwd); } catch { return cwd; }
}

async function readHeader(file: string): Promise<{ id: string; cwd: string; headerMs: number } | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) return undefined;
    const row = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    if (row?.type !== 'session' || typeof row.id !== 'string' || typeof row.cwd !== 'string' || typeof row.timestamp !== 'string') return undefined;
    const headerMs = Date.parse(row.timestamp);
    if (!Number.isFinite(headerMs)) return undefined;
    return { id: row.id, cwd: row.cwd, headerMs };
  } catch {
    return undefined;
  } finally { await handle?.close(); }
}

async function readTitle(file: string): Promise<string | undefined> {
  try {
    const meta = JSON.parse(await fs.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return typeof meta?.title === 'string' && meta.title.trim() ? meta.title.trim() : undefined;
  } catch { return undefined; }
}

/** Reads Command Code's own session transcripts; no database, no native dependencies. */
export class CommandCodeReader {
  private cache = new Map<string, { size: number; mtimeMs: number; tail: CommandCodeTail }>();
  /** A transcript's id and creation header never change, so an unchanged file is not re-read. */
  private headers = new Map<string, { size: number; mtimeMs: number; header: { id: string; cwd: string; headerMs: number } }>();
  constructor(
    private readonly projectsRoot: string = path.join(os.homedir(), '.commandcode/projects'),
    private readonly maxTail = 256 * 1024,
  ) {}

  async read(processes: CommandCodeProcess[]): Promise<SessionState[]> {
    // Compare real paths: lsof resolves symlinks (`/private/tmp`) but the session
    // header records the path it was started with (`/tmp`).
    const normalized = processes.map(p => (p.cwd ? { ...p, cwd: realCwd(p.cwd) } : p));
    const transcripts = (await this.transcripts()).map(t => ({ ...t, cwd: realCwd(t.cwd) }));
    const pairs = attributeSessions(normalized, transcripts);
    const keep = new Set(transcripts.map(t => t.file));
    for (const file of this.cache.keys()) if (!keep.has(file)) this.cache.delete(file);
    for (const file of this.headers.keys()) if (!keep.has(file)) this.headers.delete(file);

    const out: SessionState[] = [];
    for (const { process: proc, transcript } of pairs) {
      const tail = await this.tailFor(transcript);
      const title = (await readTitle(transcript.file))?.slice(0, 80)
        ?? `${path.basename(transcript.cwd) || 'Command Code'} · ${transcript.id.slice(-8)}`;
      out.push({
        provider: 'commandcode', sessionId: transcript.id, pid: proc.pid, cwd: transcript.cwd, title,
        state: tail.state,
        waitingFor: tail.state === 'needsInput' ? 'Command Code: pregunta pendiente' : undefined,
        evidence: { source: 'commandcode-transcript', reason: tail.reason, at: tail.at },
      });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title) || a.sessionId.localeCompare(b.sessionId));
  }

  private async transcripts(): Promise<CommandCodeTranscript[]> {
    let dirs: string[];
    try { dirs = await fs.readdir(this.projectsRoot); } catch { return []; }
    const out: CommandCodeTranscript[] = [];
    for (const dir of dirs.slice(0, 200)) {
      const full = path.join(this.projectsRoot, dir);
      let names: string[];
      try { names = await fs.readdir(full); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl') || name.endsWith('.checkpoints.jsonl')) continue;
        const file = path.join(full, name);
        try {
          const stat = await fs.stat(file);
          if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) continue;
          const cached = this.headers.get(file);
          if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
            out.push({ file, ...cached.header, mtimeMs: stat.mtimeMs, size: stat.size });
            continue;
          }
          const header = await readHeader(file);
          if (!header) continue;
          this.headers.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, header });
          out.push({ file, ...header, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch { /* mid-write or unreadable transcript */ }
      }
    }
    return out;
  }

  private async tailFor(t: CommandCodeTranscript): Promise<CommandCodeTail> {
    const cached = this.cache.get(t.file);
    if (cached && cached.size === t.size && cached.mtimeMs === t.mtimeMs) return cached.tail;
    let tail: CommandCodeTail = { state: 'unknown', reason: 'sin datos' };
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(t.file, 'r');
      const start = Math.max(0, t.size - this.maxTail);
      const length = t.size - start;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : ''; }
      const records: unknown[] = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { records.push(JSON.parse(trimmed)); } catch { /* incomplete trailing write */ }
      }
      tail = inferCommandCodeState(records.slice(-400));
    } catch { /* unreadable transcript keeps the honest default */ }
    finally { await handle?.close(); }
    this.cache.set(t.file, { size: t.size, mtimeMs: t.mtimeMs, tail });
    return tail;
  }
}
