import { redirect } from 'next/navigation';
import { Screen } from '../../../../../components/workspace';
import { getCurrentUser } from '../../../../../lib/current-user';
import { isClerkConfigured } from '../../../../../lib/clerk-config';
import { AccountDeletionStatus } from '../../profile/account-deletion';
import ProfileFrame from '../../profile/profile-frame';

export const dynamic = 'force-dynamic';

export default async function AccountDeletionPage() {
  if (!isClerkConfigured()) redirect('/sign-in?setup=1');
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in?redirect_url=/workspace/profile');
  return (
    <ProfileFrame>
      <Screen
        title="Account cleanup"
        description="Your account will be removed after the cleanup finishes."
      >
        <AccountDeletionStatus />
      </Screen>
    </ProfileFrame>
  );
}
