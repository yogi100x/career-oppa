import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '../../../../lib/current-user';
import { isClerkConfigured } from '../../../../lib/clerk-config';
import DiscoveryPage from './discovery-page';

export const dynamic = 'force-dynamic';

export default async function DiscoverJobsPage() {
  if (process.env.FEATURE_DISCOVERY !== 'true') notFound();
  if (!isClerkConfigured()) redirect('/sign-in?setup=1');

  const user = await getCurrentUser();
  if (!user) redirect('/sign-in?redirect_url=/workspace/discover');
  if (user.deletionRequestedAt) redirect('/workspace/account/deletion');

  return <DiscoveryPage />;
}
