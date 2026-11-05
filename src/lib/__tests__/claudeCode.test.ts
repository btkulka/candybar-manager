import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildClaudeEnv, buildClaudeArgs, toClaudeEvents, describeFailure, parseAuthStatus, runClaudeCode, candybarTools,
  type ClaudeEvent,
} from '../claude/claudeCode';

describe('buildClaudeEnv', () => {
  it('drops API keys and a parent session\'s variables but keeps an OAuth token', () => {
    const env = buildClaudeEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      ANTHROPIC_API_KEY: 'sk-ant-api',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_OAUTH_TOKEN: 'inherited',
      CLAUDE_CONFIG_DIR: '/custom',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('inherited');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/custom');
    expect(env.HOME).toBe('/Users/x');
  });

  it('uses the app\'s token and puts extra PATH dirs first without repeats', () => {
    const env = buildClaudeEnv({ PATH: `/usr/bin${path.delimiter}/bin` }, { oauthToken: 'sk-ant-oat', pathDirs: ['/nvm/bin', '/usr/bin'] });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat');
    expect(env.PATH).toBe(['/nvm/bin', '/usr/bin', '/bin'].join(path.delimiter));
  });

  it('makes print mode wait for MCP servers, so a job has its tools from the first turn', () => {
    expect(buildClaudeEnv({ MCP_CONNECTION_NONBLOCKING: 'true' }).MCP_CONNECTION_NONBLOCKING).toBe('false');
  });
});

describe('buildClaudeArgs', () => {
  it('runs headless with only the named tools and servers', () => {
    const args = buildClaudeArgs({ tools: ['Read', 'WebSearch'], allowedTools: ['Read', ...candybarTools('search_qobuz')] });
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).toContain('--strict-mcp-config');
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: {} });
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,WebSearch');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,mcp__candybar-audio-tools__search_qobuz');
    expect(args).toContain('--no-session-persistence');
  });

  it('passes an empty tool list as "" and keeps a resumable session', () => {
    const args = buildClaudeArgs({ tools: [], allowedTools: [], resumeSessionId: 's-1', model: 'sonnet', effort: 'high', addDirs: ['/a', '/b'] });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--allowedTools');
    expect(args[args.indexOf('--resume') + 1]).toBe('s-1');
    expect(args).not.toContain('--no-session-persistence');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args.filter(a => a === '--add-dir')).toHaveLength(2);
  });
});

describe('toClaudeEvents', () => {
  it('reads init, rate limits, text and tool calls, and hides StructuredOutput', () => {
    expect(toClaudeEvents({ type: 'system', subtype: 'init', session_id: 's', model: 'm', mcp_servers: [{ name: 'a', status: 'connected' }, { name: 'b', status: 'failed' }] }))
      .toEqual([{ kind: 'init', sessionId: 's', model: 'm', failedMcpServers: ['b'] }]);
    expect(toClaudeEvents({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.68, resetsAt: 1794160800 } }))
      .toEqual([{ kind: 'rate-limit', info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.68, resetsAt: 1794160800 } }]);
    expect(toClaudeEvents({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }, { type: 'text', text: '  ' }, { type: 'tool_use', name: 'Read', input: { file_path: '/x' } }, { type: 'tool_use', name: 'StructuredOutput', input: {} }] },
    })).toEqual([{ kind: 'text', text: 'ok' }, { kind: 'tool', name: 'Read', input: { file_path: '/x' } }]);
    expect(toClaudeEvents({ type: 'user', message: { content: [] } })).toEqual([]);
  });
});

describe('describeFailure', () => {
  it('names a reached usage limit and a missing sign-in', () => {
    expect(describeFailure({ is_error: true, result: 'Claude AI usage limit reached|1794160800' }, '', 1)).toMatch(/usage limit/);
    expect(describeFailure(null, 'Invalid API key · Please run /login', 1)).toMatch(/isn't signed in/);
    expect(describeFailure({ subtype: 'error_max_turns', is_error: true }, '', 1)).toMatch(/ran out of turns/);
    expect(describeFailure(null, '', 2)).toBe('Claude Code exited with code 2.');
  });
});

describe('parseAuthStatus', () => {
  it('counts a claude.ai login or setup-token as a subscription, not an API key', () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b","subscriptionType":"max"}'))
      .toEqual({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b', subscriptionType: 'max', subscription: true });
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}')?.subscription).toBe(true);
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}')?.subscription).toBe(false);
    expect(parseAuthStatus('{"loggedIn":false}')?.subscription).toBe(false);
    expect(parseAuthStatus('not json')).toBeNull();
  });
});

