import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { safeMove } from '../fileUtils';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'safemove-')); });
afterEach(async () => { if (tmp) await fs.rm(tmp, { recursive: true, force: true }); });

describe('safeMove', () => {
  it('moves a file to a free destination', async () => {
    const src = path.join(tmp, 'a.aif');
    const dest = path.join(tmp, 'b.aif');
    await fs.writeFile(src, 'x');
    await safeMove(src, dest);
    await expect(fs.access(src)).rejects.toThrow();
    expect(await fs.readFile(dest, 'utf8')).toBe('x');
  });

  it('refuses to overwrite a DIFFERENT existing destination', async () => {
    const src = path.join(tmp, 'a.aif');
    const dest = path.join(tmp, 'b.aif');
    await fs.writeFile(src, 'source');
    await fs.writeFile(dest, 'existing');
    await expect(safeMove(src, dest)).rejects.toMatchObject({ code: 'EEXIST' });
    // Both files remain untouched — no silent clobber.
    expect(await fs.readFile(src, 'utf8')).toBe('source');
    expect(await fs.readFile(dest, 'utf8')).toBe('existing');
  });

  it('overwrites when overwrite:true is explicitly passed', async () => {
    const src = path.join(tmp, 'a.aif');
    const dest = path.join(tmp, 'b.aif');
    await fs.writeFile(src, 'source');
    await fs.writeFile(dest, 'existing');
    await safeMove(src, dest, 'test', { overwrite: true });
    expect(await fs.readFile(dest, 'utf8')).toBe('source');
  });

  it('treats source-missing + destination-present as an already-moved no-op', async () => {
    const src = path.join(tmp, 'gone.aif');
    const dest = path.join(tmp, 'here.aif');
    await fs.writeFile(dest, 'x');
    await expect(safeMove(src, dest)).resolves.toBeUndefined();
    expect(await fs.readFile(dest, 'utf8')).toBe('x');
  });
});
