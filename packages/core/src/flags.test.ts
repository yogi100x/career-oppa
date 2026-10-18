import { describe, expect, it } from 'vitest';
import { guardFeature, readFlags } from './flags';

describe('unfinished feature routes', () => {
  it('returns 404 when the feature is off', async () => {
    const response = guardFeature(readFlags({}), 'practice');
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'This feature is not available.' },
    });
  });

  it('allows an explicitly enabled feature', () => {
    expect(guardFeature(readFlags({ FEATURE_PRACTICE: 'true' }), 'practice')).toBeNull();
  });

  it('does not enable publishing using a truthy-looking value', () => {
    expect(guardFeature(readFlags({ FEATURE_PUBLISHING: 'false' }), 'publishing')?.status).toBe(404);
  });

  it('keeps discovery off unless explicitly enabled', () => {
    expect(guardFeature(readFlags({ FEATURE_DISCOVERY: 'yes' }), 'discovery')?.status).toBe(404);
    expect(guardFeature(readFlags({ FEATURE_DISCOVERY: 'true' }), 'discovery')).toBeNull();
  });
});
