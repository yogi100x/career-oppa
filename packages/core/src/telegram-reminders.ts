import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  getDatabase,
  applicationHandoffs,
  jobs,
  opportunities,
  reminders,
  rateLimits,
  tasks,
  telegramLinks,
  users,
  type Database,
} from '@career-workspace/db';
import { checkRateLimit } from './rate-limit';
import { ApiError } from './api';
import { answerApplicationHandoff } from './application-handoff';
import { assertApprovedResumeUsable } from './resume-validity';
import { sendIfTelegramLinked } from './telegram-links';
import type { TelegramReply, TelegramSend } from './telegram-types';

const REMINDER_KIND = 'telegram_reminder';
const MAX_DELIVERIES = 20;
const MAX_SCHEDULED_PER_RUN = 250;
const MAX_ATTEMPTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const HANDOFF_DELAY_MS = 3 * DAY_MS;
const LEASE_MS = 5 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReminderInput = {
  source: 'reminder' | 'application_handoff';
  sourceId: string;
  linkedAt: string;
};
type SavedReminderOutput = { sent?: boolean; reply?: TelegramReply };
type EligibleLink = {
  userId: string;
  chatId: string;
  linkedAt: Date;
};

function appUrlForRole(appUrl: string | undefined, opportunityId: string) {
  const base = new URL(
    appUrl ?? process.env.APP_URL ?? 'http://localhost:3000',
  );
  return new URL(`/workspace/roles/${opportunityId}`, base.origin).toString();
}

function validInput(value: unknown): value is ReminderInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Partial<ReminderInput>;
  return (
    (input.source === 'reminder' || input.source === 'application_handoff') &&
    typeof input.sourceId === 'string' &&
    UUID.test(input.sourceId) &&
    typeof input.linkedAt === 'string' &&
    Number.isFinite(Date.parse(input.linkedAt))
  );
}

function idempotencyKey(sourceId: string) {
  return `telegram-reminder:${sourceId}`;
}

async function queueReminder(
  userId: string,
  link: EligibleLink,
  source: ReminderInput['source'],
  sourceId: string,
  database: Database,
) {
  await database
    .insert(tasks)
    .values({
      userId,
      kind: REMINDER_KIND,
      status: 'queued',
      input: { source, sourceId, linkedAt: link.linkedAt.toISOString() },
      idempotencyKey: idempotencyKey(sourceId),
    })
    .onConflictDoNothing({ target: tasks.idempotencyKey });
}

