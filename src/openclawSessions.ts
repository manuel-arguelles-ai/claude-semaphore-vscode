import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { SemaphoreState, SessionState } from './types';

/** A row of the agent's own session_windows table, as far as the semaphore cares. */
export interface OpenClawWindow {
  session_id: string;
  session_key: string;
  status?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  updated_at?: number | null;
  transcript_updated_at?: number | null;
  display_name?: string | null;
  channel?: string | null;
}

export interface OpenClawAgentDb { agentId: string; file: string }

/** Prefix that separates OpenClaw's groups from the project folders of the other providers. */
export const OPENCLAW_GROUP_PREFIX = 'openclaw:';

export const groupKeyForAgent = (agentId: string): string => `${OPENCLAW_GROUP_PREFIX}${agentId}`;

const numeric = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

/** The gateway is one process that owns every session, so it also supplies the pid. */
export function parseOpenClawGateway(text: string): number | undefined {
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[2];
    if (!/openclaw\/dist\/index\.js/.test(command)) continue;
    if (!/\bgateway\b/.test(command)) continue;
    return Number(m[1]);
  }
  return undefined;
}

const run = (file: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 5000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
    if (err) return reject(err);
    resolve(stdout);
  });
});

export function discoverOpenClawGateway(): Promise<number | undefined> {
  return run('ps', ['ax', '-ww', '-o', 'pid=,command=']).then(parseOpenClawGateway);
}

/** Latest moment anything about the session moved; `updated_at` alone is not monotonic. */
export function lastActivity(w: OpenClawWindow): number {
  return Math.max(
    numeric(w.updated_at) ?? 0,
    numeric(w.transcript_updated_at) ?? 0,
    numeric(w.started_at) ?? 0,
    numeric(w.ended_at) ?? 0,
  );
}

/**
 * State of one session window.
 *
 * `needsInput` is the only exact answer OpenClaw gives: an operator approval
 * pending on that session. Otherwise the window's own status decides, and a
 * session that is open but silent is idle — not working.
 */
export function mapOpenClawState(
  w: OpenClawWindow,
  options: { hasPendingApproval: boolean; now: number; windowMs: number },
): { state: SemaphoreState; reason: string } {
  if (options.hasPendingApproval) return { state: 'needsInput', reason: 'approval_pending' };
  const status = typeof w.status === 'string' ? w.status : undefined;
  if (status === 'running') return { state: 'running', reason: 'status_running' };
  if (status === 'failed') return { state: 'error', reason: 'status_failed' };
  if (status === 'killed' || status === 'timeout') return { state: 'stopped', reason: `status_${status}` };
  if (status === 'done') return { state: 'stopped', reason: 'status_done' };
  const active = lastActivity(w);
  if (active > 0 && options.now - active <= options.windowMs && numeric(w.ended_at) === undefined) {
    return { state: 'running', reason: 'recent_activity' };
  }
  return { state: 'stopped', reason: 'idle' };
}

/** Deduplicates by session id: cron keeps both `…:cron:<id>` and `…:cron:<id>:run:<uuid>`. */
export function dedupeBySessionId(rows: OpenClawWindow[]): OpenClawWindow[] {
  const best = new Map<string, OpenClawWindow>();
  for (const row of rows) {
    if (!row.session_id) continue;
    const current = best.get(row.session_id);
    if (!current) { best.set(row.session_id, row); continue; }
    const a = lastActivity(row); const b = lastActivity(current);
    // Prefer the most recent row; on a tie prefer the shorter key (the canonical
    // `…:cron:<id>` form) so the label is not the internal run suffix.
    if (a > b || (a === b && row.session_key.length < current.session_key.length)) {
      best.set(row.session_id, row);
    }
  }
  return [...best.values()];
}

const MAX_AGENT_DBS = 32;
const MAX_ROWS = 400;
const AGENT_CACHE_MS = 5 * 60 * 1000;

/** Reads OpenClaw's own SQLite databases; subprocess-only, never writes. */
export class OpenClawReader {
  private agentDbs: OpenClawAgentDb[] = [];
  private agentDbsAt = 0;
  constructor(
    private readonly stateDb: string = path.join(os.homedir(), '.openclaw/state/openclaw.sqlite'),
    private readonly home: string = path.join(os.homedir(), '.openclaw'),
  ) {}

