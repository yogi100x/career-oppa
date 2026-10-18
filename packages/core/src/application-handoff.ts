import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type {
  AnswerApplicationHandoff,
  CreateApplicationHandoff,
} from '@career-workspace/contracts';
import {
  applicationHandoffs,
  getDatabase,
  jobs,
  opportunities,
  resumeVersions,
  users,
  type Database,
} from '@career-workspace/db';
import { ApiError } from './api';
import { recordEvent } from './events';
import { nextSteps } from './opportunity-status';
import { assertApprovedResumeUsable } from './resume-validity';

type ApplicationHandoffRow = typeof applicationHandoffs.$inferSelect;
export type ApprovedPdfHandoffResult =
  | {
      outcome: 'created' | 'existing';
      handoff: ApplicationHandoffRow;
    }
  | {
      outcome: 'skipped';
      reason: 'role_already_advanced';
    };

export async function createApplicationHandoff(
  userId: string,
  input: CreateApplicationHandoff,
  database: Database = getDatabase(),
): Promise<ApprovedPdfHandoffResult> {
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ deletionRequestedAt: users.deletionRequestedAt })
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

    const [ownedRole] = await tx
      .select({ opportunity: opportunities, job: jobs })
      .from(opportunities)
      .innerJoin(
        jobs,
        and(eq(jobs.id, opportunities.jobId), eq(jobs.userId, userId)),
      )
      .where(
        and(
          eq(opportunities.id, input.opportunityId),
          eq(opportunities.userId, userId),
        ),
      )
      .for('update');
    if (!ownedRole) throw new ApiError(404, 'NOT_FOUND', 'Role not found.');
    const { opportunity, job } = ownedRole;
    const preparationStatuses = new Set<string>([
      'saved',
      'reviewed',
      'preparing',
    ]);
    const roleIsPreparing = preparationStatuses.has(opportunity.status);
    if (!roleIsPreparing && input.source !== 'approved_pdf')
      throw new ApiError(
        409,
        'ROLE_NOT_PREPARING',
        'This role has already moved beyond preparation.',
      );
    if (input.source === 'employer_link' && !job.url)
      throw new ApiError(
        409,
        'EMPLOYER_LINK_UNAVAILABLE',
        'This role does not have an employer link to open.',
      );
    const [resume] = await tx
      .select({ id: resumeVersions.id })
      .from(resumeVersions)
      .where(
        and(
          input.resumeId ? eq(resumeVersions.id, input.resumeId) : undefined,
          eq(resumeVersions.userId, userId),
          eq(resumeVersions.opportunityId, input.opportunityId),
          isNotNull(resumeVersions.approvedAt),
        ),
      )
      .orderBy(desc(resumeVersions.version))
      .limit(1);
    if (!resume)
      throw new ApiError(
        409,
        'APPROVED_PDF_REQUIRED',
        'Approve a CV for this role before handing it off.',
      );

    await assertApprovedResumeUsable(userId, resume.id, tx);
    if (!roleIsPreparing)
      return { outcome: 'skipped', reason: 'role_already_advanced' } as const;

    if (opportunity.status !== 'preparing') {
      await tx
        .update(opportunities)
        .set({
          status: 'preparing',
          nextStep: nextSteps.preparing,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(opportunities.id, opportunity.id),
            eq(opportunities.userId, userId),
          ),
        );
      await recordEvent(
        {
          userId,
          type: 'opportunity.status_changed',
          subjectType: 'opportunity',
          subjectId: opportunity.id,
          data: {
            from: opportunity.status,
            to: 'preparing',
            nextStep: nextSteps.preparing,
          },
        },
        tx,
      );
    }

    const [inserted] = await tx
      .insert(applicationHandoffs)
      .values({
        userId,
        opportunityId: input.opportunityId,
        resumeId: resume.id,
        source: input.source,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      await recordEvent(
        {
          userId,
          type: 'application.handoff_prepared',
          subjectType: 'opportunity',
          subjectId: input.opportunityId,
          data: { source: input.source },
        },
        tx,
      );
      return { outcome: 'created', handoff: inserted } as const;
    }
    const [pending] = await tx
      .select()
      .from(applicationHandoffs)
      .where(
        and(
          eq(applicationHandoffs.userId, userId),
          eq(applicationHandoffs.opportunityId, input.opportunityId),
          isNull(applicationHandoffs.answeredAt),
        ),
      );
    if (!pending)
      throw new ApiError(
        409,
        'HANDOFF_CONFLICT',
        'The application handoff changed. Refresh and try again.',
      );
    return { outcome: 'existing', handoff: pending } as const;
  });
}