async function queueDueReminders(database: Database, now: Date) {
  const perSourceLimit = Math.floor(MAX_SCHEDULED_PER_RUN / 2);
  const dueReminders = await database
    .select({
      userId: telegramLinks.userId,
      chatId: telegramLinks.chatId,
      linkedAt: telegramLinks.linkedAt,
      sourceId: reminders.id,
    })
    .from(reminders)
    .innerJoin(telegramLinks, eq(telegramLinks.userId, reminders.userId))
    .innerJoin(users, eq(users.id, telegramLinks.userId))
    .leftJoin(
      tasks,
      and(
        eq(tasks.userId, telegramLinks.userId),
        eq(tasks.kind, REMINDER_KIND),
        sql`${tasks.input}->>'sourceId' = ${reminders.id}::text`,
      ),
    )
    .where(
      and(
        eq(reminders.status, 'pending'),
        lte(reminders.dueAt, now),
        eq(telegramLinks.remindersEnabled, true),
        isNull(users.deletionRequestedAt),
        isNull(tasks.id),
      ),
    )
    .orderBy(asc(reminders.dueAt), asc(reminders.id))
    .limit(perSourceLimit);

  for (const item of dueReminders) {
    await queueReminder(item.userId, item, 'reminder', item.sourceId, database);
  }

  const pendingHandoffs = await database
    .select({
      userId: telegramLinks.userId,
      chatId: telegramLinks.chatId,
      linkedAt: telegramLinks.linkedAt,
      sourceId: applicationHandoffs.id,
    })
    .from(applicationHandoffs)
    .innerJoin(
      telegramLinks,
      eq(telegramLinks.userId, applicationHandoffs.userId),
    )
    .innerJoin(users, eq(users.id, telegramLinks.userId))
    .innerJoin(
      opportunities,
      and(
        eq(opportunities.id, applicationHandoffs.opportunityId),
        eq(opportunities.userId, applicationHandoffs.userId),
        eq(opportunities.status, 'preparing'),
      ),
    )
    .leftJoin(
      tasks,
      and(
        eq(tasks.userId, telegramLinks.userId),
        eq(tasks.kind, REMINDER_KIND),
        sql`${tasks.input}->>'sourceId' = ${applicationHandoffs.id}::text`,
      ),
    )
    .where(
      and(
        isNull(applicationHandoffs.answeredAt),
        lte(
          applicationHandoffs.createdAt,
          new Date(now.getTime() - HANDOFF_DELAY_MS),
        ),
        eq(telegramLinks.remindersEnabled, true),
        isNull(users.deletionRequestedAt),
        isNull(tasks.id),
      ),
    )
    .orderBy(asc(applicationHandoffs.createdAt), asc(applicationHandoffs.id))
    .limit(perSourceLimit);

  for (const item of pendingHandoffs) {
    await queueReminder(
      item.userId,
      item,
      'application_handoff',
      item.sourceId,
      database,
    );
  }
}

async function claimReminder(database: Database) {
  return database.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.kind, REMINDER_KIND),
          // Include deliveries recorded before daily counters were introduced.
          sql`NOT EXISTS (SELECT 1 FROM tasks AS delivered
            WHERE delivered.user_id = ${tasks.userId}
              AND delivered.kind = 'telegram_reminder'
              AND delivered.output->>'sent' = 'true'
              AND delivered.updated_at > statement_timestamp() - interval '24 hours')`,
          sql`NOT EXISTS (SELECT 1 FROM ${rateLimits}
            WHERE ${rateLimits.userId} = ${tasks.userId}
              AND ${rateLimits.actionKey} = 'telegram_reminders_daily'
              AND ${rateLimits.windowStart} + interval '24 hours' > statement_timestamp()
              AND ${rateLimits.count} >= 1)`,
          sql`NOT EXISTS (SELECT 1 FROM ${applicationHandoffs}
            WHERE ${tasks.input}->>'source' = 'application_handoff'
              AND ${tasks.input}->>'sourceId' = ${applicationHandoffs.id}::text
              AND ${applicationHandoffs.createdAt} > statement_timestamp() - interval '3 days')`,
          lt(tasks.attempts, MAX_ATTEMPTS),
          or(
            eq(tasks.status, 'queued'),
            and(
              eq(tasks.status, 'running'),
              lt(tasks.updatedAt, new Date(Date.now() - LEASE_MS)),
            ),
          ),
        ),
      )
      .orderBy(asc(tasks.createdAt))
      .for('update', { skipLocked: true })
      .limit(1);
    if (!task) return null;
    const [claimed] = await tx
      .update(tasks)
      .set({
        status: 'running',
        attempts: task.attempts + 1,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id))
      .returning();
    return claimed ?? null;
  });
}

