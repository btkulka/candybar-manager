/**
 * The Claude Code plugin Track Lab ships (claude-plugin/) and loads into its
 * Claude jobs. It must stay portable: it runs from the app bundle on any Mac.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..', 'claude-plugin');
const SKILL = path.join(ROOT, 'skills', 'playlist-sourcing');
const docs = () => [path.join(SKILL, 'SKILL.md'), ...fs.readdirSync(path.join(SKILL, 'references')).map(f => path.join(SKILL, 'references', f))];

describe('the bundled plugin', () => {
  it('has a manifest Claude Code accepts', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.name).toBe('track-lab');
  });

  it('carries the playlist-sourcing skill with its upgrade rules', () => {
    const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: playlist-sourcing\ndescription: /);
    expect(skill).toMatch(/## When Track Lab runs you/);
    expect(fs.existsSync(path.join(SKILL, 'references', 'upgrades.md'))).toBe(true);
  });

  it("names no one's machine: no home folders, no checkout paths", () => {
    for (const f of docs()) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text, path.basename(f)).not.toMatch(/\/Users\/[a-z]/i);
      expect(text, path.basename(f)).not.toMatch(/~\/\.claude\/skills/);
      expect(text, path.basename(f)).not.toMatch(/\$REPO\b|\$SCRATCHPAD\b/);
    }
  });

  it('ships in the app, without its evals', () => {
    const builder = fs.readFileSync(path.join(ROOT, '..', 'electron-builder.yml'), 'utf8');
    expect(builder).toContain('- claude-plugin/**');
    expect(builder).toContain('"!claude-plugin/**/evals/**"');
  });
});
