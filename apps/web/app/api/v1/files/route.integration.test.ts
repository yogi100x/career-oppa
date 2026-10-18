import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import {
  createDatabase,
  users,
  closeDatabase,
  type Database,
} from '@career-workspace/db';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET } from './[id]/route';
import { POST } from './route';

const auth = vi.hoisted(() => ({ userId: '' }));

vi.mock('server-only', () => ({}));
vi.mock('../../../../lib/api-route', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../lib/api-route')>();
  return {
    ...actual,
    authenticateApi: async () =>
      auth.userId
        ? {
            id: auth.userId,
            clerkId: `clerk-${auth.userId}`,
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

const databaseUrl = process.env.DATABASE_TEST_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('private file routes', () => {
  let pool: ReturnType<typeof createDatabase>['pool'];
  let database: Database;
  let localRoot: string | undefined;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.STORAGE_DRIVER = 'local';
    localRoot = await mkdtemp(
      join(tmpdir(), 'career-workspace-private-files-'),
    );
    process.env.STORAGE_LOCAL_DIR = localRoot;

    const created = createDatabase(databaseUrl!);
    pool = created.pool;
    database = created.database;
    const fixture = randomUUID();
    const createdUsers = await database
      .insert(users)
      .values([
        { clerkId: `files-test-user-a-${fixture}` },
        { clerkId: `files-test-user-b-${fixture}` },
      ])
      .returning({ id: users.id });
    [userAId, userBId] = createdUsers.map(({ id }) => id);
  });

  afterAll(async () => {
    await closeDatabase();
    if (userAId && userBId) {
      await database.delete(users).where(inArray(users.id, [userAId, userBId]));
    }
    if (pool) await pool.end();
    if (localRoot) await rm(localRoot, { recursive: true, force: true });
    delete process.env.STORAGE_LOCAL_DIR;
    delete process.env.STORAGE_DRIVER;
  });

  it('uploads a private CV and lets its owner download it', async () => {
    auth.userId = userAId;
    const contents = new TextEncoder().encode(
      '%PDF-1.7\nprivate test document',
    );
    const form = new FormData();
    form.append(
      'file',
      new File([contents], '../../my-cv.pdf', { type: 'application/pdf' }),
    );

    const upload = await POST(
      new Request('http://localhost/api/v1/files', {
        method: 'POST',
        body: form,
      }),
    );
    expect(upload.status).toBe(201);
    const payload = (await upload.json()) as {
      data: {
        id: string;
        originalName: string;
        contentType: string;
        size: number;
      };
    };
    expect(payload.data).toMatchObject({
      originalName: 'my-cv.pdf',
      contentType: 'application/pdf',
      size: contents.byteLength,
    });
    expect(JSON.stringify(payload)).not.toContain('r2Key');

    const download = await GET(
      new Request(`http://localhost/api/v1/files/${payload.data.id}`),
      { params: Promise.resolve({ id: payload.data.id }) },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('cache-control')).toBe('private, no-store');
    expect(download.headers.get('content-disposition')).toContain('my-cv.pdf');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(contents);
  });

  it('returns 404 when another user requests the file', async () => {
    auth.userId = userAId;
    const form = new FormData();
    form.append(
      'file',
      new File([new TextEncoder().encode('%PDF-1.7\nprivate')], 'private.pdf', {
        type: 'application/pdf',
      }),
    );
    const upload = await POST(
      new Request('http://localhost/api/v1/files', {
        method: 'POST',
        body: form,
      }),
    );
    const payload = (await upload.json()) as { data: { id: string } };

    auth.userId = userBId;
    const response = await GET(
      new Request(`http://localhost/api/v1/files/${payload.data.id}`),
      { params: Promise.resolve({ id: payload.data.id }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'File not found.' },
    });
  });

  it('rejects files above the upload limit and files with a false type', async () => {
    auth.userId = userAId;
    const largeForm = new FormData();
    largeForm.append(
      'file',
      new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'large.pdf', {
        type: 'application/pdf',
      }),
    );
    const large = await POST(
      new Request('http://localhost/api/v1/files', {
        method: 'POST',
        body: largeForm,
      }),
    );
    expect(large.status).toBe(413);

    const invalidForm = new FormData();
    invalidForm.append(
      'file',
      new File(['not a PDF'], 'fake.pdf', { type: 'application/pdf' }),
    );
    const invalid = await POST(
      new Request('http://localhost/api/v1/files', {
        method: 'POST',
        body: invalidForm,
      }),
    );
    expect(invalid.status).toBe(400);
  });
});
