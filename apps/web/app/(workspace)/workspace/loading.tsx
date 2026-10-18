import styles from '../../../components/workspace/route-state.module.css';
export default function WorkspaceLoading() {
  return (
    <main className={styles.state} aria-busy="true">
      <h1>Loading your workspace</h1>
      <p role="status">Getting your saved work. This may take a moment.</p>
    </main>
  );
}
