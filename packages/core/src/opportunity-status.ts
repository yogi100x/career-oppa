import { and, eq } from 'drizzle-orm';
import type { OpportunityStatus } from '@career-workspace/contracts';
import {
  getDatabase,
  opportunities,
  type Database,
} from '@career-workspace/db';
import { ApiError } from './api';
import { queryEventsBySubject, recordEvent } from './events';
import { getOpportunity } from './roles';

export type { OpportunityStatus };

export const nextSteps: Record<OpportunityStatus, string> = {
  saved: 'Review your fit for this role',
  reviewed: 'Decide whether to prepare an application',
  preparing: 'Finish and approve your tailored CV',
  applied: 'Follow up on your application',
  interviewing: 'Prepare for your interview',
  offer: 'Review your offer',
  rejected: 'Keep building your search momentum',
  withdrawn: 'Save this role for reference',
};

export async function updateOpportunityStatus(
  userId: string,
  opportunityId: string,
  status: OpportunityStatus,
  database: Database = getDatabase(),
) {
  const current = await getOpportunity(userId, opportunityId, database);
  if (current.opportunity.status === status) return current.opportunity;

  return database.transaction(async (tx) => {
    const [updated] = await tx
      .update(opportunities)
      .set({ status, nextStep: nextSteps[status], updatedAt: new Date() })
      .where(
        and(
          eq(opportunities.id, opportunityId),
          eq(opportunities.userId, userId),
          eq(opportunities.status, current.opportunity.status),
        ),
      )
      .returning();
    if (!updated)
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
        subjectId: opportunityId,
        data: {
          from: current.opportunity.status,
          to: updated.status,
          nextStep: updated.nextStep,
        },
      },
      tx,
    );
    return updated;
  });
}

export async function getOpportunityTimeline(
  userId: string,
  opportunityId: string,
  database: Database = getDatabase(),
) {
  await getOpportunity(userId, opportunityId, database);
  return queryEventsBySubject(
    { userId, subjectType: 'opportunity', subjectId: opportunityId },
    database,
  );
}
