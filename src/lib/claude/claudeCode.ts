import { spawn, execFile, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createScopedLogger } from '../logger';
import type { ClaudeRateLimit, ClaudeStatus } from '../../types';

export type { ClaudeRateLimit, ClaudeStatus };

// Runs Claude Code headless (`claude -p`) for the app's Claude jobs. Jobs go
// through the user's own Claude Code install, so they bill the Claude
// subscription that install is signed in to (or the long-lived token from
// `claude setup-token` saved in Settings), never API credits.

const log = createScopedLogger('ClaudeCode');

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type McpServerConfig = {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type ClaudeEvent =
  | { kind: 'init'; sessionId: string | null; model: string | null; failedMcpServers: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'rate-limit'; info: ClaudeRateLimit };

export type ClaudeRunOptions = {
  prompt: string;
  cwd: string;
  /** Built-in tools the session can see (`--tools`). Empty means none. */
  tools: string[];
  /** Permission allow rules. Everything else is denied without asking. */
  allowedTools: string[];
  mcpServers?: Record<string, McpServerConfig>;
  /** When set, the run must end in a structured result matching this schema. */
  jsonSchema?: object;
  appendSystemPrompt?: string;
  /** Model alias or id; empty uses Claude Code's default. */
  model?: string;
  effort?: ClaudeEffort;
  /** Continue an earlier session (a follow-up question). */
  resumeSessionId?: string;
  /** Keep the session on disk so it can be resumed. Off for one-shot jobs. */
  persistSession?: boolean;
  addDirs?: string[];
  oauthToken?: string;
  signal?: AbortSignal;
  onEvent?: (event: ClaudeEvent) => void;
};

export type ClaudeRunResult = {
  text: string;
  structuredOutput: unknown;
  sessionId: string | null;
  numTurns: number;
  durationMs: number;
  permissionDenials: string[];
};

// ---------- Environment ----------

/** Variables a parent Claude Code session sets for its children. Inherited (say,
 *  `npm run dev` from a Claude Code terminal) they'd make a job look like a
 *  nested session. */
const SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_(?!OAUTH_TOKEN$).*|CLAUDE_PID|CLAUDE_AGENT_SDK_VERSION|CLAUDE_EFFORT)$/;
/** API credentials outrank the subscription login in Claude Code's auth order.
 *  A job must bill the subscription, not a key that happens to be in the env. */
const API_KEY_ENV = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ELECTRON_RUN_AS_NODE']);

export function buildClaudeEnv(
  base: NodeJS.ProcessEnv,
  opts: { oauthToken?: string; pathDirs?: string[] } = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || SESSION_ENV.test(key) || API_KEY_ENV.has(key)) continue;
    env[key] = value;
  }
  if (opts.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken;
  const dirs = [...(opts.pathDirs ?? []), ...(env.PATH ?? '').split(path.delimiter)].filter(Boolean);
  env.PATH = [...new Set(dirs)].join(path.delimiter);
  return env;
}

let shellPath: Promise<string[]> | null = null;

/** PATH from the user's login shell. An app opened from the Dock gets launchd's
 *  bare PATH, which misses Homebrew, nvm and ~/.local/bin, where `claude` and
 *  the `node` it runs on usually live. */
function loginShellPath(): Promise<string[]> {
  if (process.platform === 'win32') return Promise.resolve([]);
  shellPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-ilc', 'printf "__CBPATH__%s__CBPATH__" "$PATH"'], { timeout: 8000 }, (err, stdout) => {
      const m = /__CBPATH__(.*?)__CBPATH__/s.exec(String(stdout ?? ''));
      if (!m) log.warn('Could not read the login shell PATH:', err?.message ?? 'no output');
      resolve(m ? m[1].split(':').filter(Boolean) : []);
    });
  });
  return shellPath;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export async function findClaudeBinary(): Promise<string | null> {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const home = os.homedir();
  const look = (dirs: string[]) => {
    for (const dir of dirs.filter(Boolean)) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        if (isExecutable(candidate)) return candidate;
      }
    }
    return null;
  };
  // The usual install spots first; the login shell (slow to start) only when
  // `claude` lives somewhere only the user's shell config knows about (nvm).
  return look([
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(home, '.claude', 'local'),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]) ?? look(await loginShellPath());
}

async function claudeEnv(binary: string, oauthToken?: string): Promise<NodeJS.ProcessEnv> {
  // The binary's own directory first: an npm/nvm install is a node script, and
  // its `node` sits beside it.
  return buildClaudeEnv(process.env, { oauthToken, pathDirs: [path.dirname(binary), ...await loginShellPath()] });
}

// ---------- Status ----------

let lastRateLimit: ClaudeRateLimit | null = null;

function execText(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(binary, args, { env, timeout: 20000, shell: binary.endsWith('.cmd') }, (err, stdout, stderr) => {
      // err.code is the exit status, or a string like 'ENOENT' when it never ran.
      const exit = (err as { code?: unknown } | null)?.code;
      const code = !err ? 0 : typeof exit === 'number' ? exit : 1;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr || err?.message || ''), code });
    });
  });
}

