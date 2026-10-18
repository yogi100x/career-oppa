import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../../lib/current-user';
import { isClerkConfigured } from '../../../../lib/clerk-config';
import { Screen } from '../../../../components/workspace';
import ProfileFrame from './profile-frame';
import ProfileClient from './profile-client';
import { AccountDeletionRequest } from './account-deletion';
import TelegramConnection from './telegram-connection';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  if (!isClerkConfigured()) redirect('/sign-in?setup=1');

  const user = await getCurrentUser();
  if (!user) redirect('/sign-in?redirect_url=/workspace/profile');
  if (user.deletionRequestedAt) redirect('/workspace/account/deletion');

  return (
    <ProfileFrame>
      <Screen
        title="Your profile"
        description="Review the experience and project details you choose to save."
      >
        <ProfileClient>
          <TelegramConnection />
          <AccountDeletionRequest />
        </ProfileClient>
      </Screen>
    </ProfileFrame>
  );
}
