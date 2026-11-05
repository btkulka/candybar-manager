// Locks the gate registry and the Influence Planner reader. The page snippet
// is trimmed from what gate.influenceplanner.com/3IlngjlG served on
// 2026-11-04: the gate's config rides in the Next.js payload, quotes escaped.

import { describe, it, expect } from 'vitest';
import { WALKERS, walkerFor } from '../gates/index.mjs';
import { walkGeneric } from '../gates/generic.mjs';
import {
  parseInfluencePlannerGate, summarizeInfluencePlannerGate, inspectInfluencePlanner, inspectGate, GATE_INSPECTORS,
  parseDroploudGate, summarizeDroploudGate, parseHypedditSteps, summarizeHypedditSteps,
} from '../gates/inspect.mjs';
import { WALKED_GATE_HOSTS, GATE_HOSTS } from '../soundcloud.mjs';

const IP_PAGE = '<title>John Summit &amp; Sub Focus - Go Back (Shizz Lo Flip)</title>'
  + '<form><input id="input-superfan-email" type="email"/><button type="submit" data-disabled="" disabled="">Connect with SoundCloud</button></form>'
  + '<script>self.__next_f.push([1,"11:[\\"$\\",\\"$L18\\",null,{\\"gate\\":{\\"id\\":1009,\\"ownerUserId\\":\\"4158\\",\\"ownerPermalink\\":\\"shizzlomusic\\",'
  + '\\"trackUrn\\":\\"soundcloud:tracks:1862016720\\",\\"trackArtists\\":\\"John Summit \\u0026 Sub Focus\\",\\"trackTitle\\":\\"Go Back (Shizz Lo Flip)\\",'
  + '\\"trackFilename\\":\\"3IlngjlG.wav\\",\\"gateURL\\":\\"3IlngjlG\\",\\"active\\":true,\\"superfanRequired\\":true,\\"emailRequired\\":true,'
  + '\\"commentRequired\\":true,\\"additionalAccounts\\":null,\\"downloads\\":2,\\"deletedAt\\":null}}]\\n"])</script>';

describe('Influence Planner pages', () => {
  it("reads the gate's config out of the page payload", () => {
    const gate = parseInfluencePlannerGate(IP_PAGE);
    expect(gate).toMatchObject({ id: 1009, trackFilename: '3IlngjlG.wav', trackArtists: 'John Summit & Sub Focus', emailRequired: true });
    expect(parseInfluencePlannerGate('<html>nothing here</html>')).toBeNull();
  });

  it('says what the gate gives and asks for', () => {
    expect(summarizeInfluencePlannerGate(parseInfluencePlannerGate(IP_PAGE))).toEqual({
      host: 'influenceplanner.com', active: true, format: 'WAV', lossless: true,
      needs: ['email', 'soundcloud-connect', 'comment'], optional: [], scTrackId: '1862016720',
      artists: 'John Summit & Sub Focus', title: 'Go Back (Shizz Lo Flip)',
    });
    const mp3 = summarizeInfluencePlannerGate({ trackFilename: 'x.mp3', active: true, deletedAt: null });
    expect(mp3).toMatchObject({ format: 'MP3', lossless: false, needs: [] });
    expect(summarizeInfluencePlannerGate({ trackFilename: 'x.wav', active: true, deletedAt: 1 }).active).toBe(false);
  });

  it('reads a gate over HTTP, following the short link', async () => {
    let asked = null;
    const fetchImpl = async (url, init) => { asked = { url, redirect: init.redirect }; return { ok: true, text: async () => IP_PAGE }; };
    expect(await inspectInfluencePlanner('https://ipln.io/3IlngjlG', { fetchImpl })).toMatchObject({ format: 'WAV' });
    expect(asked).toEqual({ url: 'https://ipln.io/3IlngjlG', redirect: 'follow' });
    await expect(inspectInfluencePlanner('https://ipln.io/x', { fetchImpl: async () => ({ ok: false, status: 404 }) })).rejects.toThrow(/404/);
  });

  it('only inspects hosts that have an inspector', async () => {
    expect(Object.keys(GATE_INSPECTORS).sort()).toEqual(['droploud.com', 'hypeddit.com', 'influenceplanner.com', 'ipln.io']);
    expect(await inspectGate({ host: 'toneden.io', url: 'https://toneden.io/x' })).toBeNull();
    expect(await inspectGate({ host: null, url: 'https://example.com' })).toBeNull();
  });
});

