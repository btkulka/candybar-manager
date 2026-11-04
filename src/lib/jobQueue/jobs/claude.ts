import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { JobContext, JobDefinition } from '../types';
import type {
  ClaudeAskParams, ClaudeAskResult, ClaudeProfile, ClaudeSoundcloudParams, ClaudeSoundcloudResult, ClaudeStoreFinderParams,
  ClaudeStoreFinderResult, ClaudeTrackTagsParams, ClaudeTrackTagsResult, FinderPick, FinderTrack, SoundcloudReview,
  SourcingReviewResult, SourcingReviewRow,
} from '../../../types';
import {
  runClaudeCode, candybarMcpServer, candybarTools, stopProcessTree, CANDYBAR_MCP,
  type ClaudeRunOptions, type ClaudeRunResult, type McpServerConfig,
} from '../../claude/claudeCode';
import {
  ASK_SYSTEM_PROMPT, SOURCING_REVIEW_SCHEMA, buildSourcingReviewPrompt, TRACK_TAGS_SCHEMA, buildTrackTagsPrompt,
  TAG_FIELDS, SOUNDCLOUD_REVIEW_SCHEMA, buildSoundcloudReviewPrompt, summarizeSoundcloudSession,
  STORE_FINDER_SCHEMA, buildStoreFinderPrompt,
} from '../../claude/prompts';
import { profilePrompt } from '../../claude/userProfile';

export type ClaudeJobDeps = {
  /** Repo root: cwd for sessions, home of bin/ and dist/mcp/. */
  appRoot: string;
  /** Read at run time so a token or model saved in Settings applies to the next job. */
  getSettings: () => Promise<{ oauthToken: string; model: string; libraryRoot: string; organizeSourceDir: string; profile?: ClaudeProfile | null }>;
  /** The app's store-bridge socket, so the app's MCP tools reach this app
   *  (not another install's) for store searches. */
  storeBridgePath?: string;
  /** An empty working folder for sessions that read no files, so none of the
   *  repo's project settings load into them. Defaults to appRoot. */
  scratchDir?: string;
};

/** candybar-audio-tools tools that only read: library checks, store searches, tags, history. */
const READ_TOOLS = candybarTools(
  'check_library_for_tracks', 'search_beatport', 'search_qobuz', 'get_metadata',
  'check_health', 'compare_quality', 'list_purchases', 'sourcing_history',
);

function toolLabel(name: string): string {
  return name.startsWith(`mcp__${CANDYBAR_MCP}__`) ? name.slice(`mcp__${CANDYBAR_MCP}__`.length).replace(/_/g, ' ') : name;
}

/** The app's MCP server for a session, with the store bridge pointed at this app. */
function appMcpServer(deps: ClaudeJobDeps): McpServerConfig | null {
  const server = candybarMcpServer(deps.appRoot);
  if (server && deps.storeBridgePath) server.env = { ...server.env, CANDYBAR_STORE_BRIDGE: deps.storeBridgePath };
  return server;
}

type JobRunOptions = Omit<ClaudeRunOptions, 'cwd' | 'signal' | 'onEvent' | 'oauthToken' | 'model' | 'mcpServers'> & {
  mcp?: boolean;
  /** Overrides the model picked in Settings (the finder's small sessions). */
  model?: string;
  cwd?: string;
  /** Defaults to the job's own signal. */
  signal?: AbortSignal;
  /** Prefix for log lines, when several sessions share one job. */
  label?: string;
  /** Leave the job's progress alone; the caller reports its own. */
  quiet?: boolean;
};

/** Run a session for a job: its progress, text and tool calls go to the job's log. */
async function runForJob(ctx: JobContext<unknown>, deps: ClaudeJobDeps, opts: JobRunOptions): Promise<ClaudeRunResult> {
  const { mcp, model, cwd, signal, label, quiet, ...run } = opts;
  const settings = await deps.getSettings();
  let mcpServers: Record<string, McpServerConfig> | undefined;
  if (mcp) {
    const server = appMcpServer(deps);
    if (server) mcpServers = { [CANDYBAR_MCP]: server };
    else ctx.log('The app\'s tools aren\'t built (run `npm run build:mcp`), so Claude works without library and store lookups.', 'stderr');
  }
  const tag = label ? `${label} ` : '';
  let turns = 0;
  if (!quiet) ctx.progress({ phase: 'starting', current: 0, total: 0, message: 'Starting Claude Code…' });
  const result = await runClaudeCode({
    ...run,
    cwd: cwd ?? deps.appRoot,
    model: model || settings.model || undefined,
    oauthToken: settings.oauthToken || undefined,
    mcpServers,
    signal: signal ?? ctx.signal,
    onEvent: (e) => {
      if (e.kind === 'init') {
        ctx.log(`${tag}Claude Code started${e.model ? ` (${e.model})` : ''}`, 'status');
        if (e.failedMcpServers.length) ctx.log(`${tag}Couldn't start: ${e.failedMcpServers.join(', ')}`, 'stderr');
      } else if (e.kind === 'text') {
        ctx.log(`${tag}${e.text}`, 'stdout');
      } else if (e.kind === 'tool') {
        turns++;
        ctx.log(`${tag}→ ${toolLabel(e.name)}${toolDetail(e.input)}`, 'status');
        if (!quiet) ctx.progress({ phase: 'working', current: turns, total: 0, message: `Using ${toolLabel(e.name)}…` });
      }
    },
  });
  if (result.permissionDenials.length) ctx.log(`${tag}Not allowed in this job: ${[...new Set(result.permissionDenials)].join(', ')}`, 'status');
  return result;
}

