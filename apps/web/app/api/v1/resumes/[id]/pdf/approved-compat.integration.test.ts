import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  closeDatabase,
  createDatabase,
  files,
  profileFacts,
  resumeVersions,
  users,
  type Database,
} from '@career-workspace/db';
import { createJob } from '@career-workspace/core/roles';
import { saveResumeVersion } from '@career-workspace/core/resumes';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testAuth = vi.hoisted(() => ({ userId: '' }));
const fileStorage = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@career-workspace/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@career-workspace/core')>();
  return { ...actual, getOwnedUserFile: fileStorage.read };
});
vi.mock('../../../../../../lib/api-route', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../../../lib/api-route')
  >();
  return {
    ...actual,
    authenticateApi: async () =>
      testAuth.userId
        ? {
            id: testAuth.userId,
            clerkId: `clerk-${testAuth.userId}`,
            role: 'candidate',
            coachId: 'coach',
            targetRoles: [],
            preferredLocation: '',
            workPreference: 'any',
            paperSize: 'A4',
            ageConfirmedAt: new Date(),
            deletionRequestedAt: null,
            createdAt: new Date(),
          }
        : null,
  };
});

import { GET } from './route';

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('approved PDF mixed-case skill compatibility', () => {
  let database: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userId: string;
  let resumeId: string;
  let factId: string;
  const savedPdf = new TextEncoder().encode('%PDF-1.7\napproved test PDF');

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    process.env.DATABASE_URL = databaseUrl;
    const created = createDatabase(databaseUrl!);
    database = created.database;
    pool = created.pool;
    const [user] = await database
      .insert(users)
      .values({ clerkId: `approved-pdf-compat-${randomUUID()}` })
      .returning({ id: users.id });
    userId = user.id;
    testAuth.userId = userId;

    const [fact] = await database
      .insert(profileFacts)
      .values({
        userId,
        kind: 'skill',
        text: 'Built a javascript game',
        source: 'user',
        status: 'approved',
      })
      .returning({ id: profileFacts.id });
    factId = fact.id;
    const { opportunity } = await createJob(
      userId,
      {
        title: 'Software Developer',
        company: 'Compatibility Test',
        text: 'Build software with JavaScript and collaborate with a product team. '.repeat(3),
      },
      { database },
    );
    const resume = await saveResumeVersion(
      userId,
      opportunity.id,
      {
        name: 'Candidate A',
        contact: '',
        sections: [
          {
            title: 'Skills',
            bullets: [
              { text: 'Skills: JavaScript', fact_ids: [factId] },
            ],
          },
        ],
      },
      { database },
    );
    resumeId = resume.id;
    const [pdf] = await database
      .insert(files)
      .values({
        userId,
        r2Key: `files/${randomUUID()}.blob`,
        kind: 'resume_pdf',
        originalName: 'Candidate-A-CV.pdf',
        contentType: 'application/pdf',
        size: savedPdf.byteLength,
      })
      .returning({ id: files.id });
    await database
      .update(resumeVersions)
      .set({ approvedAt: new Date(), pdfFileId: pdf.id })
      .where(eq(resumeVersions.id, resumeId));
    fileStorage.read.mockResolvedValue({ kind: 'resume_pdf', contents: savedPdf });
  });

  afterAll(async () => {
    await closeDatabase();
    if (userId) await database.delete(users).where(eq(users.id, userId));
    await pool?.end();
    testAuth.userId = '';
  });

  it('serves the saved approved PDF when fact and CV use different JavaScript casing', async () => {
    const response = await GET(
      new Request(`http://localhost/api/v1/resumes/${resumeId}/pdf?approved=1`),
      { params: Promise.resolve({ id: resumeId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(savedPdf);
  });

  it('blocks the approved download after its cited fact is rejected', async () => {
    await database
      .update(profileFacts)
      .set({ status: 'rejected' })
      .where(eq(profileFacts.id, factId));

    const response = await GET(
      new Request(`http://localhost/api/v1/resumes/${resumeId}/pdf?approved=1`),
      { params: Promise.resolve({ id: resumeId }) },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('RESUME_NOT_GROUNDED');
  });
});
