import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  createDatabase,
  applicationHandoffs,
  files,
  profileFacts,
  reminders,
  rateLimits,
  resumeVersions,
  tasks,
  telegramLinks,
  users,
  type Database,
} from '@career-workspace/db';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  disconnectTelegram,
  createTelegramLinkCode,
  consumeTelegramLinkCode,
} from './telegram-links';
import { createJob } from './roles';
import { createApplicationHandoff } from './application-handoff';
import { updateOpportunityStatus } from './opportunity-status';
import {
  handleTelegramHandoff,
  sendDueTelegramReminders,
} from './telegram-reminders';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('Telegram reminder delivery', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userId: string;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const created = createDatabase(databaseUrl!);
    database = created.database;
    pool = created.pool;
  });

  beforeEach(async () => {
    const [user] = await database
      .insert(users)
      .values({ clerkId: `telegram-reminder-${randomUUID()}` })
      .returning({ id: users.id });
    userId = user.id;
  });

  afterEach(async () => {
    if (userId) await database.delete(users).where(eq(users.id, userId));
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('sends due reminders once and keeps the original reminder pending', async () => {
    const role = await createJob(
      userId,
      {
        title: 'Product designer',
        company: 'Example Studio',
        text: 'Design accessible product experiences with a small team. Work with research, engineering, and product partners to test ideas, improve journeys, and document decisions for customers and internal teams.',
      },
      { database },
    );
    const dueAt = new Date(Date.now() - 60_000);
    const [due, later] = await database
      .insert(reminders)
      .values([
        {
          userId,
          opportunityId: role.opportunity.id,
          title: 'Follow up with the hiring team',
          dueAt,
        },
        {
          userId,
          opportunityId: role.opportunity.id,
          title: 'Not due yet',
          dueAt: new Date(Date.now() + 60 * 60_000),
        },
      ])
      .returning();
    const linkedAt = new Date();
    await database.insert(telegramLinks).values({
      userId,
      telegramUserId: '900000000001',
      chatId: '900000000001',
      linkedAt,
      remindersEnabled: true,
    });

    const sent: Array<{ chatId: string; text: string; url?: string }> = [];
    const send = async (
      chatId: string,
      reply: { text: string; buttons?: Array<{ url?: string }> },
    ) => {
      sent.push({
        chatId,
        text: reply.text,
        url: reply.buttons?.find((button) => button.url)?.url,
      });
    };
    const first = await sendDueTelegramReminders({
      database,
      send,
      appUrl: 'https://career.example.test',
    });
    const replay = await sendDueTelegramReminders({
      database,
      send,
      appUrl: 'https://career.example.test',
    });

    expect(first.sent).toBe(1);
    expect(replay.sent).toBe(0);
    expect(sent).toEqual([
      {
        chatId: '900000000001',
        text: 'Follow-up reminder: Follow up with the hiring team',
        url: `https://career.example.test/workspace/roles/${role.opportunity.id}`,
      },
    ]);
    const records = await database
      .select({ id: reminders.id, status: reminders.status })
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.id, due.id)));
    expect(records[0]?.status).toBe('pending');
    const taskRows = await database
      .select({ status: tasks.status })
      .from(tasks)
      .where(
        and(eq(tasks.userId, userId), eq(tasks.kind, 'telegram_reminder')),
      );
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.status).toBe('succeeded');
    expect(later.status).toBe('pending');
    await database
      .delete(telegramLinks)
      .where(eq(telegramLinks.userId, userId));
  });

  it('caps concurrent deliveries at one per 24 hours and preserves sent history across relinking', async () => {
    const role = await createJob(
      userId,
      {
        title: 'Analyst',
        company: 'Example',
        text: 'Research user needs and communicate findings clearly. Plan interviews, analyze data and share practical recommendations with product and delivery teams.',
      },
      { database },
    );
    await database.insert(telegramLinks).values({
      userId,
      telegramUserId: '900000000099',
      chatId: '900000000099',
    });
    await database.insert(reminders).values(
      ['First follow-up', 'Second follow-up'].map((title) => ({
        userId,
        opportunityId: role.opportunity.id,
        title,
        dueAt: new Date(Date.now() - 60_000),
      })),
    );
    const messages: string[] = [];
    const send = async (_chat: string, reply: { text: string }) => {
      messages.push(reply.text);
    };
    await Promise.all([
      sendDueTelegramReminders({ database, send }),
      sendDueTelegramReminders({ database, send }),
    ]);
    expect(messages).toHaveLength(1);
    const first = messages[0];
    await disconnectTelegram(userId, database);
    const retained = await database
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.userId, userId), eq(tasks.kind, 'telegram_reminder')),
      );
    expect(retained).toHaveLength(1);
    expect(retained[0].output).toEqual({ sent: true });
    // Simulate a sent task from the previous, link-specific key format.
    await database
      .update(tasks)
      .set({
        idempotencyKey: `telegram-reminder:123:${(retained[0].input as { sourceId: string }).sourceId}`,
      })
      .where(eq(tasks.id, retained[0].id));
    const code = await createTelegramLinkCode(userId, { database });
    expect(
      (
        await consumeTelegramLinkCode(
          new URL(code.url).searchParams.get('start')!,
          '900000000099',
          '900000000099',
          { database },
        )
      ).status,
    ).toBe('linked');
    await sendDueTelegramReminders({ database, send });
    expect(messages).toEqual([first]);
    // Existing sent history also enforces the cap before a daily counter exists.
    await database.delete(rateLimits).where(eq(rateLimits.userId, userId));
    await sendDueTelegramReminders({ database, send });
    expect(messages).toEqual([first]);
    // Only the unsent source is eligible after the daily window expires.
    await database
      .update(tasks)
      .set({ updatedAt: new Date(Date.now() - 86_400_000 - 1000) })
      .where(and(eq(tasks.userId, userId), eq(tasks.status, 'succeeded')));
    await database
      .update(rateLimits)
      .set({ windowStart: new Date(Date.now() - 86_400_000 - 1000) })
      .where(eq(rateLimits.userId, userId));
    await sendDueTelegramReminders({ database, send });
    expect(messages).toHaveLength(2);
    expect(messages[1]).not.toBe(first);
    await disconnectTelegram(userId, database);
    const next = await createTelegramLinkCode(userId, { database });
    await consumeTelegramLinkCode(
      new URL(next.url).searchParams.get('start')!,
      '900000000099',
      '900000000099',
      { database },
    );
    await database
      .update(rateLimits)
      .set({ windowStart: new Date(0) })
      .where(eq(rateLimits.userId, userId));
    await sendDueTelegramReminders({ database, send });
    expect(messages).toHaveLength(2);
  });

  it('does not send reminders when reminders are turned off', async () => {
    const role = await createJob(
      userId,
      {
        title: 'Research analyst',
        company: 'Example Lab',
        text: 'Research user needs and communicate findings clearly. Plan interviews, analyze qualitative and quantitative data, and share practical recommendations with product and delivery teams.',
      },
      { database },
    );
    await database.insert(reminders).values({
      userId,
      opportunityId: role.opportunity.id,
      title: 'Follow up',
      dueAt: new Date(Date.now() - 60_000),
    });
    await database.insert(telegramLinks).values({
      userId,
      telegramUserId: '900000000002',
      chatId: '900000000002',
      remindersEnabled: false,
    });
    const send = async () => {
      throw new Error('A disabled reminder was sent.');
    };

    await expect(sendDueTelegramReminders({ database, send })).resolves.toEqual(
      {
        sent: 0,
        processed: 0,
      },
    );
    await database
      .delete(telegramLinks)
      .where(eq(telegramLinks.userId, userId));
    await database.delete(reminders).where(eq(reminders.userId, userId));
  });

  it('waits three days for handoff buttons and reports the saved answer on a repeated press', async () => {
    const role = await createJob(
      userId,
      {
        title: 'Graduate analyst',
        company: 'Northstar',
        url: 'https://example.com/test-role',
        text: 'This role supports research, clear writing, careful data handling and client presentations. Work with experienced colleagues to prepare reports, organize project information, and communicate findings to internal and external audiences.',
      },
      { database },
    );
    await updateOpportunityStatus(
      userId,
      role.opportunity.id,
      'preparing',
      database,
    );
    const [fact] = await database
      .insert(profileFacts)
      .values({
        userId,
        kind: 'experience',
        text: 'Supported a team through research and clear writing.',
        source: 'user',
        status: 'approved',
      })
      .returning({ id: profileFacts.id });
    const [file] = await database
      .insert(files)
      .values({
        userId,
        r2Key: `telegram-reminder/${randomUUID()}.pdf`,
        kind: 'resume_pdf',
        originalName: 'approved-resume.pdf',
        contentType: 'application/pdf',
        size: 128,
      })
      .returning({ id: files.id });
    const [resume] = await database
      .insert(resumeVersions)
      .values({
        userId,
        opportunityId: role.opportunity.id,
        version: 1,
        approvedAt: new Date(),
        pdfFileId: file.id,
        content: {
          name: 'Alex Morgan',
          contact: 'alex@example.test',
          sections: [
            {
              title: 'Experience',
              bullets: [
                {
                  text: 'Supported a team through research and clear writing.',
                  fact_ids: [fact.id],
                },
              ],
            },
          ],
        },
      })
      .returning({ id: resumeVersions.id });
    const handoff = await createApplicationHandoff(
      userId,
      {
        opportunityId: role.opportunity.id,
        source: 'employer_link',
        resumeId: resume.id,
      },
      database,
    );
    if (handoff.outcome === 'skipped')
      throw new Error('Handoff fixture was skipped.');
    await database
      .update(applicationHandoffs)
      .set({ createdAt: new Date(Date.now() - 3 * 86_400_000 - 1000) })
      .where(eq(applicationHandoffs.id, handoff.handoff.id));
    await database.insert(telegramLinks).values({
      userId,
      telegramUserId: '900000000003',
      chatId: '900000000003',
      remindersEnabled: true,
    });

    const sent: Array<{
      text: string;
      buttons?: Array<{ data?: string; url?: string }>;
    }> = [];
    const readyAt = new Date(Date.now() - 3 * 86_400_000 - 1000);
    await database
      .update(applicationHandoffs)
      .set({ createdAt: new Date(Date.now() - 3 * 86_400_000 + 60_000) })
      .where(eq(applicationHandoffs.id, handoff.handoff.id));
    expect(
      await sendDueTelegramReminders({
        database,
        send: async (_chat, reply) => {
          sent.push(reply);
        },
      }),
    ).toEqual({ sent: 0, processed: 0 });
    const beforeDue = await database
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.userId, userId), eq(tasks.kind, 'telegram_reminder')),
      );
    expect(beforeDue).toHaveLength(0);
    // Also protect work queued by the previous implementation before it was due.
    const [link] = await database
      .select()
      .from(telegramLinks)
      .where(eq(telegramLinks.userId, userId));
    await database.insert(tasks).values({
      userId,
      kind: 'telegram_reminder',
      idempotencyKey: `telegram-reminder:${handoff.handoff.id}`,
      input: {
        source: 'application_handoff',
        sourceId: handoff.handoff.id,
        linkedAt: link.linkedAt.toISOString(),
      },
    });
    expect(
      await sendDueTelegramReminders({
        database,
        send: async (_chat, reply) => {
          sent.push(reply);
        },
      }),
    ).toEqual({ sent: 0, processed: 0 });
    expect(sent).toHaveLength(0);
    await database
      .update(applicationHandoffs)
      .set({ createdAt: readyAt })
      .where(eq(applicationHandoffs.id, handoff.handoff.id));
    const result = await sendDueTelegramReminders({
      database,
      appUrl: 'https://career.example.test',
      send: async (_chatId, reply) => {
        sent.push(reply);
      },
    });
    expect(result.sent).toBe(1);
    const buttons = sent[0]?.buttons ?? [];
    const notYet = buttons.find(
      (button) => button.data === `a:n:${handoff.handoff.id}`,
    )?.data;
    expect(notYet).toBe(`a:n:${handoff.handoff.id}`);
    expect(notYet!.length).toBeLessThan(48);

    const firstAnswer = await handleTelegramHandoff(userId, notYet!, database);
    const repeatedAnswer = await handleTelegramHandoff(
      userId,
      notYet!,
      database,
    );
    expect(firstAnswer[0]?.text).toMatch(/left this role in preparation/i);
    expect(repeatedAnswer[0]?.text).toMatch(/already marked this as not yet/i);
    const [saved] = await database
      .select({ response: applicationHandoffs.response })
      .from(applicationHandoffs)
      .where(eq(applicationHandoffs.id, handoff.handoff.id));
    expect(saved.response).toBe('not_yet');
    await database
      .delete(telegramLinks)
      .where(eq(telegramLinks.userId, userId));
  });

  it('rebuilds a retry reply from the current reminder source', async () => {
    const role = await createJob(
      userId,
      {
        title: 'Operations coordinator',
        company: 'Example Works',
        text: 'Coordinate daily operations, track actions, and prepare updates for a cross-functional team. Keep records accurate and raise delivery risks early.',
      },
      { database },
    );
    const [reminder] = await database
      .insert(reminders)
      .values({
        userId,
        opportunityId: role.opportunity.id,
        title: 'Original follow-up',
        dueAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: reminders.id });
    await database.insert(telegramLinks).values({
      userId,
      telegramUserId: '900000000004',
      chatId: '900000000004',
      remindersEnabled: true,
    });

    await expect(
      sendDueTelegramReminders({
        database,
        send: async () => {
          throw new Error('Temporary Telegram failure');
        },
      }),
    ).resolves.toEqual({ sent: 0, processed: 1 });
    await database
      .update(reminders)
      .set({ title: 'Updated follow-up' })
      .where(eq(reminders.id, reminder.id));
    await database
      .update(tasks)
      .set({ updatedAt: new Date(0) })
      .where(
        and(eq(tasks.userId, userId), eq(tasks.kind, 'telegram_reminder')),
      );

    const retryMessages: string[] = [];
    const retry = await sendDueTelegramReminders({
      database,
      send: async (_chatId, reply) => {
        retryMessages.push(reply.text);
      },
    });
    expect(retry.sent).toBe(1);
    expect(retryMessages).toEqual(['Follow-up reminder: Updated follow-up']);
    await database
      .delete(telegramLinks)
      .where(eq(telegramLinks.userId, userId));
  });

  it('turns a stale handoff answer button into a friendly reply', async () => {
    const replies = await handleTelegramHandoff(
      userId,
      `a:y:${randomUUID()}`,
      database,
    );
    expect(replies[0]?.text).toMatch(/already been answered or expired/i);
    expect(replies[0]?.text).not.toMatch(/HANDOFF|NOT_FOUND|ROLE_STATUS/);
  });
});
