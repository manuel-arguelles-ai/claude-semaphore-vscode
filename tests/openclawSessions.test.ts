import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  dedupeBySessionId, discoverOpenClawGateway, groupKeyForAgent, lastActivity,
  mapOpenClawState, OpenClawReader, OpenClawWindow, parseOpenClawGateway,
} from '../src/openclawSessions';

const now = 1_800_000_000_000;
const MIN = 60_000;
const win = (over: Partial<OpenClawWindow> = {}): OpenClawWindow => ({
  session_id: 's1', session_key: 'agent:main:telegram:group:-1', status: null,
  started_at: now - 2 * MIN, ended_at: null, updated_at: now - 1 * MIN,
  transcript_updated_at: now - 1 * MIN, display_name: 'telegram:g-test', channel: 'telegram', ...over,
});

describe('OpenClaw gateway discovery', () => {
  it('finds the gateway process, not the workers or browsers', () => {
    const text = [
      '  101 node /opt/homebrew/lib/node_modules/openclaw/dist/index.js gateway --port 18789',
      '  202 node /opt/homebrew/lib/node_modules/openclaw/dist/process/spawn-broker/worker.js',
      '  303 node /opt/homebrew/lib/node_modules/openclaw/dist/infra/sqlite-readonly-location.worker.js',
      '  404 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/x',
    ].join('\n');
    expect(parseOpenClawGateway(text)).toBe(101);
  });
  it('returns undefined when no gateway is running', () => {
    expect(parseOpenClawGateway('  202 node openclaw/dist/index.js worker\n')).toBeUndefined();
  });
});

describe('OpenClaw state mapping', () => {
  const base = { hasPendingApproval: false, now, windowMs: 10 * MIN };
  it('treats a pending operator approval as the exact needs-input signal', () => {
    expect(mapOpenClawState(win({ status: 'running' }), { ...base, hasPendingApproval: true }))
      .toEqual({ state: 'needsInput', reason: 'approval_pending' });
  });
  it('maps the recorded status values', () => {
    expect(mapOpenClawState(win({ status: 'running' }), base)).toEqual({ state: 'running', reason: 'status_running' });
    expect(mapOpenClawState(win({ status: 'done' }), base)).toEqual({ state: 'stopped', reason: 'status_done' });
    expect(mapOpenClawState(win({ status: 'failed' }), base)).toEqual({ state: 'error', reason: 'status_failed' });
    expect(mapOpenClawState(win({ status: 'killed' }), base)).toEqual({ state: 'stopped', reason: 'status_killed' });
    expect(mapOpenClawState(win({ status: 'timeout' }), base)).toEqual({ state: 'stopped', reason: 'status_timeout' });
  });
  it('treats an open session with recent activity as working and a silent one as idle', () => {
    expect(mapOpenClawState(win(), base)).toEqual({ state: 'running', reason: 'recent_activity' });
    expect(mapOpenClawState(win({ updated_at: now - 30 * MIN, transcript_updated_at: null, started_at: now - 40 * MIN }), base))
      .toEqual({ state: 'stopped', reason: 'idle' });
  });
  it('never calls a closed session running just because it is recent', () => {
    expect(mapOpenClawState(win({ ended_at: now - MIN }), base)).toEqual({ state: 'stopped', reason: 'idle' });
  });
});

describe('OpenClaw dedupe', () => {
  it('collapses the cron run variant onto the canonical session key', () => {
    const rows = [
      win({ session_id: 'x', session_key: 'agent:main:cron:abc:run:x', updated_at: now - 5 * MIN }),
      win({ session_id: 'x', session_key: 'agent:main:cron:abc', updated_at: now - 5 * MIN }),
    ];
    expect(dedupeBySessionId(rows).map(r => r.session_key)).toEqual(['agent:main:cron:abc']);
  });
  it('keeps the most recently active row for the same session id', () => {
    const rows = [
      win({ session_id: 'y', session_key: 'a:long:key', updated_at: now - 9 * MIN }),
      win({ session_id: 'y', session_key: 'b:short', updated_at: now - MIN }),
    ];
    expect(dedupeBySessionId(rows).map(r => r.session_key)).toEqual(['b:short']);
  });
  it('drops rows with no session id and keeps distinct sessions', () => {
    expect(dedupeBySessionId([win({ session_id: '' }), win({ session_id: 'a' }), win({ session_id: 'b' })])).toHaveLength(2);
  });
  it('measures activity across every timestamp column', () => {
    expect(lastActivity(win({ updated_at: 10, transcript_updated_at: 50, started_at: 30, ended_at: null }))).toBe(50);
  });
});

