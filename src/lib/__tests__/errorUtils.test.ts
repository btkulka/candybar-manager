import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../errorUtils';

describe('getErrorMessage', () => {
  it('returns the message from an Error instance', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns fallback when given a non-Error value', () => {
    expect(getErrorMessage('not an error', 'fallback')).toBe('fallback');
    expect(getErrorMessage(null, 'fallback')).toBe('fallback');
    expect(getErrorMessage(42, 'fallback')).toBe('fallback');
  });

  it('returns fallback when given undefined', () => {
    expect(getErrorMessage(undefined, 'unknown error')).toBe('unknown error');
  });

  it('uses default fallback when none provided', () => {
    const result = getErrorMessage('not an error');
    expect(typeof result).toBe('string');
  });
});
