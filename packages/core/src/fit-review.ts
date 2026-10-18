import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  fitReviewSchema,
  type FitReviewRequirement,
} from '@career-workspace/contracts';
import {
  fitReviews,
  creditHolds,
  profileFacts,
  opportunities,
  users,
  getDatabase,
  type Database,
  type Transaction,
} from '@career-workspace/db';
import {
  generateStructured,
  fitReviewPrompt,
} from '@career-workspace/adapters/ai';
import { ApiError } from './api';
import { CreditError, withCredits } from './credits';
import { getOpportunity } from './roles';
import { checkGrounding } from './grounding';
import { recordEvent } from './events';
import {
  calculateFitScore,
  conditionKind,
  hasRequirementEvidenceOverlap,
  isVerifiedGap,
} from './fit-score';
import { nextSteps } from './opportunity-status';

export const FIRST_FIT_REVIEW_FREE_ENABLED = true;

export async function getFitReviewEligibility(
  userId: string,
  database: Database = getDatabase(),
) {
  if (!FIRST_FIT_REVIEW_FREE_ENABLED) return { firstReviewFree: false };
  const [existing] = await database
    .select({ used: users.firstFitReviewUsed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!existing || existing.used) return { firstReviewFree: false };
  const [previous] = await database
    .select({ id: fitReviews.id })
    .from(fitReviews)
    .where(eq(fitReviews.userId, userId))
    .limit(1);
  return { firstReviewFree: !previous };
}

const normalise = (value: string) =>
  value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Turns per-requirement rows into the stored strengths, gaps and unknowns.
 * Code, not the model, decides the buckets: a requirement whose quote is not
 * in the job text is dropped; an essential requirement no approved fact meets
 * remains unknown unless explicitly classified as a gap; conditions stay visible;
 * at most five unknowns, essential only.
 */
export function deriveFitReview(
  requirements: FitReviewRequirement[],
  jobText: string,
  grounded: boolean[],
  evidenceAvailable: boolean,
) {
  const job = normalise(jobText);
  const strengths: { text: string; fact_ids: string[] }[] = [];
  const essentialGaps: string[] = [];
  const otherGaps: string[] = [];
  const unknowns: string[] = [];
  let dropped = 0;
  requirements.forEach((requirement, index) => {
    const quote = normalise(requirement.job_quote);
    if (quote.length < 3 || !job.includes(quote)) {
      dropped += 1;
      return;
    }
    const gap = `${requirement.text} — the job says “${requirement.job_quote.trim()}”`;
    const essential = requirement.importance === 'essential';
    const condition = conditionKind(requirement.job_quote);
    if (requirement.status === 'met' && grounded[index])
      strengths.push({
        text: requirement.text,
        fact_ids: requirement.fact_ids,
      });
    else if (
      condition &&
      (requirement.status === 'constraint' || requirement.status === 'gap')
    )
      (essential ? essentialGaps : otherGaps).push(gap);
    else if (requirement.status === 'constraint')
      unknowns.push(`Unverified gap: ${requirement.text}`);
    else if (essential) {
      if (isVerifiedGap(requirement, evidenceAvailable))
        essentialGaps.push(gap);
      else if (requirement.status === 'gap')
        unknowns.push(`Unverified gap: ${requirement.text}`);
      else unknowns.push(requirement.text);
    } else if (requirement.status === 'gap') {
      if (isVerifiedGap(requirement, evidenceAvailable)) otherGaps.push(gap);
      else unknowns.push(`Unverified gap: ${requirement.text}`);
    }
  });
  // A dropped row may be a real requirement the model paraphrased; say so
  // rather than let a short gap list read as all clear.
  if (dropped)
    unknowns.unshift(
      'Some requirements could not be matched to the job text; read the job description before relying on this review.',
    );
  return {
    strengths,
    gaps: [...essentialGaps, ...otherGaps],
    unknowns: unknowns.slice(0, 5),
    dropped,
  };
}

export async function getFitReviews(
  userId: string,
  opportunityId: string,
  database: Database = getDatabase(),
) {
  await getOpportunity(userId, opportunityId, database);
  const rows = await database
    .select()
    .from(fitReviews)
    .where(
      and(
        eq(fitReviews.userId, userId),
        eq(fitReviews.opportunityId, opportunityId),
      ),
    )
    .orderBy(desc(fitReviews.createdAt));
  const approvedFacts = await database
    .select({ id: profileFacts.id, updatedAt: profileFacts.updatedAt })
    .from(profileFacts)
    .where(
      and(eq(profileFacts.userId, userId), eq(profileFacts.status, 'approved')),
    );
  return Promise.all(
    rows.map(async (review) => {
      const citedFactIds = [
        ...new Set(review.strengths.flatMap((strength) => strength.fact_ids)),
      ];
      const citedFacts = citedFactIds.length
        ? await database
            .select({ id: profileFacts.id, status: profileFacts.status })
            .from(profileFacts)
            .where(
              and(
                eq(profileFacts.userId, userId),
                inArray(profileFacts.id, citedFactIds),
              ),
            )
        : [];
      const citedFactsStillApproved =
        citedFacts.length === citedFactIds.length &&
        citedFacts.every((fact) => fact.status === 'approved');
      return {
        ...review,
        outdated:
          (review.promptVersion.endsWith(':no-approved-facts') &&
            approvedFacts.length > 0) ||
          approvedFacts.some((fact) => fact.updatedAt > review.createdAt) ||
          !citedFactsStillApproved,
      };
    }),
  );
}

async function getApprovedFacts(
  executor: Database | Transaction,
  userId: string,
) {
  return executor
    .select({
      id: profileFacts.id,
      kind: profileFacts.kind,
      text: profileFacts.text,
      role: profileFacts.role,
      organisation: profileFacts.organisation,
      start: profileFacts.startDate,
      end: profileFacts.endDate,
    })
    .from(profileFacts)
    .where(
      and(eq(profileFacts.userId, userId), eq(profileFacts.status, 'approved')),
    );
}

async function generateAndSaveReview(
  executor: Transaction,
  userId: string,
  opportunityId: string,
  jobText: string,
  jobTitle: string,
  facts: Array<{
    id: string;
    kind: string;
    text: string;
    role: string | null;
    organisation: string | null;
    start: string | null;
    end: string | null;
  }>,
  options: {
    generate?: typeof generateStructured;
    isFree: boolean;
    requestKey?: string;
  },
) {
  const generated = await (options.generate ?? generateStructured)(
    fitReviewPrompt,
    fitReviewSchema,
    { jobText, approvedFacts: facts, evidenceAvailable: facts.length > 0 },
    { temperature: 0 },
  );
  const { requirements } = generated.object;
  const grounding = await checkGrounding(
    userId,
    requirements.map(({ text, fact_ids }) => ({ text, fact_ids })),
    executor,
  );
  const citedTexts = requirements.map((r, i) =>
    grounding.items[i]?.grounded &&
    grounding.items[i].approvedFacts.some(
      (f) =>
        hasRequirementEvidenceOverlap(r.text, f.text) &&
        hasRequirementEvidenceOverlap(r.job_quote, f.text),
    )
      ? grounding.items[i].approvedFacts.map((f) => f.text)
      : [],
  );
  const effectiveGrounding = requirements.map(
    (r, i) => grounding.items[i]?.grounded === true && citedTexts[i].length > 0,
  );
  const { strengths, gaps, unknowns } = deriveFitReview(
    requirements,
    jobText,
    effectiveGrounding,
    facts.length > 0,
  );
  const [owner] = await executor
    .select({ targetRoles: users.targetRoles })
    .from(users)
    .where(eq(users.id, userId));
  const scorecard = calculateFitScore({
    requirements,
    jobText,
    grounding: effectiveGrounding,
    evidenceTexts: citedTexts,
    evidenceAvailable: facts.length > 0,
    jobTitle,
    targetRoles: owner?.targetRoles ?? [],
  });
  const verifiedRequirements = requirements.flatMap((requirement, index) => {
    const quote = normalise(requirement.job_quote);
    if (quote.length < 3 || !normalise(jobText).includes(quote)) return [];
    const status =
      (requirement.status === 'met' && !effectiveGrounding[index]) ||
      (requirement.status === 'constraint' &&
        !conditionKind(requirement.job_quote)) ||
      (requirement.status === 'gap' &&
        !isVerifiedGap(requirement, facts.length > 0))
        ? ('unknown' as const)
        : requirement.status;
    return [
      {
        ...requirement,
        status,
        fact_ids: effectiveGrounding[index] ? requirement.fact_ids : [],
      },
    ];
  });
  const save = async (tx: Transaction) => {
    const [saved] = await tx
      .insert(fitReviews)
      .values({
        userId,
        opportunityId,
        verdict: generated.object.verdict,
        scorecard,
        requirements: verifiedRequirements,
        strengths,
        gaps,
        unknowns,
        promptVersion: facts.length
          ? generated.promptVersion
          : `${generated.promptVersion}:no-approved-facts`,
        model: generated.model,
        isFree: options.isFree,
        requestKey: options.isFree ? options.requestKey : null,
      })
      .returning();
    const [moved] = await tx
      .update(opportunities)
      .set({
        status: 'reviewed',
        nextStep: nextSteps.reviewed,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(opportunities.id, opportunityId),
          eq(opportunities.userId, userId),
          eq(opportunities.status, 'saved'),
        ),
      )
      .returning({ nextStep: opportunities.nextStep });
    if (moved)
      await recordEvent(
        {
          userId,
          type: 'opportunity.status_changed',
          subjectType: 'opportunity',
          subjectId: opportunityId,
          data: { from: 'saved', to: 'reviewed', nextStep: moved.nextStep },
        },
        tx,
      );
    await recordEvent(
      {
        userId,
        type: 'opportunity.fit_reviewed',
        subjectType: 'opportunity',
        subjectId: opportunityId,
        data: { fitReviewId: saved.id },
      },
      tx,
    );
    return saved;
  };
  return save(executor);
}

export async function createFitReview(
  userId: string,
  opportunityId: string,
  key: string,
  options: {
    database?: Database;
    generate?: typeof generateStructured;
    requireFree?: boolean;
  } = {},
) {
  const database = options.database ?? getDatabase();
  const { job } = await getOpportunity(userId, opportunityId, database);
  const freeUnavailable = () =>
    new ApiError(
      409,
      'FREE_REVIEW_UNAVAILABLE',
      'Your free first fit review was already used. This request was not charged; refresh to see the current price.',
    );
  if (options.requireFree && !FIRST_FIT_REVIEW_FREE_ENABLED)
    throw freeUnavailable();
  if (
    !options.generate &&
    (!process.env.OPENROUTER_API_KEY ||
      process.env.OPENROUTER_API_KEY.startsWith('REPLACE_WITH_'))
  )
    throw new ApiError(
      503,
      'AI_NOT_CONFIGURED',
      'AI reviews are not configured yet. Your credits have not been charged.',
    );
  if (!key.trim() || key.length > 150)
    throw new ApiError(400, 'INVALID_INPUT', 'Provide a request key.');
  const creditKey = `fit:${opportunityId}:${key}`;

  // Locking the user serializes first-review attempts. A failed generation rolls
  // back its review row, so the next attempt can still use the free review.
  if (FIRST_FIT_REVIEW_FREE_ENABLED) {
    let freeReview: string | null;
    try {
      freeReview = await database.transaction(async (tx) => {
        const [owner] = await tx
          .select({
            id: users.id,
            deletionRequestedAt: users.deletionRequestedAt,
            firstFitReviewUsed: users.firstFitReviewUsed,
            firstFitReviewRequestKey: users.firstFitReviewRequestKey,
            firstFitReviewOpportunityId: users.firstFitReviewOpportunityId,
          })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!owner) throw new ApiError(404, 'NOT_FOUND', 'Profile not found.');
        if (owner.deletionRequestedAt)
          throw new ApiError(
            403,
            'ACCOUNT_DELETION_PENDING',
            'Account deletion is in progress.',
          );
        if (
          owner.firstFitReviewUsed &&
          owner.firstFitReviewRequestKey === key
        ) {
          if (owner.firstFitReviewOpportunityId !== opportunityId)
            throw new ApiError(
              409,
              'IDEMPOTENCY_KEY_CONFLICT',
              'This request key was already used for another role.',
            );
          const [replay] = await tx
            .select({ id: fitReviews.id })
            .from(fitReviews)
            .where(
              and(
                eq(fitReviews.userId, userId),
                eq(fitReviews.opportunityId, opportunityId),
                eq(fitReviews.isFree, true),
              ),
            )
            .orderBy(desc(fitReviews.createdAt))
            .limit(1);
          return replay?.id ?? null;
        }
        const [replay] = await tx
          .select()
          .from(fitReviews)
          .where(
            and(
              eq(fitReviews.userId, userId),
              eq(fitReviews.requestKey, key),
              eq(fitReviews.isFree, true),
            ),
          )
          .limit(1);
        if (replay) {
          if (replay.opportunityId === opportunityId) return replay.id;
          return null;
        }
        const [previous] = await tx
          .select({ id: fitReviews.id })
          .from(fitReviews)
          .where(eq(fitReviews.userId, userId))
          .orderBy(desc(fitReviews.createdAt))
          .limit(1);
        if (owner.firstFitReviewUsed || previous) {
          if (options.requireFree) throw freeUnavailable();
          return null;
        }
        const facts = await getApprovedFacts(tx, userId);
        const saved = await generateAndSaveReview(
          tx,
          userId,
          opportunityId,
          job.text,
          job.title,
          facts,
          {
            generate: options.generate,
            isFree: true,
            requestKey: key,
          },
        );
        await tx
          .update(users)
          .set({
            firstFitReviewUsed: true,
            firstFitReviewRequestKey: key,
            firstFitReviewOpportunityId: opportunityId,
          })
          .where(eq(users.id, userId));
        return saved.id;
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        502,
        'FIT_REVIEW_NOT_CHARGED',
        'The fit review could not be completed. No credits were charged. Try again.',
      );
    }
    if (freeReview) {
      const [review] = await database
        .select()
        .from(fitReviews)
        .where(
          and(
            eq(fitReviews.id, freeReview),
            eq(fitReviews.userId, userId),
            eq(fitReviews.opportunityId, opportunityId),
          ),
        );
      if (!review)
        throw new ApiError(404, 'NOT_FOUND', 'Fit review not found.');
      return review;
    }
    if (options.requireFree) throw freeUnavailable();
  }

  let result: { type: string; id: string };
  try {
    result = await withCredits(
      userId,
      'fit_review',
      creditKey,
      async () => {
        const review = await database.transaction(async (tx) => {
          const facts = await getApprovedFacts(tx, userId);
          return generateAndSaveReview(
            tx,
            userId,
            opportunityId,
            job.text,
            job.title,
            facts,
            {
              generate: options.generate,
              isFree: false,
            },
          );
        });
        return { type: 'fit_review', id: review.id };
      },
      { database },
    );
  } catch (error) {
    if (error instanceof CreditError) throw error;
    try {
      const holds = await database
        .select({ status: creditHolds.status })
        .from(creditHolds)
        .where(
          and(
            eq(creditHolds.userId, userId),
            eq(creditHolds.idempotencyKey, `${userId}:${creditKey}`),
          ),
        );
      if (holds.length > 0 && holds.every((hold) => hold.status === 'released'))
        throw new ApiError(
          502,
          'FIT_REVIEW_NOT_CHARGED',
          'The fit review could not be completed. No credits were charged. Try again.',
        );
    } catch (statusError) {
      if (statusError instanceof ApiError) throw statusError;
    }
    throw error;
  }
  const [review] = await database
    .select()
    .from(fitReviews)
    .where(
      and(
        eq(fitReviews.id, result.id),
        eq(fitReviews.userId, userId),
        eq(fitReviews.opportunityId, opportunityId),
      ),
    );
  if (!review) throw new ApiError(404, 'NOT_FOUND', 'Fit review not found.');
  return review;
}
