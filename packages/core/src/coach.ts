import { and, desc, eq, gt, gte, isNull, or } from 'drizzle-orm';
import {
  COACH_DAILY_MESSAGE_LIMIT,
  COACH_DAILY_WINDOW_MS,
  COACH_GENERATION_TIMEOUT_MS,
  COACH_MESSAGE_MAX_CHARS,
  COACH_PENDING_STALE_MS,
  type OpportunityStatus,
} from '@career-workspace/contracts';
export { trimCoachHistory } from '@career-workspace/contracts';
import {
  coachMessages,
  coachProposals,
  getDatabase,
  opportunities,
  profileFacts,
  projects,
  users,
  type Database,
  type Transaction,
} from '@career-workspace/db';
import { ApiError } from './api';
import { recordEvent } from './events';
import { listOpportunities, getOpportunity } from './roles';
import { getFitReviews } from './fit-review';
import { nextSteps } from './opportunity-status';
import { getResumePreparation } from './resume-preparation-service';

const PENDING_STALE_MS = COACH_PENDING_STALE_MS;
const COACH_RESUME_CONTEXT_LIST_LIMIT = 20;

function logCoachResumeContextFailure(
  opportunityId: string,
  stage: 'preparation' | 'versions or readability',
) {
  console.error(
    JSON.stringify({
      event: 'coach_resume_context_failure',
      message: `Optional resume ${stage} could not be loaded.`,
      opportunityId,
    }),
  );
}

type CoachExecutor = Database | Transaction;

async function readCoachAllowance(
  userId: string,
  executor: CoachExecutor,
  now: Date,
  cap = COACH_DAILY_MESSAGE_LIMIT,
) {
  const windowStart = new Date(now.getTime() - COACH_DAILY_WINDOW_MS);
  const staleBefore = new Date(now.getTime() - PENDING_STALE_MS);
  const rows = await executor
    .select({
      status: coachMessages.status,
      updatedAt: coachMessages.updatedAt,
    })
    .from(coachMessages)
    .where(
      and(
        eq(coachMessages.userId, userId),
        eq(coachMessages.role, 'user'),
        or(
          and(
            eq(coachMessages.status, 'completed'),
            gte(coachMessages.updatedAt, windowStart),
          ),
          and(
            eq(coachMessages.status, 'pending'),
            gt(coachMessages.updatedAt, staleBefore),
          ),
        ),
      ),
    );
  const successful = rows.filter((row) => row.status === 'completed');
  const pending = rows.filter((row) => row.status === 'pending');
  // Pending replies can finish and count for a full day. Never advertise
  // their short recovery timeout as the daily reset. Completed replies are
  // the earliest guaranteed slots; if all are pending, use a conservative
  // estimate based on the bounded generation deadline.
  const expiries = (
    successful.length
      ? successful.map((row) => row.updatedAt.getTime() + COACH_DAILY_WINDOW_MS)
      : pending.map(
          (row) =>
            Math.max(
              now.getTime(),
              row.updatedAt.getTime() + COACH_GENERATION_TIMEOUT_MS,
            ) + COACH_DAILY_WINDOW_MS,
        )
  ).sort((a, b) => a - b);
  return {
    limit: cap,
    used: successful.length,
    pending: pending.length,
    remaining: Math.max(0, cap - successful.length - pending.length),
    resetAt: expiries.length ? new Date(expiries[0]!) : null,
  };
}

export async function getCoachAllowance(
  userId: string,
  options: { database?: Database; now?: Date; cap?: number } = {},
) {
  return readCoachAllowance(
    userId,
    options.database ?? getDatabase(),
    options.now ?? new Date(),
    options.cap,
  );
}

function coachLimitError(resetAt: Date | null) {
  const resetTime = resetAt
    ? new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(resetAt)
    : 'soon';
  return new ApiError(
    429,
    'COACH_DAILY_LIMIT',
    `Your rolling 24-hour coach limit has been reached. Your next message slot opens around ${resetTime} UTC. You can still paste a job for review (the cost is shown before confirmation), open Discover for collected matches, or visit My roles.`,
  );
}

async function requireCoachAllowance(
  userId: string,
  executor: CoachExecutor,
  now: Date,
  cap?: number,
) {
  const allowance = await readCoachAllowance(userId, executor, now, cap);
  if (!allowance.remaining) throw coachLimitError(allowance.resetAt);
}