describe('the walker registry', () => {
  it('walks Influence Planner links with their own walker, short link or not', () => {
    expect(walkerFor('https://gate.influenceplanner.com/3IlngjlG').name).toBe('walkInfluencePlanner');
    expect(walkerFor('https://ipln.io/3IlngjlG').name).toBe('walkInfluencePlanner');
    expect(walkerFor('https://pumpyoursound.com/f/pys/x')).toBe(walkGeneric);
  });

  it('keeps the classifier\'s list of walked hosts in step with the walkers', () => {
    for (const host of WALKED_GATE_HOSTS) {
      expect(WALKERS[host], host).toBeDefined();
      expect(GATE_HOSTS, host).toContain(host);
    }
  });
});

// Trimmed from droploud.com/track/b604d493… (2026-11-04): "gateData" in the
// Next.js payload, quotes escaped once.
const DROPLOUD_PAGE = '<title>DISPARATE YOUTH (Trance Remix) by JOR | Free Download | Droploud</title><script>self.__next_f.push([1,"'
  + JSON.stringify(JSON.stringify({ gateData: {
    track: { id: 'b604d493', title: 'DISPARATE YOUTH (Trance Remix)', soundcloud_url: 'https://soundcloud.com/jor_musicc/disparate-youth' },
    artist: { display_name: 'JOR', username: 'jor_music' },
    steps: [
      { id: 'email', type: 'email' }, { id: 'instagram', type: 'instagram_follow', url: 'https://instagram.com/jor_music' },
      { id: 'sc_follow', type: 'soundcloud_follow' }, { id: 'sc_like', type: 'soundcloud_like' }, { id: 'sc_repost', type: 'soundcloud_repost' },
      { id: 'sc_comment', type: 'soundcloud_comment' }, { id: 'spotify', type: 'spotify_follow' }, { id: 'droploud_follow', type: 'droploud_follow' },
    ],
    fan_prefill: null, advertise_droploud_follow: true, sc_optional: false,
  } })).slice(1, -1) + '"])</script>';

describe('Droploud pages', () => {
  it('reads the steps out of the page payload, and tells required from skippable', () => {
    const data = parseDroploudGate(DROPLOUD_PAGE);
    expect(data.steps).toHaveLength(8);
    expect(summarizeDroploudGate(data)).toMatchObject({
      host: 'droploud.com',
      needs: ['email', 'instagram', 'soundcloud-connect', 'comment'],
      optional: ['spotify', 'droploud-follow'],
      scTrackUrl: 'https://soundcloud.com/jor_musicc/disparate-youth',
    });
    expect(parseDroploudGate('<html></html>')).toBeNull();
  });
});

describe('Hypeddit pages', () => {
  it('reads the step groups, leaving out the download itself', () => {
    expect(parseHypedditSteps(`<input type="hidden" name="steps_select" id="steps_select" value='dw,sc,sp,ig'>`)).toEqual([['sc'], ['sp'], ['ig']]);
    expect(summarizeHypedditSteps([['sc'], ['sp'], ['ig']])).toMatchObject({ needs: ['soundcloud-support', 'spotify-connect', 'instagram'], optional: [] });
    expect(parseHypedditSteps('<a class="smartlink-click-button">Download</a>')).toBeNull();
  });

  it('counts a step with alternatives as a choice, not a must', () => {
    expect(summarizeHypedditSteps(parseHypedditSteps(`<input id="steps_select" value='dw,sc|sp,email'>`)))
      .toMatchObject({ needs: ['email'], optional: ['soundcloud-support', 'spotify-connect'] });
  });
});

describe('Droploud verify steps', () => {
  it('maps each step card heading to the account action it wants', async () => {
    const { VERIFY_STEPS } = await import('../gates/droploud.mjs');
    const stepFor = h => VERIFY_STEPS.find(s => s.re.test(h))?.step ?? null;
    expect(stepFor('Repost the track')).toBe('repost');
    expect(stepFor('Like the track')).toBe('like');
    expect(stepFor('Comment on the track')).toBe('comment');
    expect(stepFor('Follow benii')).toBe('follow');
    expect(stepFor('Connect SoundCloud')).toBeNull();
    expect(stepFor('Download unlocked')).toBeNull();
  });
});
