import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { isArtistHeader, isTitleHeader, normalizeCsvHeader } from '../csvHeaders';
import { previewCsv } from '../musicLibraryCheck';

describe('csvHeaders', () => {
  it('normalizes to lowercase letters only', () => {
    expect(normalizeCsvHeader('Artist Name(s)')).toBe('artistnames');
    expect(normalizeCsvHeader(' Track Name ')).toBe('trackname');
  });

  it('accepts the plain and Exportify spellings', () => {
    for (const h of ['Artist', 'artists', 'Performer', 'Artist Name(s)', 'Album Artist']) expect(isArtistHeader(h)).toBe(true);
    for (const h of ['Title', 'Track', 'Name', 'Song', 'Track Name']) expect(isTitleHeader(h)).toBe(true);
    expect(isArtistHeader('Artist URI(s)')).toBe(false);
    expect(isTitleHeader('Track URI')).toBe(false);
  });

  it('previews an Exportify export as having artist and title columns', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csvh-'));
    const file = path.join(dir, 'exportify.csv');
    await fs.writeFile(file, [
      '"Track URI","Track Name","Album Name","Artist Name(s)","Release Date"',
      '"spotify:track:1","Your Mind","Your Mind","Adam Beyer, Bart Skils","2018-03-02"',
    ].join('\n'));
    try {
      const preview = await previewCsv(file);
      expect(preview.hasArtistColumn).toBe(true);
      expect(preview.hasTitleColumn).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
