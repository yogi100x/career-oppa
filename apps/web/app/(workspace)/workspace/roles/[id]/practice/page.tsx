import { notFound } from 'next/navigation';
import { getOpportunity } from '@career-workspace/core/roles';
import { guardFeature, readFlags, ApiError } from '@career-workspace/core';
import { getCurrentUser } from '../../../../../../lib/current-user';
import PracticeWorkspace from './practice-workspace';

export const dynamic = 'force-dynamic';

export default async function PracticePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (guardFeature(readFlags(process.env), 'practice')) notFound();
  const user = await getCurrentUser();
  if (!user) notFound();
  const { id } = await params;
  try {
    const { job } = await getOpportunity(user.id, id);
    return <PracticeWorkspace opportunityId={id} roleTitle={job.title} company={job.company} />;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}