/** A store search's query beside its tool name in the log, so the log shows what Claude looked for. */
function toolDetail(input: unknown): string {
  const i = input as { store?: unknown; query?: unknown } | null;
  return i && typeof i.query === 'string' ? ` ${typeof i.store === 'string' ? `${i.store}: ` : ''}"${i.query}"` : '';
}

function existingDirs(...dirs: string[]): string[] {
  return dirs.filter(d => d && fs.existsSync(d));
}

// ---------- Ask ----------

export function claudeAskJob(deps: ClaudeJobDeps): JobDefinition<ClaudeAskParams, ClaudeAskResult> {
  return {
    type: 'claude-ask',
    lane: 'claude-ask',
    dependencies: [],
    timeoutMs: 30 * 60 * 1000,
    run: async (ctx) => {
      const prompt = ctx.params.prompt?.trim();
      if (!prompt) throw new Error('Ask Claude something first.');
      const settings = await deps.getSettings();
      const builtIns = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
      const result = await runForJob(ctx, deps, {
        prompt,
        tools: builtIns,
        allowedTools: [...builtIns, ...READ_TOOLS],
        mcp: true,
        // Tuned to what Ben said about himself; memory still loads as usual.
        appendSystemPrompt: [ASK_SYSTEM_PROMPT, profilePrompt(settings.profile)].filter(Boolean).join('\n\n'),
        resumeSessionId: ctx.params.sessionId,
        persistSession: true,
        addDirs: existingDirs(settings.libraryRoot, settings.organizeSourceDir),
      });
      return { text: result.text, sessionId: result.sessionId };
    },
  };
}

// ---------- Sourcing review ----------

export function claudeSourcingReviewJob(deps: ClaudeJobDeps): JobDefinition<{ rows: SourcingReviewRow[] }, SourcingReviewResult> {
  return {
    type: 'claude-sourcing-review',
    lane: 'claude-sourcing-review',
    dependencies: [],
    timeoutMs: 20 * 60 * 1000,
    run: async (ctx) => {
      const rows = ctx.params.rows ?? [];
      if (rows.length === 0) return { verdicts: [], summary: 'Nothing to review.' };
      ctx.log(`Reviewing ${rows.length} rows`, 'status');
      // Judgment over data the app already has: no tools, one structured answer.
      const result = await runForJob(ctx, deps, {
        prompt: buildSourcingReviewPrompt(rows),
        tools: [],
        allowedTools: [],
        jsonSchema: SOURCING_REVIEW_SCHEMA,
        effort: 'high',
      });
      const out = result.structuredOutput as SourcingReviewResult;
      const known = new Set(rows.map(r => r.id));
      return { summary: out.summary, verdicts: out.verdicts.filter(v => known.has(v.id)) };
    },
  };
}

// ---------- Track tags ----------

export function claudeTrackTagsJob(deps: ClaudeJobDeps): JobDefinition<ClaudeTrackTagsParams, ClaudeTrackTagsResult> {
  return {
    type: 'claude-track-tags',
    lane: 'claude-track-tags',
    dependencies: [],
    timeoutMs: 10 * 60 * 1000,
    run: async (ctx) => {
      const builtIns = ['WebSearch', 'WebFetch'];
      const result = await runForJob(ctx, deps, {
        prompt: buildTrackTagsPrompt(ctx.params),
        tools: builtIns,
        allowedTools: [...builtIns, ...candybarTools('search_beatport', 'search_qobuz', 'get_metadata')],
        mcp: true,
        jsonSchema: TRACK_TAGS_SCHEMA,
        effort: 'medium',
      });
      const out = result.structuredOutput as ClaudeTrackTagsResult;
      const fields = Object.fromEntries(TAG_FIELDS.map(f => [f, String(out.fields?.[f] ?? '').trim()])) as ClaudeTrackTagsResult['fields'];
      return { ...out, fields };
    },
  };
}

