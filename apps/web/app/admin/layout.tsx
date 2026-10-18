import { redirect, notFound } from 'next/navigation';
import { getCurrentUser } from '../../lib/current-user';
import { isClerkConfigured } from '../../lib/clerk-config';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isClerkConfigured()) redirect('/sign-in?setup=1');
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  if (user.role !== 'admin') notFound();
  return children;
}
