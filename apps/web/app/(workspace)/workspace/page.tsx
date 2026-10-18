import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/current-user';
import { isClerkConfigured } from '../../../lib/clerk-config';
import WorkspaceHome from './workspace-home';
import { readFlags } from '@career-workspace/core';

export const dynamic = 'force-dynamic';

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    add?: string;
    setup?: string;
    returnRole?: string;
  }>;
}) {
  if (!isClerkConfigured()) redirect('/sign-in?setup=1');

  const user = await getCurrentUser();
  if (!user) redirect('/sign-in?redirect_url=/workspace');

  const params = await searchParams;
  const initialView =
    params.view === 'roles' || params.view === 'documents'
      ? params.view
      : undefined;
  return (
    <WorkspaceHome
      key={`${params.view ?? 'home'}:${params.setup ?? ''}:${params.returnRole ?? ''}`}
      initialView={initialView}
      initialSetup={
        params.setup === 'cv' || params.setup === 'role'
          ? params.setup
          : undefined
      }
      returnRole={
        params.returnRole && /^[0-9a-f-]{36}$/i.test(params.returnRole)
          ? params.returnRole
          : undefined
      }
      initialAddRole={params.add === '1'}
      practiceEnabled={readFlags(process.env).practice}
    />
  );
}
