import { fitScoreBandLabels, type FitScorecard } from '@career-workspace/contracts';
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import {
  creditHolds,
  tasks,
  users,
  type Database,
  type Task,
} from '@career-workspace/db';
import { generateStructured } from '@career-workspace/adapters/ai';
import {
  handleTelegramCoach,
  type TelegramCoachOptions,
} from './telegram-coach';
import { confirmCoachSaveProposal } from './coach-toolset';
import { balance, ACTIONS, CreditError } from './credits';
import { ApiError } from './api';
import {
  createFitReview,
  getFitReviewEligibility,
  getFitReviews,
} from './fit-review';
import { getOpportunity, listOpportunities, createJob } from './roles';
import { checkRateLimit } from './rate-limit';
import type { TelegramReply, TelegramUpdate } from './telegram-types';

// Telegram allows 4096 characters after formatting escapes; leave room for them.
const MAX_REPLY = 3000;
const PENDING_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;
const MINUTE_REVIEW_LIMIT = 10;
const DAILY_REVIEW_LIMIT = 20;
const ROLE_PAGE_SIZE = 20;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type HandlerOptions = TelegramCoachOptions & {
  database: Database;
  generate?: typeof generateStructured;
  appUrl: string;
};
type PendingInput = {
  text: string;
  url?: string;
  originUpdateId: number;
  opportunityId?: string;
  expectedFree?: boolean;
};
type ReviewOutput = {
  kind: 'review';
  scorecard?: FitScorecard | null;
  opportunityId: string;
  verdict: string;
  gaps: string[];
  unknowns: string[];
  strengths: Array<{ text: string; fact_ids: string[] }>;
};

function appLink(appUrl: string, path: string) {
  const base = new URL(appUrl);
  return new URL(path, base).toString();
}

function splitText(
  text: string,
  buttons?: TelegramReply['buttons'],
): TelegramReply[] {
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text.split('\n')) {
    const next = current ? `${current}\n${paragraph}` : paragraph;
    if (next.length <= MAX_REPLY) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= MAX_REPLY) {
      current = paragraph;
      continue;
    }
    for (let i = 0; i < paragraph.length; i += MAX_REPLY)
      chunks.push(paragraph.slice(i, i + MAX_REPLY));
    current = '';
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks.map((chunk, index) => ({
    text: chunk,
    ...(index === chunks.length - 1 && buttons ? { buttons } : {}),
  }));
}

function formatReview(
  review: Pick<ReviewOutput, 'verdict' | 'gaps' | 'unknowns' | 'strengths' | 'scorecard'>,
) {
  const score = review.scorecard;
  if (score) return `Fit score: ${score.score === null ? 'More evidence needed' : `${score.score.toFixed(1)}/5 · ${fitScoreBandLabels[score.band]}`} · ${score.confidence} confidence (not hiring odds).\nNext: ${score.nextAction.replace(/\s+/g, ' ')} Open the web review for matches, gaps and evidence.`;
  return `Fit review: ${review.verdict.replace(/\s+/g, ' ')}\nNext: ${review.gaps[0] ?? review.unknowns[0] ?? 'Read your evidence before preparing a CV.'} Open the web review for details.`;
}

function savedTaskOutput(task: Task): Record<string, unknown> | null {
  return task.output && typeof task.output === 'object' ? task.output : null;
}

async function getOwnedPendingTask(
  userId: string,
  taskId: string,
  database: Database,
) {
  if (!UUID.test(taskId)) return null;
  const [task] = await database
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.userId, userId),
        eq(tasks.kind, 'telegram_job'),
      ),
    )
    .limit(1);
  return task ?? null;
}

/** Conservative local routing: unclear pasted text needs the student's choice. */
export function messageIntent(text: string): 'job' | 'question' | 'ambiguous' {
  const hasUrl = /https?:\/\/\S+/i.test(text);
  const jobSignals =
    /\b(responsibilities|requirements|qualifications|about the role|apply|salary|vacancy|job description|we are hiring|we're hiring)\b/i.test(
      text,
    );
  if (/^https?:\/\/\S+$/i.test(text) || (hasUrl && jobSignals)) return 'job';
  const question =
    /\?\s*$/.test(text) ||
    /^(?:what|why|how|when|where|who|which|can|could|would|should|do|does|did|is|are|will|may)\b/i.test(
      text,
    ) ||
    /^(?:(?:hi|hey|hello)[, ]+)?(?:oppa|coach)\b/i.test(text) ||
    /^(?:please\s+)?(?:help me|tell me|advise me)\b/i.test(text);
  if (question) return 'question';
  const lines = text.split(/\n/).filter((line) => line.trim()).length;
  if (jobSignals && lines >= 2) return 'job';
  if (text.length >= 300 || (jobSignals && text.length >= 120)) return 'job';
  return text.length >= 120 ? 'ambiguous' : 'question';
}

