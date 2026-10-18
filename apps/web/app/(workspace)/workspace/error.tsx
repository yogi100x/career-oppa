'use client';
import Link from 'next/link';
import styles from '../../../components/workspace/route-state.module.css';
export default function WorkspaceError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className={styles.state}>
      <h1>This page could not load</h1>
      <p role="alert">
        We could not read your saved work. Try loading the page again.
      </p>
      <button onClick={() => retry()}>Try again</button>
      <Link href="/workspace">Back to workspace</Link>
    </main>
  );
}
