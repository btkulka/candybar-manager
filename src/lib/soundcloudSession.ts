/**
 * The app's side of the one SoundCloud sign-in.
 *
 * The sign-in lives in the 'soundcloud' Chrome profile
 * (~/.cache/candybar-manager/playwright-profiles/soundcloud), the same one
 * bin/source-soundcloud-likes.mjs and the MCP tools open, so signing in from
 * any of them signs in all of them. Track Lab never stores the token: it opens
 * the profile and reads the session from the page (lib/sourcing/soundcloud.mjs),
 * and every read notes who's signed in, which is what the status shows.
 */

import { app } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import type { SoundCloudSignIn } from '../types';

/** A Playwright page; only lib/sourcing/soundcloud.mjs looks inside. */
type Page = unknown;

export type SoundCloudSession = {
  signedIn: boolean;
  clientId: string | null;
  token: string | null;
  meId: string | null;
  diagnostic?: string;
};

export type SetRow = {
  scId: number;
  artist: string;
  title: string;
  duration: number | null;
  url: string | null;
  /** The title as uploaded ("Artist - Title [FREE DL]"). */
  scTitle?: string;
  uploader?: string;
  /** Where its free file is, per lib/sourcing/soundcloud.mjs classifyFreeDownload. */
  free?: { kind: 'native' | 'gate' | 'none'; gate: { host: string | null; url: string } | null; reason: string };
};

export type SetSource = {
  set: string;
  user: string | null;
  url: string;
  trackCount: number;
  fetchedCount: number;
  unavailable: Array<{ scId: number }>;
  image: string | null;
};

type SetOpts = { onProgress?: (loaded: number, total: number) => void };

export type SoundCloudModule = {
  openSoundCloud: (opts?: { headless?: boolean }) => Promise<{ page: Page; close: () => Promise<void> }>;
  captureSession: (page: Page) => Promise<SoundCloudSession>;
  waitForSoundCloudLogin: (page: Page, opts?: { timeoutMs?: number }) => Promise<boolean>;
  readSessionStatus: () => SoundCloudSignIn | null;
  fetchSetPublic: (setUrl: string, opts?: SetOpts) => Promise<{ source: SetSource; tracks: SetRow[] }>;
  fetchSetViaSession: (page: Page, sess: SoundCloudSession, setUrl: string, opts?: SetOpts) => Promise<{ source: SetSource; tracks: SetRow[] }>;
};

let mod: Promise<SoundCloudModule> | null = null;

export function loadSoundCloudModule(): Promise<SoundCloudModule> {
  mod ??= import(pathToFileURL(path.join(app.getAppPath(), 'lib', 'sourcing', 'soundcloud.mjs')).href) as Promise<SoundCloudModule>;
  return mod;
}

const SIGN_IN_WAIT_MS = 5 * 60_000;

/** Who the saved sign-in belonged to at its last check by any run, or null
 *  when nothing has looked yet. Never opens Chrome. */
export async function readSoundCloudSignIn(): Promise<SoundCloudSignIn | null> {
  return (await loadSoundCloudModule()).readSessionStatus();
}

/**
 * Open the saved profile and run `fn` with its signed-in session. When it's
 * signed out, the window stays up for the user to sign in (`onWaiting` says
 * so) for up to five minutes.
 */
export async function withSoundCloudSession<T>(
  fn: (page: Page, sess: SoundCloudSession, sc: SoundCloudModule) => Promise<T>,
  opts: { onWaiting?: () => void } = {}
): Promise<T> {
  const sc = await loadSoundCloudModule();
  const browser = await sc.openSoundCloud({ headless: false });
  try {
    let sess = await sc.captureSession(browser.page);
    if (!sess.signedIn) {
      opts.onWaiting?.();
      if (await sc.waitForSoundCloudLogin(browser.page, { timeoutMs: SIGN_IN_WAIT_MS })) {
        sess = await sc.captureSession(browser.page);
      }
    }
    if (!sess.signedIn) throw new Error('SoundCloud isn\'t signed in, and the sign-in window closed or timed out.');
    return await fn(browser.page, sess, sc);
  } finally {
    await browser.close();
  }
}

/**
 * Check the saved sign-in, and sign in if it's signed out. The first look is
 * headless, so a profile that's already signed in never shows a window.
 */
export async function signInToSoundCloud(): Promise<SoundCloudSignIn> {
  const sc = await loadSoundCloudModule();
  const quiet = await sc.openSoundCloud({ headless: true });
  let signedIn = false;
  try {
    signedIn = (await sc.captureSession(quiet.page)).signedIn;
  } finally {
    await quiet.close();
  }
  if (!signedIn) {
    const browser = await sc.openSoundCloud({ headless: false });
    try {
      if (!(await sc.captureSession(browser.page)).signedIn
        && await sc.waitForSoundCloudLogin(browser.page, { timeoutMs: SIGN_IN_WAIT_MS })) {
        await sc.captureSession(browser.page);
      }
    } finally {
      await browser.close();
    }
  }
  return sc.readSessionStatus() ?? { signedIn: false, username: null, permalink: null, url: null, checkedAt: new Date().toISOString() };
}
