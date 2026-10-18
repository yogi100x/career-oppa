import { redirect } from 'next/navigation';
import { Screen } from '../../../../components/workspace';
import { getCurrentUser } from '../../../../lib/current-user';
import { isClerkConfigured } from '../../../../lib/clerk-config';
import CreditsClient from './credits-client';
import ProfileFrame from '../profile/profile-frame';

export const dynamic = 'force-dynamic';

export default async function CreditsPage() {
  if (!isClerkConfigured()) redirect('/sign-in?setup=1');

  const user = await getCurrentUser();
  if (!user) redirect('/sign-in?redirect_url=/workspace/credits');

  return (
    <ProfileFrame>
      <Screen
        title="Your credits"
        description="See what you have, what you have used, and choose whether to add more."
      >
        <CreditsClient />
      </Screen>
    </ProfileFrame>
  );
}