function asStatus(value: string): OpportunityStatus {
  const values: OpportunityStatus[] = [
    'saved',
    'reviewed',
    'preparing',
    'applied',
    'interviewing',
    'offer',
    'rejected',
    'withdrawn',
  ];
  if (!values.includes(value as OpportunityStatus))
    throw new ApiError(
      409,
      'INVALID_PROPOSAL',
      'This status proposal is invalid.',
    );
  return value as OpportunityStatus;
}

export async function listCoachMessages(
  userId: string,
  database: Database = getDatabase(),
) {
  const rows = await database
    .select()
    .from(coachMessages)
    .where(eq(coachMessages.userId, userId))
    .orderBy(desc(coachMessages.createdAt), desc(coachMessages.id))
    .limit(100);
  return rows.reverse();
}

export async function beginCoachMessage(
  userId: string,
  input: { message: string; opportunityId?: string },
  requestKey: string,
  options: { database?: Database; now?: Date; cap?: number } = {},
) {
  const database = options.database ?? getDatabase();
  const now = options.now ?? new Date();
  if (!requestKey.trim() || requestKey.length > 200)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'A valid request key is required.',
    );
  const messageText = input.message.trim();
  if (!messageText || messageText.length > COACH_MESSAGE_MAX_CHARS)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      `Please shorten your coach message to ${COACH_MESSAGE_MAX_CHARS.toLocaleString('en-GB')} characters or fewer and try again. You can paste a job in My roles for a separate review.`,
    );
  const staleBefore = new Date(now.getTime() - PENDING_STALE_MS);

  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, coachId: users.coachId })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
    if (input.opportunityId) {
      const [owned] = await tx
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(
          and(
            eq(opportunities.id, input.opportunityId),
            eq(opportunities.userId, userId),
          ),
        );
      if (!owned) throw new ApiError(404, 'NOT_FOUND', 'Role not found.');
    }
    const [existing] = await tx
      .select()
      .from(coachMessages)
      .where(
        and(
          eq(coachMessages.userId, userId),
          eq(coachMessages.requestKey, requestKey),
        ),
      )
      .limit(1)
      .for('update');
    if (existing) {
      if (
        existing.role !== 'user' ||
        existing.content !== messageText ||
        existing.opportunityId !== (input.opportunityId ?? null)
      )
        throw new ApiError(
          409,
          'REQUEST_KEY_CONFLICT',
          'This request key was already used for a different message.',
        );
      const [reply] = await tx
        .select()
        .from(coachMessages)
        .where(
          and(
            eq(coachMessages.userId, userId),
            eq(coachMessages.replyToId, existing.id),
          ),
        )
        .limit(1);
      if (existing.status === 'completed' && reply)
        return { message: existing, reply, coachId: user.coachId };
      if (
        existing.status === 'pending' &&
        existing.updatedAt.getTime() > staleBefore.getTime()
      )
        throw new ApiError(
          409,
          'COACH_MESSAGE_IN_PROGRESS',
          'This message is still being answered.',
        );
      await requireCoachAllowance(userId, tx, now, options.cap);
      const [reused] = await tx
        .update(coachMessages)
        .set({ status: 'pending', updatedAt: now })
        .where(
          and(
            eq(coachMessages.id, existing.id),
            eq(coachMessages.userId, userId),
          ),
        )
        .returning();
      return { message: reused, reply: null, coachId: user.coachId };
    }
    await requireCoachAllowance(userId, tx, now, options.cap);
    const [message] = await tx
      .insert(coachMessages)
      .values({
        userId,
        role: 'user',
        content: messageText,
        opportunityId: input.opportunityId ?? null,
        requestKey,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { message, reply: null, coachId: user.coachId };
  });
}

