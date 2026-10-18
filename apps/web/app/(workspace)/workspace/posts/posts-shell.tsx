'use client';

import { useRouter } from 'next/navigation';
import { AppShell } from '../../../../components/workspace';
import ProfileActions from '../profile/profile-actions';
import PostsClient from './posts-client';
import styles from './posts.module.css';

export default function PostsShell({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  return (
    <AppShell
      active="posts"
      onNavigate={(view) =>
        router.push(view === 'home' ? '/workspace' : `/workspace?view=${view}`)
      }
      profile={<ProfileActions />}
    >
      {enabled ? (
        <PostsClient />
      ) : (
        <section className={styles.disabled}>
          <p>Posts are turned off</p>
          <h1>Project posts</h1>
          <p>
            This workspace feature is not enabled yet. Your approved project
            facts and drafts are unchanged.
          </p>
          <a href="/workspace/profile">Review your profile</a>
        </section>
      )}
    </AppShell>
  );
}
