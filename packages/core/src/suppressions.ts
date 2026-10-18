import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import {
  getDatabase,
  suppressions,
  type Database,
  type Transaction,
} from '@career-workspace/db';
import type { CreateSuppression } from '@career-workspace/contracts';
import { ApiError } from './api';
import { recordEvent } from './events';

function normalizeEmail(email: string) {
  return email.trim().normalize('NFC').toLowerCase();
}

export function hashSuppressionEmail(email: string) {
  return createHash('sha256')
    .update(normalizeEmail(email), 'utf8')
    .digest('hex');
}

/** Check a normalized SHA-256 hash; the original address is never persisted. */
export async function isEmailSuppressed(
  email: string,
  database: Database | Transaction = getDatabase(),
) {
  const hash = hashSuppressionEmail(email);
  const [match] = await database
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.emailHash, hash))
    .limit(1);
  return Boolean(match);
}

export async function listSuppressions(database: Database = getDatabase()) {
  return database
    .select({
      id: suppressions.id,
      reason: suppressions.reason,
      createdAt: suppressions.createdAt,
    })
    .from(suppressions)
    .orderBy(asc(suppressions.createdAt));
}

export async function addSuppression(
  adminUserId: string,
  input: CreateSuppression,
  database: Database = getDatabase(),
) {
  return database.transaction((tx) =>
    addSuppressionInTransaction(adminUserId, input, tx),
  );
}

/** Add a hashed address and event inside a caller-owned atomic transaction. */
export async function addSuppressionInTransaction(
  actorUserId: string,
  input: CreateSuppression,
  tx: Transaction,
) {
  const emailHash = hashSuppressionEmail(input.email);
  const [record] = await tx
    .insert(suppressions)
    .values({
      emailHash,
      reason: input.reason.trim(),
      createdBy: actorUserId,
    })
    .onConflictDoUpdate({
      target: suppressions.emailHash,
      set: { reason: input.reason.trim() },
    })
    .returning({
      id: suppressions.id,
      reason: suppressions.reason,
      createdAt: suppressions.createdAt,
    });
  await recordEvent(
    {
      userId: actorUserId,
      actorId: actorUserId,
      type: 'suppression.added',
      subjectType: 'suppression',
      subjectId: record.id,
      visibility: 'internal',
      data: { emailHash },
    },
    tx,
  );
  return record;
}

export async function removeSuppression(
  adminUserId: string,
  id: string,
  database: Database = getDatabase(),
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new ApiError(404, 'NOT_FOUND', 'Suppression not found.');
  return database.transaction(async (tx) => {
    const [record] = await tx
      .delete(suppressions)
      .where(eq(suppressions.id, id))
      .returning({ id: suppressions.id, emailHash: suppressions.emailHash });
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Suppression not found.');
    await recordEvent(
      {
        userId: adminUserId,
        actorId: adminUserId,
        type: 'suppression.removed',
        subjectType: 'suppression',
        subjectId: record.id,
        visibility: 'internal',
        data: { emailHash: record.emailHash },
      },
      tx,
    );
    return { id: record.id };
  });
}
