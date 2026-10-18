import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  events,
  suppressions,
  users,
} from '@career-workspace/db';
import {
  addSuppression,
  isEmailSuppressed,
  listSuppressions,
  removeSuppression,
} from './suppressions';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('admin email suppressions', () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  const clerkId = `suppression-admin-${randomUUID()}`;
  let adminId: string;

  beforeAll(async () => {
    if (new URL(testDatabaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    const [admin] = await database
      .insert(users)
      .values({ clerkId, role: 'admin' })
      .returning({ id: users.id });
    adminId = admin.id;
  });

  afterAll(async () => {
    await database.delete(users).where(eq(users.clerkId, clerkId));
    await pool.end();
  });

  it('hashes addresses consistently, audits changes, and never stores raw email', async () => {
    const address = `NoContact-${randomUUID()}@Example.test`;
    expect(
      await isEmailSuppressed(`  ${address.toLowerCase()} `, database),
    ).toBe(false);
    const record = await addSuppression(
      adminId,
      { email: address, reason: 'User requested no contact.' },
      database,
    );
    expect(await isEmailSuppressed(address.toUpperCase(), database)).toBe(true);
    expect(
      await isEmailSuppressed(` ${address.toLowerCase()} `, database),
    ).toBe(true);
    expect(await listSuppressions(database)).toContainEqual(record);

    const stored = await database
      .select()
      .from(suppressions)
      .where(eq(suppressions.id, record.id));
    expect(stored[0].emailHash).not.toContain(address);
    expect(JSON.stringify(stored)).not.toContain(address.toLowerCase());
    expect(record).not.toHaveProperty('emailHash');

    const audit = await database
      .select()
      .from(events)
      .where(
        and(
          eq(events.userId, adminId),
          eq(events.subjectId, record.id),
          eq(events.visibility, 'internal'),
        ),
      );
    expect(audit.map(({ type }) => type)).toContain('suppression.added');

    await removeSuppression(adminId, record.id, database);
    expect(await isEmailSuppressed(address, database)).toBe(false);
    await expect(
      removeSuppression(adminId, record.id, database),
    ).rejects.toMatchObject({
      status: 404,
    });
    const removedAudit = await database
      .select()
      .from(events)
      .where(
        and(
          eq(events.userId, adminId),
          eq(events.subjectId, record.id),
          eq(events.visibility, 'internal'),
        ),
      );
    expect(removedAudit.map(({ type }) => type)).toContain(
      'suppression.removed',
    );
  });
});
