'use client';
import styles from '../../components/workspace/route-state.module.css';
export default function WorkspaceAccessError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className={styles.state}>
      <h1>Your workspace could not load</h1>
      <p role="alert">
        We could not check your account. Try again in a moment.
      </p>
      <button onClick={() => retry()}>Try again</button>
    </main>
  );
}
