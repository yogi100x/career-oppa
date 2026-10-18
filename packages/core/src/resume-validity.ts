import {
  hasValidResumeContact,
  resumeClaims,
} from '@career-workspace/contracts';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  applicationHandoffs,
  answerDrafts,
  resumeVersions,
  tasks,
  type Database,
  type Transaction,
} from '@career-workspace/db';
import { checkGrounding } from './grounding';
import { ApiError } from './api';
import { recordEvent } from './events';

/** Caller holds the user lock before changing facts or checking an approval. */
export async function revokeResumesCitingFacts(
  userId: string,
  factIds: string[],
  database: Transaction,
) {
  if (!factIds.length) return;
  const changed = new Set(factIds);
  const approvedAnswers = await database
    .select()
    .from(answerDrafts)
    .where(
      and(eq(answerDrafts.userId, userId), isNotNull(answerDrafts.approvedAt)),
    )
    .for('update');
  for (const answer of approvedAnswers) {
    if (!answer.factIds.some((id) => changed.has(id))) continue;
    await database
      .update(answerDrafts)
      .set({ approvedAt: null, updatedAt: new Date() })
      .where(
        and(eq(answerDrafts.id, answer.id), eq(answerDrafts.userId, userId)),
      );
    await recordEvent(
      {
        userId,
        type: 'answer.approval_revoked',
        subjectType: 'opportunity',
        subjectId: answer.opportunityId,
        data: { answerId: answer.id, reason: 'CITED_FACT_CHANGED' },
      },
      database,
    );
  }
  const rows = await database
    .select()
    .from(resumeVersions)
    .where(
      and(
        eq(resumeVersions.userId, userId),
        isNotNull(resumeVersions.approvedAt),
      ),
    )
    .for('update');
  const affected = rows.filter((row) =>
    resumeClaims(row.content).some((claim) =>
      claim.fact_ids.some((id) => changed.has(id)),
    ),
  );
  for (const fileId of new Set(
    affected
      .map((row) => row.pdfFileId)
      .filter((id): id is string => Boolean(id)),
  )) {
    await database
      .insert(tasks)
      .values({
        userId,
        kind: 'revoked_pdf_cleanup',
        input: { fileId },
        idempotencyKey: `task:${userId}:revoked-pdf-cleanup:${fileId}`,
      })
      .onConflictDoNothing();
  }
  for (const row of affected) {
    const grounding = await checkGrounding(
      userId,
      resumeClaims(row.content),
      database,
    );
    await database
      .update(resumeVersions)
      .set({
        approvedAt: null,
        pdfFileId: null,
        groundingFlags: grounding.items.flatMap((item, index) =>
          item.flags.length
            ? [{ index, codes: item.flags.map((flag) => flag.code) }]
            : [],
        ),
      })
      .where(
        and(eq(resumeVersions.id, row.id), eq(resumeVersions.userId, userId)),
      );
    await recordEvent(
      {
        userId,
        type: 'resume.approval_revoked',
        subjectType: 'opportunity',
        subjectId: row.opportunityId,
        data: { resumeId: row.id, reason: 'CITED_FACT_CHANGED' },
      },
      database,
    );
  }
  if (affected.length)
    await database.delete(applicationHandoffs).where(
      and(
        eq(applicationHandoffs.userId, userId),
        inArray(
          applicationHandoffs.resumeId,
          affected.map((row) => row.id),
        ),
        isNull(applicationHandoffs.answeredAt),
      ),
    );
}

export function hasResumeHeader(content: { name: string; contact: string }) {
  return Boolean(content.name.trim() && hasValidResumeContact(content.contact));
}

/** Defence in depth for old approvals and facts changed outside the profile API. */
export async function assertApprovedResumeUsable(
  userId: string,
  resumeId: string,
  database: Database | Transaction,
) {
  const [resume] = await database
    .select()
    .from(resumeVersions)
    .where(
      and(eq(resumeVersions.id, resumeId), eq(resumeVersions.userId, userId)),
    );
  if (!resume?.approvedAt || !resume.pdfFileId)
    throw new ApiError(
      409,
      'APPROVED_PDF_REQUIRED',
      'Approve this CV again before downloading or applying.',
    );
  const grounding = await checkGrounding(
    userId,
    resumeClaims(resume.content),
    database,
    { lockFacts: true },
  );
  if (!grounding.canApprove)
    throw new ApiError(
      409,
      'RESUME_NOT_GROUNDED',
      'A cited fact changed. Review the flagged bullets and approve the CV again.',
    );
  if (!hasResumeHeader(resume.content))
    throw new ApiError(
      409,
      'RESUME_HEADER_REQUIRED',
      'Add and check your name and an email address or phone number before approving this CV.',
    );
  return resume;
}
