'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '../../../../components/workspace';
import ProfileActions from './profile-actions';

export default function ProfileFrame({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <AppShell
      active="profile"
      onNavigate={() => router.push('/workspace')}
      profile={<ProfileActions />}
    >
      {children}
    </AppShell>
  );
}
