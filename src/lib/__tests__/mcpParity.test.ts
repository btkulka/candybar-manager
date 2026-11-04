// Everything the app can do, Claude can do over MCP: every IPC action in
// main.ts is mapped in mcpParity.ts to MCP tools that exist, or marked
// window-only / internal with a reason.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PARITY, parityTools, windowOnlyReason } from '../mcpParity';

const SRC = path.join(__dirname, '..', '..');
const main = fs.readFileSync(path.join(SRC, 'main.ts'), 'utf8');
const mcp = fs.readFileSync(path.join(SRC, 'mcp-server.ts'), 'utf8');

const channels = [...main.matchAll(/handleIpc\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
const tools = new Set([...mcp.matchAll(/^tool\(\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]));

describe('MCP parity', () => {
  it('finds the actions and tools to compare', () => {
    expect(channels.length).toBeGreaterThan(100);
    expect(tools.size).toBeGreaterThan(40);
  });

  it('registers every handler through handleIpc (logged, and reachable over MCP)', () => {
    expect(main).not.toMatch(/ipcMain\.handle\(/);
  });

  it('maps every IPC action', () => {
    expect(channels.filter((c) => !(c in PARITY))).toEqual([]);
  });

  it('lists no action that no longer exists', () => {
    expect(Object.keys(PARITY).filter((c) => !channels.includes(c))).toEqual([]);
  });

  it('names only tools the MCP server has', () => {
    expect([...parityTools()].filter((t) => !tools.has(t))).toEqual([]);
  });

  it('gives a reason for every action without a tool', () => {
    for (const [channel, entry] of Object.entries(PARITY)) {
      if (typeof entry === 'string') expect(entry, channel).toMatch(/^(window-only|internal): \S/);
      else expect(entry.length, channel).toBeGreaterThan(0);
    }
  });

  it('refuses window-only actions over the socket and allows the rest', () => {
    expect(windowOnlyReason('select-path')).toMatch(/picker/);
    expect(windowOnlyReason('store-panel-place-order')).toMatch(/Ben's clicks/);
    expect(windowOnlyReason('organize-tracks')).toBeNull();
    expect(windowOnlyReason('update-health-result')).toBeNull(); // internal, harmless
  });
});
