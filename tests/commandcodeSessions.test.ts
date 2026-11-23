import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  attributeSessions, CommandCodeReader, CommandCodeTranscript, inferCommandCodeState,
  parseCommandCodeCwd, parseCommandCodeProcesses, parseLstartMs, realCwd,
} from '../src/commandcodeSessions';

const header = (id: string, cwd: string, timestamp: string) => ({ type: 'session', version: 3, id, timestamp, cwd });
const message = (role: string, content: unknown[], timestamp: string, source?: string) => ({
  type: 'message', id: `${role}-${timestamp}`, parentId: null, timestamp,
  message: { role, content, ...(source ? { meta: { source } } : {}) },
});
const toolUse = (name: string, id = 'tool-1') => ({ type: 'tool_use', id, name, input: {} });
const toolResult = (id = 'tool-1') => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });

describe('Command Code process parsing', () => {
  it('parses lstart into epoch milliseconds without relying on the locale', () => {
    expect(parseLstartMs('Mon Nov 23 08:57:32 2026')).toBe(new Date(2026, 10, 23, 8, 57, 32).getTime());
    expect(parseLstartMs('garbage')).toBeUndefined();
  });
  it('keeps command-code, cmd and node-launched processes but not unrelated ones', () => {
    const text = [
      '  101 Mon Nov 23 08:57:32 2026 command-code ',
      '  202 Mon Nov 23 08:43:50 2026 /opt/homebrew/bin/cmd --resume',
      '  303 Mon Nov 23 07:00:00 2026 node /opt/homebrew/lib/node_modules/command-code/dist/cli.mjs',
      '  404 Mon Nov 23 07:00:00 2026 node /Users/x/other-tool.mjs',
      '  505 Mon Nov 23 07:00:00 2026 opencode',
    ].join('\n');
    expect(parseCommandCodeProcesses(text).map(p => p.pid)).toEqual([101, 202, 303]);
  });
  it('reads the cwd descriptor and ignores other files', () => {
    const text = 'p101\nfcwd\nn/Users/work\np202\nfcwd\nn/elsewhere\n';
    expect(parseCommandCodeCwd(text)).toEqual(new Map([[101, '/Users/work'], [202, '/elsewhere']]));
  });
});

describe('Command Code tail state', () => {
  it('reports running while a tool call is open and stopped when the turn closes', () => {
    expect(inferCommandCodeState([
      header('s', '/w', '2026-11-23T10:00:00.000Z'),
      message('user', [{ type: 'text', text: 'hi' }], '2026-11-23T10:00:01.000Z', 'user'),
      message('assistant', [toolUse('shell_command')], '2026-11-23T10:00:02.000Z', 'model'),
    ])).toMatchObject({ state: 'running', reason: 'tool_use' });
    expect(inferCommandCodeState([
      message('assistant', [toolUse('shell_command')], '2026-11-23T10:00:02.000Z', 'model'),
      message('user', [toolResult()], '2026-11-23T10:00:02.000Z', 'tool'),
    ])).toMatchObject({ state: 'running', reason: 'tool_result' });
    expect(inferCommandCodeState([
      message('assistant', [{ type: 'text', text: 'done' }], '2026-11-23T10:00:09.000Z', 'model'),
    ])).toMatchObject({ state: 'stopped', reason: 'turn_complete', at: Date.parse('2026-11-23T10:00:09.000Z') });
  });
  it('flags a pending question and stays honest without records', () => {
    expect(inferCommandCodeState([
      message('assistant', [toolUse('ask_user_question', 'q1')], '2026-11-23T10:00:05.000Z', 'model'),
    ])).toMatchObject({ state: 'needsInput', reason: 'question_pending' });
    expect(inferCommandCodeState([])).toMatchObject({ state: 'unknown' });
    expect(inferCommandCodeState([{ type: 'session', version: 3, id: 's', timestamp: 'x', cwd: '/w' }]))
      .toMatchObject({ state: 'unknown' });
  });
});

