import { and, asc, eq } from "drizzle-orm";
import {
  events,
  getDatabase,
  type Database,
  type Transaction,
  type Event,
} from "@career-workspace/db";

export type RecordEventInput = {
  userId: string;
  type: string;
  actorId?: string | null;
  subjectType: string;
  subjectId: string;
  visibility?: "user" | "internal";
  data?: Record<string, unknown>;
};

export async function recordEvent(
  input: RecordEventInput,
  database: Database | Transaction = getDatabase(),
): Promise<Event> {
  const [event] = await database
    .insert(events)
    .values({
      userId: input.userId,
      type: input.type,
      actorId: input.actorId === undefined ? input.userId : input.actorId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      visibility: input.visibility ?? "user",
      data: input.data ?? {},
    })
    .returning();

  return event;
}

export async function queryEventsBySubject(
  input: { userId: string; subjectType: string; subjectId: string },
  database: Database | Transaction = getDatabase(),
): Promise<Event[]> {
  return database
    .select()
    .from(events)
    .where(
      and(
        eq(events.userId, input.userId),
        eq(events.subjectType, input.subjectType),
        eq(events.subjectId, input.subjectId),
        eq(events.visibility, "user"),
      ),
    )
    .orderBy(asc(events.createdAt), asc(events.id));
}