async function askMessageIntent(
  userId: string,
  update: TelegramUpdate,
  options: HandlerOptions,
) {
  const key = `telegram-choice:${update.updateId}`;
  await options.database
    .insert(tasks)
    .values({
      userId,
      kind: 'telegram_choice',
      idempotencyKey: key,
      input: { text: update.text.trim(), originUpdateId: update.updateId },
    })
    .onConflictDoNothing({ target: tasks.idempotencyKey });
  const [choice] = await options.database
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.idempotencyKey, key),
        eq(tasks.userId, userId),
        eq(tasks.kind, 'telegram_choice'),
      ),
    )
    .limit(1);
  if (!choice)
    return splitText('That message is not available. Please send it again.');
  const { firstReviewFree } = await getFitReviewEligibility(
    userId,
    options.database,
  );
  return splitText(
    'Would you like a job fit review, or is this a question for Oppa?',
    [
      {
        text: firstReviewFree
          ? 'Review this job (first review free)'
          : 'Review this job (1 credit)',
        data: `j:${choice.id}`,
      },
      { text: 'It is a question', data: `q:${choice.id}` },
    ],
  );
}

async function handleMessageChoice(
  userId: string,
  update: TelegramUpdate,
  options: HandlerOptions,
) {
  const [action, id] = update.callbackData!.split(':', 2);
  if (!UUID.test(id ?? ''))
    return splitText('That message is not available. Please send it again.');
  const [choice] = await options.database
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.userId, userId),
        eq(tasks.kind, 'telegram_choice'),
      ),
    )
    .limit(1);
  if (!choice)
    return splitText('That message is not available. Please send it again.');
  if (choice.createdAt.getTime() + PENDING_LIFETIME_MS <= Date.now())
    return splitText(
      'That choice has expired. Please send your message again.',
    );
  const input = choice.input as { text: string; originUpdateId: number };
  if (action === 'j')
    return createPendingJob(
      userId,
      { ...update, updateId: input.originUpdateId },
      options,
      input.text,
    );
  // Use the button press's update ID, never the old pasted message's request key.
  return handleTelegramCoach(userId, { ...update, text: input.text }, options);
}

async function createPendingJob(
  userId: string,
  update: TelegramUpdate,
  options: HandlerOptions,
  rawText: string,
) {
  const text = rawText.trim();
  const url = /^https?:\/\/\S+$/i.test(text)
    ? text
    : text.length < 120
      ? text.match(/https?:\/\/[^\s]+/i)?.[0]
      : undefined;

  if (!url && text.length < 120)
    return splitText(
      'Please paste the full job description (at least 120 characters) so I can review it. No credits were used.',
    );
  const key = `telegram-job:${update.updateId}`;
  const idempotencyKey = key;
  const input: PendingInput = {
    text: url ? '' : text,
    ...(url ? { url } : {}),
    originUpdateId: update.updateId,
    expectedFree: (await getFitReviewEligibility(userId, options.database)).firstReviewFree,
  };
  const task = await options.database.transaction(async (tx) => {
    const [created] = await tx
      .insert(tasks)
      .values({
        userId,
        kind: 'telegram_job',
        status: 'queued',
        input,
        idempotencyKey,
      })
      .onConflictDoNothing({ target: tasks.idempotencyKey })
      .returning();
    if (created) return created;
    const [existing] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.idempotencyKey, idempotencyKey))
      .limit(1);
    if (
      !existing ||
      existing.userId !== userId ||
      existing.kind !== 'telegram_job'
    )
      throw new Error('This Telegram update has already been used.');
    return existing;
  });
  if (task.status === 'succeeded')
    return replyForSavedTask(task, userId, options);
  const expires = new Date(task.createdAt.getTime() + PENDING_LIFETIME_MS);
  if (expires <= new Date())
    return splitText(
      'That job review request has expired. Send the job again to start a new request.',
    );
  const expectedFree = (task.input as PendingInput).expectedFree ?? false;
  return splitText(
    expectedFree
      ? 'Your first job fit review is free. Would you like to continue?'
      : 'Reviewing this job costs 1 credit. Would you like to continue?',
    [
      {
        text: expectedFree
          ? 'Review (free first review)'
          : 'Review (1 credit)',
        data: `review:${task.id}`,
      },
      { text: 'Cancel', data: `cancel:${task.id}` },
    ],
  );
}