export async function finishCoachMessage(
  userId: string,
  id: string,
  text: string,
  metadata: { promptVersion: string; model: string },
  database: Database = getDatabase(),
) {
  const content = text.trim();
  if (!content || content.length > 20000)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'The coach reply is empty or too long.',
    );
  return database.transaction(async (tx) => {
    const [message] = await tx
      .select()
      .from(coachMessages)
      .where(
        and(
          eq(coachMessages.id, id),
          eq(coachMessages.userId, userId),
          eq(coachMessages.role, 'user'),
        ),
      )
      .limit(1)
      .for('update');
    if (!message) throw new ApiError(404, 'NOT_FOUND', 'Message not found.');
    const [previous] = await tx
      .select()
      .from(coachMessages)
      .where(
        and(eq(coachMessages.userId, userId), eq(coachMessages.replyToId, id)),
      )
      .limit(1);
    if (message.status === 'completed' && previous)
      return { message, reply: previous };
    if (message.status !== 'pending')
      throw new ApiError(
        409,
        'COACH_MESSAGE_NOT_PENDING',
        'This message cannot be completed.',
      );
    const [reply] = await tx
      .insert(coachMessages)
      .values({
        userId,
        role: 'assistant',
        content,
        opportunityId: message.opportunityId,
        replyToId: message.id,
        status: 'completed',
        promptVersion: metadata.promptVersion,
        model: metadata.model,
      })
      .returning();
    const [completed] = await tx
      .update(coachMessages)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(
        and(
          eq(coachMessages.id, message.id),
          eq(coachMessages.userId, userId),
          eq(coachMessages.status, 'pending'),
        ),
      )
      .returning();
    if (!completed)
      throw new ApiError(
        409,
        'COACH_MESSAGE_NOT_PENDING',
        'This message cannot be completed.',
      );
    return { message: completed, reply };
  });
}

export async function failCoachMessage(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  const [failed] = await database
    .update(coachMessages)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(
      and(
        eq(coachMessages.id, id),
        eq(coachMessages.userId, userId),
        eq(coachMessages.role, 'user'),
        eq(coachMessages.status, 'pending'),
      ),
    )
    .returning();
  return failed ?? null;
}

export function coachReaders(
  userId: string,
  database: Database = getDatabase(),
) {
  return {
    async profile() {
      const [facts, ownProjects] = await Promise.all([
        database
          .select({
            id: profileFacts.id,
            kind: profileFacts.kind,
            text: profileFacts.text,
            source: profileFacts.source,
          })
          .from(profileFacts)
          .where(
            and(
              eq(profileFacts.userId, userId),
              eq(profileFacts.status, 'approved'),
            ),
          )
          .orderBy(desc(profileFacts.createdAt)),
        database
          .select({
            id: projects.id,
            title: projects.title,
            summary: projects.summary,
            links: projects.links,
          })
          .from(projects)
          .where(eq(projects.userId, userId))
          .orderBy(desc(projects.updatedAt)),
      ]);
      return { facts, projects: ownProjects };
    },
    roles: async () =>
      (await listOpportunities(userId, database))
        .slice(0, 50)
        .map(({ job, opportunity, fitBand }) => ({
          id: opportunity.id,
          title: job.title,
          company: job.company,
          status: opportunity.status,
          nextStep: opportunity.nextStep,
          fitBand,
        })),
    role: async (id: string) => {
      const role = await getOpportunity(userId, id, database);
      const reviews = await getFitReviews(userId, id, database);
      const latest = reviews[0];
      const fitReview = latest
        ? {
            scorecard: latest.scorecard,
            requirements: latest.requirements,
            gaps: latest.gaps,
            strengths: latest.strengths,
            unknowns: latest.unknowns,
            outdated: latest.outdated,
          }
        : null;

      let preparation;
      try {
        preparation = await getResumePreparation(userId, id, database);
      } catch {
        logCoachResumeContextFailure(id, 'preparation');
        return {
          ...role,
          resumePreparation: null,
          resumeAts: null,
          resumeSummary: null,
          fitReview,
        };
      }

      const skills = preparation.skills.buckets;
      const buckets = {
        existing: skills.existing.slice(0, COACH_RESUME_CONTEXT_LIST_LIMIT),
        supportedByResume: skills.supportedByResume.slice(
          0,
          COACH_RESUME_CONTEXT_LIST_LIMIT,
        ),
        gaps: skills.gaps.slice(0, COACH_RESUME_CONTEXT_LIST_LIMIT),
      };
      const resumePreparation = {
        skills: {
          ...preparation.skills,
          buckets,
          incompleteRequirements:
            preparation.skills.incompleteRequirements.slice(
              0,
              COACH_RESUME_CONTEXT_LIST_LIMIT,
            ),
        },
        requirements: preparation.requirements.slice(
          0,
          COACH_RESUME_CONTEXT_LIST_LIMIT,
        ),
        reuse: preparation.reuse.slice(0, 3),
      };

      let versionsFound: boolean | null = null;
      let ats = null;
      try {
        const { getResumeAtsReport, listResumeVersions } = await import(
          './resumes'
        );
        const versions = await listResumeVersions(userId, id, database);
        versionsFound = versions.length > 0;
        if (versions[0])
          ats = await getResumeAtsReport(userId, versions[0].id, database);
      } catch {
        logCoachResumeContextFailure(id, 'versions or readability');
      }
      const resumeSummary = `${skills.existing.length} named skills, ${skills.supportedByResume.length} supported by facts, ${skills.gaps.length} gaps. Confirm these before drafting.\n${ats?.score != null ? `PDF readability: ${ats.score}/100 (${ats.grade}); this is not an employer acceptance score.` : versionsFound === false ? 'No CV has been drafted for this role yet.' : 'PDF readability is unavailable; check the CV workspace.'} Prepare or reuse your CV in the workspace.`;
      return {
        ...role,
        resumePreparation,
        resumeAts: ats,
        resumeSummary,
        fitReview,
      };
    },
    proposeStatus: (id: string, status: OpportunityStatus, reason: string) =>
      createCoachProposal(userId, id, status, reason, database),
  };
}

