// The ledger decides what a re-run skips. Anything ever fetched stays skipped,
// whatever has since happened to the file.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DownloadLedger } from '../downloads.mjs';

describe('DownloadLedger', () => {
  it('remembers a track after its file is gone, so a deleted track stays deleted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ledger-'));
    const file = path.join(dir, 'ledger.json');
    const led = new DownloadLedger(file);
    led.record(1, { files: [{ path: path.join(dir, 'deleted-by-ben.wav') }] });
    led.record(2, { files: [], dropped: [{ original: 'x.mp3', codec: 'mp3', ext: 'mp3' }] });
    expect(led.get(1)).not.toBeNull();
    expect(led.get(2)).toMatchObject({ dropped: [{ codec: 'mp3' }] });
    expect(led.get(3)).toBeNull();
    expect(new DownloadLedger(file).get(1)).not.toBeNull();
  });
});
