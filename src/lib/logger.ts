import fs from 'fs';
import path from 'path';
import { format } from 'util';
import log from 'electron-log/main';
import type { LogMessage } from 'electron-log';
import { currentOp } from './opLog';

// Console by default; the app and the MCP server each add a file (enableFileLog).
log.transports.file.level = false;

// Configure console transport
log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {scope} {text}';
log.transports.console.level = 'debug';

// Every line logged while an operation runs also goes into that operation's
// record in the operations log (opLog.ts), so its timeline has the detail.
const opTransport = Object.assign(
  (message: LogMessage) => {
    const op = currentOp();
    if (op) op.log(message.level, message.scope, format(...message.data));
  },
  { level: 'debug' as const, transforms: [] }
);
log.transports.op = opTransport;

// In the file, tag each line with the operation it belongs to, to find its
// whole story in logs/ops.
log.hooks.push((message, _transport, transportName) => {
  if (transportName !== 'file') return message;
  const op = currentOp();
  return op ? { ...message, data: [`[${op.id}]`, ...message.data] } : message;
});

const KEEP_ARCHIVES = 5;

/**
 * Also write the log to <logsDir>/<name>.log, debug and up. At 10 MB it's
 * archived as <name>-<timestamp>.log and the last five archives are kept.
 * Returns the file's path.
 */
export function enableFileLog(logsDir: string, name: string): string {
  const file = path.join(logsDir, `${name}.log`);
  const t = log.transports.file;
  t.resolvePathFn = () => file;
  t.level = 'debug';
  t.maxSize = 10 * 1024 * 1024;
  t.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope} {text}';
  t.archiveLogFn = (old) => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(old.path, path.join(logsDir, `${name}-${stamp}.log`));
      const archives = fs.readdirSync(logsDir).filter((n) => n.startsWith(`${name}-`) && n.endsWith('.log')).sort();
      for (const n of archives.slice(0, Math.max(0, archives.length - KEEP_ARCHIVES))) fs.rmSync(path.join(logsDir, n), { force: true });
    } catch {
      // Keep logging to the full file rather than lose lines.
    }
  };
  return file;
}

/** Print to stderr instead of stdout. An MCP stdio server's stdout carries
 *  only the protocol; a stray log line there corrupts it. */
export function consoleToStderr(): void {
  // The console format (time, level, scope) is already applied to data here.
  log.transports.console.writeFn = ({ message }) => {
    process.stderr.write(`${format(...message.data)}\n`);
  };
}

export default log;

/**
 * Create a scoped logger for a specific module.
 * Usage: const log = createScopedLogger('Config');
 */
export function createScopedLogger(scope: string) {
  return log.scope(scope);
}