export async function createCoachProposal(
  userId: string,
  opportunityId: string,
  status: OpportunityStatus,
  reason: string,
  database: Database = getDatabase(),
) {
  asStatus(status);
  const cleanReason = reason.trim();
  if (!cleanReason || cleanReason.length > 1000)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Add a short reason for this status change.',
    );
  const targetStatus = asStatus(status);
  const { opportunity } = await getOpportunity(userId, opportunityId, database);
  const [proposal] = await database
    .insert(coachProposals)
    .values({
      userId,
      opportunityId,
      data: { from: opportunity.status, to: targetStatus, reason: cleanReason },
    })
    .returning();
  return proposal;
}

export async function listCoachProposals(
  userId: string,
  database: Database = getDatabase(),
) {
  return database
    .select()
    .from(coachProposals)
    .where(eq(coachProposals.userId, userId))
    .orderBy(desc(coachProposals.createdAt), desc(coachProposals.id));
}

function nextStepForStatus(status: OpportunityStatus) {
  return nextSteps[status];
}

export async function confirmCoachProposal(
  userId: string,
  proposalId: string,
  database: Database = getDatabase(),
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      proposalId,
    )
  )
    throw new ApiError(404, 'NOT_FOUND', 'Proposal not found.');
  return database.transaction(async (tx: Transaction) => {
    const [proposal] = await tx
      .select()
      .from(coachProposals)
      .where(
        and(
          eq(coachProposals.id, proposalId),
          eq(coachProposals.userId, userId),
        ),
      )
      .limit(1)
      .for('update');
    if (!proposal) throw new ApiError(404, 'NOT_FOUND', 'Proposal not found.');
    const [opportunity] = await tx
      .select()
      .from(opportunities)
      .where(
        and(
          eq(opportunities.id, proposal.opportunityId),
          eq(opportunities.userId, userId),
        ),
      )
      .limit(1)
      .for('update');
    if (!opportunity) throw new ApiError(404, 'NOT_FOUND', 'Role not found.');
    if (proposal.confirmedAt)
      return { proposal, opportunity, alreadyConfirmed: true };
    const to = asStatus(proposal.data.to);
    if (opportunity.status !== proposal.data.from)
      throw new ApiError(
        409,
        'STALE_PROPOSAL',
        'This role changed after the coach made this suggestion.',
      );
    const nextStep = nextStepForStatus(to);
    const [updatedOpportunity] = await tx
      .update(opportunities)
      .set({ status: to, nextStep, updatedAt: new Date() })
      .where(
        and(
          eq(opportunities.id, opportunity.id),
          eq(opportunities.userId, userId),
          eq(opportunities.status, proposal.data.from),
        ),
      )
      .returning();
    if (!updatedOpportunity)
      throw new ApiError(
        409,
        'STALE_PROPOSAL',
        'This role changed after the coach made this suggestion.',
      );
    const [confirmed] = await tx
      .update(coachProposals)
      .set({ confirmedAt: new Date() })
      .where(
        and(
          eq(coachProposals.id, proposal.id),
          eq(coachProposals.userId, userId),
          isNull(coachProposals.confirmedAt),
        ),
      )
      .returning();
    if (!confirmed)
      throw new ApiError(
        409,
        'STALE_PROPOSAL',
        'This suggestion was confirmed elsewhere.',
      );
    await recordEvent(
      {
        userId,
        type: 'opportunity.status_changed',
        subjectType: 'opportunity',
        subjectId: opportunity.id,
        data: {
          from: proposal.data.from,
          to,
          nextStep,
          proposalId: proposal.id,
        },
      },
      tx,
    );
    return {
      proposal: confirmed,
      opportunity: updatedOpportunity,
      alreadyConfirmed: false,
    };
  });
}
