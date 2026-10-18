import { and, asc, eq } from 'drizzle-orm';
import { getDatabase, reminders, type Database } from '@career-workspace/db';

export async function listPendingReminders(
  userId: string,
  database: Database = getDatabase(),
) {
  return database
    .select()
    .from(reminders)
    .where(and(eq(reminders.userId, userId), eq(reminders.status, 'pending')))
    .orderBy(asc(reminders.dueAt))
    .limit(50);
}
