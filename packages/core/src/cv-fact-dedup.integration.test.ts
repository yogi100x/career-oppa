import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createRecordedResponseGenerator } from '@career-workspace/adapters/ai';
import {
  cvExtractionPrompt,
  cvExtractionSchema,
} from '@career-workspace/adapters/ai/cv-extract';
import { LocalFolderStorage } from '@career-workspace/adapters/storage';
import {
  createDatabase,
  profileFacts,
  users,
  type Database,
} from '@career-workspace/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUserFile } from './files';
import { createTask } from './tasks';
import { runCvExtraction } from './cv';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;
const cvFact = (text: string, sourceQuote = '') => ({
  kind: 'experience',
  text,
  organisation: '',
  role: '',
  start: '',
  end: '',
  source_quote: sourceQuote,
});

integration('CV extraction deduplicates facts conservatively', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userId: string;
  let storageRoot: string;
  let storage: LocalFolderStorage;

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    ({ database, pool } = createDatabase(databaseUrl!));
    const [user] = await database
      .insert(users)
      .values({ clerkId: `cv-fact-dedup-${randomUUID()}` })
      .returning({ id: users.id });
    userId = user.id;
    storageRoot = await mkdtemp(join(tmpdir(), 'career-cv-dedup-'));
    storage = new LocalFolderStorage(storageRoot);
  });

  afterAll(async () => {
    if (userId) await database.delete(users).where(eq(users.id, userId));
    await pool?.end();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  async function makeTask() {
    const contents = await readFile(
      new URL('../../adapters/src/fixtures/sample-cv.docx', import.meta.url),
    );
    const file = await createUserFile(
      userId,
      { kind: 'cv_upload', originalName: 'sample.docx', contents },
      { database, storage },
    );
    const task = await createTask(
      userId,
      'cv_extract',
      `cv-dedup:${file.id}:${randomUUID()}`,
      { fileId: file.id },
      database,
    );
    return { file, task };
  }

  function generator(facts: ReturnType<typeof cvFact>[]) {
    const recording = createRecordedResponseGenerator({
      'cv-extract.v3': { facts },
    });
    return (text: string) =>
      recording(cvExtractionPrompt, cvExtractionSchema, { cvText: text });
  }

  it('checks approved, proposed, and rejected facts, while retaining changed numbers and quotes', async () => {
    const { file, task } = await makeTask();
    const [approved, proposed, rejected] = await database
      .insert(profileFacts)
      .values([
        {
          userId,
          kind: 'experience',
          text: 'Built secure customer account services for the product team across three annual releases',
          source: 'cv',
          status: 'approved',
        },
        {
          userId,
          kind: 'experience',
          text: 'Managed a team of 5 engineers',
          source: 'cv',
          status: 'proposed',
        },
        {
          userId,
          kind: 'experience',
          text: 'Provided support on weekend rotations',
          source: 'cv',
          status: 'rejected',
        },
      ])
      .returning({ id: profileFacts.id });
    const result = await runCvExtraction(userId, task.id, {
      database,
      storage,
      generate: generator([
        cvFact(
          'Built secure customer account services for the product team across three annual releases.',
        ),
        cvFact('Managed a team of 5 engineers.'),
        cvFact('Provided support on weekend rotations.'),
        cvFact('Managed a team of 6 engineers.', 'Volunteer   scheduling'),
      ]),
    });
    expect(result.output).toMatchObject({
      newFactCount: 1,
      duplicateFactCount: 3,
      duplicateFactIds: [approved.id, proposed.id],
    });
    expect(result.output?.duplicateFactIds).not.toContain(rejected.id);
    expect(result.output?.factIds).toHaveLength(1);
    const facts = await database
      .select()
      .from(profileFacts)
      .where(eq(profileFacts.userId, userId));
    expect(facts).toHaveLength(4);
    const added = facts.find((item) => item.sourceFileId === file.id);
    expect(added).toMatchObject({
      text: 'Managed a team of 6 engineers.',
      sourceQuote: 'Volunteer   scheduling',
      status: 'proposed',
    });
    expect(
      facts.find(
        (item) => item.text === 'Provided support on weekend rotations',
      )?.status,
    ).toBe('rejected');
  });

  it('serializes concurrent extractions so identical facts are inserted once', async () => {
    const [{ task: taskA }, { task: taskB }] = await Promise.all([
      makeTask(),
      makeTask(),
    ]);
    let callers = 0;
    let release!: () => void;
    const bothGenerated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recording = createRecordedResponseGenerator({
      'cv-extract.v3': {
        facts: [cvFact('Designed dependable customer account systems')],
      },
    });
    const waitForBoth = async (text: string) => {
      callers += 1;
      if (callers === 2) release();
      await bothGenerated;
      return recording(cvExtractionPrompt, cvExtractionSchema, {
        cvText: text,
      });
    };
    const [a, b] = await Promise.all([
      runCvExtraction(userId, taskA.id, {
        database,
        storage,
        generate: waitForBoth,
      }),
      runCvExtraction(userId, taskB.id, {
        database,
        storage,
        generate: waitForBoth,
      }),
    ]);
    expect(
      Number(a.output?.newFactCount) + Number(b.output?.newFactCount),
    ).toBe(1);
    expect(
      Number(a.output?.duplicateFactCount) +
        Number(b.output?.duplicateFactCount),
    ).toBe(1);
    const inserted = await database
      .select()
      .from(profileFacts)
      .where(
        and(
          eq(profileFacts.userId, userId),
          eq(profileFacts.text, 'Designed dependable customer account systems'),
        ),
      );
    expect(inserted).toHaveLength(1);
  });
});
