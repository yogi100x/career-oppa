import { eq } from 'drizzle-orm';
import { getDatabase, users, type Database } from '@career-workspace/db';
import {
  profilePreferences,
  type ProfilePreferences,
} from '@career-workspace/contracts';
import { ApiError } from './api';
import { recordEvent } from './events';
const selection = {
  targetRoles: users.targetRoles,
  preferredLocation: users.preferredLocation,
  workPreference: users.workPreference,
  paperSize: users.paperSize,
  cvName: users.cvName,
  cvContact: users.cvContact,
};
export async function getProfilePreferences(
  userId: string,
  database: Database = getDatabase(),
): Promise<ProfilePreferences> {
  const [row] = await database
    .select(selection)
    .from(users)
    .where(eq(users.id, userId));
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Profile not found.');
  return profilePreferences.parse(row);
}
export async function saveProfilePreferences(
  userId: string,
  input: ProfilePreferences,
  database: Database = getDatabase(),
) {
  const parsed = profilePreferences.parse(input);
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ deletionRequestedAt: users.deletionRequestedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'Profile not found.');
    if (user.deletionRequestedAt)
      throw new ApiError(
        403,
        'ACCOUNT_DELETION_PENDING',
        'Account deletion is in progress.',
      );
    const [row] = await tx
      .update(users)
      .set(parsed)
      .where(eq(users.id, userId))
      .returning(selection);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Profile not found.');
    await recordEvent(
      {
        userId,
        type: 'profile.preferences.updated',
        subjectType: 'user',
        subjectId: userId,
        data: {},
      },
      tx,
    );
    return profilePreferences.parse(row);
  });
}
