import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  CreateProject,
  PatchProfileFact,
  PatchProject,
  ProjectClaimInput,
} from '@career-workspace/contracts';
import type { PrivateStorage } from '@career-workspace/adapters/storage';
import {
  getDatabase,
  profileFacts,
  projects,
  users,
  type Database,
  type ProfileFact,
  type Project,
  type Transaction,
} from '@career-workspace/db';
import { ApiError } from './api';
import { recordEvent } from './events';
import { runPendingRevokedPdfCleanup } from './revoked-pdf-cleanup';
import { revokeResumesCitingFacts } from './resume-validity';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertProfileRecordId(id: string): void {
  if (!UUID_PATTERN.test(id))
    throw new ApiError(404, 'NOT_FOUND', 'The requested item was not found.');
}

export async function createProfileFact(
  userId: string,
  input: { kind: string; text: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (tx) => {
    const [fact] = await tx
      .insert(profileFacts)
      .values({
        userId,
        kind: input.kind,
        text: input.text,
        source: 'user',
        status: 'proposed',
      })
      .returning();
    await recordEvent(
      {
        userId,
        type: 'profile.fact.proposed',
        subjectType: 'profile_fact',
        subjectId: fact.id,
        data: { source: 'user' },
      },
      tx,
    );
    return fact;
  });
}

export async function listProfileFacts(
  userId: string,
  database: Database = getDatabase(),
): Promise<ProfileFact[]> {
  return database
    .select()
    .from(profileFacts)
    .where(eq(profileFacts.userId, userId))
    .orderBy(desc(profileFacts.createdAt), asc(profileFacts.id));
}

export async function updateProfileFact(
  userId: string,
  id: string,
  input: PatchProfileFact,
  database: Database = getDatabase(),
  cleanupOptions: { storage?: PrivateStorage } = {},
): Promise<ProfileFact> {
  assertProfileRecordId(id);
  const result = await database.transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    const [current] = await tx
      .select()
      .from(profileFacts)
      .where(and(eq(profileFacts.id, id), eq(profileFacts.userId, userId)))
      .limit(1)
      .for('update');
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Fact not found.');
    const changedText = input.text !== undefined && input.text !== current.text;
    const nextStatus = changedText
      ? 'proposed'
      : (input.status ?? current.status);
    const [updated] = await tx
      .update(profileFacts)
      .set({
        ...(input.text === undefined ? {} : { text: input.text }),
        status: nextStatus,
        updatedAt: new Date(),
      })
      .where(and(eq(profileFacts.id, id), eq(profileFacts.userId, userId)))
      .returning();

    const changedStatus = nextStatus !== current.status;
    if (changedText || (changedStatus && nextStatus !== 'approved')) {
      await revokeResumesCitingFacts(userId, [id], tx);
    }
    if (changedStatus || changedText) {
      await recordEvent(
        {
          userId,
          type: changedStatus
            ? `profile.fact.${nextStatus}`
            : 'profile.fact.updated',
          subjectType: 'profile_fact',
          subjectId: id,
          data: {
            ...(changedStatus
              ? { previousStatus: current.status, status: nextStatus }
              : {}),
            ...(changedText ? { textChanged: true } : {}),
          },
        },
        tx,
      );
    }
    return {
      fact: updated,
      shouldCleanup: changedText || (changedStatus && nextStatus !== 'approved'),
    };
  });
  if (result.shouldCleanup)
    await runPendingRevokedPdfCleanup(userId, {
      database,
      storage: cleanupOptions.storage,
    }).catch(() => undefined);
  return result.fact;
}

export type ProjectWithClaims = Project & { claims: ProfileFact[] };

async function withClaims(
  userId: string,
  projectRows: Project[],
  database: Database | Transaction,
): Promise<ProjectWithClaims[]> {
  if (!projectRows.length) return [];
  const facts = await database
    .select()
    .from(profileFacts)
    .where(
      and(
        eq(profileFacts.userId, userId),
        inArray(
          profileFacts.projectId,
          projectRows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(profileFacts.createdAt), asc(profileFacts.id));
  const byProject = new Map<string, ProfileFact[]>();
  for (const fact of facts) {
    if (!fact.projectId) continue;
    const existing = byProject.get(fact.projectId) ?? [];
    existing.push(fact);
    byProject.set(fact.projectId, existing);
  }
  return projectRows.map((row) => ({
    ...row,
    claims: byProject.get(row.id) ?? [],
  }));
}

async function insertProjectClaims(
  userId: string,
  projectId: string,
  claims: ProjectClaimInput[],
  database: Transaction,
) {
  if (!claims.length) return [];
  return database
    .insert(profileFacts)
    .values(
      claims.map((claim) => ({
        userId,
        projectId,
        kind: claim.kind,
        text: claim.text,
        source: 'project',
        status: 'proposed',
      })),
    )
    .returning();
}

export async function listProjects(
  userId: string,
  database: Database = getDatabase(),
): Promise<ProjectWithClaims[]> {
  const rows = await database
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt), asc(projects.id));
  return withClaims(userId, rows, database);
}

export async function createProject(
  userId: string,
  input: CreateProject,
  database: Database = getDatabase(),
): Promise<ProjectWithClaims> {
  return database.transaction(async (tx) => {
    const [created] = await tx
      .insert(projects)
      .values({
        userId,
        title: input.title,
        summary: input.summary,
        links: input.links,
      })
      .returning();
    await insertProjectClaims(userId, created.id, input.claims, tx);
    await recordEvent(
      {
        userId,
        type: 'project.created',
        subjectType: 'project',
        subjectId: created.id,
        data: { claimCount: input.claims.length },
      },
      tx,
    );
    return (await withClaims(userId, [created], tx))[0];
  });
}

export async function updateProject(
  userId: string,
  id: string,
  input: PatchProject,
  database: Database = getDatabase(),
): Promise<ProjectWithClaims> {
  assertProfileRecordId(id);
  return database.transaction(async (tx) => {
    const [updated] = await tx
      .update(projects)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.links === undefined ? {} : { links: input.links }),
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .returning();
    if (!updated) throw new ApiError(404, 'NOT_FOUND', 'Project not found.');
    const claims = input.claims ?? [];
    await insertProjectClaims(userId, updated.id, claims, tx);
    await recordEvent(
      {
        userId,
        type: 'project.updated',
        subjectType: 'project',
        subjectId: updated.id,
        data: {
          fields: Object.keys(input).filter((field) => field !== 'claims'),
          claimCount: claims.length,
        },
      },
      tx,
    );
    return (await withClaims(userId, [updated], tx))[0];
  });
}

export async function deleteProject(
  userId: string,
  id: string,
  database: Database = getDatabase(),
  cleanupOptions: { storage?: PrivateStorage } = {},
): Promise<{ id: string }> {
  assertProfileRecordId(id);
  const deleted = await database.transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    const claims = await tx
      .select({ id: profileFacts.id })
      .from(profileFacts)
      .where(
        and(eq(profileFacts.userId, userId), eq(profileFacts.projectId, id)),
      );
    const [deleted] = await tx
      .delete(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .returning({ id: projects.id });
    if (!deleted) throw new ApiError(404, 'NOT_FOUND', 'Project not found.');
    await revokeResumesCitingFacts(
      userId,
      claims.map((claim) => claim.id),
      tx,
    );
    await recordEvent(
      {
        userId,
        type: 'project.deleted',
        subjectType: 'project',
        subjectId: id,
      },
      tx,
    );
    return deleted;
  });
  await runPendingRevokedPdfCleanup(userId, {
    database,
    storage: cleanupOptions.storage,
  }).catch(() => undefined);
  return deleted;
}
