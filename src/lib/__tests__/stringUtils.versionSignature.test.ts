import { describe, it, expect } from 'vitest';
import {
  normalizeTitleKeepVersion,
  titleVersionSignature,
  sameTitleVersion,
} from '../stringUtils';

describe('normalizeTitleKeepVersion', () => {
  it('preserves remix/edit/extended version words', () => {
    expect(normalizeTitleKeepVersion('Formula (Adam Beyer Remix)')).toBe('formula adam beyer remix');
    expect(normalizeTitleKeepVersion('Losing It (Extended Mix)')).toBe('losing it extended mix');
  });

  it('folds diacritics, case and punctuation but keeps version tokens', () => {
    expect(normalizeTitleKeepVersion('Piece Of Your Heart (Radio Edit)')).toBe('piece of your heart radio edit');
  });

  it('folds the generic "Original Mix/Version" label to the base title', () => {
    expect(normalizeTitleKeepVersion('Gravity (Original Mix)')).toBe('gravity');
    expect(normalizeTitleKeepVersion('Nova (Original Version)')).toBe('nova');
  });

  it('strips feat credits but keeps a trailing version tag', () => {
    expect(normalizeTitleKeepVersion('Ocean Drive (feat. Ebenezer)')).toBe('ocean drive');
    expect(normalizeTitleKeepVersion('Ocean Drive feat. Ebenezer')).toBe('ocean drive');
  });
});

describe('titleVersionSignature', () => {
  it('is empty for a bare title and its "(Original Mix)" (same version)', () => {
    expect(titleVersionSignature('Gravity')).toBe('');
    expect(titleVersionSignature('Gravity (Original Mix)')).toBe('');
  });

  it('is non-empty and order-independent for a real variant', () => {
    expect(titleVersionSignature('Losing It (Extended Mix)')).toBe('extended mix');
  });

  it('differs between a remix and the base track', () => {
    expect(titleVersionSignature('Formula (Adam Beyer Remix)')).not.toBe(titleVersionSignature('Formula'));
  });
});

describe('sameTitleVersion', () => {
  it('treats bare title, "(Original Mix)", and feat-labelled as the same version', () => {
    expect(sameTitleVersion('Gravity', 'Gravity (Original Mix)')).toBe(true);
    expect(sameTitleVersion('Ocean Drive', 'Ocean Drive (feat. Ebenezer)')).toBe(true);
  });

  it('treats different versions of the same song as different', () => {
    expect(sameTitleVersion('Formula (Adam Beyer Remix)', 'Formula')).toBe(false);
    expect(sameTitleVersion('Losing It (Extended Mix)', 'Losing It')).toBe(false);
    expect(sameTitleVersion('Piece Of Your Heart (Radio Edit)', 'Piece Of Your Heart (Extended Mix)')).toBe(false);
    expect(sameTitleVersion('Innerbloom - What So Not Remix', 'Innerbloom')).toBe(false);
  });

  it('treats the exact same version as the same', () => {
    expect(sameTitleVersion('Formula (Adam Beyer Remix)', 'Formula (Adam Beyer Remix)')).toBe(true);
  });
});
