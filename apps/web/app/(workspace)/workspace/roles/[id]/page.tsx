import { notFound, redirect } from 'next/navigation';
import { getOpportunity } from '@career-workspace/core/roles';
import { ApiError } from '@career-workspace/core';
import { getCurrentUser } from '../../../../../lib/current-user';
import WorkspaceHome from '../../workspace-home';
import { readFlags } from '@career-workspace/core';

export const dynamic = 'force-dynamic';
export default async function RolePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ review?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  const { id } = await params;
  try {
    await getOpportunity(user.id, id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  return (
    <WorkspaceHome
      initialOpportunityId={id}
      autoReview={(await searchParams).review === '1'}
      practiceEnabled={readFlags(process.env).practice}
    />
  );
}
