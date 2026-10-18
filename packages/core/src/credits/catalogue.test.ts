import { describe, expect, it } from 'vitest';
import { ACTIONS, CREDIT_COSTS, MONTHLY_ALLOWANCE } from './catalogue';

describe('credit catalogue', () => {
  it('uses the starting action prices from the build plan', () => {
    expect(CREDIT_COSTS).toEqual({
      FIT_REVIEW: 1,
      TAILOR_CV: 3,
      ANSWER_DRAFT: 1,
      OUTREACH_DRAFT: 1,
      PRACTICE_SESSION: 3,
      POST_DRAFT: 1,
      CONTACT_REVEAL: 5,
    });
    expect(
      Object.fromEntries(
        Object.entries(ACTIONS).map(([key, value]) => [key, value.cost]),
      ),
    ).toEqual({
      fit_review: 1,
      tailor_cv: 3,
      answer_draft: 1,
      contact_reveal: 5,
      outreach_draft: 1,
      practice_session: 3,
      post_draft: 1,
    });
  });

  it('grants 30 free credits each month', () => {
    expect(MONTHLY_ALLOWANCE).toBe(30);
  });
});