async function makeReminderReply(
  userId: string,
  input: ReminderInput,
  appUrl: string | undefined,
  database: Database,
  now: Date,
): Promise<TelegramReply | null> {
  if (input.source === 'reminder') {
    const [row] = await database
      .select({
        title: reminders.title,
        opportunityId: reminders.opportunityId,
      })
      .from(reminders)
      .innerJoin(
        opportunities,
        and(
          eq(opportunities.id, reminders.opportunityId),
          eq(opportunities.userId, userId),
        ),
      )
      .where(
        and(
          eq(reminders.id, input.sourceId),
          eq(reminders.userId, userId),
          eq(reminders.status, 'pending'),
          lte(reminders.dueAt, now),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      text: `Follow-up reminder: ${row.title}`,
      buttons: [
        {
          text: 'Open in Career Workspace',
          url: appUrlForRole(appUrl, row.opportunityId),
        },
      ],
    };
  }

  const [handoff] = await database
    .select({
      id: applicationHandoffs.id,
      resumeId: applicationHandoffs.resumeId,
      answeredAt: applicationHandoffs.answeredAt,
      opportunityId: applicationHandoffs.opportunityId,
      roleStatus: opportunities.status,
      title: jobs.title,
      company: jobs.company,
    })
    .from(applicationHandoffs)
    .innerJoin(
      opportunities,
      and(
        eq(opportunities.id, applicationHandoffs.opportunityId),
        eq(opportunities.userId, userId),
      ),
    )
    .innerJoin(
      jobs,
      and(eq(jobs.id, opportunities.jobId), eq(jobs.userId, userId)),
    )
    .where(
      and(
        eq(applicationHandoffs.id, input.sourceId),
        eq(applicationHandoffs.userId, userId),
        lte(
          applicationHandoffs.createdAt,
          new Date(now.getTime() - HANDOFF_DELAY_MS),
        ),
      ),
    )
    .limit(1);
  if (!handoff || handoff.answeredAt) return null;
  if (handoff.roleStatus !== 'preparing') return null;
  if (!handoff.resumeId)
    return {
      text: 'This application question expired because your CV needs review. Open Career Workspace to review and approve your CV again.',
      buttons: [
        {
          text: 'Open role',
          url: appUrlForRole(appUrl, handoff.opportunityId),
        },
      ],
    };
  try {
    await assertApprovedResumeUsable(userId, handoff.resumeId, database);
  } catch (error) {
    if (error instanceof ApiError)
      return {
        text: 'This application question expired because your CV needs review. Open Career Workspace to review and approve your CV again.',
        buttons: [
          {
            text: 'Open role',
            url: appUrlForRole(appUrl, handoff.opportunityId),
          },
        ],
      };
    throw error;
  }
  const yesData = `a:y:${handoff.id}`;
  const noData = `a:n:${handoff.id}`;
  if (yesData.length >= 48 || noData.length >= 48) return null;
  return {
    text: `Did you apply for ${handoff.title} at ${handoff.company}?`,
    buttons: [
      { text: 'Yes, I applied', data: yesData },
      { text: 'Not yet', data: noData },
      {
        text: 'Open role',
        url: appUrlForRole(appUrl, handoff.opportunityId),
      },
    ],
  };
}

async function markTask(
  database: Database,
  taskId: string,
  status: 'succeeded' | 'failed' | 'running',
  output?: SavedReminderOutput,
  error: string | null = null,
) {
  await database
    .update(tasks)
    .set({
      status,
      ...(output ? { output } : {}),
      error,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.kind, REMINDER_KIND)));
}

