import { and, desc, eq } from 'drizzle-orm';
import {
  getDatabase,
  tasks,
  type Database,
  type Task,
} from '@career-workspace/db';
import type { CoachTools } from '@career-workspace/adapters/ai/coach';
import { ApiError } from './api';
import {
  coachReaders,
  confirmCoachProposal,
  listCoachProposals,
} from './coach';
import { getDiscoveryFeed, saveDiscoveredJob } from './discovery';
import { listPendingReminders } from './reminders';
import { getOpportunity } from './roles';
import { readFlags } from './flags';

const SAVE_KIND = 'coach_save_discovery';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type CoachDiscoveryMatch = {
  id: string;
  title: string;
  company: string;
  location: string;
  reasons: string[];
  url: string;
  savedOpportunityId: string | null;
};
export type CoachDiscoveryResult = {
  matches: CoachDiscoveryMatch[];
  message: string;
  updatedAt: string | null;
};
type SaveData = {
  discoveredJobId: string;
  title: string;
  company: string;
  url: string;
};
export type CoachSaveProposal = {
  id: string;
  kind: 'save_discovered_job';
  opportunityId: string | null;
  data: SaveData;
  confirmedAt: string | null;
};
function proposalFromTask(task: Task): CoachSaveProposal {
  return {
    id: task.id,
    kind: 'save_discovered_job',
    data: task.input as SaveData,
    opportunityId:
      (task.output as { opportunityId?: string } | null)?.opportunityId ?? null,
    confirmedAt:
      task.status === 'succeeded' ? task.updatedAt.toISOString() : null,
  };
}
function discoveryEnabled() {
  if (!readFlags(process.env).discovery)
    throw new ApiError(
      404,
      'NOT_FOUND',
      'Job discovery is not enabled in this workspace.',
    );
}

export async function discoveryMatches(
  userId: string,
  keyword?: string,
  database: Database = getDatabase(),
): Promise<CoachDiscoveryResult> {
  discoveryEnabled();
  if (
    keyword !== undefined &&
    (typeof keyword !== 'string' || keyword.length > 100)
  )
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Use a short keyword to filter collected matches.',
    );
  const feed = await getDiscoveryFeed(userId, database);
  const terms = (keyword ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const matches = feed.matches
    .filter(({ job }) => {
      const searchable =
        `${job.title} ${job.company} ${job.location} ${job.text}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    })
    .slice(0, 10)
    .map(({ job, reasons, savedOpportunityId }) => ({
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      reasons,
      url: job.url,
      savedOpportunityId,
    }));
  return {
    matches,
    updatedAt: feed.updatedAt,
    message: matches.length
      ? feed.profileReady
        ? 'These collected listings share keywords with your approved profile or chosen target roles. Read each match reason; a full fit review is a separate step.'
        : 'These are collected matches to your chosen target role, not a CV fit review or live search.'
      : 'No matches collected yet. Open Discover on the web to refresh.',
  };
}

export async function proposeDiscoveredJob(
  userId: string,
  id: string,
  database: Database = getDatabase(),
): Promise<CoachSaveProposal> {
  discoveryEnabled();
  if (!UUID.test(id))
    throw new ApiError(404, 'NOT_FOUND', 'This match is not available.');
  const match = (await getDiscoveryFeed(userId, database)).matches.find(
    ({ job }) => job.id === id,
  );
  if (!match)
    throw new ApiError(
      404,
      'NOT_FOUND',
      'This match is not available for your profile.',
    );
  // A proposal is durable but does not create a role or spend credits.
  const key = `coach-save:${userId}:${id}`;
  await database
    .insert(tasks)
    .values({
      userId,
      kind: SAVE_KIND,
      idempotencyKey: key,
      input: {
        discoveredJobId: id,
        title: match.job.title,
        company: match.job.company,
        url: match.job.url,
      },
    })
    .onConflictDoNothing({ target: tasks.idempotencyKey });
  const [task] = await database
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.idempotencyKey, key),
        eq(tasks.kind, SAVE_KIND),
      ),
    );
  return proposalFromTask(task);
}

export async function listCoachSaveProposals(
  userId: string,
  database: Database = getDatabase(),
) {
  const rows = await database
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.kind, SAVE_KIND)))
    .orderBy(desc(tasks.createdAt))
    .limit(50);
  return rows.map(proposalFromTask);
}
export async function listCoachToolProposals(
  userId: string,
  database: Database = getDatabase(),
) {
  const [status, saves] = await Promise.all([
    listCoachProposals(userId, database),
    listCoachSaveProposals(userId, database),
  ]);
  return [...status, ...saves];
}

export async function confirmCoachSaveProposal(
  userId: string,
  proposalId: string,
  database: Database = getDatabase(),
) {
  discoveryEnabled();
  if (!UUID.test(proposalId))
    throw new ApiError(404, 'NOT_FOUND', 'Suggestion not found.');
  return database.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, proposalId),
          eq(tasks.userId, userId),
          eq(tasks.kind, SAVE_KIND),
        ),
      )
      .for('update');
    if (!task) throw new ApiError(404, 'NOT_FOUND', 'Suggestion not found.');
    const proposal = proposalFromTask(task);
    if (proposal.confirmedAt && proposal.opportunityId) {
      const { opportunity } = await getOpportunity(
        userId,
        proposal.opportunityId,
        tx,
      );
      return { proposal, opportunity, alreadyConfirmed: true };
    }
    // Recheck the user's own current matches before the explicit save.
    const match = (await getDiscoveryFeed(userId, tx)).matches.find(
      ({ job }) => job.id === proposal.data.discoveredJobId,
    );
    if (!match)
      throw new ApiError(
        409,
        'MATCH_UNAVAILABLE',
        'This job is no longer in your collected matches. Open Discover to check again.',
      );
    const { opportunity } = await saveDiscoveredJob(userId, match.job.id, tx);
    const [saved] = await tx
      .update(tasks)
      .set({
        status: 'succeeded',
        output: { opportunityId: opportunity.id },
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id))
      .returning();
    return {
      proposal: proposalFromTask(saved),
      opportunity,
      alreadyConfirmed: false,
    };
  });
}

export async function confirmCoachToolProposal(
  userId: string,
  proposalId: string,
  database: Database = getDatabase(),
) {
  if (!UUID.test(proposalId))
    throw new ApiError(404, 'NOT_FOUND', 'Suggestion not found.');
  const [saved] = await database
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, proposalId),
        eq(tasks.userId, userId),
        eq(tasks.kind, SAVE_KIND),
      ),
    );
  return saved
    ? confirmCoachSaveProposal(userId, proposalId, database)
    : confirmCoachProposal(userId, proposalId, database);
}

/** One capability set for every coach surface. Hooks only capture output for presentation. */
export function coachToolset(
  userId: string,
  database: Database = getDatabase(),
  observe: {
    discovery?: (result: CoachDiscoveryResult) => void;
    proposal?: (proposal: CoachSaveProposal) => void;
  } = {},
): CoachTools {
  return {
    ...coachReaders(userId, database),
    reminders: () => listPendingReminders(userId, database),
    discoveryMatches: async (keyword?: string) => {
      const result = await discoveryMatches(userId, keyword, database);
      observe.discovery?.(result);
      return result;
    },
    saveDiscoveredJob: async (id: string) => {
      const proposal = await proposeDiscoveredJob(userId, id, database);
      observe.proposal?.(proposal);
      return proposal;
    },
  };
}
