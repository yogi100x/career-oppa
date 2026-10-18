import { describe, expect, it } from 'vitest';
import { shouldReviewSavedCv } from './home-dashboard-state';

describe('home CV review prompt', () => {
  it('does not interrupt a user with approved facts from any source', () => {
    expect(
      shouldReviewSavedCv(
        { file: { id: 'latest-failed-cv' }, state: 'failed' },
        true,
        false,
      ),
    ).toBe(false);
  });

  it('opens review when a saved CV is the only starting point', () => {
    expect(
      shouldReviewSavedCv(
        { file: { id: 'cv' }, state: 'ready' },
        false,
        false,
      ),
    ).toBe(true);
  });

  it('leaves a saved target role on the dashboard when a CV failed', () => {
    expect(
      shouldReviewSavedCv(
        { file: { id: 'cv' }, state: 'failed' },
        false,
        true,
      ),
    ).toBe(false);
  });
});
