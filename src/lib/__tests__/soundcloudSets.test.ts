import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));

import { setFreeDownload } from '../soundcloudSets';
import type { SetRow } from '../soundcloudSession';

const row = (free: SetRow['free'], over: Partial<SetRow> = {}): SetRow => ({
  scId: 1, artist: 'A', title: 'T', duration: 300, url: 'https://soundcloud.com/a/t',
  scTitle: 'A - T [FREE DL]', uploader: 'a', free, ...over,
});

describe('setFreeDownload', () => {
  it('describes the download button and gates', () => {
    expect(setFreeDownload(row({ kind: 'native', gate: null, reason: 'SoundCloud download button' }))).toEqual({
      kind: 'native', url: 'https://soundcloud.com/a/t', listedAs: 'A - T [FREE DL]', uploader: 'a',
      gateHost: null, reason: 'SoundCloud download button',
    });
    expect(setFreeDownload(row({ kind: 'gate', gate: { host: 'hypeddit.com', url: 'https://hypeddit.com/x' }, reason: '' }))?.reason)
      .toBe('Free download via hypeddit.com');
    expect(setFreeDownload(row({ kind: 'gate', gate: { host: null, url: 'https://odd.example/x' }, reason: 'unknown host odd.example' }))?.reason)
      .toBe('Free download link (unknown host odd.example)');
  });

  it('is null for a track with nothing free, or no page to fetch from', () => {
    expect(setFreeDownload(row({ kind: 'none', gate: null, reason: 'no download offered' }))).toBeNull();
    expect(setFreeDownload(row(undefined))).toBeNull();
    expect(setFreeDownload(row({ kind: 'native', gate: null, reason: '' }, { url: null }))).toBeNull();
  });
});
