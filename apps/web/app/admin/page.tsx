import Link from 'next/link';
import styles from './admin-ops.module.css';

export default function AdminPage() {
  return (
    <main className={styles.page}>
      <h1>Administration</h1>
      <p>Review reward submissions and make recorded account adjustments.</p>
      <nav aria-label="Administration tools">
        <ul className={styles.adminNav}>
          <li>
            <Link href="/admin/rewards">Reward queue</Link>
          </li>
          <li>
            <Link href="/admin/users">Find a user</Link>
          </li>
          <li>
            <Link href="/admin/ledger-adjustments">Adjust credits</Link>
          </li>
          <li>
            <Link href="/admin/tasks">Failed tasks</Link>
          </li>
          <li>
            <Link href="/admin/suppressions">Do-not-contact list</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