/** Queue due app reminders and pending handoff prompts, then deliver at most 20. */
export async function sendDueTelegramReminders(options: {
  database?: Database;
  send: TelegramSend;
  appUrl?: string;
}) {
  const database = options.database ?? getDatabase();
  const now = new Date();
  await queueDueReminders(database, now);

  let sent = 0;
  let processed = 0;
  while (processed < MAX_DELIVERIES) {
    const task = await claimReminder(database);
    if (!task) break;
    processed += 1;
    const input = task.input;
    if (!validInput(input)) {
      await markTask(
        database,
        task.id,
        'failed',
        undefined,
        'INVALID_REMINDER_TASK',
      );
      continue;
    }

    try {
      const previous = task.output as SavedReminderOutput | null;
      if (previous?.sent) {
        await markTask(database, task.id, 'succeeded', { sent: true });
        continue;
      }
      const reply = await makeReminderReply(
        task.userId,
        input,
        options.appUrl,
        database,
        new Date(),
      );
      if (!reply) {
        await markTask(
          database,
          task.id,
          'failed',
          undefined,
          'REMINDER_NO_LONGER_PENDING',
        );
        continue;
      }
      await markTask(
        database,
        task.id,
        'running',
        { sent: false, reply },
        null,
      );
      let dailyLimitReached = false;
      const delivered = await sendIfTelegramLinked(
        task.userId,
        input.linkedAt,
        reply,
        async (chatId, message, transaction) => {
          const limit = await checkRateLimit(
            task.userId,
            'telegram_reminders_daily',
            { limit: 1, windowMs: DAY_MS },
            transaction,
          );
          if (!limit.allowed) {
            dailyLimitReached = true;
            return;
          }
          await options.send(chatId, message);
          // Save delivery before releasing the existing account lock, so unlink
          // preserves it. Failed sends roll back the daily allowance as well.
          await markTask(
            transaction,
            task.id,
            'succeeded',
            { sent: true },
            null,
          );
        },
        database,
        true,
      );
      if (dailyLimitReached) {
        await database
          .update(tasks)
          .set({
            status: 'queued',
            attempts: task.attempts - 1,
            output: null,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));
        continue;
      }
      if (!delivered) {
        await markTask(
          database,
          task.id,
          'failed',
          undefined,
          'TELEGRAM_LINK_INACTIVE',
        );
        continue;
      }
      sent += 1;
    } catch (error) {
      // API errors describe a stale or unusable user action. Retrying those
      // won't make the source valid again, so leave the task terminal.
      await markTask(
        database,
        task.id,
        error instanceof ApiError || task.attempts >= MAX_ATTEMPTS
          ? 'failed'
          : 'running',
        undefined,
        error instanceof ApiError
          ? 'TELEGRAM_REMINDER_ACTION_EXPIRED'
          : 'TELEGRAM_REMINDER_DELIVERY_FAILED',
      );
    }
  }
  return { sent, processed };
}

/** Resolve a Telegram Yes/Not yet button through the same owned web action. */
export async function handleTelegramHandoff(
  userId: string,
  callbackData: string,
  database: Database = getDatabase(),
): Promise<TelegramReply[]> {
  const match = /^a:([yn]):([0-9a-f-]{36})$/i.exec(callbackData);
  if (!match || !UUID.test(match[2]))
    return [
      {
        text: 'This application question has already been answered or expired. Check your role in Career Workspace.',
      },
    ];

  const answer = match[1] === 'y' ? 'applied' : 'not_yet';
  try {
    const result = await answerApplicationHandoff(
      userId,
      match[2],
      { answer },
      database,
    );
    if (result.alreadyAnswered)
      return [
        {
          text:
            result.handoff.response === 'applied'
              ? 'You already told me you applied.'
              : 'You already marked this as not yet.',
        },
      ];
    return [
      {
        text:
          answer === 'applied'
            ? 'Thanks — I marked this role as applied.'
            : 'No problem — I left this role in preparation.',
      },
    ];
  } catch (error) {
    if (error instanceof ApiError) {
      if (
        [
          'APPROVED_PDF_REQUIRED',
          'RESUME_NOT_GROUNDED',
          'RESUME_HEADER_REQUIRED',
        ].includes(error.code)
      )
        return [
          {
            text: 'This application question expired because your CV needs review. Open Career Workspace to review and approve your CV again.',
          },
        ];
      if (
        [
          'HANDOFF_ALREADY_ANSWERED',
          'ROLE_STATUS_CHANGED',
          'STATUS_CHANGED',
          'NOT_FOUND',
        ].includes(error.code)
      )
        return [
          {
            text: 'This application question has already been answered or expired. Check your role in Career Workspace.',
          },
        ];
      return [
        {
          text: 'I could not update this application. Please check your account and role in Career Workspace.',
        },
      ];
    }
    throw error;
  }
}
