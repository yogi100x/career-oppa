import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  files,
  getDatabase,
  users,
  resumeVersions,
  type Database,
  type FileRecord,
} from '@career-workspace/db';
import {
  getPrivateStorage,
  type PrivateStorage,
} from '@career-workspace/adapters/storage';
import { checkRateLimit } from '../rate-limit';
import { ApiError } from '../api';
import { assertApprovedResumeUsable } from '../resume-validity';

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const PDF_CONTENT_TYPE = 'application/pdf';
export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type UserFileKind =
  'cv_upload' | 'resume_pdf' | 'portfolio' | 'supporting_document';
export type CreateUserFileInput = {
  kind: UserFileKind;
  originalName: string;
  contents: Uint8Array;
};
type Options = { database?: Database; storage?: PrivateStorage; now?: Date };

export class FileValidationError extends Error {
  constructor(
    public code: 'INVALID_FILE' | 'FILE_TOO_LARGE' | 'UNSUPPORTED_FILE_TYPE',
    message: string,
  ) {
    super(message);
  }
}

export function safeOriginalName(name: string): string {
  const finalSegment = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const safeName = finalSegment
    .normalize('NFKC')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, 200);
  return safeName || 'upload';
}

function detectContentType(name: string, contents: Uint8Array): string {
  const extension = name.toLowerCase().split('.').pop();
  if (
    extension === 'pdf' &&
    new TextDecoder().decode(contents.subarray(0, 5)) === '%PDF-'
  ) {
    return PDF_CONTENT_TYPE;
  }
  if (
    extension === 'docx' &&
    contents[0] === 0x50 &&
    contents[1] === 0x4b &&
    contents[2] === 0x03 &&
    contents[3] === 0x04
  ) {
    return DOCX_CONTENT_TYPE;
  }
  throw new FileValidationError(
    'UNSUPPORTED_FILE_TYPE',
    'Upload a PDF or DOCX file.',
  );
}

function validateFile(input: CreateUserFileInput): {
  originalName: string;
  contentType: string;
} {
  if (input.contents.byteLength === 0) {
    throw new FileValidationError(
      'INVALID_FILE',
      'The selected file is empty.',
    );
  }
  if (input.contents.byteLength > MAX_UPLOAD_BYTES) {
    throw new FileValidationError(
      'FILE_TOO_LARGE',
      'Files must be 4 MB or smaller.',
    );
  }
  if (
    input.kind === 'resume_pdf' &&
    !input.originalName.toLowerCase().endsWith('.pdf')
  ) {
    throw new FileValidationError(
      'UNSUPPORTED_FILE_TYPE',
      'Resume files must be PDF files.',
    );
  }
  const originalName = safeOriginalName(input.originalName);
  const contentType = detectContentType(originalName, input.contents);
  if (input.kind === 'resume_pdf' && contentType !== PDF_CONTENT_TYPE) {
    throw new FileValidationError(
      'UNSUPPORTED_FILE_TYPE',
      'Resume files must be PDF files.',
    );
  }
  return { originalName, contentType };
}

export type PublicFileRecord = Pick<
  FileRecord,
  'id' | 'kind' | 'originalName' | 'contentType' | 'size' | 'createdAt'
>;

function publicRecord(record: FileRecord): PublicFileRecord {
  const { id, kind, originalName, contentType, size, createdAt } = record;
  return { id, kind, originalName, contentType, size, createdAt };
}

// A repeat upload is the user's latest CV again, so move it to the top.
async function touchReusedCv(
  tx: Pick<Database, 'update'>,
  fileId: string,
  now = new Date(),
): Promise<FileRecord> {
  const [touched] = await tx
    .update(files)
    .set({ createdAt: now })
    .where(eq(files.id, fileId))
    .returning();
  return touched;
}

