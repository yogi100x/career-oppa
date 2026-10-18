/** Starting credit prices from the build plan's pricing table. */
export const CREDIT_COSTS = {
  FIT_REVIEW: 1,
  TAILOR_CV: 3,
  ANSWER_DRAFT: 1,
  OUTREACH_DRAFT: 1,
  PRACTICE_SESSION: 3,
  POST_DRAFT: 1,
  CONTACT_REVEAL: 5,
} as const;

export const ACTIONS = {
  fit_review: { cost: CREDIT_COSTS.FIT_REVIEW },
  tailor_cv: { cost: CREDIT_COSTS.TAILOR_CV },
  answer_draft: { cost: CREDIT_COSTS.ANSWER_DRAFT },
  contact_reveal: { cost: CREDIT_COSTS.CONTACT_REVEAL },
  outreach_draft: { cost: CREDIT_COSTS.OUTREACH_DRAFT },
  practice_session: { cost: CREDIT_COSTS.PRACTICE_SESSION },
  post_draft: { cost: CREDIT_COSTS.POST_DRAFT },
} as const;

export type CreditAction = keyof typeof ACTIONS;

export const MONTHLY_ALLOWANCE = 30;
