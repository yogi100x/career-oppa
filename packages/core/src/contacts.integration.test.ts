import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contacts,
  createDatabase,
  creditHolds,
  ledgerEntries,
  rateLimits,
  users,
} from '@career-workspace/db';
import { GetLeadsError } from '@career-workspace/adapters/getleads';
import { balance } from './credits';
import { createJob } from './roles';
import { addSuppression, removeSuppression } from './suppressions';
import {
  CONTACTS_SEARCH_DAILY_LIMIT,
  CONTACTS_SEARCH_PER_MINUTE_LIMIT,
  createContactsSearchTask,
  getContact,
  listContacts,
  revealContactEmail,
  runContactsSearch,
} from './contacts';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('private contact search task', () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  const clerkA = `contacts-a-${randomUUID()}`;
  const clerkB = `contacts-b-${randomUUID()}`;
  const clerkC = `contacts-c-${randomUUID()}`;
  let userAId: string;
  let userBId: string;
  let userCId: string;

  async function candidate(clerkId: string) {
    const [user] = await database
      .insert(users)
      .values({ clerkId })
      .returning({ id: users.id });
    return user.id;
  }

  async function opportunity(userId: string) {
    return createJob(
      userId,
      {
        title: 'Talent Partner',
        company: 'Example Co',
        text: `Help our team hire people for meaningful roles. Reference ${randomUUID()}. `.repeat(4),
      },
      { database },
    );
  }

  const recordedPerson = {
    providerContactId: 'getleads-record-1',
    providerProfileUrl: 'https://www.linkedin.com/in/jane-doe',
    name: 'Jane Doe',
    title: 'Senior Talent Partner',
    companyName: 'Example Co',
    companyDomain: 'example.test',
    companyWebsite: 'https://example.test',
    emailStatus: 'VALID' as const,
    refreshedAt: new Date('2026-09-01T00:00:00.000Z'),
  };

  beforeAll(async () => {
    if (new URL(testDatabaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    userAId = await candidate(clerkA);
    userBId = await candidate(clerkB);
    userCId = await candidate(clerkC);
  });

  afterAll(async () => {
    await database.delete(users).where(eq(users.clerkId, clerkA));
    await database.delete(users).where(eq(users.clerkId, clerkB));
    await database.delete(users).where(eq(users.clerkId, clerkC));
    await pool.end();
  });

  it('saves recorded provider results once and keeps them scoped to the searching user', async () => {
    const { opportunity: roleA } = await opportunity(userAId);
    const { opportunity: roleB } = await opportunity(userBId);
    const search = async (input: {
      companyName: string;
      role: string;
      limit?: number;
    }) => {
      expect(input).toEqual({
        companyName: 'Example Co',
        role: 'Talent Partner',
        limit: 25,
      });
      return [recordedPerson];
    };
    const task = await createContactsSearchTask(
      userAId,
      roleA.id,
      'contacts-search-retry',
      database,
    );
    const retry = await createContactsSearchTask(
      userAId,
      roleA.id,
      'contacts-search-retry',
      database,
    );
    expect(retry.id).toBe(task.id);
    const { opportunity: roleA2 } = await opportunity(userAId);
    await expect(
      createContactsSearchTask(
        userAId,
        roleA2.id,
        'contacts-search-retry',
        database,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT', status: 409 });
    await expect(
      createContactsSearchTask(
        userBId,
        roleA.id,
        'cross-user-contact-search',
        database,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    const result = await runContactsSearch(userAId, task.id, {
      database,
      search,
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    });
    if (result.status !== 'succeeded')
      throw new Error(`Recorded contact search failed: ${result.error}`);
    expect(result).toMatchObject({
      status: 'succeeded',
      output: { contactIds: [expect.any(String)], count: 1 },
    });
    await runContactsSearch(userAId, task.id, { database, search });
    expect(
      await database
        .select()
        .from(contacts)
        .where(eq(contacts.userId, userAId)),
    ).toHaveLength(1);

    const saved = await listContacts(userAId, roleA.id, database);
    expect(saved[0]).toMatchObject({
      id: expect.any(String),
      name: 'Jane Doe',
      title: 'Senior Talent Partner',
      companyName: 'Example Co',
      source: 'getleads',
      sourceDate: recordedPerson.refreshedAt,
    });
    expect(saved[0]).toMatchObject({ email: null, revealedAt: null });
    expect(await listContacts(userBId, roleB.id, database)).toHaveLength(0);
    await expect(
      listContacts(userBId, roleA.id, database),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await database
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.userId, userBId),
            eq(contacts.opportunityId, roleB.id),
          ),
        ),
    ).toHaveLength(0);
  });

  it('reveals once for five credits, returns it free later, and blocks suppressed emails without charge', async () => {
    const { opportunity: role } = await opportunity(userAId);
    const unique = randomUUID();
    const people = [
      {
        ...recordedPerson,
        providerContactId: `reveal-${unique}`,
        name: 'Reveal Person',
      },
      {
        ...recordedPerson,
        providerContactId: `suppressed-${unique}`,
        providerProfileUrl: 'https://www.linkedin.com/in/suppressed-person',
        name: 'Suppressed Person',
      },
      {
        ...recordedPerson,
        providerContactId: `provider-failure-${unique}`,
        providerProfileUrl: 'https://www.linkedin.com/in/provider-failure',
        name: 'Provider Failure Person',
      },
      {
        ...recordedPerson,
        providerContactId: `concurrent-${unique}`,
        providerProfileUrl: 'https://www.linkedin.com/in/concurrent-person',
        name: 'Concurrent Person',
      },
      {
        ...recordedPerson,
        providerContactId: `same-key-${unique}`,
        providerProfileUrl: 'https://www.linkedin.com/in/same-key-person',
        name: 'Same Key Person',
      },
    ];
    const task = await createContactsSearchTask(
      userAId,
      role.id,
      `reveal-search-${unique}`,
      database,
    );
    const completed = await runContactsSearch(userAId, task.id, {
      database,
      search: async () => people,
    });
    if (completed.status !== 'succeeded')
      throw new Error(`Recorded contact search failed: ${completed.error}`);
    const [firstId, secondId, providerFailureId, concurrentId, sameKeyId] =
      completed.output?.contactIds as string[];
    const before = await balance(userAId, { database });
    const lookup = async (url: string) => ({
      email: url.includes('suppressed-person')
        ? `suppressed-${unique}@example.test`
        : `reveal-${unique}@example.test`,
      emailStatus: 'VALID' as const,
    });
    const revealed = await revealContactEmail(userAId, firstId!, {
      database,
      reveal: lookup,
      now: () => new Date('2026-10-06T12:00:00.000Z'),
    });
    expect(revealed).toMatchObject({
      charged: true,
      alreadyRevealed: false,
      contact: {
        email: `reveal-${unique}@example.test`,
        revealedAt: expect.any(Date),
      },
    });
    const after = await balance(userAId, { database });
    expect(before.available - after.available).toBe(5);
    const secondView = await revealContactEmail(userAId, firstId!, {
      database,
      reveal: async () => {
        throw new Error(
          'A repeated view must not make another provider lookup.',
        );
      },
    });
    expect(secondView).toMatchObject({ charged: false, alreadyRevealed: true });
    expect((await balance(userAId, { database })).available).toBe(
      after.available,
    );
    await expect(getContact(userBId, firstId!, database)).rejects.toMatchObject(
      { status: 404 },
    );

    const suppressedEmail = `suppressed-${unique}@example.test`;
    const suppression = await addSuppression(
      userBId,
      {
        email: suppressedEmail,
        reason: 'Test suppression.',
      },
      database,
    );
    const beforeBlocked = await balance(userAId, { database });
    await expect(
      revealContactEmail(userAId, secondId!, { database, reveal: lookup }),
    ).rejects.toMatchObject({ code: 'CONTACT_SUPPRESSED', status: 409 });
    expect((await balance(userAId, { database })).available).toBe(
      beforeBlocked.available,
    );
    const [suppressedHold] = await database
      .select({ status: creditHolds.status })
      .from(creditHolds)
      .where(
        eq(creditHolds.idempotencyKey, `${userAId}:contact-reveal:${secondId}`),
      );
    expect(suppressedHold?.status).toBe('released');
    await removeSuppression(userBId, suppression.id, database);

    const beforeFailure = await balance(userAId, { database });
    await expect(
      revealContactEmail(userAId, providerFailureId!, {
        database,
        reveal: async () => {
          throw new GetLeadsError('GETLEADS_UNAVAILABLE', 'recorded outage');
        },
      }),
    ).rejects.toMatchObject({ code: 'GETLEADS_UNAVAILABLE', status: 503 });
    expect((await balance(userAId, { database })).available).toBe(
      beforeFailure.available,
    );
    const [failedHold] = await database
      .select({ status: creditHolds.status })
      .from(creditHolds)
      .where(
        eq(
          creditHolds.idempotencyKey,
          `${userAId}:contact-reveal:${providerFailureId}`,
        ),
      );
    expect(failedHold?.status).toBe('released');

    const beforeConcurrent = await balance(userAId, { database });
    let lookups = 0;
    let releaseLookups!: () => void;
    let startLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      startLookup = resolve;
    });
    const lookupBarrier = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    const concurrentLookup = async () => {
      lookups += 1;
      startLookup();
      await lookupBarrier;
      return {
        email: `concurrent-${unique}@example.test`,
        emailStatus: 'VALID' as const,
      };
    };
    const firstConcurrent = revealContactEmail(userAId, concurrentId!, {
      database,
      reveal: concurrentLookup,
    });
    await lookupStarted;
    // The provider call must not hold the contact row lock.
    await database.transaction(async (tx) => {
      const [unlocked] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.id, concurrentId!))
        .for('update', { noWait: true });
      expect(unlocked?.id).toBe(concurrentId);
    });
    const [inFlightHold] = await database
      .select({ status: creditHolds.status })
      .from(creditHolds)
      .where(
        eq(
          creditHolds.idempotencyKey,
          `${userAId}:contact-reveal:${concurrentId}`,
        ),
      );
    expect(inFlightHold?.status).toBe('reserved');
    const secondConcurrent = revealContactEmail(userAId, concurrentId!, {
      database,
      reveal: concurrentLookup,
    });
    releaseLookups();
    const concurrentResults = await Promise.all([
      firstConcurrent,
      secondConcurrent,
    ]);
    expect(lookups).toBe(1);
    expect(concurrentResults.filter((result) => result.charged)).toHaveLength(
      1,
    );
    expect(
      concurrentResults.filter((result) => result.alreadyRevealed),
    ).toHaveLength(1);
    expect((await balance(userAId, { database })).available).toBe(
      beforeConcurrent.available - 5,
    );
    expect(await getContact(userAId, concurrentId!, database)).toMatchObject({
      email: `concurrent-${unique}@example.test`,
      revealedAt: expect.any(Date),
    });

    let sameKeyLookups = 0;
    let releaseSameKeyLookup!: () => void;
    let startSameKeyLookup!: () => void;
    const sameKeyStarted = new Promise<void>((resolve) => {
      startSameKeyLookup = resolve;
    });
    const sameKeyBarrier = new Promise<void>((resolve) => {
      releaseSameKeyLookup = resolve;
    });
    const sameKeyReveal = async () => {
      sameKeyLookups += 1;
      startSameKeyLookup();
      await sameKeyBarrier;
      return {
        email: `same-key-${unique}@example.test`,
        emailStatus: 'VALID' as const,
      };
    };
    const firstSameKey = revealContactEmail(userAId, sameKeyId!, {
      database,
      reveal: sameKeyReveal,
    });
    await sameKeyStarted;
    const secondSameKey = revealContactEmail(userAId, sameKeyId!, {
      database,
      reveal: sameKeyReveal,
    });
    releaseSameKeyLookup();
    const sameKeyResults = await Promise.all([firstSameKey, secondSameKey]);
    expect(sameKeyLookups).toBe(1);
    expect(sameKeyResults.filter((result) => result.charged)).toHaveLength(1);
    expect(
      sameKeyResults.filter((result) => result.alreadyRevealed),
    ).toHaveLength(1);
  });

  it('checks the balance before lookup and limits distinct search keys per user', async () => {
    const { opportunity: role } = await opportunity(userBId);
    const unique = randomUUID();
    await balance(userBId, { database });
    await database.insert(ledgerEntries).values({
      userId: userBId,
      bucket: 'free',
      kind: 'adjust',
      amount: -30,
      idempotencyKey: `contacts-zero-balance-${unique}`,
    });
    const task = await createContactsSearchTask(
      userBId,
      role.id,
      `contacts-zero-balance-search-${unique}`,
      database,
    );
    const completed = await runContactsSearch(userBId, task.id, {
      database,
      search: async () => [
        {
          ...recordedPerson,
          providerContactId: `zero-balance-${unique}`,
        },
      ],
    });
    if (completed.status !== 'succeeded')
      throw new Error(`Recorded contact search failed: ${completed.error}`);
    const [contactId] = completed.output?.contactIds as string[];
    let lookups = 0;
    await expect(
      revealContactEmail(userBId, contactId!, {
        database,
        reveal: async () => {
          lookups += 1;
          return {
            email: `zero-${unique}@example.test`,
            emailStatus: 'VALID' as const,
          };
        },
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    expect(lookups).toBe(0);

    for (let index = 0; index < 4; index += 1) {
      await createContactsSearchTask(
        userBId,
        role.id,
        `contacts-rate-search-${unique}-${index}`,
        database,
      );
    }
    await expect(
      createContactsSearchTask(
        userBId,
        role.id,
        `contacts-rate-search-${unique}-over-limit`,
        database,
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    // Reusing the same idempotency key returns its task without another slot.
    const retry = await createContactsSearchTask(
      userBId,
      role.id,
      `contacts-zero-balance-search-${unique}`,
      database,
    );
    expect(retry.id).toBe(task.id);
  });

  it('applies the daily search cap, charges retries of failed searches, and limits reveals', async () => {
    const { opportunity: role } = await opportunity(userCId);
    const unique = randomUUID();
    const failedKey = `contacts-failed-${unique}`;
    const failing = await createContactsSearchTask(
      userCId,
      role.id,
      failedKey,
      database,
    );
    const failed = await runContactsSearch(userCId, failing.id, {
      database,
      search: async () => {
        throw new GetLeadsError('GETLEADS_UNAVAILABLE', 'recorded outage');
      },
    });
    expect(failed.status).toBe('failed');

    // Fill the per-minute window: retrying the failed key must now be refused.
    await database
      .update(rateLimits)
      .set({ count: CONTACTS_SEARCH_PER_MINUTE_LIMIT, windowStart: new Date() })
      .where(
        and(
          eq(rateLimits.userId, userCId),
          eq(rateLimits.actionKey, 'contacts_search'),
        ),
      );
    await expect(
      createContactsSearchTask(userCId, role.id, failedKey, database),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });

    // With minute slots free but the daily cap used, new searches are refused.
    await database
      .delete(rateLimits)
      .where(
        and(
          eq(rateLimits.userId, userCId),
          eq(rateLimits.actionKey, 'contacts_search'),
        ),
      );
    await database
      .update(rateLimits)
      .set({ count: CONTACTS_SEARCH_DAILY_LIMIT, windowStart: new Date() })
      .where(
        and(
          eq(rateLimits.userId, userCId),
          eq(rateLimits.actionKey, 'contacts_search_daily'),
        ),
      );
    await expect(
      createContactsSearchTask(
        userCId,
        role.id,
        `contacts-daily-${unique}`,
        database,
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });

    await database.delete(rateLimits).where(eq(rateLimits.userId, userCId));
    const task = await createContactsSearchTask(
      userCId,
      role.id,
      `contacts-reveal-limit-${unique}`,
      database,
    );
    const completed = await runContactsSearch(userCId, task.id, {
      database,
      search: async () => [
        { ...recordedPerson, providerContactId: `reveal-limit-${unique}` },
      ],
    });
    const [contactId] = completed.output?.contactIds as string[];
    await database.insert(rateLimits).values({
      userId: userCId,
      actionKey: 'contact_reveal',
      count: 10,
      windowStart: new Date(),
    });
    let lookups = 0;
    await expect(
      revealContactEmail(userCId, contactId!, {
        database,
        reveal: async () => {
          lookups += 1;
          return {
            email: `limit-${unique}@example.test`,
            emailStatus: 'VALID' as const,
          };
        },
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(lookups).toBe(0);
  });
});
