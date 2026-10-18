'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../../../components/workspace';
import type { ProfilePreferences } from '@career-workspace/contracts';
import styles from './profile.module.css';
const defaults: ProfilePreferences = {
  targetRoles: [],
  preferredLocation: '',
  workPreference: 'any',
  paperSize: 'A4',
};
export default function ProfilePreferencesForm() {
  const [values, setValues] = useState(defaults),
    [roles, setRoles] = useState(''),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function load() {
    setError('');
    try {
      const response = await fetch('/api/v1/profile/preferences', {
        cache: 'no-store',
      });
      const body = await response.json();
      if (!response.ok || !body.data)
        throw new Error('Your preferences could not be loaded.');
      setValues(body.data);
      setRoles(body.data.targetRoles.join('\n'));
      setLoaded(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Preferences could not be loaded.',
      );
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const response = await fetch('/api/v1/profile/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          targetRoles: [
            ...new Set(
              roles
                .split('\n')
                .map((role) => role.trim())
                .filter(Boolean),
            ),
          ],
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error?.message ?? 'Your preferences could not be saved.',
        );
      setValues(body.data);
      setRoles(body.data.targetRoles.join('\n'));
      setNotice('Preferences saved.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Preferences could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.section} aria-labelledby="preferences-heading">
      <div className={styles.sectionHeading}>
        <h2 id="preferences-heading">Your role preferences</h2>
        <p>Save the roles, location and work arrangement you prefer.</p>
      </div>
      {error && (
        <p role="alert">
          {error}{' '}
          {!loaded && <Button onClick={() => void load()}>Try again</Button>}
        </p>
      )}
      {!loaded ? (
        !error && <p role="status">Loading your preferences…</p>
      ) : (
        <form onSubmit={save} className={styles.projectForm}>
          <label className={styles.field}>
            Name on your CV
            <input
              value={values.cvName ?? ''}
              maxLength={200}
              autoComplete="name"
              onChange={(e) => setValues({ ...values, cvName: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            Contact line on your CV (email or phone)
            <input
              value={values.cvContact ?? ''}
              maxLength={500}
              onChange={(e) =>
                setValues({ ...values, cvContact: e.target.value })
              }
              placeholder="you@example.com · 07700 900123"
            />
          </label>
          <label className={styles.field}>
            Target roles, one per line
            <textarea
              value={roles}
              maxLength={4000}
              rows={3}
              onChange={(e) => setRoles(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            Preferred location
            <input
              value={values.preferredLocation}
              maxLength={200}
              onChange={(e) =>
                setValues({ ...values, preferredLocation: e.target.value })
              }
              placeholder="City, region or country"
            />
          </label>
          <label className={styles.field}>
            Work arrangement
            <select
              value={values.workPreference}
              onChange={(e) =>
                setValues({
                  ...values,
                  workPreference: e.target
                    .value as ProfilePreferences['workPreference'],
                })
              }
            >
              <option value="any">Any arrangement</option>
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">On site</option>
            </select>
          </label>
          <label className={styles.field}>
            Default CV page size
            <select
              value={values.paperSize}
              onChange={(e) =>
                setValues({
                  ...values,
                  paperSize: e.target.value as ProfilePreferences['paperSize'],
                })
              }
            >
              <option value="A4">A4</option>
              <option value="LETTER">US Letter</option>
            </select>
          </label>
          <div className={styles.actions}>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? 'Saving preferences…' : 'Save preferences'}
            </Button>
          </div>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
