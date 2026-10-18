import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  createDatabase,
  profileFacts,
  users,
  type Database,
} from '@career-workspace/db';
import { checkGrounding } from './grounding';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('checkGrounding', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let ownerId: string;
  let otherUserId: string;
  const factIds: string[] = [];

  beforeAll(async () => {
    const created = createDatabase(databaseUrl!);
    database = created.database;
    pool = created.pool;
    const [owner, other] = await database
      .insert(users)
      .values([
        { clerkId: `grounding-owner-${randomUUID()}` },
        { clerkId: `grounding-other-${randomUUID()}` },
      ])
      .returning({ id: users.id });
    ownerId = owner.id;
    otherUserId = other.id;

    const facts = await database
      .insert(profileFacts)
      .values([
        {
          userId: ownerId,
          kind: 'skill',
          text: 'Built TypeScript applications',
          source: 'user',
          status: 'approved',
        },
        {
          userId: ownerId,
          kind: 'achievement',
          text: 'Proposed measurable result',
          source: 'user',
          status: 'proposed',
        },
        {
          userId: ownerId,
          kind: 'experience',
          text: 'Rejected unsupported experience',
          source: 'user',
          status: 'rejected',
        },
        {
          userId: otherUserId,
          kind: 'skill',
          text: 'Another user’s fact',
          source: 'user',
          status: 'approved',
        },
        {
          userId: ownerId,
          kind: 'experience',
          text: 'I excel at teamwork and go the extra mile.',
          source: 'user',
          status: 'approved',
        },
      ])
      .returning({ id: profileFacts.id });
    factIds.push(...facts.map((fact) => fact.id));
  });

  afterAll(async () => {
    if (ownerId && otherUserId) {
      await database
        .delete(users)
        .where(inArray(users.id, [ownerId, otherUserId]));
    }
    await pool?.end();
  });

  it('allows only claims backed by owned approved facts and returns cited text', async () => {
    const result = await checkGrounding(
      ownerId,
      [
        {
          id: 'bullet-1',
          text: 'TypeScript application claim',
          fact_ids: [factIds[0]],
        },
      ],
      database,
    );

    expect(result.canApprove).toBe(true);
    expect(result.items[0]).toMatchObject({
      id: 'bullet-1',
      grounded: true,
      approvedFacts: [
        { id: factIds[0], text: 'Built TypeScript applications' },
      ],
      flags: [],
    });
  });

  it('flags facts owned by another user without revealing their contents', async () => {
    const result = await checkGrounding(
      ownerId,
      [{ text: 'Claim from another account', fact_ids: [factIds[3]] }],
      database,
    );

    expect(result.canApprove).toBe(false);
    expect(result.items[0].flags).toMatchObject([
      { code: 'FACT_NOT_FOUND_OR_NOT_OWNED', factId: factIds[3] },
    ]);
    expect(result.items[0].approvedFacts).toEqual([]);
  });

  it.each([
    ['proposed', 1],
    ['rejected', 2],
  ])('flags a %s fact', async (_status, index) => {
    const result = await checkGrounding(
      ownerId,
      [{ text: 'Claim needs approval', fact_ids: [factIds[index]] }],
      database,
    );

    expect(result.canApprove).toBe(false);
    expect(result.items[0].flags).toMatchObject([
      { code: 'FACT_NOT_APPROVED', factId: factIds[index] },
    ]);
  });

  it('flags missing references and claims with no references', async () => {
    const result = await checkGrounding(
      ownerId,
      [
        { text: 'Missing fact', fact_ids: [randomUUID()] },
        { text: 'No supporting fact', fact_ids: [] },
      ],
      database,
    );

    expect(result.canApprove).toBe(false);
    expect(result.items[0].flags[0].code).toBe('FACT_NOT_FOUND_OR_NOT_OWNED');
    expect(result.items[1].flags[0].code).toBe('NO_FACT_REFERENCES');
  });

  it('blocks an empty set of claims', async () => {
    const result = await checkGrounding(ownerId, [], database);

    expect(result.canApprove).toBe(false);
    expect(result.flags).toMatchObject([{ code: 'NO_CLAIMS' }]);
  });

  it('does not approve Excel as a skill from ordinary uses of excel and go', async () => {
    const result = await checkGrounding(
      ownerId,
      [{ text: 'Skills: Excel', fact_ids: [factIds[4]] }],
      database,
      { checkWording: true },
    );

    expect(result.canApprove).toBe(false);
    expect(result.items[0].flags).toContainEqual(
      expect.objectContaining({ code: 'DETAIL_NOT_IN_FACT' }),
    );
  });
});
