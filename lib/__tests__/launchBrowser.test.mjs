// Shared-context leases: one window per profile, reused across calls.

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { acquireShared, closeSharedBrowsers, enableSharedBrowsers } from '../launchBrowser.mjs';

function fakeContext() {
  const ctx = new EventEmitter();
  const pages = [];
  const makePage = () => {
    const page = { closed: false, isClosed() { return this.closed; }, async close() { this.closed = true; pages.splice(pages.indexOf(this), 1); } };
    pages.push(page);
    return page;
  };
  makePage(); // a persistent context starts with one blank tab
  ctx.pages = () => [...pages];
  ctx.newPage = async () => makePage();
  ctx.closed = false;
  ctx.close = async () => { ctx.closed = true; ctx.emit('close'); };
  return ctx;
}

afterEach(async () => {
  await closeSharedBrowsers();
});

describe('acquireShared', () => {
  it('opens a profile once and hands every caller the same window', async () => {
    let opens = 0;
    const ctx = fakeContext();
    const open = async () => { opens++; return ctx; };

    const a = await acquireShared('qobuz', open);
    const pageA = a.pages()[0];
    await a.close();
    const b = await acquireShared('qobuz', open);

    expect(opens).toBe(1);
    expect(b.pages()[0]).toBe(pageA);
    expect(ctx.closed).toBe(false);
  });

  it('closes only the extra tabs a caller opened, never the last one', async () => {
    const ctx = fakeContext();
    const lease = await acquireShared('beatport', async () => ctx);
    await lease.newPage();
    expect(ctx.pages()).toHaveLength(2);
    await lease.close();
    expect(ctx.pages()).toHaveLength(1);
    expect(ctx.closed).toBe(false);
  });

  it('relaunches after the user closes the window', async () => {
    let opens = 0;
    const open = async () => { opens++; return fakeContext(); };
    const first = await acquireShared('soundcloud', open);
    await first.close();
    // The real context, not the lease, is what the user closes.
    first.emit('close');
    await acquireShared('soundcloud', open);
    expect(opens).toBe(2);
  });

  it('closes everything on closeSharedBrowsers', async () => {
    const ctx = fakeContext();
    await acquireShared('splice', async () => ctx);
    await closeSharedBrowsers();
    expect(ctx.closed).toBe(true);
  });

  it('closes an idle window after the idle timeout', async () => {
    enableSharedBrowsers({ idleMs: 20 });
    const ctx = fakeContext();
    const lease = await acquireShared('qobuz-idle', async () => ctx);
    await lease.close();
    await new Promise(r => setTimeout(r, 60));
    expect(ctx.closed).toBe(true);
  });
});