// ---------- SoundCloud free downloads ----------

/** Flags for bin/source-soundcloud-likes.mjs. Exported for tests. */
export function soundcloudArgs(p: ClaudeSoundcloudParams): string[] {
  const args: string[] = [];
  // A resume reads its source from the session; only the gate options apply.
  if (p.resumeSessionPath) {
    args.push('--resume', p.resumeSessionPath);
  } else {
    if (p.setUrl?.trim()) args.push('--set', p.setUrl.trim());
    if (p.limit && p.limit > 0) args.push('--limit', String(Math.floor(p.limit)));
    if (p.since?.trim()) args.push('--since', p.since.trim());
  }
  if (p.listOnly) args.push('--list-only');
  if (p.dropLossy) args.push('--drop-lossy');
  // The form starts with the email saved in Settings; one cleared there
  // means no email this run, rather than the downloader's saved default.
  if (p.email?.trim()) args.push('--email', p.email.trim());
  else args.push('--no-email');
  // Following, liking and commenting are account actions: only with a yes.
  args.push('--sc-actions', p.accountActions ? 'follow,like,comment' : 'none');
  return args;
}

/** Run the downloader on Electron's bundled Node. Resolves with the session path it prints. */
function runSoundcloudCli(ctx: JobContext<ClaudeSoundcloudParams>, appRoot: string): Promise<string> {
  const script = path.join(appRoot, 'bin', 'source-soundcloud-likes.mjs');
  const args = [script, ...soundcloudArgs(ctx.params)];
  ctx.log(`node bin/source-soundcloud-likes.mjs ${args.slice(1).join(' ')}`, 'status');
  const child = spawn(process.execPath, args, {
    cwd: appRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so a cancel also closes the Chrome it drives.
    detached: process.platform !== 'win32',
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderrBuf = '';
    let tail = '';
    const onAbort = () => {
      stopProcessTree(child);
      reject(new Error('Job cancelled'));
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => {
      stderrBuf += c.toString('utf8');
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, nl).trimEnd();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (!line) continue;
        tail = (tail + '\n' + line).slice(-2000);
        ctx.log(line, 'stdout');
        ctx.progress({ phase: 'downloading', current: 0, total: 0, message: line.slice(0, 160) });
      }
    });
    child.on('error', (err) => reject(new Error(`Could not start the SoundCloud downloader: ${err.message}`)));
    child.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort);
      if (ctx.signal.aborted) return; // already rejected
      const sessionPath = stdout.trim().split('\n').pop()?.trim() ?? '';
      if (code !== 0 || !sessionPath) {
        return reject(new Error(`The SoundCloud run stopped (exit ${code}). ${tail.trim().split('\n').slice(-3).join(' ')}`));
      }
      resolve(sessionPath);
    });
  });
}