describe('OpenClawReader', () => {
  let root: string;
  let stateDb: string;
  const sqlite = (file: string, sql: string) => execFileSync('sqlite3', [file, sql], { encoding: 'utf8' });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-'));
    stateDb = path.join(root, 'state/openclaw.sqlite');
    fs.mkdirSync(path.dirname(stateDb), { recursive: true });
    sqlite(stateDb, `
      CREATE TABLE agent_databases (agent_id TEXT PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE operator_approvals (approval_id TEXT PRIMARY KEY, status TEXT NOT NULL, source_session_key TEXT, source_session_id TEXT);
      INSERT INTO agent_databases VALUES ('main', 'agents/main/agent/openclaw-agent.sqlite'),
                                          ('nix-groq', 'agents/nix-groq/agent/openclaw-agent.sqlite');`);
    for (const agent of ['main', 'nix-groq']) {
      const file = path.join(root, 'agents', agent, 'agent/openclaw-agent.sqlite');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      sqlite(file, `CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, status TEXT, started_at INTEGER, ended_at INTEGER, updated_at INTEGER, transcript_updated_at INTEGER, display_name TEXT, channel TEXT);
        INSERT INTO session_windows VALUES
          ('run-1', 'agent:${agent}:telegram:group:-1', NULL, ${now - 2 * MIN}, NULL, ${now - MIN}, ${now - MIN}, 'telegram:g-${agent}', 'telegram'),
          ('run-2', 'agent:${agent}:cron:abc:run:run-2', 'done', ${now - 20 * MIN}, ${now - 18 * MIN}, ${now - 18 * MIN}, ${now - 18 * MIN}, 'Automation: tarea', NULL);`);
    }
    // A pending approval on main's live session.
    sqlite(stateDb, `INSERT INTO operator_approvals VALUES ('a1', 'pending', 'agent:main:telegram:group:-1', 'run-1');`);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads every agent database and groups by agent', async () => {
    const reader = new OpenClawReader(stateDb, root);
    const sessions = await reader.read(4242, 45 * MIN, now);
    expect(sessions.map(s => s.sessionId).sort()).toEqual(['run-1', 'run-1', 'run-2', 'run-2']);
    expect(new Set(sessions.map(s => s.cwd))).toEqual(new Set([groupKeyForAgent('main'), groupKeyForAgent('nix-groq')]));
    expect(sessions.every(s => s.pid === 4242)).toBe(true);
  });

  it('marks the approved session as needs-input and the other live one as running', async () => {
    const reader = new OpenClawReader(stateDb, root);
    const sessions = await reader.read(4242, 10 * MIN, now);
    const main = sessions.filter(s => s.cwd === groupKeyForAgent('main'));
    expect(main.find(s => s.sessionId === 'run-1')).toMatchObject({ state: 'needsInput', waitingFor: expect.stringContaining('aprobación') });
    const groq = sessions.filter(s => s.cwd === groupKeyForAgent('nix-groq'));
    expect(groq.find(s => s.sessionId === 'run-1')).toMatchObject({ state: 'running' }); // same session id, different agent db
  });

  it('keeps a recently closed session inside the window and drops it once it ages out', async () => {
    const reader = new OpenClawReader(stateDb, root);
    const closeEnough = await reader.read(4242, 45 * MIN, now);
    expect(closeEnough.some(s => s.sessionId === 'run-2')).toBe(true);
    const aged = await reader.read(4242, 10 * MIN, now);
    expect(aged.some(s => s.sessionId === 'run-2')).toBe(false);
  });

  it('survives a missing state database without throwing', async () => {
    const reader = new OpenClawReader(path.join(root, 'nope.sqlite'), root);
    expect(await reader.read(1, 10 * MIN, now)).toEqual([]);
  });
});

describe('gateway discovery is tolerant', () => {
  it('resolves undefined rather than rejecting when ps is unavailable', async () => {
    await expect(discoverOpenClawGateway()).resolves.toBeTypeOf('number');
  });
});
