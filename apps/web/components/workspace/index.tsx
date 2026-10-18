'use client';

import { useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import Link from 'next/link';
import s from './workspace.module.css';
import { FitBandBadge } from './fit-scorecard';
import type { FitScoreBand } from '@career-workspace/contracts';

export type Role = {
  id: string;
  title: string;
  company: string;
  location: string;
  score: number | null;
  reason: string;
  reviewed?: boolean;
  fitBand?: FitScoreBand | null;
};
export type CareerDocument = {
  id: string;
  name: string;
  context: string;
  type: string;
  version: string;
};
export function fitLabel(score: number | null, reviewed = false) {
  if (score === null || !Number.isFinite(score) || score < 0 || score > 10)
    return reviewed ? 'Reviewed · see gaps' : 'Not assessed';
  return score >= 8 ? 'Excellent' : score >= 6 ? 'Good' : 'OK';
}
export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'text';
}) {
  return (
    <button
      type="button"
      className={`${s.button} ${s[variant]} ${className}`}
      {...props}
    />
  );
}
export function FitScore({
  score,
  reviewed = false,
}: {
  score: number | null;
  reviewed?: boolean;
}) {
  const label = fitLabel(score, reviewed);
  const unscored = score === null || label === 'Not assessed';
  return (
    <div className={s.score}>
      {unscored && reviewed ? null : (
        <strong aria-label={unscored ? label : `${score} out of 10`}>
          {unscored ? '—' : Number(score!.toFixed(1))}
        </strong>
      )}
      <span
        className={`${s.badge} ${label === 'Excellent' ? s.green : label === 'Good' ? s.yellow : label === 'OK' ? s.amber : s.neutral}`}
      >
        {label === 'Reviewed · see gaps' ? (
          <>
            Reviewed<span className={s.badgeMore}> · see gaps</span>
          </>
        ) : (
          label
        )}
      </span>
    </div>
  );
}
export { FitBandBadge, FitScorecardView } from './fit-scorecard';
export function AppShell({
  active,
  onNavigate,
  children,
  chat,
  profile,
}: {
  active: string;
  onNavigate: (view: string) => void;
  children: ReactNode;
  chat?: ReactNode;
  profile?: ReactNode;
}) {
  const links = [
    ['home', 'Home', '/workspace'],
    ['roles', 'Roles', '/workspace?view=roles'],
    ['documents', 'Documents', '/workspace?view=documents'],
    ['coach', 'Coach', '/workspace/coach'],
  ];
  const navigation = links.map(([id, label, href]) => (
    <Link
      key={id}
      href={href}
      aria-current={
        active === id || (id === 'home' && active === 'discover')
          ? 'page'
          : undefined
      }
    >
      {label}
    </Link>
  ));
  return (
    <div className={s.shell}>
      <header className={s.header}>
        <button className={s.brand} onClick={() => onNavigate('home')}>
          career<span>-oppa</span>
        </button>
        <nav aria-label="Main navigation">{navigation}</nav>
        {profile ?? (
          <span className={s.avatar} aria-label="Sample profile">
            Y
          </span>
        )}
      </header>
      <div className={s.body}>
        <main className={s.main}>{children}</main>
        {chat}
      </div>
      <nav className={s.mobileNavigation} aria-label="Phone navigation">
        {navigation}
      </nav>
    </div>
  );
}
export function Screen({
  title,
  description,
  children,
  tools,
  variant,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  tools?: ReactNode;
  variant?: 'home';
  className?: string;
}) {
  return (
    <div className={`${s.screen} ${variant === 'home' ? s.homeScreen : ''} ${className ?? ''}`}>
      <div className={s.heading}>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {tools}
      <div className={s.content}>{children}</div>
    </div>
  );
}
export function WelcomeCard({
  onContinue,
  title = 'Let’s finish your Northstar application.',
  description = 'You’ve got a strong story for this role. Let’s check one open question, then get your CV ready.',
  actionLabel = 'Continue with Oppa →',
  eyebrow,
  disabled = false,
}: {
  onContinue: () => void;
  title?: string;
  description?: string;
  actionLabel?: string;
  eyebrow?: string;
  disabled?: boolean;
}) {
  return (
    <section className={s.welcome}>
      <div>
        {eyebrow && <small>{eyebrow}</small>}
        <h2>{title}</h2>
        <p>{description}</p>
        <Button variant="primary" onClick={onContinue} disabled={disabled}>
          {actionLabel}
        </Button>
      </div>
      <img
        src="/assets/career-oppa-character-adult.png"
        alt="Oppa, your career companion"
      />
    </section>
  );
}
export function ScrollRegion({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={s.scroll} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
export function RoleTable({
  roles,
  onReview,
}: {
  roles: Role[];
  onReview: (role: Role) => void;
}) {
  return (
    <ScrollRegion label="Matching roles">
      <table className={`${s.table} ${s.roles}`}>
        <caption className={s.srOnly}>
          Matching roles; fit scores are out of 10
        </caption>
        <thead>
          <tr>
            {[
              'Role & company',
              'Location',
              'Fit score',
              'Why it fits',
              'Action',
            ].map((label) => (
              <th scope="col" key={label}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <tr key={role.id}>
              <td>
                <strong>{role.title}</strong>
                <small>{role.company}</small>
              </td>
              <td>{role.location}</td>
              <td>
                <FitScore score={role.score} />
              </td>
              <td>{role.reason}</td>
              <td>
                <Button
                  variant="text"
                  onClick={() => onReview(role)}
                  aria-label={`Review fit for ${role.title} at ${role.company}`}
                >
                  Review fit →
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!roles.length && (
        <p className={s.empty}>No matching roles. Try another search.</p>
      )}
    </ScrollRegion>
  );
}
export type WorkspaceOpportunity = {
  id: string;
  title: string;
  company: string;
  location?: string | null;
  status: string;
  nextStep: string | null;
  fitBand?: FitScoreBand | null;
};
export function OpportunityTable({
  opportunities,
  onOpen,
  emptyMessage = 'No roles saved yet. Add a job link or paste its description to get started.',
}: {
  opportunities: WorkspaceOpportunity[];
  onOpen: (opportunity: WorkspaceOpportunity) => void;
  emptyMessage?: string;
}) {
  return (
    <ScrollRegion label="Saved roles">
      <table className={`${s.table} ${s.opportunities}`}>
        <caption className={s.srOnly}>
          Saved roles and application status
        </caption>
        <thead>
          <tr>
            <th scope="col">Role &amp; company</th>
            <th scope="col">Location</th>
            <th scope="col">Status</th>
            <th scope="col">Next step</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {opportunities.map((opportunity) => (
            <tr key={opportunity.id}>
              <td>
                <strong>{opportunity.title}</strong>
                <small>{opportunity.company}</small>
                <FitBandBadge band={opportunity.fitBand} />
              </td>
              <td>{opportunity.location || '—'}</td>
              <td>
                <span
                  className={`${s.statusBadge} ${s[`status_${opportunity.status}`] ?? s.status_default}`}
                >
                  {opportunity.status}
                </span>
              </td>
              <td>{opportunity.nextStep || '—'}</td>
              <td>
                <Button
                  variant="text"
                  onClick={() => onOpen(opportunity)}
                  aria-label={`Open ${opportunity.title} at ${opportunity.company}`}
                >
                  Open role →
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!opportunities.length && <p className={s.empty}>{emptyMessage}</p>}
    </ScrollRegion>
  );
}
export function DocumentTable({
  documents,
  onOpen,
}: {
  documents: CareerDocument[];
  onOpen: (document: CareerDocument) => void;
}) {
  return (
    <ScrollRegion label="Career documents">
      <table className={s.table}>
        <caption className={s.srOnly}>
          Your résumé versions and supporting documents
        </caption>
        <thead>
          <tr>
            {['Document', 'Type', 'Version / status', 'Action'].map((x) => (
              <th scope="col" key={x}>
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => (
            <tr key={doc.id}>
              <td>
                <strong>{doc.name}</strong>
                <small>{doc.context}</small>
              </td>
              <td>{doc.type}</td>
              <td>{doc.version}</td>
              <td>
                <Button variant="text" onClick={() => onOpen(doc)}>
                  Open {doc.name} →
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!documents.length && (
        <p className={s.empty}>Your documents will appear here.</p>
      )}
    </ScrollRegion>
  );
}
export function Verdict({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={s.verdict}>
      <small>Oppa’s take</small>
      <h2>{title}</h2>
      <p>{children}</p>
    </section>
  );
}
export type Evidence = {
  area: string;
  assessment: string;
  explanation: string;
};
export function EvidenceTable({ rows }: { rows: Evidence[] }) {
  return (
    <ScrollRegion label="The story behind the fit">
      <table className={`${s.table} ${s.evidenceTable}`}>
        <caption className={s.srOnly}>
          Evidence and questions behind the role fit
        </caption>
        <thead>
          <tr>
            <th scope="col">Fit area</th>
            <th scope="col">Assessment</th>
            <th scope="col">Why it matters</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.area}-${index}`}>
              <th scope="row">{row.area}</th>
              <td>{row.assessment}</td>
              <td>{row.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
export function ResumePreview({
  children,
  pdfUrl,
}: {
  children: ReactNode;
  pdfUrl: string;
}) {
  return (
    <section className={s.content}>
      <div className={s.toolbar}>
        <h2>Your story, tailored to this role.</h2>
        <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
          Open sample PDF ↗
        </a>
      </div>
      <ScrollRegion label="Résumé preview">
        <article className={s.resume}>{children}</article>
      </ScrollRegion>
    </section>
  );
}
export type ChatMessage = { id: string; author: 'user' | 'oppa'; text: string };
export function ChatPanel({
  messages,
  onSend,
  onClose,
  context,
  pending = false,
  placeholder = 'Ask about this role…',
  maxLength,
  children,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onClose: () => void;
  context: string;
  pending?: boolean;
  placeholder?: string;
  maxLength?: number;
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const messageTooLong = maxLength !== undefined && draft.length > maxLength;
  return (
    <aside className={s.chat} aria-label="Talk to Oppa">
      <header>
        <img src="/assets/career-oppa-character-adult.png" alt="" />
        <div>
          <strong>Oppa is with you</strong>
          <small>{context}</small>
        </div>
        <Button variant="text" onClick={onClose}>
          Close
        </Button>
      </header>
      <div
        className={s.messages}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        tabIndex={0}
      >
        {messages.map((message) => (
          <div
            key={message.id}
            className={message.author === 'user' ? s.userMessage : s.message}
          >
            <small>{message.author === 'user' ? 'You' : 'Oppa'}</small>
            <p>{message.text}</p>
          </div>
        ))}
        {children}
        {pending && <p role="status">Oppa is thinking…</p>}
      </div>
      <form
        className={s.composer}
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() && !pending && !messageTooLong) {
            onSend(draft.trim());
            setDraft('');
          }
        }}
      >
        <label htmlFor="oppa-message">Talk it through</label>
        <textarea
          id="oppa-message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          aria-describedby={maxLength ? 'oppa-message-length' : undefined}
        />
        {maxLength !== undefined && (
          <small
            id="oppa-message-length"
            className={messageTooLong ? s.messageLengthError : s.messageLength}
            role={messageTooLong ? 'alert' : undefined}
          >
            {messageTooLong
              ? `Please shorten your message to ${maxLength.toLocaleString('en-GB')} characters or paste a job for review in My roles.`
              : `${draft.length.toLocaleString('en-GB')} / ${maxLength.toLocaleString('en-GB')} characters`}
          </small>
        )}
        <Button
          variant="primary"
          type="submit"
          disabled={pending || !draft.trim() || messageTooLong}
        >
          Send
        </Button>
      </form>
    </aside>
  );
}

export function RoleWorkspace({
  role,
  stage,
  onStage,
  onBack,
  onChat,
  children,
  actions,
}: {
  role: Role;
  stage: 'review' | 'resume' | 'track';
  onStage: (stage: 'review' | 'resume' | 'track') => void;
  onBack: () => void;
  onChat: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className={`${s.screen} ${s.roleWorkspace}`}>
      <Button variant="text" className={s.back} onClick={onBack}>
        ← All roles
      </Button>
      <div className={s.roleHeading}>
        <div className={s.heading}>
          <small>{role.company}</small>
          <h1>{role.title}</h1>
          <p>{role.location}</p>
        </div>
        <div className={s.roleSummary}>
          {role.fitBand ? (
            <FitBandBadge band={role.fitBand} />
          ) : (
            <FitScore score={role.score} reviewed={role.reviewed} />
          )}
          <Button onClick={onChat} aria-label="Talk to Oppa">
            <span className={s.longLabel}>Talk to Oppa</span>
            <span className={s.shortLabel}>Oppa</span>
          </Button>
        </div>
      </div>
      <nav className={s.steps} aria-label="Application steps">
        {(['review', 'resume', 'track'] as const).map((item, i) => (
          <button
            key={item}
            aria-current={stage === item ? 'step' : undefined}
            onClick={() => onStage(item)}
          >
            <span>0{i + 1}</span>{' '}
            {['Review fit', 'Prepare', 'Track progress'][i]}
          </button>
        ))}
      </nav>
      <div className={s.roleContent}>{children}</div>
      <footer className={s.actions}>{actions}</footer>
    </div>
  );
}

export { PostWorkspace, type PostWorkspaceProps } from './post-workspace';