async function replyForSavedTask(
  task: Task,
  userId: string,
  options: HandlerOptions,
): Promise<TelegramReply[]> {
  const output = savedTaskOutput(task);
  if (output?.kind === 'saved') return splitText('Saved for later.');
  if (
    !output ||
    output.kind !== 'review' ||
    typeof output.opportunityId !== 'string'
  )
    return splitText(
      'That job review has already finished. Use /roles to find the role.',
    );
  const review = output as unknown as ReviewOutput;
  let latest;
  try {
    latest = (
      await getFitReviews(userId, review.opportunityId, options.database)
    )[0];
  } catch {
    return splitText(
      'This role review is no longer available. Use /roles to see your saved roles.',
    );
  }
  if (!latest)
    return splitText(
      'This role review is no longer available. Use /roles to see your saved roles.',
    );
  const staleNote = latest.outdated
    ? ' Your confirmed facts changed; refresh this review before relying on it.'
    : '';
  return splitText(`${formatReview(latest)}${staleNote}`, [
    {
      text: 'Prepare on the web',
      url: appLink(options.appUrl, `/workspace/roles/${review.opportunityId}`),
    },
    { text: 'Save for later', data: `save:${review.opportunityId}` },
    { text: 'View all roles', data: 'roles' },
  ]);
}

async function showRole(
  userId: string,
  roleId: string,
  options: HandlerOptions,
) {
  try {
    const { opportunity, job } = await getOpportunity(
      userId,
      roleId,
      options.database,
    );
    const reviews = await getFitReviews(userId, roleId, options.database);
    const latest = reviews[0];
    if (!latest)
      return splitText(
        `${job.title} at ${job.company}\nStatus: ${opportunity.status}\nNo fit review yet.`,
        [
          {
            text: 'Open role',
            url: appLink(options.appUrl, `/workspace/roles/${roleId}`),
          },
        ],
      );
    const staleNote = latest.outdated
      ? ' Your confirmed facts changed; refresh this review before relying on it.'
      : '';
    return splitText(
      `${job.title} at ${job.company} · ${formatReview(latest)}${staleNote}`,
      [
        {
          text: 'Prepare on the web',
          url: appLink(options.appUrl, `/workspace/roles/${roleId}`),
        },
      ],
    );
  } catch {
    return splitText('Role not found. Use /roles to see your saved roles.');
  }
}

async function listRoles(userId: string, options: HandlerOptions) {
  return listRolesPage(userId, 0, options);
}

async function listRolesPage(
  userId: string,
  offset: number,
  options: HandlerOptions,
) {
  const roles = await listOpportunities(userId, options.database);
  if (!roles.length)
    return splitText(
      'You have no saved roles yet. Paste a job link or description to get started.',
    );
  const page = Math.max(0, Math.floor(offset / ROLE_PAGE_SIZE));
  const start = page * ROLE_PAGE_SIZE;
  const buttons = roles
    .slice(start, start + ROLE_PAGE_SIZE)
    .map(({ opportunity, job }) => ({
      text: `${job.title} — ${opportunity.status}`.slice(0, 64),
      data: `role:${opportunity.id}`,
    }));
  if (page > 0)
    buttons.push({
      text: '← Previous roles',
      data: `roles:${start - ROLE_PAGE_SIZE}`,
    });
  if (start + ROLE_PAGE_SIZE < roles.length)
    buttons.push({
      text: 'More roles →',
      data: `roles:${start + ROLE_PAGE_SIZE}`,
    });
  return splitText(
    `Your roles (${roles.length}) · page ${page + 1}\nChoose one to view its fit review.`,
    buttons,
  );
}

async function prepareRole(
  userId: string,
  roleId: string,
  options: HandlerOptions,
) {
  try {
    const { job } = await getOpportunity(userId, roleId, options.database);
    return splitText(
      `Open ${job.title} in your workspace to prepare your application.`,
      [
        {
          text: 'Prepare on the web',
          url: appLink(options.appUrl, `/workspace/roles/${roleId}`),
        },
      ],
    );
  } catch {
    return splitText('Role not found. Use /roles to see your saved roles.');
  }
}