describe('Command Code attribution', () => {
  const t = (over: Partial<CommandCodeTranscript>): CommandCodeTranscript => ({
    file: '/x/a.jsonl', id: 'a', cwd: '/work', headerMs: 1000, mtimeMs: 5000, size: 10, ...over,
  });
  it('matches each new session by its own start time even when two share a cwd', () => {
    const pairs = attributeSessions(
      [{ pid: 1, startMs: 1000, cwd: '/work' }, { pid: 2, startMs: 9000, cwd: '/work' }],
      [t({ headerMs: 9100, mtimeMs: 9500, id: 'new', file: '/x/new.jsonl' }), t({ headerMs: 1200, mtimeMs: 3000, id: 'old' })],
    );
    expect(pairs.map(p => [p.process.pid, p.transcript.id])).toEqual([[2, 'new'], [1, 'old']]);
  });
  it('falls back for resumed sessions whose header keeps the original creation time', () => {
    // Resumed at 08:00 (pid 7); header still says the session was created long ago.
    const pairs = attributeSessions(
      [{ pid: 7, startMs: 8000, cwd: '/work' }],
      [t({ headerMs: 100, mtimeMs: 12000, id: 'resumed' })],
    );
    expect(pairs).toEqual([{ process: { pid: 7, startMs: 8000, cwd: '/work' }, transcript: expect.objectContaining({ id: 'resumed' }) }]);
  });
  it('never crosses working directories or reuses one process twice', () => {
    expect(attributeSessions(
      [{ pid: 1, startMs: 1000, cwd: '/one' }],
      [t({ headerMs: 1000, cwd: '/two', mtimeMs: 9000 })],
    )).toEqual([]);
    const pairs = attributeSessions(
      [{ pid: 1, startMs: 1000, cwd: '/work' }],
      [t({ headerMs: 1000, mtimeMs: 9000, id: 'a' }), t({ headerMs: 1000, mtimeMs: 8000, id: 'b', file: '/x/b.jsonl' })],
    );
    expect(pairs.map(p => p.transcript.id)).toEqual(['a']);
  });
  it('does not pair a process that started after the transcript was last written', () => {
    expect(attributeSessions(
      [{ pid: 9, startMs: 60000, cwd: '/work' }],
      [t({ headerMs: 100, mtimeMs: 5000 })],
    )).toEqual([]);
  });
});

describe('CommandCodeReader', () => {
  let root: string;
  const write = (dir: string, id: string, records: unknown[], meta?: unknown) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, `${id}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(root, dir, `${id}.checkpoints.jsonl`), '{"turnNumber":1}\n');
    if (meta) fs.writeFileSync(path.join(root, dir, `${id}.meta.json`), JSON.stringify(meta));
  };
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'commandcode-')); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads the title from the sidecar and the state from the transcript tail', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000001';
    write('users-macdenix', id, [
      header(id, '/work/app', '2026-11-23T10:00:00.000Z'),
      message('assistant', [toolUse('read_file')], '2026-11-23T10:00:04.000Z', 'model'),
    ], { title: 'Project Recovery' });
    const stat = fs.statSync(path.join(root, 'users-macdenix', `${id}.jsonl`));
    const reader = new CommandCodeReader(root);
    const sessions = await reader.read([{ pid: 55, startMs: Date.parse('2026-11-23T10:00:00.000Z'), cwd: '/work/app' }]);
    expect(sessions).toMatchObject([{
      provider: 'commandcode', sessionId: id, pid: 55, cwd: '/work/app', title: 'Project Recovery', state: 'running',
    }]);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('refreshes the cached state once the transcript grows', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000002';
    write('users-macdenix', id, [
      header(id, '/work/live', '2026-11-23T11:00:00.000Z'),
      message('assistant', [toolUse('edit_file')], '2026-11-23T11:00:05.000Z', 'model'),
    ]);
    const reader = new CommandCodeReader(root);
    const process = [{ pid: 66, startMs: Date.parse('2026-11-23T11:00:00.000Z'), cwd: '/work/live' }];
    expect((await reader.read(process))[0]?.state).toBe('running');
    fs.appendFileSync(path.join(root, 'users-macdenix', `${id}.jsonl`),
      JSON.stringify(message('assistant', [{ type: 'text', text: 'done' }], '2026-11-23T11:00:30.000Z', 'model')) + '\n');
    expect((await reader.read(process))[0]?.state).toBe('stopped');
  });

  it('ignores checkpoints files and unrelated providers by directory shape', async () => {
    const reader = new CommandCodeReader(root);
    const sessions = await reader.read([{ pid: 77, startMs: 1, cwd: '/nowhere' }]);
    expect(sessions).toEqual([]);
  });

  it('matches when lsof resolves a symlinked cwd but the session recorded the original path', async () => {
    // Regression: /tmp is a symlink to /private/tmp on macOS; lsof reports the
    // resolved path while the transcript header keeps the path it was started with.
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-real-'));
    const linkDir = path.join(os.tmpdir(), `cc-link-${process.pid}`);
    fs.rmSync(linkDir, { force: true });
    fs.symlinkSync(realDir, linkDir, 'dir');
    const id = 'cccccccc-0000-0000-0000-000000000001';
    const startedAt = Date.parse('2026-11-23T12:00:00.000Z');
    fs.mkdirSync(path.join(root, 'users-link'), { recursive: true });
    fs.writeFileSync(path.join(root, 'users-link', `${id}.jsonl`), [
      header(id, linkDir, '2026-11-23T12:00:00.000Z'),
      message('assistant', [toolUse('read_file')], '2026-11-23T12:00:05.000Z', 'model'),
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    try {
      const reader = new CommandCodeReader(root);
      const sessions = await reader.read([{ pid: 88, startMs: startedAt, cwd: fs.realpathSync(realDir) }]);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ sessionId: id, pid: 88, state: 'running' });
      expect(realCwd(linkDir)).toBe(fs.realpathSync(realDir));
    } finally {
      fs.rmSync(linkDir, { force: true });
      fs.rmSync(realDir, { recursive: true, force: true });
    }
  });
});