export async function createUserFile(
  userId: string,
  input: CreateUserFileInput,
  options: Options = {},
): Promise<PublicFileRecord & { duplicate?: boolean }> {
  const validated = validateFile(input);
  const storage = options.storage ?? getPrivateStorage();
  const database = options.database ?? getDatabase();
  const key = `files/${randomUUID()}.blob`;
  const contentHash =
    input.kind === 'cv_upload'
      ? createHash('sha256').update(input.contents).digest('hex')
      : null;
  let duplicate = false;

  try {
    const record = await database.transaction(async (tx) => {
      const [user] = await tx
        .select({
          id: users.id,
          deletionRequestedAt: users.deletionRequestedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
      if (user.deletionRequestedAt)
        throw new ApiError(
          403,
          'ACCOUNT_DELETION_PENDING',
          'Account deletion is in progress.',
        );
      if (contentHash) {
        const [existing] = await tx
          .select()
          .from(files)
          .where(
            and(
              eq(files.userId, userId),
              eq(files.kind, 'cv_upload'),
              eq(files.contentHash, contentHash),
            ),
          )
          .limit(1);
        if (existing) {
          duplicate = true;
          return touchReusedCv(tx, existing.id, options.now);
        }
        // Older uploads have a null hash; compare same-size legacy files lazily.
        const legacy = await tx
          .select()
          .from(files)
          .where(
            and(
              eq(files.userId, userId),
              eq(files.kind, 'cv_upload'),
              eq(files.size, input.contents.byteLength),
              isNull(files.contentHash),
            ),
          );
        for (const candidate of legacy) {
          const bytes = await storage.get(candidate.r2Key).catch(() => null);
          if (
            bytes &&
            createHash('sha256').update(bytes).digest('hex') === contentHash
          ) {
            await tx
              .update(files)
              .set({ contentHash })
              .where(eq(files.id, candidate.id));
            duplicate = true;
            return touchReusedCv(tx, candidate.id, options.now);
          }
        }
        const limit = await checkRateLimit(
          userId,
          'cv_upload',
          { limit: 10, windowMs: 3_600_000 },
          tx,
        );
        if (!limit.allowed)
          throw new ApiError(
            429,
            'RATE_LIMITED',
            'Try another CV upload in an hour. Your saved CV is still available.',
          );
      }
      // Keep the user lock until the object key is recorded. Deletion takes
      // the same lock before listing files, so it cannot miss an in-flight put.
      await storage.put(key, input.contents, validated.contentType);
      const [created] = await tx
        .insert(files)
        .values({
          userId,
          r2Key: key,
          kind: input.kind,
          originalName: validated.originalName,
          contentType: validated.contentType,
          size: input.contents.byteLength,
          contentHash,
          createdAt: options.now,
        })
        .returning();
      return created;
    });
    return {
      ...publicRecord(record),
      ...(duplicate ? { duplicate: true } : {}),
    };
  } catch (error) {
    await storage.delete(key).catch(() => undefined);
    throw error;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DownloadableUserFile = PublicFileRecord & { contents: Uint8Array };

export async function getOwnedUserFile(
  userId: string,
  fileId: string,
  options: Options = {},
): Promise<DownloadableUserFile | null> {
  if (!UUID_PATTERN.test(fileId)) return null;
  const database = options.database ?? getDatabase();
  const [record] = await database
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .limit(1);
  if (!record) return null;
  const read = () => (options.storage ?? getPrivateStorage()).get(record.r2Key);
  const contents =
    record.kind === 'resume_pdf'
      ? await database.transaction(async (tx) => {
          const [owner] = await tx
            .select({ deletionRequestedAt: users.deletionRequestedAt })
            .from(users)
            .where(eq(users.id, userId))
            .for('no key update');
          if (!owner || owner.deletionRequestedAt) return null;
          const [resume] = await tx
            .select({ id: resumeVersions.id })
            .from(resumeVersions)
            .where(
              and(
                eq(resumeVersions.userId, userId),
                eq(resumeVersions.pdfFileId, record.id),
              ),
            )
            .for('update');
          if (!resume)
            throw new ApiError(
              409,
              'APPROVED_PDF_REQUIRED',
              'This PDF is no longer approved. Review the CV and approve it again.',
            );
          await assertApprovedResumeUsable(userId, resume.id, tx);
          return read();
        })
      : await read();
  if (!contents) return null;
  return { ...publicRecord(record), contents };
}
