import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../../lib/current-user';
import { isClerkConfigured } from '../../../../lib/clerk-config';
import CoachPage from './coach-page';

export const dynamic = 'force-dynamic';

export default async function WorkspaceCoachPage() {
  if (!isClerkConfigured()) redirect('/sign-in?setup=1');
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in?redirect_url=/workspace/coach');
  return <CoachPage />;
}