export function claudeSoundcloudJob(deps: ClaudeJobDeps): JobDefinition<ClaudeSoundcloudParams, ClaudeSoundcloudResult> {
  return {
    type: 'claude-soundcloud',
    lane: 'claude-soundcloud',
    dependencies: [],
    // A full likes sync with gates can run for an hour or more.
    timeoutMs: 3 * 60 * 60 * 1000,
    run: async (ctx) => {
      // The app runs the downloader itself (deterministic, and account actions
      // stay under the flags the user picked); Claude reviews what came back.
      const sessionPath = await runSoundcloudCli(ctx, deps.appRoot);
      const session = JSON.parse(await fs.promises.readFile(sessionPath, 'utf8'));
      const { counts } = summarizeSoundcloudSession(session);
      ctx.log(`Downloads done: ${JSON.stringify(counts)}`, 'status');
      try {
        const result = await runForJob(ctx, deps, {
          prompt: buildSoundcloudReviewPrompt(sessionPath, session),
          tools: ['Read'],
          allowedTools: ['Read', ...candybarTools('check_library_for_tracks')],
          mcp: true,
          jsonSchema: SOUNDCLOUD_REVIEW_SCHEMA,
          effort: 'medium',
          addDirs: [path.dirname(sessionPath)],
        });
        return { sessionPath, counts, review: result.structuredOutput as SoundcloudReview };
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        // The files are already in place; a failed review shouldn't hide that.
        return { sessionPath, counts, review: null, reviewError: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------- Store finder ----------

/** Tracks per session: few enough for a small model to judge each with care,
 *  enough to share a session's start-up between them. */
export const FINDER_BATCH = 8;
/** Sessions at once. Each searches the stores through the app. */
export const FINDER_PARALLEL = 4;
/** A small, fast model: the work is reading store listings. */
export const FINDER_MODEL = 'haiku';
/** A session that hasn't answered by then is stopped; its tracks keep the plain match. */
const FINDER_SESSION_MS = 6 * 60 * 1000;

/** Split into sessions' worth. Exported for tests. */
export function finderBatches<T>(items: T[], size = FINDER_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Whether the built MCP server has a tool: a build from before it was added doesn't. */
function builtMcpHas(appRoot: string, tool: string): boolean {
  try {
    return fs.readFileSync(path.join(appRoot, 'dist', 'mcp', 'mcp-server.js'), 'utf8').includes(`'${tool}'`);
  } catch {
    return false;
  }
}

/** Failures every later session would hit too, so there's no point starting them. */
function stopsTheRest(message: string): boolean {
  return /usage limit|isn't signed in|not installed|Could not start Claude Code/i.test(message);
}

export function claudeStoreFinderJob(deps: ClaudeJobDeps): JobDefinition<ClaudeStoreFinderParams, ClaudeStoreFinderResult> {
  return {
    type: 'claude-store-finder',
    lane: 'claude-store-finder',
    dependencies: [],
    timeoutMs: 60 * 60 * 1000,
    run: async (ctx) => {
      const tracks = ctx.params.tracks ?? [];
      const batches = finderBatches(tracks);
      const canSearch = !!appMcpServer(deps) && builtMcpHas(deps.appRoot, 'search_store_catalog');
      if (!canSearch) ctx.log('The app\'s store search tool isn\'t built (run `npm run build:mcp`), so Claude judges the plain search\'s candidates without searching again.', 'stderr');
      const cwd = deps.scratchDir && fs.existsSync(deps.scratchDir) ? deps.scratchDir : deps.appRoot;
      const picks: FinderPick[] = [];
      let next = 0;
      let done = 0;
      let unchecked = 0;
      let firstError: string | null = null;
      let stopped = false;
      ctx.log(`Finding store matches for ${tracks.length} tracks in ${batches.length} sessions (${FINDER_MODEL}, ${FINDER_PARALLEL} at a time)`, 'status');
      ctx.progress({ phase: 'finding', current: 0, total: tracks.length, message: 'Starting Claude Code…' });

      const runBatch = async (batch: FinderTrack[], n: number) => {
        // Each session gets its own deadline; a cancel of the job stops them all.
        const timer = new AbortController();
        const onAbort = () => timer.abort();
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        const timeout = setTimeout(() => timer.abort(), FINDER_SESSION_MS);
        try {
          const result = await runForJob(ctx, deps, {
            prompt: buildStoreFinderPrompt(batch, canSearch),
            tools: [],
            allowedTools: canSearch ? candybarTools('search_store_catalog') : [],
            mcp: canSearch,
            jsonSchema: STORE_FINDER_SCHEMA,
            model: FINDER_MODEL,
            cwd,
            signal: timer.signal,
            label: `[${n}]`,
            quiet: true,
          });
          const keys = new Set(batch.map(t => t.key));
          const answered = ((result.structuredOutput as { picks?: FinderPick[] })?.picks ?? []).filter(p => keys.delete(p.key));
          picks.push(...answered);
          unchecked += keys.size;
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          const message = timer.signal.aborted ? 'a session ran out of time' : err instanceof Error ? err.message : String(err);
          firstError ??= message;
          unchecked += batch.length;
          if (stopsTheRest(message)) stopped = true;
          ctx.log(`[${n}] kept the plain search's matches: ${message}`, 'stderr');
        } finally {
          clearTimeout(timeout);
          ctx.signal.removeEventListener('abort', onAbort);
        }
      };

      const worker = async () => {
        while (!stopped && next < batches.length) {
          const n = next++;
          await runBatch(batches[n], n + 1);
          done += batches[n].length;
          ctx.progress({ phase: 'finding', current: done, total: tracks.length, message: `Claude checked ${done} of ${tracks.length} tracks` });
        }
      };
      await Promise.all(Array.from({ length: Math.min(FINDER_PARALLEL, batches.length) }, worker));
      // Batches never started after a failure that stops the rest.
      for (let i = next; i < batches.length; i++) unchecked += batches[i].length;
      return { picks, unchecked, firstError };
    },
  };
}

export function claudeJobs(deps: ClaudeJobDeps): JobDefinition<any, any>[] {
  return [claudeAskJob(deps), claudeSourcingReviewJob(deps), claudeTrackTagsJob(deps), claudeSoundcloudJob(deps), claudeStoreFinderJob(deps)];
}
