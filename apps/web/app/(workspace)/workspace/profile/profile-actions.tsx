'use client';

import { UserButton } from '@clerk/nextjs';
import styles from './profile.module.css';

export default function ProfileActions() {
  return (
    <div className={styles.headerActions}>
      <span className={styles.accountLabel}>Account</span>
      <UserButton>
        <UserButton.MenuItems>
          <UserButton.Link
            href="/workspace/profile"
            label="Your profile"
            labelIcon={
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="6" r="3" />
                <path d="M4 17c.5-3.2 2.5-5 6-5s5.5 1.8 6 5" />
              </svg>
            }
          />
          <UserButton.Link
            href="/workspace/credits"
            label="Credits"
            labelIcon={
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="7" />
                <path d="M12.5 7.5c-.5-.6-1.2-.9-2.3-.9-1.3 0-2.2.6-2.2 1.6 0 2.5 4.5.8 4.5 3.3 0 1-.9 1.8-2.3 1.8-1.1 0-2-.4-2.6-1.1M10 5.5v9" />
              </svg>
            }
          />
          <UserButton.Action label="manageAccount" />
          <UserButton.Action label="signOut" />
        </UserButton.MenuItems>
      </UserButton>
    </div>
  );
}