export async function listPendingApplicationHandoffs(
  userId: string,
  database: Database = getDatabase(),
) {
  const pending = await database
    .select({
      id: applicationHandoffs.id,
      resumeId: applicationHandoffs.resumeId,
      opportunityId: applicationHandoffs.opportunityId,
      source: applicationHandoffs.source,
      createdAt: applicationHandoffs.createdAt,
      title: jobs.title,
      company: jobs.company,
    })
    .from(applicationHandoffs)
    .innerJoin(
      opportunities,
      and(
        eq(opportunities.id, applicationHandoffs.opportunityId),
        eq(opportunities.userId, userId),
        eq(opportunities.status, 'preparing'),
      ),
    )
    .innerJoin(
      jobs,
      and(eq(jobs.id, opportunities.jobId), eq(jobs.userId, userId)),
    )
    .where(
      and(
        eq(applicationHandoffs.userId, userId),
        isNull(applicationHandoffs.answeredAt),
      ),
    )
    .orderBy(desc(applicationHandoffs.createdAt));
  const usable = await Promise.all(
    pending.map(async (item) => {
      if (!item.resumeId) return null;
      try {
        await assertApprovedResumeUsable(userId, item.resumeId, database);
        return item;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) return null;
        throw error;
      }
    }),
  );
  return usable.filter(
    (item): item is NonNullable<typeof item> => item !== null,
  );
}

export async function answerApplicationHandoff(
  userId: string,
  handoffId: string,
  input: AnswerApplicationHandoff,
  database: Database = getDatabase(),
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      handoffId,
    )
  )
    throw new ApiError(404, 'NOT_FOUND', 'Application handoff not found.');
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ deletionRequestedAt: users.deletionRequestedAt })
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

    const [handoff] = await tx
      .select()
      .from(applicationHandoffs)
      .where(
        and(
          eq(applicationHandoffs.id, handoffId),
          eq(applicationHandoffs.userId, userId),
        ),
      )
      .for('update');
    if (!handoff)
      throw new ApiError(404, 'NOT_FOUND', 'Application handoff not found.');
    if (handoff.answeredAt) {
      if (handoff.response === input.answer)
        return { handoff, alreadyAnswered: true };
      throw new ApiError(
        409,
        'HANDOFF_ALREADY_ANSWERED',
        'This application prompt was already answered.',
      );
    }

    const [opportunity] = await tx
      .select()
      .from(opportunities)
      .where(
        and(
          eq(opportunities.id, handoff.opportunityId),
          eq(opportunities.userId, userId),
        ),
      )
      .for('update');
    if (!opportunity) throw new ApiError(404, 'NOT_FOUND', 'Role not found.');
    if (opportunity.status !== 'preparing')
      throw new ApiError(
        409,
        'ROLE_STATUS_CHANGED',
        'This role changed. Refresh before answering.',
      );

    if (!handoff.resumeId)
      throw new ApiError(
        409,
        'APPROVED_PDF_REQUIRED',
        'Review and approve the CV again before answering.',
      );
    await assertApprovedResumeUsable(userId, handoff.resumeId, tx);

    let updatedOpportunity = opportunity;
    if (input.answer === 'applied') {
      [updatedOpportunity] = await tx
        .update(opportunities)
        .set({
          status: 'applied',
          nextStep: nextSteps.applied,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(opportunities.id, handoff.opportunityId),
            eq(opportunities.userId, userId),
            eq(opportunities.status, 'preparing'),
          ),
        )
        .returning();
      if (!updatedOpportunity)
        throw new ApiError(
          409,
          'STATUS_CHANGED',
          'This role changed elsewhere. Refresh and try again.',
        );
      await recordEvent(
        {
          userId,
          type: 'opportunity.status_changed',
          subjectType: 'opportunity',
          subjectId: handoff.opportunityId,
          data: {
            from: 'preparing',
            to: 'applied',
            nextStep: updatedOpportunity.nextStep,
          },
        },
        tx,
      );
    }
    const [answered] = await tx
      .update(applicationHandoffs)
      .set({ response: input.answer, answeredAt: new Date() })
      .where(
        and(
          eq(applicationHandoffs.id, handoffId),
          eq(applicationHandoffs.userId, userId),
          isNull(applicationHandoffs.answeredAt),
        ),
      )
      .returning();
    if (!answered)
      throw new ApiError(
        409,
        'HANDOFF_ALREADY_ANSWERED',
        'This application prompt was already answered.',
      );
    await recordEvent(
      {
        userId,
        type:
          input.answer === 'applied'
            ? 'application.confirmed_applied'
            : 'application.not_yet',
        subjectType: 'opportunity',
        subjectId: handoff.opportunityId,
        data: { handoffId },
      },
      tx,
    );
    return { handoff: answered, alreadyAnswered: false };
  });
}
