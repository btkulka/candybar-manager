/**
 * Track Lab served as a web app (src/lib/webHost.ts): in a Benhäus tab or on
 * the phone, through electron-kit's web host, instead of in its own window.
 * The host sets window.__kitWeb before the preload runs.
 */

declare global {
  interface Window {
    __kitWeb?: { web: true; platform: string; port: number; app?: string; version?: string };
  }
}

export function isWebApp(): boolean {
  return Boolean(window.__kitWeb);
}

/** The web app on a phone: a small touch screen gets the sourcing page
 *  (mobile.html). `?desktop` keeps the whole app; `?phone` asks for the page. */
export function wantsPhonePage(): boolean {
  if (!isWebApp()) return false;
  const q = new URLSearchParams(location.search);
  if (q.has('desktop')) return false;
  return q.has('phone') || matchMedia('(max-width: 700px) and (pointer: coarse)').matches;
}
