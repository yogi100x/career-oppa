import styles from '../../components/workspace/route-state.module.css';
export default function AdminLoading() {
  return (
    <main className={styles.state} aria-busy="true">
      <h1>Loading administration</h1>
      <p role="status">Getting the latest saved records.</p>
    </main>
  );
}
