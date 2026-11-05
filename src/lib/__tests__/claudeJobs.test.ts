import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { soundcloudArgs, trackLabSkills, upgradeReviewSummary } from '../jobQueue/jobs/claude';
import { summarizeSoundcloudSession, buildSourcingReviewPrompt, buildTrackTagsPrompt, TRACK_TAGS_SCHEMA, TAG_FIELDS, buildUpgradeReviewPrompt, buildSkillSourcingReviewPrompt, UPGRADE_REVIEW_SCHEMA, SOURCING_REVIEW_SCHEMA } from '../claude/prompts';
import type { SourcingReviewRow, UpgradeReviewRow } from '../../types';

describe('soundcloudArgs', () => {
  it('keeps account actions off unless asked', () => {
    expect(soundcloudArgs({})).toEqual(['--no-email', '--sc-actions', 'none']);
    expect(soundcloudArgs({ accountActions: true })).toEqual(['--no-email', '--sc-actions', 'follow,like,comment']);
  });

  it('holds the saved email back when the form\'s email was cleared', () => {
    expect(soundcloudArgs({ email: '   ' })).toContain('--no-email');
    expect(soundcloudArgs({ email: 'x@y.z' })).not.toContain('--no-email');
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

describe("Track Lab's skills for a job", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tl-skills-'));

  it('finds the bundled plugin and writes a node that runs on Track Lab itself', () => {
    const appRoot = tmp();
    const runtimeDir = tmp();
    fs.mkdirSync(path.join(appRoot, 'claude-plugin', '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'claude-plugin', '.claude-plugin', 'plugin.json'), '{"name":"track-lab"}');
    const s = trackLabSkills({ appRoot, runtimeDir }, "/Applications/Track Lab.app/Contents/MacOS/Track Lab");
    expect(s).toEqual({ pluginDirs: [path.join(appRoot, 'claude-plugin')], env: { TRACK_LAB_ROOT: appRoot }, fallbackPathDirs: [path.join(runtimeDir, 'bin')] });
    const shim = fs.readFileSync(path.join(runtimeDir, 'bin', 'node'), 'utf8');
    expect(shim).toContain(`ELECTRON_RUN_AS_NODE=1 exec '/Applications/Track Lab.app/Contents/MacOS/Track Lab' "$@"`);
    expect(fs.statSync(path.join(runtimeDir, 'bin', 'node')).mode & 0o111).toBeTruthy();
  });

  it('is off for a build without the plugin', () => {
    expect(trackLabSkills({ appRoot: tmp() })).toBeNull();
  });
});

describe('the upgrade review', () => {
  const row: UpgradeReviewRow = {
    rbId: '42', artist: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)', duration: 197, formatLabel: 'MP3 320',
    free: { soundcloud: null, bandcamp: null, nearMisses: [] }, store: null,
  };

  it('sends Claude to the skill and its upgrade rules, with the rows', () => {
    const p = buildUpgradeReviewPrompt([row]);
    expect(p).toMatch(/playlist-sourcing skill/);
    expect(p).toMatch(/references\/upgrades\.md/);
    expect(p).toMatch(/find_free_sources/);
    expect(p).toContain('"rbId": "42"');
    expect(UPGRADE_REVIEW_SCHEMA.properties.verdicts.items.properties.verdict.enum).toEqual(['free', 'store', 'none', 'keep']);
  });

  it("sums up what Claude found across its sessions", () => {
    expect(upgradeReviewSummary([
      { rbId: '1', verdict: 'free', note: '', freeUrl: 'x' }, { rbId: '2', verdict: 'store', note: '', ref: 'bp:1' },
      { rbId: '3', verdict: 'none', note: '' }, { rbId: '4', verdict: 'keep', note: '' },
    ], 5, 'a session ran out of time')).toBe('Claude says: 1 free, 1 from a store, 1 with no full-quality copy of that cut, 1 as the check had it. 1 not checked (a session ran out of time).');
  });

  it('lets the Find & buy review name the right record, when it can search', () => {
    expect(SOURCING_REVIEW_SCHEMA.properties.verdicts.items.properties).toHaveProperty('ref');
    expect(buildSkillSourcingReviewPrompt([], true)).toMatch(/search_store_catalog/);
    expect(buildSkillSourcingReviewPrompt([], false)).not.toMatch(/search_store_catalog \(Beatport/);
  });
});