// A stand-in `claude` on PATH that records how it was called and prints a
// canned stream, so the spawn / stream / result plumbing runs for real.
describe('runClaudeCode', () => {
  let dir: string;
  const savedPath = process.env.PATH;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
    fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_DIR/args"
cat > "$FAKE_DIR/stdin"
echo "\${ANTHROPIC_API_KEY:-unset}" > "$FAKE_DIR/apikey"
echo '{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-5-5","mcp_servers":[]}'
if [ "$FAKE_MODE" = "slow" ]; then sleep 30; fi
if [ "$FAKE_MODE" = "limit" ]; then
  echo '{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached|1794160800","session_id":"s1"}'
  exit 1
fi
echo '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"seven_day","utilization":0.5,"resetsAt":1}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use","name":"WebSearch","input":{"query":"x"}}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","structured_output":{"ok":true},"session_id":"s1","num_turns":2,"duration_ms":5,"permission_denials":[{"tool_name":"Bash"}]}'
`, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
    process.env.FAKE_DIR = dir;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    delete process.env.FAKE_DIR;
    delete process.env.FAKE_MODE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends the prompt on stdin, streams events and returns the result', async () => {
    process.env.FAKE_MODE = '';
    const events: ClaudeEvent[] = [];
    const result = await runClaudeCode({
      prompt: 'Find the tags', cwd: dir, tools: ['WebSearch'], allowedTools: ['WebSearch'],
      jsonSchema: { type: 'object' }, onEvent: e => events.push(e),
    });
    expect(result).toEqual({ text: 'done', structuredOutput: { ok: true }, sessionId: 's1', numTurns: 2, durationMs: 5, permissionDenials: ['Bash'] });
    expect(events.map(e => e.kind)).toEqual(['init', 'rate-limit', 'text', 'tool']);
    expect(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')).toBe('Find the tags');
    expect(fs.readFileSync(path.join(dir, 'args'), 'utf8')).toContain('--json-schema');
    // Billing must go to the subscription, never a key in the environment.
    expect(fs.readFileSync(path.join(dir, 'apikey'), 'utf8').trim()).toBe('unset');
  }, 20000);

  it('rejects with a readable reason when the plan limit is reached', async () => {
    process.env.FAKE_MODE = 'limit';
    await expect(runClaudeCode({ prompt: 'x', cwd: dir, tools: [], allowedTools: [] })).rejects.toThrow(/usage limit/);
  }, 20000);

  it('stops the process and rejects when cancelled', async () => {
    process.env.FAKE_MODE = 'slow';
    const ac = new AbortController();
    const run = runClaudeCode({ prompt: 'x', cwd: dir, tools: [], allowedTools: [], signal: ac.signal, onEvent: (e) => { if (e.kind === 'init') ac.abort(); } });
    await expect(run).rejects.toThrow(/cancelled/);
  }, 20000);
});

describe("Track Lab's skills in a session", () => {
  it('loads each plugin folder for the session', () => {
    const args = buildClaudeArgs({ tools: ['Skill', 'Read'], allowedTools: ['Skill'], pluginDirs: ['/App/claude-plugin'] });
    expect(args.slice(args.indexOf('--plugin-dir'), args.indexOf('--plugin-dir') + 2)).toEqual(['--plugin-dir', '/App/claude-plugin']);
    expect(args).toContain('Skill,Read');
  });

  it("puts Track Lab's own node after everything else on PATH, and sets the extra env", () => {
    const env = buildClaudeEnv({ PATH: `/usr/bin${path.delimiter}/bin` }, { pathDirs: ['/nvm/bin'], fallbackPathDirs: ['/UD/runtime/bin'], extra: { TRACK_LAB_ROOT: '/App' } });
    expect(env.PATH!.split(path.delimiter)).toEqual(['/nvm/bin', '/usr/bin', '/bin', '/UD/runtime/bin']);
    expect(env.TRACK_LAB_ROOT).toBe('/App');
  });
});