async function handleCallback(
  userId: string,
  data: string,
  options: HandlerOptions,
): Promise<TelegramReply[]> {
  const [action, id] = data.split(':', 2);
  if (data === 'roles') return listRoles(userId, options);
  if (action === 'roles')
    return listRolesPage(userId, Number(id) || 0, options);
  if (action === 'prepares')
    return listPrepareRolesPage(userId, Number(id) || 0, options);
  if (action === 'role' && id) return showRole(userId, id, options);
  if (action === 'prepare' && id) return prepareRole(userId, id, options);
  if (action === 'save' && id) {
    try {
      const { opportunity } = await getOpportunity(
        userId,
        id,
        options.database,
      );
      return splitText(
        opportunity.status === 'saved'
          ? 'Saved for later. This role is in /roles.'
          : `This role is already ${opportunity.status}. I kept its status unchanged.`,
      );
    } catch {
      return splitText('Role not found. Use /roles to see your saved roles.');
    }
  }
  if (action === 'cancel' && id) {
    const task = await getOwnedPendingTask(userId, id, options.database);
    if (!task) return splitText('That job review request was not found.');
    if (task.status === 'queued') {
      const [cancelled] = await options.database
        .update(tasks)
        .set({ status: 'failed', error: 'CANCELLED', updatedAt: new Date() })
        .where(
          and(
            eq(tasks.id, id),
            eq(tasks.userId, userId),
            eq(tasks.status, 'queued'),
          ),
        )
        .returning({ id: tasks.id });
      if (cancelled) return splitText('Cancelled. No credits were used.');
      return splitText('That review has already started or finished.');
    }
    if (task.status === 'succeeded')
      return replyForSavedTask(task, userId, options);
    return splitText('That review has already started or finished.');
  }
  if (action === 'review' && id) return runPendingReview(userId, id, options);
  return splitText(
    'That button has expired. Send the job again if you still want a review.',
  );
}

