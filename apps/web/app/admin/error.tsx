'use client';
import styles from '../../components/workspace/route-state.module.css';
export default function AdminError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className={styles.state}>
      <h1>These records could not load</h1>
      <p role="alert">Try again to get the latest records.</p>
      <button onClick={() => retry()}>Try again</button>
    </main>
  );
}
