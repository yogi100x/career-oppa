import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  getPrivateStorage,
  type PrivateStorage,
} from '@career-workspace/adapters/storage';
import {
  getDatabase,
  files,
  users,
  resumeVersions,
  type Database,
} from '@career-workspace/db';
import type { ResumePageSize } from '@career-workspace/pdf';
import { renderResumePdf } from '@career-workspace/pdf';
import { resumeClaims, resumeFileName } from '@career-workspace/contracts';
import { checkGrounding } from './grounding';
import { ApiError } from './api';
import { recordEvent } from './events';
import { hasResumeHeader } from './resume-validity';
export { assertApprovedResumeUsable } from './resume-validity';

type ApprovalInput = {
  confirmedFactPairs: true;
  confirmedHeader: true;
  pageSize: ResumePageSize;
};

type ApprovalOptions = {
  database?: Database;
  storage?: PrivateStorage;
  render?: typeof renderResumePdf;
  now?: () => Date;
};

/** Approves a grounded resume version and stores one private PDF for that version. */
export async function approveResume(
  userId: string,
  resumeId: string,
  input: ApprovalInput,
  options: ApprovalOptions = {},
) {
  if (input.confirmedFactPairs !== true || input.confirmedHeader !== true)
    throw new ApiError(
      400,
      'MEANING_NOT_CONFIRMED',
      'Confirm your name and contact details, and that each CV bullet accurately reflects its cited facts.',
    );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      resumeId,
    )
  )
    throw new ApiError(404, 'NOT_FOUND', 'CV version not found.');

  const database = options.database ?? getDatabase();
  let objectKey: string | undefined;
  let storage: PrivateStorage | undefined = options.storage;
  try {
    return await database.transaction(async (tx) => {
      const [owner] = await tx
        .select({ deletionRequestedAt: users.deletionRequestedAt })
        .from(users)
        .where(eq(users.id, userId))
        .for('no key update');
      if (!owner) throw new ApiError(404, 'NOT_FOUND', 'CV version not found.');
      if (owner.deletionRequestedAt)
        throw new ApiError(
          403,
          'ACCOUNT_DELETION_PENDING',
          'Account deletion is in progress.',
        );
      const [resume] = await tx
        .select()
        .from(resumeVersions)
        .where(
          and(
            eq(resumeVersions.id, resumeId),
            eq(resumeVersions.userId, userId),
          ),
        )
        .for('update')
        .limit(1);
      if (!resume)
        throw new ApiError(404, 'NOT_FOUND', 'CV version not found.');

      if (!hasResumeHeader(resume.content))
        throw new ApiError(
          409,
          'RESUME_HEADER_REQUIRED',
          'Add your name and an email address or phone number before approving this CV.',
        );

      const claims = resumeClaims(resume.content);
      const grounding = await checkGrounding(userId, claims, tx, {
        lockFacts: true,
        checkWording: true,
      });
      if (!grounding.canApprove)
        throw new ApiError(
          409,
          'RESUME_NOT_GROUNDED',
          'Resolve every grounding issue before approving this CV.',
        );

      if (resume.approvedAt && resume.pdfFileId) return resume;

      const contents = await (options.render ?? renderResumePdf)(
        resume.content,
        input.pageSize,
      );
      storage ??= getPrivateStorage();
      objectKey = `files/${randomUUID()}.blob`;
      await storage.put(objectKey, contents, 'application/pdf');
      const [file] = await tx
        .insert(files)
        .values({
          userId,
          r2Key: objectKey,
          kind: 'resume_pdf',
          originalName: resumeFileName(resume.content.name),
          contentType: 'application/pdf',
          size: contents.byteLength,
        })
        .returning();
      const approvedAt = (options.now ?? (() => new Date()))();
      const [approved] = await tx
        .update(resumeVersions)
        .set({
          approvedAt,
          pdfFileId: file.id,
          pageSize: input.pageSize,
        })
        .where(
          and(
            eq(resumeVersions.id, resumeId),
            eq(resumeVersions.userId, userId),
          ),
        )
        .returning();
      // Remember the confirmed header so the next draft starts with it.
      await tx
        .update(users)
        .set({ cvName: resume.content.name, cvContact: resume.content.contact })
        .where(eq(users.id, userId));
      await recordEvent(
        {
          userId,
          type: 'resume.approved',
          subjectType: 'opportunity',
          subjectId: resume.opportunityId,
          data: {
            resumeId: resume.id,
            version: resume.version,
            pageSize: input.pageSize,
          },
        },
        tx,
      );
      return approved;
    });
  } catch (error) {
    if (objectKey && storage)
      await storage.delete(objectKey).catch(() => undefined);
    throw error;
  }
}
