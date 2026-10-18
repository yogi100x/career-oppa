'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell, Screen } from '../../../components/workspace';
import { CoachWorkspacePanel } from '../../../components/workspace/coach-panel';
import DocumentsPanel from './documents-panel';
import HomeDashboard from './home-dashboard';
import ProfileActions from './profile/profile-actions';
import RolesPanel from './roles-panel';
import ActivationFlow from './activation-flow';

type WorkspaceView = 'home' | 'roles' | 'documents';

const emptyContent: Record<
  WorkspaceView,
  { title: string; description: string }
> = {
  home: {
    title: 'Your next step starts here.',
    description:
      'Your workspace is ready. Add a role when you’re ready to begin.',
  },
  roles: {
    title: 'My roles',
    description: 'Roles you save will appear here.',
  },
  documents: {
    title: 'My documents',
    description:
      'Your résumé versions and supporting documents will appear here.',
  },
};

export default function WorkspaceHome({
  initialOpportunityId,
  initialView,
  initialAddRole = false,
  practiceEnabled = false,
  initialSetup,
  returnRole,
  autoReview = false,
}: {
  initialOpportunityId?: string;
  initialView?: WorkspaceView;
  initialAddRole?: boolean;
  practiceEnabled?: boolean;
  initialSetup?: 'cv' | 'role';
  returnRole?: string;
  autoReview?: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState<WorkspaceView>(
    initialOpportunityId ? 'roles' : (initialView ?? 'home'),
  );
  const [coachOpportunityId, setCoachOpportunityId] = useState<string | null>(
    null,
  );
  const content = emptyContent[view];

  return (
    <AppShell
      active={view}
      onNavigate={(next) => {
        setCoachOpportunityId(null);
        setView(next as WorkspaceView);
      }}
      profile={<ProfileActions />}
      chat={
        view === 'roles' && coachOpportunityId ? (
          <CoachWorkspacePanel
            opportunityId={coachOpportunityId}
            onClose={() => setCoachOpportunityId(null)}
          />
        ) : undefined
      }
    >
      {initialSetup ? (
        <ActivationFlow
          cvOnly={initialSetup === 'cv'}
          returnRole={returnRole}
          onComplete={() => {
            window.location.assign(
              returnRole
                ? `/workspace/roles/${returnRole}?review=1`
                : '/workspace',
            );
          }}
        />
      ) : view === 'roles' ? (
        <RolesPanel
          onAskCoach={setCoachOpportunityId}
          initialOpportunityId={initialOpportunityId}
          autoReview={autoReview}
          initialAddRole={initialAddRole}
          practiceEnabled={practiceEnabled}
          onBackToRoles={
            initialOpportunityId
              ? () => router.push('/workspace?view=roles')
              : undefined
          }
        />
      ) : view === 'home' ? (
        <HomeDashboard
          onReviewProfile={() => router.push('/workspace/profile')}
          onOpenRole={(opportunityId) =>
            router.push(`/workspace/roles/${opportunityId}`)
          }
        />
      ) : view === 'documents' ? (
        <DocumentsPanel />
      ) : (
        <Screen title={content.title} description={content.description}>
          <section aria-label={content.title} className="workspace-empty">
            <p>
              {view === 'home' ? 'Nothing saved yet.' : content.description}
            </p>
          </section>
        </Screen>
      )}
    </AppShell>
  );
}
