import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, users, profileFacts } from '@career-workspace/db';
import { LocalFolderStorage } from '@career-workspace/adapters/storage';
import { createRecordedResponseGenerator } from '@career-workspace/adapters/ai';
import {
  cvExtractionPrompt,
  cvExtractionSchema,
} from '@career-workspace/adapters/ai/cv-extract';
import { and, eq } from 'drizzle-orm';
import { createUserFile } from './files';
import { createTask } from './tasks';
import { runCvExtraction } from './cv';

const url = process.env.DATABASE_TEST_URL;
const fact = (
  kind: 'education' | 'skill',
  text: string,
  extra: Partial<
    Record<'organisation' | 'start' | 'source_quote', string>
  > = {},
) => ({
  kind,
  text,
  organisation: '',
  role: '',
  start: '',
  end: '',
  source_quote: '',
  ...extra,
});
describe.skipIf(!url)('CV extraction with recorded AI responses', () => {
  const { database, pool } = createDatabase(url!);
  const ids: string[] = [];
  let root: string;
  let storage: LocalFolderStorage;
  beforeAll(async () => {
    if (new URL(url!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    root = await mkdtemp(join(tmpdir(), 'career-cv-'));
    storage = new LocalFolderStorage(root);
  });
  afterAll(async () => {
    for (const id of ids) await database.delete(users).where(eq(users.id, id));
    await pool.end();
    await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const [user] = await database
      .insert(users)
      .values({ clerkId: `cv-${randomUUID()}` })
      .returning();
    ids.push(user.id);
    const contents = await readFile(
      new URL('../../adapters/src/fixtures/sample-cv.docx', import.meta.url),
    );
    const file = await createUserFile(
      user.id,
      { kind: 'cv_upload', originalName: 'sample.docx', contents },
      { database, storage },
    );
    const task = await createTask(
      user.id,
      'cv_extract',
      `cv:${file.id}`,
      { fileId: file.id },
      database,
    );
    return { user, file, task };
  }
  it('extracts text, proposes facts, and replays completion without duplicate facts', async () => {
    const { user, file, task } = await fixture();
    const recording = createRecordedResponseGenerator({
      'cv-extract.v3': {
        facts: [
          fact('education', 'BSc Computer Science', {
            source_quote: 'Volunteer   scheduling',
          }),
        ],
      },
    });
    const generate = (text: string) =>
      recording(cvExtractionPrompt, cvExtractionSchema, { cvText: text });
    const completed = await runCvExtraction(user.id, task.id, {
      database,
      storage,
      generate,
    });
    expect(completed.status).toBe('succeeded');
    expect(completed.output?.text).toBeUndefined();
    expect(completed.output?.textLength).toBeGreaterThan(40);
    expect(JSON.stringify(completed.output)).not.toContain(
      'volunteer scheduling',
    );
    await runCvExtraction(user.id, task.id, { database, storage, generate });
    const facts = await database
      .select()
      .from(profileFacts)
      .where(eq(profileFacts.userId, user.id));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      status: 'proposed',
      source: 'cv',
      sourceFileId: file.id,
      sourceQuote: 'Volunteer   scheduling',
      organisation: null,
    });
  });
  it('does not duplicate facts the student already has when a CV is uploaded again', async () => {
    const { user, file, task } = await fixture();
    await database.insert(profileFacts).values({
      userId: user.id,
      kind: 'education',
      text: 'BSc Computer Science.',
      source: 'cv',
      status: 'approved',
    });
    const recording = createRecordedResponseGenerator({
      'cv-extract.v3': {
        facts: [
          fact('education', 'bsc computer science'),
          fact('skill', 'Python (basic)', {
            source_quote: 'not in this CV at all',
          }),
          fact('skill', 'Python (basic)'),
        ],
      },
    });
    await runCvExtraction(user.id, task.id, {
      database,
      storage,
      generate: (text: string) =>
        recording(cvExtractionPrompt, cvExtractionSchema, { cvText: text }),
    });
    const facts = await database
      .select({ text: profileFacts.text, status: profileFacts.status })
      .from(profileFacts)
      .where(eq(profileFacts.userId, user.id));
    expect(facts).toHaveLength(2);
    expect(facts).toContainEqual({
      text: 'Python (basic)',
      status: 'proposed',
    });
    const [python] = await database
      .select({ sourceQuote: profileFacts.sourceQuote })
      .from(profileFacts)
      .where(
        and(
          eq(profileFacts.userId, user.id),
          eq(profileFacts.text, 'Python (basic)'),
        ),
      );
    // A quote that is not in the CV text is not kept.
    expect(python.sourceQuote).toBeNull();
    expect(file.id).toBeTruthy();
  });

  it('records provider failure without inventing facts', async () => {
    const { user, task } = await fixture();
    const failed = await runCvExtraction(user.id, task.id, {
      database,
      storage,
      generate: async () => {
        throw new Error('Recorded provider failure');
      },
    });
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'CV_EXTRACTION_FAILED',
    });
    expect(failed.output?.textLength).toBeGreaterThan(40);
    expect(JSON.stringify(failed.output)).not.toContain('Education');
    expect(
      await database
        .select()
        .from(profileFacts)
        .where(eq(profileFacts.userId, user.id)),
    ).toHaveLength(0);
  });
  it('refuses to run another user’s task', async () => {
    const first = await fixture();
    const second = await fixture();
    await expect(
      runCvExtraction(second.user.id, first.task.id, { database, storage }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