  private query(file: string, sql: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      execFile('sqlite3', ['-readonly', '-json', file, sql], { timeout: 5000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        const text = stdout.trim();
        try { resolve(text ? JSON.parse(text) : []); } catch (e) { reject(e); }
      });
    });
  }

  async read(gatewayPid: number, windowMs: number, now = Date.now()): Promise<SessionState[]> {
    const dbFiles = await this.agentFiles(now);
    if (!dbFiles.length) return [];
    const since = Math.floor(now - windowMs);
    const rows: { agentId: string; row: OpenClawWindow }[] = [];

    for (const { agentId, file } of dbFiles) {
      try {
        const windows = await this.query(file, `
          SELECT session_id, session_key, status, started_at, ended_at, updated_at,
                 transcript_updated_at, display_name, channel
          FROM session_windows
          WHERE status = 'running' OR updated_at > ${since}
          ORDER BY updated_at DESC
          LIMIT ${MAX_ROWS};`) as OpenClawWindow[];
        for (const row of windows) rows.push({ agentId, row });
      } catch { /* an agent database can be mid-migration; skip it this tick */ }
    }
    if (!rows.length) return [];

    const pending = await this.pendingApprovals().catch(() => ({ keys: new Set<string>(), ids: new Set<string>() }));
    const out: SessionState[] = [];
    for (const { agentId, row } of dedupeByAgent(rows)) {
      const hasPendingApproval = (!!row.session_key && pending.keys.has(row.session_key)) || pending.ids.has(row.session_id);
      const { state, reason } = mapOpenClawState(row, { hasPendingApproval, now, windowMs });
      // A session that never started and never closed, silent for the whole window,
      // is leftover history rather than a live row.
      const neverRan = (numeric(row.started_at) ?? 0) === 0;
      if (neverRan && (row.status ?? null) === null && (numeric(row.ended_at) ?? 0) === 0
        && now - lastActivity(row) > windowMs) continue;
      out.push({
        provider: 'openclaw', sessionId: row.session_id, pid: gatewayPid,
        cwd: groupKeyForAgent(agentId),
        title: (row.display_name?.trim() || row.session_key || `OpenClaw · ${agentId}`).slice(0, 120),
        state,
        waitingFor: hasPendingApproval ? 'OpenClaw: aprobación pendiente' : undefined,
        evidence: { source: 'openclaw-sqlite', reason, at: lastActivity(row) || undefined },
      });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title) || a.sessionId.localeCompare(b.sessionId));
  }

  /** agent_databases is the authoritative list; guessing directory names would miss agents. */
  private async agentFiles(now: number): Promise<OpenClawAgentDb[]> {
    if (this.agentDbs.length && now - this.agentDbsAt < AGENT_CACHE_MS) return this.agentDbs;
    try {
      const rows = await this.query(this.stateDb,
        `SELECT agent_id, path FROM agent_databases ORDER BY agent_id LIMIT ${MAX_AGENT_DBS};`) as { agent_id: string; path: string }[];
      this.agentDbs = rows
        .filter(r => typeof r.agent_id === 'string' && typeof r.path === 'string' && r.path)
        .map(r => ({
          agentId: r.agent_id,
          file: path.isAbsolute(r.path) ? r.path : path.join(this.home, r.path),
        }));
      this.agentDbsAt = now;
    } catch {
      this.agentDbs = [];
      this.agentDbsAt = now;
    }
    return this.agentDbs;
  }

  /**
   * `pending` is the only status that means a human is being waited on.
   *
   * Approvals are scoped by `session_key` when the row records one: the same
   * session id can exist in another agent's database, and a plain id match would
   * light up the wrong row.
   */
  private async pendingApprovals(): Promise<{ keys: Set<string>; ids: Set<string> }> {
    const rows = await this.query(this.stateDb,
      `SELECT IFNULL(source_session_key, '') AS k, IFNULL(source_session_id, '') AS s
       FROM operator_approvals WHERE status = 'pending';`) as { k: string; s: string }[];
    const keys = new Set<string>();
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.k) keys.add(row.k);
      else if (row.s) ids.add(row.s);
    }
    return { keys, ids };
  }
}

/**
 * Deduplicates per agent: cron keeps both `…:cron:<id>` and `…:cron:<id>:run:<uuid>`
 * for the same execution, and only one row per session should be shown.
 */
function dedupeByAgent(entries: { agentId: string; row: OpenClawWindow }[]): { agentId: string; row: OpenClawWindow }[] {
  const best = new Map<string, { agentId: string; row: OpenClawWindow }>();
  for (const entry of entries) {
    if (!entry.row.session_id) continue;
    const key = `${entry.agentId}\u0000${entry.row.session_id}`;
    const current = best.get(key);
    if (!current) { best.set(key, entry); continue; }
    const a = lastActivity(entry.row); const b = lastActivity(current.row);
    // Prefer the most recent row; on a tie prefer the shorter key (the canonical
    // `…:cron:<id>` form) so the label is not the internal run suffix.
    if (a > b || (a === b && entry.row.session_key.length < current.row.session_key.length)) {
      best.set(key, entry);
    }
  }
  return [...best.values()];
}
