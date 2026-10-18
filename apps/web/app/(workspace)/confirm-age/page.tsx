import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/current-user';
import { isClerkConfigured } from '../../../lib/clerk-config';

export const dynamic = 'force-dynamic';

export default async function ConfirmAgePage() {
  if (!isClerkConfigured()) redirect('/sign-in?setup=1');

  const user = await getCurrentUser();
  if (!user) redirect('/sign-in?redirect_url=/confirm-age');
  redirect('/workspace');
}
