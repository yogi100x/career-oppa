import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  companies,
  contacts,
  createDatabase,
  jobs,
  ledgerEntries,
  opportunities,
  profileFacts,
  reminders,
  suppressions,
  users,
  closeDatabase,
  type Database,
} from '@career-workspace/db';
import { createRecordedResponseGenerator } from '@career-workspace/adapters/ai';
import { balance } from './credits';
import { addSuppression, removeSuppression } from './suppressions';
import {
  createOutreach,
  editOutreach,
  getOutreach,
  handoffOutreach,
  markContactOutcome,
  markOutreachSent,
} from './outreach';

const integration = process.env.DATABASE_TEST_URL ? describe : describe.skip;
integration('grounded outreach and explicit handoff', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userId: string;
  let otherId: string;
  let opportunityId: string;
  let contactId: string;
  let factId: string;
  let companyId: string;
  const email = `outreach-${randomUUID()}@example.test`;
  beforeAll(async () => {
    const result = createDatabase(process.env.DATABASE_TEST_URL!);
    database = result.database;
    pool = result.pool;
    const insertedUsers = await database
      .insert(users)
      .values([
        { clerkId: `outreach-a-${randomUUID()}` },
        { clerkId: `outreach-b-${randomUUID()}` },
      ])
      .returning();
    [userId, otherId] = insertedUsers.map((user) => user.id);
    const [company] = await database
      .insert(companies)
      .values({
        name: 'Outreach fixture',
        normalizedName: `outreach-${randomUUID()}`,
      })
      .returning();
    companyId = company.id;
    const [job] = await database
      .insert(jobs)
      .values({
        userId,
        title: 'Developer',
        company: company.name,
        source: 'paste',
        text: 'Build accessible web tools with TypeScript and collaborate with the product team.',
        textHash: randomUUID(),
      })
      .returning();
    const [opportunity] = await database
      .insert(opportunities)
      .values({ userId, jobId: job.id })
      .returning();
    opportunityId = opportunity.id;
    const [fact] = await database
      .insert(profileFacts)
      .values({
        userId,
        kind: 'skill',
        text: 'Built accessible TypeScript interfaces.',
        source: 'user',
        status: 'approved',
      })
      .returning();
    factId = fact.id;
    const [contact] = await database
      .insert(contacts)
      .values({
        userId,
        opportunityId,
        companyId,
        providerContactId: `fixture-${randomUUID()}`,
        name: 'Casey',
        title: 'Engineer',
        email,
        revealedAt: new Date(),
        emailStatus: 'VALID',
      })
      .returning();
    contactId = contact.id;
  });
  afterAll(async () => {
    if (database && userId) {
      await database
        .delete(suppressions)
        .where(eq(suppressions.createdBy, userId));
      await database.delete(users).where(inArray(users.id, [userId, otherId]));
      await database.delete(companies).where(eq(companies.id, companyId));
    }
    if (pool) await pool.end();
    await closeDatabase();
  });
  const generate = () =>
    createRecordedResponseGenerator({
      'outreach.v2': {
        subject: 'Developer role',
        body: 'I built accessible TypeScript interfaces and would welcome a conversation about the role.',
        fact_ids: [factId],
      },
    });

  it('charges once, refuses other owners, requires handoff, and creates one reminder', async () => {
    const first = await createOutreach(
      userId,
      opportunityId,
      { contactId },
      'first',
      { database, generate: generate() },
    );
    const replay = await createOutreach(
      userId,
      opportunityId,
      { contactId },
      'first',
      { database, generate: generate() },
    );
    expect(replay.id).toBe(first.id);
    expect((await balance(userId, { database })).available).toBe(29);
    await expect(
      getOutreach(otherId, first.id, database),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      markOutreachSent(userId, first.id, database),
    ).rejects.toMatchObject({ code: 'NOT_HANDED_OFF' });
    await expect(
      handoffOutreach(
        userId,
        first.id,
        {
          confirmed: true,
          subject: first.subject,
          body: 'Changed text',
          method: 'copy',
        },
        database,
      ),
    ).rejects.toMatchObject({ code: 'DRAFT_CHANGED' });
    const handoff = await handoffOutreach(
      userId,
      first.id,
      {
        confirmed: true,
        subject: first.subject,
        body: first.body,
        method: 'copy',
      },
      database,
    );
    expect(handoff.recipient).toBe(email);
    await markOutreachSent(userId, first.id, database);
    await markOutreachSent(userId, first.id, database);
    expect(
      await database
        .select()
        .from(reminders)
        .where(
          and(eq(reminders.userId, userId), eq(reminders.outreachId, first.id)),
        ),
    ).toHaveLength(1);
    await markContactOutcome(userId, contactId, 'reply', database);
    expect(
      (
        await database
          .select()
          .from(reminders)
          .where(eq(reminders.outreachId, first.id))
      )[0].status,
    ).toBe('stopped');
  });

  it('rechecks suppressions before drafting and before handoff without extra credit charges', async () => {
    const draft = await createOutreach(
      userId,
      opportunityId,
      { contactId },
      'suppression',
      { database, generate: generate() },
    );
    const before = await balance(userId, { database });
    const suppression = await addSuppression(
      userId,
      { email, reason: 'Test opt-out' },
      database,
    );
    await expect(
      createOutreach(userId, opportunityId, { contactId }, 'suppressed', {
        database,
        generate: generate(),
      }),
    ).rejects.toMatchObject({ code: 'CONTACT_SUPPRESSED' });
    await expect(
      handoffOutreach(
        userId,
        draft.id,
        {
          confirmed: true,
          subject: draft.subject,
          body: draft.body,
          method: 'mailto',
        },
        database,
      ),
    ).rejects.toMatchObject({ code: 'CONTACT_SUPPRESSED' });
    expect((await balance(userId, { database })).available).toBe(
      before.available,
    );
    await removeSuppression(userId, suppression.id, database);
  });

  it('releases credits for unsupported generated facts and blocks unsupported edited text at handoff', async () => {
    const before = await balance(userId, { database });
    const bad = createRecordedResponseGenerator({
      'outreach.v2': {
        subject: 'Role',
        body: 'Invented experience.',
        fact_ids: [randomUUID()],
      },
    });
    await expect(
      createOutreach(userId, opportunityId, { contactId }, 'unsupported', {
        database,
        generate: bad,
      }),
    ).rejects.toMatchObject({ code: 'UNGROUNDED_CONTENT' });
    expect((await balance(userId, { database })).available).toBe(
      before.available,
    );
    const draft = await createOutreach(
      userId,
      opportunityId,
      { contactId },
      'edited',
      { database, generate: generate() },
    );
    const edited = await editOutreach(
      userId,
      draft.id,
      { subject: draft.subject, body: 'New unconfirmed claim.', fact_ids: [] },
      database,
    );
    await expect(
      handoffOutreach(
        userId,
        draft.id,
        {
          confirmed: true,
          subject: edited.subject,
          body: edited.body,
          method: 'copy',
        },
        database,
      ),
    ).rejects.toMatchObject({ code: 'UNGROUNDED_CONTENT' });
    const debits = await database
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.userId, userId), eq(ledgerEntries.kind, 'debit')),
      );
    expect(debits.length).toBe(3);
  });
});
