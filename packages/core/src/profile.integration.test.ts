import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  createDatabase,
  events,
  profileFacts,
  users,
} from '@career-workspace/db';
import { ApiError } from './api';
import {
  createProject,
  deleteProject,
  listProfileFacts,
  listProjects,
  updateProfileFact,
  updateProject,
} from './profile';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('profile facts and project ownership', () => {
  const { database, pool } = createDatabase(testDatabaseUrl!);
  const clerkIdA = `profile-a-${randomUUID()}`;
  const clerkIdB = `profile-b-${randomUUID()}`;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    const rows = await database
      .insert(users)
      .values([{ clerkId: clerkIdA }, { clerkId: clerkIdB }])
      .returning({ id: users.id });
    [userAId, userBId] = rows.map(({ id }) => id);
  });

  afterAll(async () => {
    await database
      .delete(users)
      .where(and(eq(users.clerkId, clerkIdA), eq(users.id, userAId)));
    await database
      .delete(users)
      .where(and(eq(users.clerkId, clerkIdB), eq(users.id, userBId)));
    await pool.end();
  });

  it('lists and updates only the owner’s facts and records review events', async () => {
    const [fact] = await database
      .insert(profileFacts)
      .values({
        userId: userAId,
        kind: 'experience',
        text: 'Built a useful internal tool.',
        source: 'cv',
        status: 'proposed',
      })
      .returning();

    expect(await listProfileFacts(userAId, database)).toContainEqual(fact);
    expect(await listProfileFacts(userBId, database)).toEqual([]);

    await expect(
      updateProfileFact(userBId, fact.id, { status: 'approved' }, database),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

    const changed = await updateProfileFact(
      userAId,
      fact.id,
      {
        text: 'Built and maintained a useful internal tool.',
        status: 'approved',
      },
      database,
    );
    expect(changed).toMatchObject({
      id: fact.id,
      status: 'proposed',
      text: 'Built and maintained a useful internal tool.',
    });
    const approved = await updateProfileFact(
      userAId,
      fact.id,
      { status: 'approved' },
      database,
    );
    expect(approved.status).toBe('approved');
    const [event] = await database
      .select()
      .from(events)
      .where(
        and(
          eq(events.userId, userAId),
          eq(events.subjectId, fact.id),
          eq(events.type, 'profile.fact.approved'),
        ),
      );
    expect(event).toBeTruthy();
    const edited = await updateProfileFact(
      userAId,
      fact.id,
      { text: 'A newly edited claim needs another review.' },
      database,
    );
    expect(edited.status).toBe('proposed');
  });

  it('creates proposed project facts, appends claims, and blocks cross-owner edits', async () => {
    const created = await createProject(
      userAId,
      {
        title: 'Community volunteering',
        summary: 'A local mentoring project.',
        links: ['https://example.com/project'],
        claims: [
          { kind: 'achievement', text: 'Mentored five students.' },
          { kind: 'skill', text: 'Planned weekly sessions.' },
        ],
      },
      database,
    );
    expect(created.claims).toHaveLength(2);
    expect(
      created.claims.every(
        (claim) =>
          claim.source === 'project' &&
          claim.status === 'proposed' &&
          claim.projectId === created.id,
      ),
    ).toBe(true);
    expect(await listProjects(userBId, database)).toEqual([]);
    await expect(
      updateProject(userBId, created.id, { title: 'Stolen project' }, database),
    ).rejects.toBeInstanceOf(ApiError);

    const updated = await updateProject(
      userAId,
      created.id,
      {
        title: 'Community mentoring',
        claims: [{ kind: 'experience', text: 'Coordinated weekly sessions.' }],
      },
      database,
    );
    expect(updated.title).toBe('Community mentoring');
    expect(updated.claims).toHaveLength(3);
    expect(updated.claims.every((claim) => claim.status === 'proposed')).toBe(
      true,
    );

    await expect(deleteProject(userBId, created.id, database)).rejects.toThrow(
      ApiError,
    );
    await deleteProject(userAId, created.id, database);
    expect(
      await database
        .select()
        .from(profileFacts)
        .where(eq(profileFacts.projectId, created.id)),
    ).toEqual([]);
  });
});
