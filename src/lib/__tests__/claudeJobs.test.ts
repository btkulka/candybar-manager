import { describe, it, expect } from 'vitest';
import { soundcloudArgs } from '../jobQueue/jobs/claude';
import { summarizeSoundcloudSession, buildSourcingReviewPrompt, buildTrackTagsPrompt, TRACK_TAGS_SCHEMA, TAG_FIELDS } from '../claude/prompts';
import type { SourcingReviewRow } from '../../types';

describe('soundcloudArgs', () => {
  it('keeps account actions off unless asked', () => {
    expect(soundcloudArgs({})).toEqual(['--sc-actions', 'none']);
    expect(soundcloudArgs({ accountActions: true })).toEqual(['--sc-actions', 'follow,like,comment']);
  });

  it('maps the options to the downloader\'s flags', () => {
    expect(soundcloudArgs({
      setUrl: ' https://soundcloud.com/a/sets/b ', limit: 10.7, since: '2026-09-01', listOnly: true, dropLossy: true, email: 'x@y.z',
    })).toEqual([
      '--set', 'https://soundcloud.com/a/sets/b', '--limit', '10', '--since', '2026-09-01',
      '--list-only', '--drop-lossy', '--email', 'x@y.z', '--sc-actions', 'none',
    ]);
  });

  it('on a resume, passes only the session and the gate options', () => {
    expect(soundcloudArgs({ resumeSessionPath: '/s.json', setUrl: 'https://soundcloud.com/a/sets/b', limit: 5, email: 'x@y.z' }))
      .toEqual(['--resume', '/s.json', '--email', 'x@y.z', '--sc-actions', 'none']);
  });
});

describe('summarizeSoundcloudSession', () => {
  it('counts every bucket and details only the ones worth reading', () => {
    const session = {
      owned: [{}, {}],
      alreadyDownloaded: [{}],
      downloaded: [{
        artist: 'A', title: 'T', free: { kind: 'gate', gate: { host: 'hypeddit.com', url: 'https://hypeddit.com/x' } },
        outcome: { status: 'downloaded', files: [{ path: '/in/A - T.wav', ext: 'wav', codec: 'pcm_s24le', lossless: true }] },
      }],
      flagged: [{
        artist: 'B', title: 'U', libraryStatus: 'probable', libraryConfidence: 0.8, libraryMatch: { artist: 'B', title: 'U (Edit)' },
        outcome: { status: 'needs-email', reason: 'gate wants an email' },
      }],
      notFree: [{ artist: 'C', title: 'V', free: { kind: 'none', reason: 'Bandcamp sells it' }, outcome: { status: 'not-free' } }],
    };
    const { counts, rows } = summarizeSoundcloudSession(session);
    expect(counts).toEqual({ downloaded: 1, flagged: 1, notFree: 1, owned: 2, alreadyDownloaded: 1 });
    expect(rows.map(r => r.bucket)).toEqual(['downloaded', 'flagged', 'notFree']);
    expect(rows[0]).toMatchObject({ gate: 'hypeddit.com', files: ['A - T.wav (lossless)'] });
    expect(rows[1]).toMatchObject({ status: 'needs-email', reason: 'gate wants an email', maybeOwned: { confidence: 0.8 } });
    expect(rows[2].reason).toBe('Bandcamp sells it');
  });
});

describe('prompts', () => {
  it('puts every review row in the prompt', () => {
    const rows: SourcingReviewRow[] = [{
      id: 'r1', wanted: { artist: 'Vaultage', title: 'Vaultage 003' },
      store: { source: 'beatport', artists: ['Vaultage'], title: 'Vaultage 004', confidence: 0.97, versionFlag: false, releaseLevel: false },
    }];
    const prompt = buildSourcingReviewPrompt(rows);
    expect(prompt).toContain('"id": "r1"');
    expect(prompt).toContain('Vaultage 004');
  });

  it('asks for every tag field and requires all of them in the schema', () => {
    const prompt = buildTrackTagsPrompt({
      filePath: '/m/A - T.aiff',
      tags: { title: 'T', artist: 'A', remixer: '', album: '', genre: '', year: '', bpm: '', key: 'Am', label: '', comment: '' },
    });
    expect(prompt).toContain('A - T.aiff');
    expect(prompt).toContain('"key":"Am"');
    expect(TRACK_TAGS_SCHEMA.properties.fields.required).toEqual(TAG_FIELDS);
  });
});
