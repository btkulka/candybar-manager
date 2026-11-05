// Locks the gate registry and the Influence Planner reader. The page snippet
// is trimmed from what gate.influenceplanner.com/3IlngjlG served on
// 2026-11-04: the gate's config rides in the Next.js payload, quotes escaped.

import { describe, it, expect } from 'vitest';
import { WALKERS, walkerFor } from '../gates/index.mjs';
import { walkGeneric } from '../gates/generic.mjs';
import { parseInfluencePlannerGate, summarizeInfluencePlannerGate, inspectInfluencePlanner, inspectGate, GATE_INSPECTORS } from '../gates/inspect.mjs';
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
      needs: ['email', 'soundcloud-connect', 'comment'], scTrackId: '1862016720',
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
    expect(Object.keys(GATE_INSPECTORS).sort()).toEqual(['influenceplanner.com', 'ipln.io']);
    expect(await inspectGate({ host: 'hypeddit.com', url: 'https://hypeddit.com/x' })).toBeNull();
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
