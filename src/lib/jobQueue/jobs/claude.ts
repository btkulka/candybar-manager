import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { JobContext, JobDefinition } from '../types';
import type {
  ClaudeAskParams, ClaudeAskResult, ClaudeSoundcloudParams, ClaudeSoundcloudResult, ClaudeTrackTagsParams,
  ClaudeTrackTagsResult, SoundcloudReview, SourcingReviewResult, SourcingReviewRow,
} from '../../../types';
import {
  runClaudeCode, candybarMcpServer, candybarTools, stopProcessTree, CANDYBAR_MCP,
  type ClaudeRunOptions, type ClaudeRunResult, type McpServerConfig,
} from '../../claude/claudeCode';
import {
  ASK_SYSTEM_PROMPT, SOURCING_REVIEW_SCHEMA, buildSourcingReviewPrompt, TRACK_TAGS_SCHEMA, buildTrackTagsPrompt,
  TAG_FIELDS, SOUNDCLOUD_REVIEW_SCHEMA, buildSoundcloudReviewPrompt, summarizeSoundcloudSession,
} from '../../claude/prompts';

export type ClaudeJobDeps = {
  /** Repo root: cwd for sessions, home of bin/ and dist/mcp/. */
  appRoot: string;
  /** Read at run time so a token or model saved in Settings applies to the next job. */
  getSettings: () => Promise<{ oauthToken: string; model: string; libraryRoot: string; organizeSourceDir: string }>;
};

/** candybar-audio-tools tools that only read: library checks, store searches, tags, history. */
const READ_TOOLS = candybarTools(
  'check_library_for_tracks', 'search_beatport', 'search_qobuz', 'get_metadata',
  'check_health', 'compare_quality', 'list_purchases', 'sourcing_history',
);

function toolLabel(name: string): string {
  return name.startsWith(`mcp__${CANDYBAR_MCP}__`) ? name.slice(`mcp__${CANDYBAR_MCP}__`.length).replace(/_/g, ' ') : name;
}

/** Run a session for a job: its progress, text and tool calls go to the job's log. */
async function runForJob(
  ctx: JobContext<unknown>,
  deps: ClaudeJobDeps,
  opts: Omit<ClaudeRunOptions, 'cwd' | 'signal' | 'onEvent' | 'oauthToken' | 'model' | 'mcpServers'> & { mcp?: boolean },
): Promise<ClaudeRunResult> {
  const settings = await deps.getSettings();
  let mcpServers: Record<string, McpServerConfig> | undefined;
  if (opts.mcp) {
    const server = candybarMcpServer(deps.appRoot);
    if (server) mcpServers = { [CANDYBAR_MCP]: server };
    else ctx.log('The app\'s tools aren\'t built (run `npm run build:mcp`), so Claude works without library and store lookups.', 'stderr');
  }
  let turns = 0;
  ctx.progress({ phase: 'starting', current: 0, total: 0, message: 'Starting Claude Code…' });
  const result = await runClaudeCode({
    ...opts,
    cwd: deps.appRoot,
    model: settings.model || undefined,
    oauthToken: settings.oauthToken || undefined,
    mcpServers,
    signal: ctx.signal,
    onEvent: (e) => {
      if (e.kind === 'init') {
        ctx.log(`Claude Code started${e.model ? ` (${e.model})` : ''}`, 'status');
        if (e.failedMcpServers.length) ctx.log(`Couldn't start: ${e.failedMcpServers.join(', ')}`, 'stderr');
      } else if (e.kind === 'text') {
        ctx.log(e.text, 'stdout');
      } else if (e.kind === 'tool') {
        turns++;
        ctx.log(`→ ${toolLabel(e.name)}`, 'status');
        ctx.progress({ phase: 'working', current: turns, total: 0, message: `Using ${toolLabel(e.name)}…` });
      }
    },
  });
  if (result.permissionDenials.length) ctx.log(`Not allowed in this job: ${[...new Set(result.permissionDenials)].join(', ')}`, 'status');
  return result;
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
        appendSystemPrompt: ASK_SYSTEM_PROMPT,
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
  if (p.email?.trim()) args.push('--email', p.email.trim());
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

export function claudeJobs(deps: ClaudeJobDeps): JobDefinition<any, any>[] {
  return [claudeAskJob(deps), claudeSourcingReviewJob(deps), claudeTrackTagsJob(deps), claudeSoundcloudJob(deps)];
}
