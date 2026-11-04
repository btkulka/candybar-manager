// ============================================================
// Every IPC handler, registered once, for two callers:
//   - the window (ipcMain.handle), each call recorded as an
//     operation in the operations log (opLog.ts);
//   - Claude's MCP tools and scripts, through the app's socket
//     (storeBridge.ts → `invoke`), running the very same handler
//     with a stand-in sender whose messages become progress.
// ============================================================

import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { withOp, currentOp, type OpSource } from './opLog';

// Handlers take typed arguments; the registry doesn't care which.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;

export type InvokeContext = {
  /** Receives everything the handler sends the "window". */
  send: (channel: string, payload: unknown) => void;
  source: OpSource;
  parent?: string;
  meta?: Record<string, unknown>;
};

export function createIpcRegistry(
  ipc: { handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void },
  opts: { quiet?: ReadonlySet<string> } = {}
) {
  const handlers = new Map<string, IpcHandler>();
  const quiet = opts.quiet ?? new Set<string>();

  /** ipcMain.handle, recorded. */
  function handle(channel: string, fn: IpcHandler): void {
    if (handlers.has(channel)) throw new Error(`IPC channel registered twice: ${channel}`);
    handlers.set(channel, fn);
    ipc.handle(channel, (event, ...args) =>
      withOp(channel, { source: 'ui', args: args.length ? (args.length === 1 ? args[0] : args) : undefined }, () => fn(event, ...args), {
        quiet: quiet.has(channel),
      })
    );
  }

  /** Run a handler for someone outside the window. */
  function invoke(channel: string, args: unknown[], ctx: InvokeContext): Promise<unknown> {
    const fn = handlers.get(channel);
    if (!fn) return Promise.reject(new Error(`Track Lab has no action "${channel}"`));
    const sender = {
      id: -1,
      isDestroyed: () => false,
      send: (ch: string, payload: unknown) => ctx.send(ch, payload),
    } as unknown as WebContents;
    const event = { sender, processId: -1, frameId: -1 } as unknown as IpcMainInvokeEvent;
    return withOp(
      channel,
      { source: ctx.source, args: args.length ? (args.length === 1 ? args[0] : args) : undefined, parent: ctx.parent ?? currentOp()?.id, meta: ctx.meta },
      () => fn(event, ...args)
    );
  }

  return {
    handle,
    invoke,
    has: (channel: string) => handlers.has(channel),
    channels: () => [...handlers.keys()],
  };
}