/** Parse `claude auth status` JSON. Exported for tests. */
export function parseAuthStatus(stdout: string): Pick<ClaudeStatus, 'loggedIn' | 'authMethod' | 'email' | 'subscriptionType' | 'subscription'> | null {
  try {
    const s = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const authMethod = typeof s.authMethod === 'string' ? s.authMethod : null;
    const provider = typeof s.apiProvider === 'string' ? s.apiProvider : 'firstParty';
    const loggedIn = s.loggedIn === true;
    return {
      loggedIn,
      authMethod,
      email: typeof s.email === 'string' ? s.email : null,
      subscriptionType: typeof s.subscriptionType === 'string' ? s.subscriptionType : null,
      subscription: loggedIn && provider === 'firstParty' && (authMethod === 'claude.ai' || authMethod === 'oauth_token'),
    };
  } catch {
    return null;
  }
}

export async function getClaudeStatus(oauthToken?: string): Promise<ClaudeStatus> {
  const base: ClaudeStatus = {
    installed: false, binaryPath: null, version: null, loggedIn: false, authMethod: null, email: null,
    subscriptionType: null, subscription: false, usingAppToken: !!oauthToken, rateLimit: lastRateLimit, error: null,
  };
  const binary = await findClaudeBinary();
  if (!binary) return { ...base, error: 'Claude Code is not installed (no `claude` command found).' };
  const env = await claudeEnv(binary, oauthToken);
  const version = await execText(binary, ['--version'], env);
  const status: ClaudeStatus = {
    ...base,
    installed: true,
    binaryPath: binary,
    version: version.code === 0 ? version.stdout.trim().split(/\s+/)[0] || null : null,
  };
  if (version.code !== 0) return { ...status, error: `\`claude --version\` failed: ${version.stderr.trim().slice(0, 300)}` };
  const auth = await execText(binary, ['auth', 'status'], env);
  const parsed = parseAuthStatus(auth.stdout);
  if (!parsed) return { ...status, error: auth.stderr.trim().slice(0, 300) || 'Could not read `claude auth status`.' };
  return { ...status, ...parsed };
}

/** Open a terminal running `claude auth login`, which signs in with a browser.
 *  Returns the command when there's no terminal to open, so the UI can show it. */