async function claimPendingTask(
  userId: string,
  taskId: string,
  database: Database,
) {
  return database.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.userId, userId),
          eq(tasks.kind, 'telegram_job'),
        ),
      )
      .limit(1);
    if (!task) return { status: 'missing' as const };
    if (task.status === 'succeeded')
      return { status: 'succeeded' as const, task };
    if (
      task.status === 'running' &&
      task.updatedAt.getTime() > Date.now() - PROCESSING_LEASE_MS
    )
      return { status: 'running' as const, task };
    if (task.createdAt.getTime() + PENDING_LIFETIME_MS <= Date.now())
      return { status: 'expired' as const, task };
    if (
      task.status === 'failed' &&
      ['CANCELLED', 'RATE_LIMITED', 'EXPIRED'].includes(task.error ?? '')
    )
      return { status: 'failed' as const, task };
    const [claimed] = await tx
      .update(tasks)
      .set({
        status: 'running',
        attempts: sql`${tasks.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.userId, userId),
          or(
            eq(tasks.status, 'queued'),
            and(
              eq(tasks.status, 'failed'),
              notInArray(tasks.error, ['CANCELLED', 'RATE_LIMITED', 'EXPIRED']),
            ),
            and(
              eq(tasks.status, 'running'),
              sql`${tasks.updatedAt} <= ${new Date(Date.now() - PROCESSING_LEASE_MS)}`,
            ),
          ),
        ),
      )
      .returning();
    if (!claimed) return { status: 'running' as const, task };
    return { status: 'claimed' as const, task: claimed };
  });
}

async function markTaskFailed(
  userId: string,
  taskId: string,
  errorCode: string,
  database: Database,
) {
  await database
    .update(tasks)
    .set({ status: 'failed', error: errorCode, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.userId, userId),
        eq(tasks.status, 'running'),
      ),
    );
}

async function runPendingReview(
  userId: string,
  taskId: string,
  options: HandlerOptions,
): Promise<TelegramReply[]> {
  const claim = await claimPendingTask(userId, taskId, options.database);
  if (claim.status === 'missing')
    return splitText('That job review request was not found.');
  if (claim.status === 'expired') {
    await options.database
      .update(tasks)
      .set({ status: 'failed', error: 'EXPIRED', updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.userId, userId),
          inArray(tasks.status, ['queued', 'running']),
        ),
      );
    return splitText(
      'That job review request has expired. Send the job again to start a new request.',
    );
  }
  if (claim.status === 'succeeded')
    return replyForSavedTask(claim.task, userId, options);
  if (claim.status === 'failed')
    return splitText(
      claim.task.error === 'RATE_LIMITED'
        ? 'You have reached the review limit. Please wait and send the job again later.'
        : 'That review could not be restarted. Send the job again if you still want a review.',
    );
  if (claim.status === 'running')
    return splitText(
      'This review is already processing. Please wait a moment.',
    );

  const task = claim.task;
  const input = task.input as PendingInput;
  let opportunityId = input.opportunityId;
  try {
    if (!opportunityId) {
      const created = await createJob(
        userId,
        {
          // Keep pasted roles distinguishable without inventing a job title or company.
          title: input.url
            ? `Job link: ${new URL(input.url).hostname}${new URL(input.url).pathname}`.slice(
                0,
                180,
              )
            : `Pasted job: ${input.text.replace(/\s+/g, ' ').slice(0, 140)}`,
          company: 'Not provided',
          ...(input.url ? { url: input.url } : { text: input.text }),
        },
        { database: options.database },
      );
      opportunityId = created.opportunity.id;
      input.opportunityId = opportunityId;
      await options.database
        .update(tasks)
        .set({
          input: { ...input, opportunityId },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.userId, userId),
            eq(tasks.status, 'running'),
          ),
        );
    }

    const creditIdempotencyKey = `${userId}:fit:${opportunityId}:telegram:${input.originUpdateId}`;
    const [settledCredit] = await options.database
      .select({ id: creditHolds.id })
      .from(creditHolds)
      .where(
        and(
          eq(creditHolds.userId, userId),
          eq(creditHolds.idempotencyKey, creditIdempotencyKey),
          eq(creditHolds.status, 'settled'),
        ),
      )
      .limit(1);
    if (!settledCredit) {
      const minute = await checkRateLimit(
        userId,
        'fit_review',
        {
          limit: MINUTE_REVIEW_LIMIT,
          windowMs: 60_000,
        },
        options.database,
      );
      const daily = await checkRateLimit(
        userId,
        'telegram_fit_review_daily',
        {
          limit: DAILY_REVIEW_LIMIT,
          windowMs: 24 * 60 * 60_000,
        },
        options.database,
      );
      if (!minute.allowed || !daily.allowed) {
        await markTaskFailed(userId, task.id, 'RATE_LIMITED', options.database);
        return splitText(
          'You have reached the review limit. Please wait and send the job again later.',
        );
      }
    }

    const review = await createFitReview(
      userId,
      opportunityId,
      `telegram:${input.originUpdateId}`,
      {
        database: options.database,
        ...(options.generate ? { generate: options.generate } : {}),
        requireFree: input.expectedFree === true,
      },
    );
    const output: ReviewOutput = {
      kind: 'review',
      opportunityId,
      verdict: review.verdict,
      scorecard: review.scorecard,
      gaps: review.gaps,
      unknowns: review.unknowns,
      strengths: review.strengths,
    };
    await options.database
      .update(tasks)
      .set({ status: 'succeeded', output, error: null, updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.userId, userId),
          eq(tasks.status, 'running'),
        ),
      );
    return replyForSavedTask(
      { ...task, status: 'succeeded', output },
      userId,
      options,
    );
  } catch (error) {
    await markTaskFailed(userId, task.id, 'REVIEW_FAILED', options.database);
    // The role could not be saved (for example an unreadable link); nothing was charged.
    if (!opportunityId && error instanceof ApiError)
      return splitText(`${error.message} No credits were charged.`);
    if (error instanceof CreditError && error.code === 'INSUFFICIENT_CREDITS')
      return splitText(
        'You do not have enough credits for this review. No credits were charged.',
      );
    if (error instanceof ApiError && error.code === 'AI_NOT_CONFIGURED')
      return splitText(
        'AI reviews are not configured yet. Your credits have not been charged.',
      );
    if (error instanceof ApiError && error.code === 'FIT_REVIEW_NOT_CHARGED')
      return splitText(
        'The review could not be completed. No credits were charged. You can try again.',
      );
    if (error instanceof ApiError && error.code === 'FREE_REVIEW_UNAVAILABLE')
      return splitText(
        'Your free first review was used in another session. This review was not charged. Send the job again to confirm the current price.',
      );
    return splitText(
      'I could not finish that review. Use /roles to check the role before trying again.',
    );
  }
}

export async function handleTelegramCommand(
  userId: string,
  update: TelegramUpdate,
  options: HandlerOptions,
): Promise<TelegramReply[]> {
  const [account] = await options.database
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), sql`${users.deletionRequestedAt} IS NULL`))
    .limit(1);
  if (!account)
    return splitText('Your account is not available for Telegram commands.');
  if (update.callbackData?.startsWith('s:')) {
    try {
      const saved = await confirmCoachSaveProposal(
        userId,
        update.callbackData.slice(2),
        options.database,
      );
      return splitText(
        `Role saved: ${saved.proposal.data.title} — ${saved.proposal.data.company}`,
        [
          {
            text: 'Open role',
            url: appLink(
              options.appUrl,
              `/workspace/roles/${saved.opportunity.id}`,
            ),
          },
        ],
      );
    } catch (error) {
      if (error instanceof ApiError) return splitText(error.message);
      throw error;
    }
  }
  if (/^[jq]:/.test(update.callbackData ?? ''))
    return handleMessageChoice(userId, update, options);
  if (update.callbackData)
    return handleCallback(userId, update.callbackData, options);
  const text = update.text.trim();
  const [command = '', ...args] = text.split(/\s+/);
  const cmd = command.toLowerCase().split('@')[0];
  if (cmd === '/roles') return listRoles(userId, options);
  if (cmd === '/credits') {
    const current = await balance(userId, { database: options.database });
    const { firstReviewFree } = await getFitReviewEligibility(
      userId,
      options.database,
    );
    return splitText(
      `You have ${current.available} credits available.\n\nFit review: ${firstReviewFree ? 'first review free, then 1 credit' : `${ACTIONS.fit_review.cost} credit`}\nTailored CV: ${ACTIONS.tailor_cv.cost} credits\nAnswer draft: ${ACTIONS.answer_draft.cost} credit\nOutreach draft: ${ACTIONS.outreach_draft.cost} credit\nPractice session: ${ACTIONS.practice_session.cost} credits\nPost draft: ${ACTIONS.post_draft.cost} credit\nContact reveal: ${ACTIONS.contact_reveal.cost} credits`,
    );
  }
  if (cmd === '/prepare') {
    const id = args[0];
    if (id) return prepareRole(userId, id, options);
    return listPrepareRolesPage(userId, 0, options);
  }
  if (cmd === '/help' || cmd.startsWith('/') || !text) {
    const { firstReviewFree } = await getFitReviewEligibility(
      userId,
      options.database,
    );
    return splitText(
      `Ask me a question about your job search, or paste a job link or description for a fit review (${firstReviewFree ? 'first review free, then 1 credit' : '1 credit'}, confirmed first).\n\n/roles — your saved roles\n/credits — your credit balance\n/stop — disconnect and stop reminders\n\nCV uploads and CV drafting stay in the web workspace.`,
      [{ text: 'Open workspace', url: appLink(options.appUrl, '/workspace') }],
    );
  }
  const intent = messageIntent(text);
  if (intent === 'job') return createPendingJob(userId, update, options, text);
  if (intent === 'ambiguous') return askMessageIntent(userId, update, options);
  return handleTelegramCoach(userId, update, options);
}

async function listPrepareRolesPage(
  userId: string,
  offset: number,
  options: HandlerOptions,
) {
  const roles = await listOpportunities(userId, options.database);
  if (!roles.length)
    return splitText(
      'You have no saved roles yet. Paste a job link or description to get started.',
    );
  const page = Math.max(0, Math.floor(offset / ROLE_PAGE_SIZE));
  const start = page * ROLE_PAGE_SIZE;
  const buttons = roles
    .slice(start, start + ROLE_PAGE_SIZE)
    .map(({ opportunity, job }) => ({
      text: `${job.title} — ${opportunity.status}`.slice(0, 64),
      data: `prepare:${opportunity.id}`,
    }));
  if (page > 0)
    buttons.push({
      text: '← Previous roles',
      data: `prepares:${start - ROLE_PAGE_SIZE}`,
    });
  if (start + ROLE_PAGE_SIZE < roles.length)
    buttons.push({
      text: 'More roles →',
      data: `prepares:${start + ROLE_PAGE_SIZE}`,
    });
  return splitText(
    `Choose a role to prepare on the web · page ${page + 1}.`,
    buttons,
  );
}
