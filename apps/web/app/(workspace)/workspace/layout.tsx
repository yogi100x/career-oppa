import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/current-user';
import { isClerkConfigured } from '../../../lib/clerk-config';

export default async function AuthenticatedWorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isClerkConfigured()) redirect('/sign-in?setup=1');
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in?redirect_url=/workspace');
  return children;
}