export async function openClaudeLogin(): Promise<{ opened: boolean; command: string }> {
  const binary = await findClaudeBinary();
  const command = binary ? `${shellQuote(binary)} auth login` : 'claude auth login';
  if (!binary) return { opened: false, command };
  try {
    if (process.platform === 'darwin') {
      const pathPrefix = `PATH=${shellQuote(path.dirname(binary))}:"$PATH"`;
      const script = `${pathPrefix} ${command}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await new Promise<void>((resolve, reject) => {
        execFile('osascript', ['-e', 'tell application "Terminal" to activate', '-e', `tell application "Terminal" to do script "${script}"`],
          (err) => (err ? reject(err) : resolve()));
      });
      return { opened: true, command };
    }
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', `"${binary}" auth login`], { detached: true, stdio: 'ignore' }).unref();
      return { opened: true, command };
    }
  } catch (err) {
    log.warn('Could not open a terminal for claude auth login:', err);
  }
  return { opened: false, command };
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------- Running ----------

export function buildClaudeArgs(o: Omit<ClaudeRunOptions, 'prompt' | 'cwd' | 'signal' | 'onEvent' | 'oauthToken'>): string[] {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    // Headless: anything not allowed below is refused, never asked about.
    '--permission-mode', 'dontAsk',
    // Only the servers the job names, not every MCP server the user has set up.
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: o.mcpServers ?? {} }),
    // User settings carry hooks and plugins meant for interactive sessions.
    '--setting-sources', 'project,local',
    '--tools', o.tools.join(','),
  ];
  if (o.allowedTools.length > 0) args.push('--allowedTools', o.allowedTools.join(','));
  if (o.jsonSchema) args.push('--json-schema', JSON.stringify(o.jsonSchema));
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  if (!o.persistSession && !o.resumeSessionId) args.push('--no-session-persistence');
  for (const dir of o.addDirs ?? []) args.push('--add-dir', dir);
  return args;
}

type StreamMessage = Record<string, any>;

/** Turn one stream-json message into the events a job cares about. */
export function toClaudeEvents(msg: StreamMessage): ClaudeEvent[] {
  if (msg.type === 'system' && msg.subtype === 'init') {
    const failed = Array.isArray(msg.mcp_servers)
      ? msg.mcp_servers.filter((s: StreamMessage) => s?.status && s.status !== 'connected').map((s: StreamMessage) => String(s.name))
      : [];
    return [{ kind: 'init', sessionId: msg.session_id ?? null, model: msg.model ?? null, failedMcpServers: failed }];
  }
  if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
    const r = msg.rate_limit_info;
    return [{
      kind: 'rate-limit',
      info: {
        status: String(r.status ?? ''),
        rateLimitType: r.rateLimitType ?? null,
        utilization: typeof r.utilization === 'number' ? r.utilization : null,
        resetsAt: typeof r.resetsAt === 'number' ? r.resetsAt : null,
      },
    }];
  }
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    const events: ClaudeEvent[] = [];
    for (const block of msg.message.content) {
      if (block?.type === 'text' && block.text?.trim()) events.push({ kind: 'text', text: block.text });
      // StructuredOutput is how --json-schema hands back the result, not work.
      else if (block?.type === 'tool_use' && block.name !== 'StructuredOutput') events.push({ kind: 'tool', name: block.name, input: block.input });
    }
    return events;
  }
  return [];
}

/** A readable reason for a failed run. Exported for tests. */
export function describeFailure(result: StreamMessage | null, stderrTail: string, exitCode: number | null): string {
  const text = String(result?.result ?? '') + ' ' + stderrTail;
  if (/usage limit|rate limit|429/i.test(text) || result?.api_error_status === 429) {
    return 'Your Claude plan\'s usage limit is reached. Try again once it resets.';
  }
  if (/not logged in|please run \/login|invalid api key|authentication|401|oauth token/i.test(text)) {
    return 'Claude Code isn\'t signed in. Open Settings → Claude to sign in.';
  }
  if (result?.subtype === 'error_max_turns') return 'Claude ran out of turns before finishing.';
  const detail = (String(result?.result ?? '').trim() || stderrTail.trim()).slice(0, 400);
  return detail || `Claude Code exited with code ${exitCode ?? 'unknown'}.`;
}

/** Run one Claude Code session to completion. Rejects on failure or abort. */
export async function runClaudeCode(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const binary = await findClaudeBinary();
  if (!binary) throw new Error('Claude Code is not installed. Install it from claude.com/claude-code, then sign in from Settings → Claude.');
  if (opts.signal?.aborted) throw new Error('Job cancelled');

  const args = buildClaudeArgs(opts);
  const child = spawn(binary, args, {
    cwd: opts.cwd,
    env: await claudeEnv(binary, opts.oauthToken),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: binary.endsWith('.cmd'),
    // Its own process group, so a cancel also stops the MCP servers and any
    // browser they opened.
    detached: process.platform !== 'win32',
  });

  return new Promise<ClaudeRunResult>((resolve, reject) => {
    let result: StreamMessage | null = null;
    let sessionId: string | null = null;
    let stdoutBuf = '';
    let stderrTail = '';

    // A cancel settles at once: a grandchild can hold stdout open long after
    // claude itself is gone, and 'close' would wait for it.
    const onAbort = () => {
      stopProcessTree(child);
      reject(new Error('Job cancelled'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let msg: StreamMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        log.debug('non-JSON line from claude:', line.slice(0, 200));
        return;
      }
      if (msg.session_id) sessionId = msg.session_id;
      if (msg.type === 'result') result = msg;
      for (const event of toClaudeEvents(msg)) {
        if (event.kind === 'rate-limit') lastRateLimit = event.info;
        opts.onEvent?.(event);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        handleLine(stdoutBuf.slice(0, nl));
        stdoutBuf = stdoutBuf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Could not start Claude Code: ${err.message}`));
    });
    child.on('close', (code) => {
      if (stdoutBuf) handleLine(stdoutBuf);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return; // already rejected
      const r = result as StreamMessage | null;
      if (!r || r.is_error || r.subtype !== 'success') {
        return reject(new Error(describeFailure(r, stderrTail, code)));
      }
      if (opts.jsonSchema && r.structured_output === undefined) {
        return reject(new Error('Claude finished without the structured answer this job needs.'));
      }
      resolve({
        text: typeof r.result === 'string' ? r.result : '',
        structuredOutput: r.structured_output,
        sessionId: r.session_id ?? sessionId,
        numTurns: Number(r.num_turns ?? 0),
        durationMs: Number(r.duration_ms ?? 0),
        permissionDenials: Array.isArray(r.permission_denials)
          ? r.permission_denials.map((d: StreamMessage) => String(d?.tool_name ?? d))
          : [],
      });
    });

    child.stdin.on('error', () => { /* the process exited before reading; close reports why */ });
    child.stdin.end(opts.prompt);
  });
}

/** SIGTERM a child started with `detached` and everything in its process
 *  group, then SIGKILL whatever is left after five seconds. */
export function stopProcessTree(child: ChildProcess): void {
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // Already gone.
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 5000).unref();
}

/** The app's own MCP server (candybar-audio-tools), run on Electron's bundled
 *  Node so it works without a system Node. Null until `npm run build:mcp`. */
export function candybarMcpServer(appRoot: string): McpServerConfig | null {
  const script = path.join(appRoot, 'dist', 'mcp', 'mcp-server.js');
  if (!fs.existsSync(script)) return null;
  return { type: 'stdio', command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

export const CANDYBAR_MCP = 'candybar-audio-tools';

/** Permission rule names for candybar-audio-tools' tools. */
export function candybarTools(...names: string[]): string[] {
  return names.map(n => `mcp__${CANDYBAR_MCP}__${n}`);
}
