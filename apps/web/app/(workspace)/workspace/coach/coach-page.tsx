'use client';

import { useRouter } from 'next/navigation';
import { AppShell, Screen } from '../../../../components/workspace';
import CoachWorkspacePanel from '../../../../components/workspace/coach-panel';
import ProfileActions from '../profile/profile-actions';

export default function CoachPage() {
  const router = useRouter();
  return (
    <AppShell
      active="coach"
      onNavigate={() => router.push('/workspace')}
      profile={<ProfileActions />}
      chat={<CoachWorkspacePanel onClose={() => router.push('/workspace')} />}
    >
      <Screen
        title="Your coach"
        description="Talk through your experience, saved roles, and next steps."
      >
        <section
          aria-label="How coach suggestions work"
          className="workspace-empty"
        >
          <p>
            Your coach can suggest a role status change. You choose whether to
            confirm it.
          </p>
        </section>
      </Screen>
    </AppShell>
  );
}
