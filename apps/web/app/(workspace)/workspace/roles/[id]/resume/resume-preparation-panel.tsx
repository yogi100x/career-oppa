'use client';

import { Button } from '../../../../../../components/workspace';
import styles from './resume-workspace.module.css';

export type PreparationRequirement = {
  text: string;
  quote: string;
  importance: 'essential' | 'desirable' | 'unknown';
  status: 'met' | 'gap' | 'unknown';
  fact_ids: string[];
  nominalWeight?: number;
  weight?: number;
  contribution?: number;
};
export type PreparationReuse = {
  resumeId: string;
  opportunityId: string;
  title: string;
  company: string;
  approved: boolean;
  similarity: number;
  action: 'reuse' | 'edit' | 'generate';
  reason: 'similarity_high' | 'similarity_medium' | 'similarity_low' | 'seniority_mismatch';
};
export type PreparationData = {
  token: string;
  skills: {
    buckets: {
      existing: { id: string; skill: string; priority: string; factIds: string[]; requirementQuote?: string }[];
      supportedByResume: { id: string; skill: string; priority: string; factIds: string[]; requirementQuote?: string }[];
      gaps: { id: string; skill: string; priority: string; factIds: string[]; requirementQuote?: string }[];
    };
    incompleteDetection: boolean;
    incompleteRequirements: string[];
  };
  requirements: PreparationRequirement[];
  reuse: PreparationReuse[];
};

type Props = {
  preparation: PreparationData | null;
  loading: boolean;
  error: string | null;
  confirmed: boolean;
  busy: boolean;
  onConfirmedChange: (value: boolean) => void;
  onCreate: () => void;
  onReuse: (resumeId: string) => void;
  onRetry: () => void;
  onCancel: () => void;
};

const reasonText: Record<PreparationReuse['reason'], string> = {
  similarity_high: 'This CV is close to this role.',
  similarity_medium: 'Some parts may carry over; review them for this role.',
  similarity_low: 'This role is different, so this CV may need more changes.',
  seniority_mismatch: 'The level differs, so review this CV carefully before using it.',
};

function SkillGroup({ title, skills }: { title: string; skills: PreparationData['skills']['buckets']['existing'] }) {
  return (
    <section className={styles.prepBucket}>
      <h4>{title} <span>{skills.length}</span></h4>
      {skills.length ? (
        <ul>{skills.map((item) => <li key={item.id}><span>{item.skill}</span>{item.priority === 'essential' && <>{' '}<small>Essential</small></>}{item.factIds.length > 0 && <> <a href="/workspace/profile#facts-heading">View approved facts for {item.skill}</a></>}</li>)}</ul>
      ) : <p>None identified</p>}
    </section>
  );
}

export default function ResumePreparationPanel({
  preparation,
  loading,
  error,
  confirmed,
  busy,
  onConfirmedChange,
  onCreate,
  onReuse,
  onRetry,
  onCancel,
}: Props) {
  return (
    <section className={styles.preparation} aria-labelledby="preparation-title">
      <h3 id="preparation-title">Review the role before creating a CV</h3>
      <p>See what your approved facts support and what the job asks for. Creating a tailored CV costs 3 credits.</p>
      {loading ? (
        <><p className={styles.status} role="status">Comparing your approved facts with the job…</p><Button variant="text" disabled={busy} onClick={onCancel}>Back</Button></>
      ) : error ? (
        <div className={styles.alert} role="alert">{error} <Button variant="text" disabled={busy} onClick={onRetry}>Try again</Button> <Button variant="text" disabled={busy} onClick={onCancel}>Back</Button></div>
      ) : preparation ? (
        <>
          {preparation.skills.incompleteDetection && (
            <aside className={styles.prepWarning} role="status">
              <strong>Some job requirements may be missing from this comparison.</strong>
              <p>Check the full job description before deciding what to include.</p>
              {preparation.skills.incompleteRequirements.length > 0 && <ul>{preparation.skills.incompleteRequirements.map((item, i) => <li key={`${i}-${item}`}>{item}</li>)}</ul>}
            </aside>
          )}
          <div className={styles.prepBuckets}>
            <SkillGroup title="Already in your approved profile" skills={preparation.skills.buckets.existing} />
            <SkillGroup title="Supported by other approved facts" skills={preparation.skills.buckets.supportedByResume} />
            <SkillGroup title="Gaps to consider" skills={preparation.skills.buckets.gaps} />
          </div>
          {preparation.requirements.length > 0 && (
            <details className={styles.history}>
              <summary>Job requirements and evidence ({preparation.requirements.length})</summary>
              <ul className={styles.prepRequirements}>{preparation.requirements.map((row, index) => (
                <li key={`${row.text}-${index}`}>
                  <span><strong>{row.text}</strong> <small>{row.importance}</small></span>
                  <blockquote>{row.quote}</blockquote>
                </li>
              ))}</ul>
            </details>
          )}
          {preparation.reuse.length > 0 && (
            <section className={styles.reuseSection} aria-labelledby="reuse-title">
              <h4 id="reuse-title">A CV you already have may help</h4>
              {preparation.reuse.map((item) => {
                const label = item.action === 'reuse' ? 'Reuse as a new draft · no charge' : item.action === 'edit' ? 'Edit for this role · no charge' : 'Use as a starting point · no charge';
                const sourceLabel = [item.title || 'Untitled CV', item.company].filter(Boolean).join(' at ');
                return (
                  <div className={styles.reuseRow} key={item.resumeId}>
                    <div><strong>{item.title || 'Untitled CV'}{item.company ? ` · ${item.company}` : ''}</strong><p>{reasonText[item.reason]} {Math.round(item.similarity * 100)}% similar{item.approved ? ' · previously approved' : ' · draft'}</p></div>
                    <Button variant="secondary" aria-label={`${label} from ${sourceLabel}`} disabled={busy} onClick={() => onReuse(item.resumeId)}>{label}</Button>
                  </div>
                );
              })}
            </section>
          )}
          <label className={styles.check}>
            <input type="checkbox" checked={confirmed} onChange={(event) => onConfirmedChange(event.target.checked)} disabled={busy} />
            I reviewed this comparison and understand that a gap means no supporting evidence was found. I’ll only include claims that are true.
          </label>
          <div className={styles.prepActions}>
            <Button variant="primary" disabled={busy || !confirmed} onClick={onCreate}>
              {busy ? 'Creating your CV…' : 'Create tailored CV · 3 credits'}
            </Button>
            <Button variant="text" disabled={busy} onClick={onCancel}>Back</Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
