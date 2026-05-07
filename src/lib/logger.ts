import log from 'electron-log/main';

// Disable file transport — console only
log.transports.file.level = false;

// Configure console transport
log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {scope} {text}';
log.transports.console.level = 'debug';

export default log;

/**
 * Create a scoped logger for a specific module.
 * Usage: const log = createScopedLogger('Config');
 */
export function createScopedLogger(scope: string) {
  return log.scope(scope);
}
