'use client';
import CreditRecovery from '../../../../../../components/workspace/credit-recovery';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  AppShell,
  Button,
  Screen,
} from '../../../../../../components/workspace';
import ProfileActions from '../../../profile/profile-actions';
import ProfileClient from '../../../profile/profile-client';
import { ApplicationHandoffPrompt } from '../../../../../../components/workspace/application-handoff-prompt';
import {
  createApprovedPdfHandoff,
  downloadApprovedResumePdf,
} from '../../../../../../lib/approved-pdf-download';
import {
  hasValidResumeContact,
  initialResumeDraftKey,
  resumeEntryHeader,
  resumeSectionTitles,
} from '@career-workspace/contracts';
import ResumePreparationPanel, {
  type PreparationData,
} from './resume-preparation-panel';
import styles from './resume-workspace.module.css';

type Api<T> = { data?: T; error?: { code?: string; message?: string } };
type Bullet = { text: string; fact_ids: string[] };
type Entry = {
  title: string;
  organisation: string;
  start: string;
  end: string;
  fact_ids: string[];
  bullets: Bullet[];
};
type ResumeContent = {
  name: string;
  contact: string;
  sections: { title: string; bullets: Bullet[]; entries?: Entry[] }[];
  notes_for_candidate?: string[];
  left_out?: { fact_id: string; reason: string }[];
};
type Resume = {
  id: string;
  version: number;
  content: ResumeContent;
  approvedAt: string | null;
  pdfFileId: string | null;
  pageSize: 'A4' | 'LETTER' | null;
};
type PdfFlowFailure = Error & {
  code?: string;
  stage?: 'download' | 'handoff';
  retryable?: boolean;
  downloaded?: boolean;
};
type HandoffFailure = {
  code: string;
  message: string;
  retryable: boolean;
};
type Answer = {
  id: string;
  question: string;
  answer: string;
  factIds: string[];
  approvedAt: string | null;
};
type GroundingItem = {
  text: string;
  fact_ids: string[];
  grounded: boolean;
  flags: { code: string; message: string; factId?: string }[];
  approvedFacts: { id: string; text: string }[];
};
type AtsAudit = {
  score: number | null;
  grade: string | null;
  disclaimer?: string;
  caveat?: string;
  issues?: string[];
  checks: { id: string; label: string; status: 'pass' | 'fail' | 'unknown'; weight?: number; detail: string; fix?: string }[];
};
type Grounding = {
  ats?: AtsAudit;
  pageCount?: number;
  keywords?: { covered: string[]; notEvidenced: string[] };
  canApprove: boolean;
  items: GroundingItem[];
  flags: { code: string; message: string }[];
};
type Fact = {
  id: string;
  text: string;
  status: 'proposed' | 'approved' | 'rejected';
  kind: string;
};

function factSignature(facts: Fact[]) {
  return JSON.stringify(
    [...facts]
      .map(({ id, text, status }) => ({ id, text, status }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

const emptyContent: ResumeContent = {
  name: '',
  contact: '',
  sections: [{ title: 'Experience', bullets: [{ text: '', fact_ids: [] }] }],
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = (await response.json()) as Api<T>;
  if (!response.ok) {
    const code = body.error?.code;
    if (code === 'AI_NOT_CONFIGURED')
      throw new Error(
        'AI drafting is not configured yet. Your credits have not been charged. You can return later to create a draft.',
      );
    if (code === 'NO_APPROVED_FACTS')
      throw new Error(
        'Approve facts in your profile before creating a tailored CV or answer.',
      );
    throw new Error(
      body.error?.message ??
        'We could not complete that change. Please try again.',
    );
  }
  if (body.data === undefined)
    throw new Error('The server returned an incomplete response.');
  return body.data;
}

function requestKey() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function newResumeDraftKey() {
  return requestKey();
}

export default function ResumeWorkspace({
  opportunityId,
  prepare = false,
}: {
  opportunityId: string;
  prepare?: boolean;
}) {
  const router = useRouter();
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [resume, setResume] = useState<Resume | null>(null);
  const [content, setContent] = useState<ResumeContent>(emptyContent);
  const [resumeGrounding, setResumeGrounding] = useState<Grounding | null>(
    null,
  );
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [roleUrl, setRoleUrl] = useState<string | null>(null);
  const [roleTitle, setRoleTitle] = useState('');
  const [handoffError, setHandoffError] = useState<HandoffFailure | null>(null);
  const [handoffResumeId, setHandoffResumeId] = useState<string | null>(null);
  const [downloadedResumeId, setDownloadedResumeId] = useState<string | null>(
    null,
  );
  const [handoffRevision, setHandoffRevision] = useState(0);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [answerGrounding, setAnswerGrounding] = useState<Grounding | null>(
    null,
  );
  const [facts, setFacts] = useState<Fact[]>([]);
  const [reviewFacts, setReviewFacts] = useState(false);
  const draftInFlight = useRef(false);
  const reuseRequestKeys = useRef(new Map<string, string>());
  const [question, setQuestion] = useState('');
  const [newFactFor, setNewFactFor] = useState<string | null>(null);
  const [newFactText, setNewFactText] = useState('');
  const [pageSize, setPageSize] = useState<'A4' | 'LETTER'>('A4');
  const [preparation, setPreparation] = useState<PreparationData | null>(null);
  const [preparationLoading, setPreparationLoading] = useState(false);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [preparationOpen, setPreparationOpen] = useState(prepare);
  const [confirmedSkills, setConfirmedSkills] = useState(false);
  const [confirmedResume, setConfirmedResume] = useState(false);
  const [confirmedHeader, setConfirmedHeader] = useState(false);
  const [confirmedAnswer, setConfirmedAnswer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [applicationLoaded, setApplicationLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const knownFactSignature = useRef<string | null>(null);
  const knownFactsSnapshot = useRef<Fact[]>([]);
  const resumeIsSaved = Boolean(
    resume && JSON.stringify(content) === JSON.stringify(resume.content),
  );
  const savedAnswer = answer && answers.find((item) => item.id === answer.id);
  const answerIsSaved = Boolean(
    savedAnswer &&
    answer &&
    answer.answer === savedAnswer.answer &&
    JSON.stringify(answer.factIds) === JSON.stringify(savedAnswer.factIds),
  );
  const waitingFacts = facts.filter(
    (fact) => fact.status === 'proposed',
  ).length;
  const resumeHeaderValid =
    Boolean(content.name.trim()) && hasValidResumeContact(content.contact);

  const loadAll = useCallback(async () => {
    setLoadError(false);
    setError(null);
    try {
      const [resumeRows, answerRows, factResult, preferences, role] =
        await Promise.all([
          api<Resume[]>(`/api/v1/opportunities/${opportunityId}/resumes`),
          api<Answer[]>(`/api/v1/opportunities/${opportunityId}/answers`),
          api<{ facts: Fact[] }>('/api/v1/profile/facts'),
          api<{ paperSize: 'A4' | 'LETTER' }>('/api/v1/profile/preferences'),
          api<{
            job: { url: string | null; title: string; company: string };
            opportunity: { status: string };
          }>(`/api/v1/opportunities/${opportunityId}`),
        ]);
      const nextResume = resumeRows[0] ?? null;
      setRoleTitle(
        role.job.title
          ? `${role.job.title}${role.job.company ? ` at ${role.job.company}` : ''}`
          : '',
      );
      try {
        const url = role.job.url ? new URL(role.job.url) : null;
        setRoleUrl(
          url && ['https:', 'http:'].includes(url.protocol) ? url.href : null,
        );
      } catch {
        setRoleUrl(null);
      }
      const nextAnswer = answerRows[0] ?? null;
      const nextResumeGrounding = nextResume
        ? await api<Grounding>(`/api/v1/resumes/${nextResume.id}/grounding`)
        : null;
      const nextAnswerGrounding = nextAnswer
        ? await api<Grounding>(`/api/v1/answers/${nextAnswer.id}/grounding`)
        : null;

      setResumes(resumeRows);
      setAnswers(answerRows);
      setFacts(factResult.facts);
      knownFactsSnapshot.current = factResult.facts;
      knownFactSignature.current = factSignature(factResult.facts);
      if (
        !nextResume &&
        !factResult.facts.some((fact) => fact.status === 'approved')
      )
        setReviewFacts(true);
      setResume(nextResume);
      setContent(nextResume?.content ?? emptyContent);
      setPageSize(nextResume?.pageSize ?? preferences.paperSize);
      setResumeGrounding(nextResumeGrounding);
      setAnswer(nextAnswer);
      setConfirmedAnswer(false);
      setAnswerGrounding(nextAnswerGrounding);
      setApplicationLoaded(true);
    } catch (cause) {
      setLoadError(true);
      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not load this application.',
      );
    } finally {
      setLoading(false);
    }
  }, [opportunityId]);

  const loadPreparation = useCallback(async () => {
    setPreparationLoading(true);
    setPreparationError(null);
    try {
      const result = await api<PreparationData>(
        `/api/v1/opportunities/${opportunityId}/resumes/preparation`,
      );
      setPreparation(result);
    } catch (cause) {
      setPreparation(null);
      setPreparationError(
        cause instanceof Error
          ? cause.message
          : 'We could not compare this role with your approved facts.',
      );
    } finally {
      setPreparationLoading(false);
    }
  }, [opportunityId]);

  const approvedFactsSignature = factSignature(
    facts.filter((fact) => fact.status === 'approved'),
  );
  const hasApprovedFacts = approvedFactsSignature !== '[]';
  useEffect(() => {
    if (!preparationOpen || !hasApprovedFacts) return;
    setPreparation(null);
    setConfirmedSkills(false);
    void loadPreparation();
  }, [preparationOpen, approvedFactsSignature, hasApprovedFacts, loadPreparation]);

  const handleProfileFactsChange = useCallback(
    (nextFacts: Fact[]) => {
      const nextSignature = factSignature(nextFacts);
      const previousSignature = knownFactSignature.current;
      const previousFacts = knownFactsSnapshot.current;
      const nextFactsById = new Map(nextFacts.map((fact) => [fact.id, fact]));
      const invalidatedApprovedFactIds = new Set(
        previousFacts
          .filter((fact) => {
            if (fact.status !== 'approved') return false;
            const nextFact = nextFactsById.get(fact.id);
            return (
              !nextFact ||
              nextFact.status !== 'approved' ||
              nextFact.text !== fact.text
            );
          })
          .map((fact) => fact.id),
      );
      knownFactsSnapshot.current = nextFacts;
      knownFactSignature.current = nextSignature;
      setFacts(nextFacts);
      setPreparation(null);
      setConfirmedSkills(false);
      if (!resume && nextFacts.some((fact) => fact.status === 'approved'))
        setPreparationOpen(true);
      if (previousSignature === null || previousSignature === nextSignature)
        return;

      // Hide approved-document actions immediately while the server refreshes
      // grounding and revokes any approval affected by a fact change.
      setResume((current) =>
        current ? { ...current, approvedAt: null } : current,
      );
      setResumeGrounding(null);
      setDownloadedResumeId(null);
      setConfirmedResume(false);
      setConfirmedHeader(false);
      setHandoffError(null);
      if (
        answer?.approvedAt &&
        answer.factIds.some((id) => invalidatedApprovedFactIds.has(id))
      ) {
        setAnswer((current) =>
          current ? { ...current, approvedAt: null } : current,
        );
        setAnswerGrounding(null);
        setConfirmedAnswer(false);
      }
      setNotice(
        'Profile facts changed. Rechecking your CV before approval or download.',
      );
      void loadAll();
    },
    [answer, loadAll, resume],
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const retryLoad = () => {
    if (!applicationLoaded) setLoading(true);
    void loadAll();
  };

  const startResume = useCallback(
    async (idempotencyKey: string, preparationToken: string) => {
      if (draftInFlight.current) return;
      draftInFlight.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await api<Resume>(`/api/v1/opportunities/${opportunityId}/resumes`, {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ confirmedSkills: true, preparationToken }),
        });
        await loadAll();
        setPreparationOpen(false);
        setPreparation(null);
        setConfirmedSkills(false);
        setReviewFacts(false);
        setConfirmedResume(false);
        setConfirmedHeader(false);
        setDownloadedResumeId(null);
        setHandoffError(null);
        setNotice('Your tailored CV draft is ready to review.');
      } catch (cause) {
        setConfirmedSkills(false);
        void loadPreparation();
        setError(
          cause instanceof Error
            ? cause.message
            : 'We could not create a CV draft.',
        );
      } finally {
        draftInFlight.current = false;
        setBusy(false);
      }
    },
    [opportunityId, loadAll, loadPreparation],
  );



  const reuseResume = async (resumeId: string) => {
    if (draftInFlight.current || !preparation) return;
    draftInFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const actionKey = `${opportunityId}:${resumeId}`;
      const idempotencyKey =
        reuseRequestKeys.current.get(actionKey) ?? requestKey();
      reuseRequestKeys.current.set(actionKey, idempotencyKey);
      await api<Resume>(`/api/v1/opportunities/${opportunityId}/resumes`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ action: 'reuse', resumeId }),
      });
      await loadAll();
      reuseRequestKeys.current.delete(actionKey);
      setPreparationOpen(false);
      setPreparation(null);
      setConfirmedSkills(false);
      setReviewFacts(false);
      setConfirmedResume(false);
      setConfirmedHeader(false);
      setNotice('A new unapproved CV draft is ready. Review it before approval.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not reuse that CV.');
    } finally {
      draftInFlight.current = false;
      setBusy(false);
    }
  };

  const saveResume = async () => {
    if (!resume) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api<Resume>(`/api/v1/resumes/${resume.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content }),
      });
      setConfirmedResume(false);
      setConfirmedHeader(false);
      setDownloadedResumeId(null);
      setNotice(`Saved as CV version ${saved.version}.`);
      await loadAll();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'We could not save the CV.',
      );
    } finally {
      setBusy(false);
    }
  };

  const restoreResume = async (id: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const restored = await api<Resume>(`/api/v1/resumes/${id}/restore`, {
        method: 'POST',
      });
      await loadAll();
      setNotice(
        `Restored as new draft version ${restored.version}. Review it before approval.`,
      );
      setConfirmedResume(false);
      setConfirmedHeader(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not restore that version.',
      );
    } finally {
      setBusy(false);
    }
  };

  const approveResume = async () => {
    if (
      !resume ||
      !resumeGrounding?.canApprove ||
      !resumeHeaderValid ||
      !confirmedHeader ||
      !confirmedResume
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let approved: Resume;
    try {
      approved = await api<Resume>(`/api/v1/resumes/${resume.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          confirmedFactPairs: true,
          confirmedHeader: true,
          pageSize,
        }),
      });
      await loadAll();
      setNotice('CV approved. Downloading your PDF…');
      setConfirmedResume(false);
      setConfirmedHeader(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'We could not approve the CV.',
      );
      setBusy(false);
      return;
    }
    setBusy(false);
    // Approve and download are one action for the student.
    await downloadApprovedPdf(approved);
  };

  const createPdfHandoff = async (resumeId: string) => {
    setHandoffResumeId(resumeId);
    const outcome = await createApprovedPdfHandoff(opportunityId, resumeId);
    setHandoffError(null);
    if (outcome === 'skipped') {
      setNotice(
        'PDF downloaded. This role has moved past preparation, so no new application follow-up was added.',
      );
      return;
    }
    setHandoffRevision((value) => value + 1);
    setNotice(
      'PDF downloaded. Your application follow-up is ready; we’ll ask how it went when you return.',
    );
  };

  const showPdfFlowFailure = (cause: unknown): PdfFlowFailure => {
    if (cause instanceof Error) return cause as PdfFlowFailure;
    return new Error('We could not complete this PDF step. Try again.');
  };

  const handoffFailure = (cause: unknown): HandoffFailure => {
    const failure = showPdfFlowFailure(cause);
    return {
      code: failure.code ?? 'APPLICATION_FOLLOWUP_FAILED',
      message: failure.message,
      retryable: failure.retryable === true,
    };
  };

  const retryPdfHandoff = async () => {
    if (!handoffResumeId || busy) return;
    setBusy(true);
    setHandoffError(null);
    try {
      await createPdfHandoff(handoffResumeId);
    } catch (cause) {
      setHandoffError(handoffFailure(cause));
    } finally {
      setBusy(false);
    }
  };

  const downloadApprovedPdf = async (approvedResume: Resume) => {
    if (!approvedResume.approvedAt || busy) return;
    setBusy(true);
    setError(null);
    setHandoffError(null);
    try {
      if (!approvedResume.pdfFileId)
        throw new Error('This CV has no approved PDF. Approve it again.');
      const result = await downloadApprovedResumePdf({
        opportunityId,
        resumeId: approvedResume.id,
      });
      setDownloadedResumeId(approvedResume.id);
      setHandoffResumeId(approvedResume.id);
      if (result.handoff === 'skipped') {
        setHandoffError(null);
        setNotice(
          'PDF downloaded. This role has moved past preparation, so no new application follow-up was added.',
        );
      } else {
        setHandoffError(null);
        setHandoffRevision((value) => value + 1);
        setNotice(
          'PDF downloaded. Your application follow-up is ready; we’ll ask how it went when you return.',
        );
      }
    } catch (cause) {
      const failure = showPdfFlowFailure(cause);
      if (failure.stage === 'handoff' && failure.downloaded) {
        setNotice('PDF downloaded.');
        setHandoffResumeId(approvedResume.id);
        setHandoffError(handoffFailure(failure));
      } else {
        setDownloadedResumeId(null);
        setHandoffResumeId(null);
        if (
          failure.code === 'APPROVED_PDF_REQUIRED' ||
          failure.code === 'RESUME_NOT_GROUNDED' ||
          failure.code === 'RESUME_HEADER_REQUIRED'
        ) {
          await loadAll();
        }
        setError(
          failure.code
            ? `${failure.message} (${failure.code})`
            : failure.message,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const openEmployer = async () => {
    const approvedResume = resumes.find(
      (item) => item.id === downloadedResumeId && item.approvedAt,
    );
    if (!approvedResume || !roleUrl || busy) return;
    // Open during the click so the browser permits a new tab; navigate only
    // after the handoff is saved, or close it on failure.
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      setError(
        'Allow a new tab, then try opening the employer’s application again.',
      );
      return;
    }
    tab.opener = null;
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/application-handoffs', {
        method: 'POST',
        body: JSON.stringify({
          opportunityId,
          source: 'employer_link',
          resumeId: approvedResume.id,
        }),
      });
      tab.location.href = roleUrl;
      setNotice(
        'Complete the application on the employer’s site. We’ll check in when you return.',
      );
    } catch (cause) {
      tab.close();
      setError(
        cause instanceof Error
          ? cause.message
          : 'The employer’s application could not be opened. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const startAnswer = async (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api<Answer>(`/api/v1/opportunities/${opportunityId}/answers`, {
        method: 'POST',
        headers: { 'Idempotency-Key': requestKey() },
        body: JSON.stringify({ question }),
      });
      setQuestion('');
      await loadAll();
      setNotice('Your answer draft is ready to review.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not create an answer draft.',
      );
    } finally {
      setBusy(false);
    }
  };

  const saveAnswer = async () => {
    if (!answer) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api<Answer>(`/api/v1/answers/${answer.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          answer: answer.answer,
          fact_ids: answer.factIds,
        }),
      });
      setAnswer(updated);
      setAnswers((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setAnswerGrounding(
        await api<Grounding>(`/api/v1/answers/${updated.id}/grounding`),
      );
      setConfirmedAnswer(false);
      setNotice(
        'Answer saved. Review its supporting facts again before approval.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not save the answer.',
      );
    } finally {
      setBusy(false);
    }
  };

  const approveAnswer = async () => {
    if (!answer || !answerGrounding?.canApprove || !confirmedAnswer) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/v1/answers/${answer.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ confirmedFactPairs: true }),
      });
      await loadAll();
      setNotice('Answer approved.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not approve the answer.',
      );
    } finally {
      setBusy(false);
    }
  };

  const updateBullet = (
    sectionIndex: number,
    bulletIndex: number,
    patch: Partial<Bullet>,
  ) =>
    setContent((current) => ({
      ...current,
      sections: current.sections.map((section, si) =>
        si !== sectionIndex
          ? section
          : {
              ...section,
              bullets: section.bullets.map((bullet, bi) =>
                bi === bulletIndex ? { ...bullet, ...patch } : bullet,
              ),
            },
      ),
    }));
  const updateEntry = (
    sectionIndex: number,
    entryIndex: number,
    patch: Partial<Entry>,
  ) =>
    setContent((current) => ({
      ...current,
      sections: current.sections.map((section, si) =>
        si !== sectionIndex
          ? section
          : {
              ...section,
              entries: (section.entries ?? []).map((entry, ei) =>
                ei === entryIndex ? { ...entry, ...patch } : entry,
              ),
            },
      ),
    }));
  const addBullet = (sectionIndex: number) =>
    setContent((current) => ({
      ...current,
      sections: current.sections.map((section, index) =>
        index === sectionIndex
          ? {
              ...section,
              bullets: [...section.bullets, { text: '', fact_ids: [] }],
            }
          : section,
      ),
    }));
  const addSection = () =>
    setContent((current) => ({
      ...current,
      sections: [
        ...current.sections,
        {
          title:
            resumeSectionTitles.find(
              (title) =>
                !current.sections.some((section) => section.title === title),
            ) ?? 'Achievements',
          bullets: [{ text: '', fact_ids: [] }],
        },
      ],
    }));
  const createProposedFact = async (kind: string, text: string) => {
    try {
      await api('/api/v1/profile/facts', {
        method: 'POST',
        body: JSON.stringify({ kind, text }),
      });
      const result = await api<{ facts: Fact[] }>('/api/v1/profile/facts');
      handleProfileFactsChange(result.facts);
      setNotice(
        'Added as a proposed profile fact. Approve it on your profile before citing it here.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'We could not add that profile fact.',
      );
    }
  };

  // One CV line with its supporting facts, evidence and flags. A role header
  // line is computed from its fields, so only its facts are edited here.
  const renderLine = (
    line: Bullet,
    key: string,
    onChange: (patch: Partial<Bullet>) => void,
    header = false,
  ) => {
    const grounded = resumeGrounding?.items.find(
      (item) => item.text === line.text,
    );
    return (
      <div className={styles.claim} key={key}>
        {header ? (
          <p className={styles.status}>{line.text}</p>
        ) : (
          <label className={styles.field}>
            CV line
            <textarea
              rows={3}
              value={line.text}
              onChange={(e) => onChange({ text: e.target.value })}
            />
          </label>
        )}
        <fieldset className={styles.factChoices}>
          <legend>Supporting approved facts</legend>
          {facts
            .filter((fact) => fact.status === 'approved')
            .map((fact) => (
              <label className={styles.check} key={fact.id}>
                <input
                  type="checkbox"
                  checked={line.fact_ids.includes(fact.id)}
                  onChange={(e) =>
                    onChange({
                      fact_ids: e.target.checked
                        ? [...line.fact_ids, fact.id]
                        : line.fact_ids.filter((id) => id !== fact.id),
                    })
                  }
                />
                {fact.text}
              </label>
            ))}
        </fieldset>
        {grounded?.approvedFacts.map((fact) => (
          <p className={styles.evidence} key={fact.id}>
            <strong>Approved fact</strong>
            {fact.text}
          </p>
        ))}
        {grounded?.flags.map((flag) => (
          <p
            className={styles.flag}
            key={`${flag.code}-${flag.factId}-${flag.message}`}
          >
            {flag.message}
          </p>
        ))}
        {Boolean(grounded?.flags.length) && (
          <details className={styles.propose}>
            <summary>Missing a fact? Add it in your own words</summary>
            <label className={styles.field}>
              What you really did (not copied from this line)
              <textarea
                rows={2}
                value={newFactFor === key ? newFactText : ''}
                onChange={(e) => {
                  setNewFactFor(key);
                  setNewFactText(e.target.value);
                }}
              />
            </label>
            <Button
              disabled={
                busy ||
                newFactFor !== key ||
                !newFactText.trim() ||
                newFactText.trim() === line.text.trim()
              }
              onClick={() => {
                void createProposedFact('experience', newFactText.trim());
                setNewFactText('');
              }}
            >
              Add for review
            </Button>
          </details>
        )}
      </div>
    );
  };

  return (
    <AppShell
      active="roles"
      onNavigate={(view: string) =>
        view === 'home'
          ? router.push('/workspace')
          : view === 'documents'
            ? router.push('/workspace?view=documents')
            : router.push('/workspace')
      }
      profile={<ProfileActions />}
    >
      <Screen
        title={roleTitle ? `Prepare: ${roleTitle}` : 'Prepare your application'}
        description="Review your tailored CV and answers. Each claim should point to an approved fact from your profile."
        tools={
          <button
            className={styles.back}
            onClick={() => router.push('/workspace?view=roles')}
          >
            ← Back to roles
          </button>
        }
      >
        <main className={styles.page}>
          <ApplicationHandoffPrompt
            key={handoffRevision}
            onAnswered={() => void loadAll()}
          />
          <CreditRecovery message={error} />
          {error && (
            <p className={styles.alert} role="alert">
              {error}
              {error.includes('Approve facts') && (
                <>
                  {' '}
                  <a href="/workspace/profile">Open your profile →</a>
                </>
              )}
              {loadError && (
                <>
                  {' '}
                  <button type="button" onClick={retryLoad}>
                    Try again
                  </button>
                </>
              )}
            </p>
          )}
          {notice && (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          )}
          {loading ? (
            <p className={styles.status} role="status">
              Loading your application…
            </p>
          ) : !applicationLoaded ? (
            <p className={styles.status} role="status">
              Your application details are unavailable until they load.
            </p>
          ) : (
            <>
              <section className={styles.cvSection} aria-labelledby="cv-title">
                <header className={styles.sectionHeading}>
                  <div>
                    <p className={styles.kicker}>
                      {resume ? 'TAILORED CV' : 'TAILORED CV · 3 CREDITS'}
                    </p>
                    <h2 id="cv-title">Your CV for this role</h2>
                    <p>
                      Edit each claim and check the approved fact beside it.
                    </p>
                  </div>
                  {resume && (
                    <span className={styles.versionBadge}>
                      {resume.approvedAt
                        ? 'Approved'
                        : `Draft · v${resume.version}`}
                    </span>
                  )}
                  {resume && (
                    <Button
                      variant="secondary"
                      disabled={
                        busy ||
                        !resumeIsSaved ||
                        !facts.some((fact) => fact.status === 'approved')
                      }
                      onClick={() => { setPreparationOpen(true); setPreparation(null); setConfirmedSkills(false); }}
                    >
                      Review before creating another draft
                    </Button>
                  )}
                </header>
                {preparationOpen && facts.some((fact) => fact.status === 'approved') ? (
                  <ResumePreparationPanel
                    preparation={preparation}
                    loading={preparationLoading}
                    error={preparationError}
                    confirmed={confirmedSkills}
                    busy={busy}
                    onConfirmedChange={setConfirmedSkills}
                    onRetry={() => void loadPreparation()}
                    onCreate={() => {
                      if (!preparation || !confirmedSkills) return;
                      void startResume(
                        resume ? newResumeDraftKey() : initialResumeDraftKey(opportunityId),
                        preparation.token,
                      );
                    }}
                    onReuse={(resumeId) => { void reuseResume(resumeId); }}
                    onCancel={() => setPreparationOpen(false)}
                  />
                ) : !resume && reviewFacts ? (
                  <section aria-label="CV upload and fact review">
                    <p className={styles.status}>
                      Upload your CV, then approve or reject each fact. Only
                      approved facts are used in your draft.
                    </p>
                    <ProfileClient
                      applicationMode
                      onFactsChange={handleProfileFactsChange}
                    />
                    <Button
                      variant="primary"
                      disabled={
                        busy ||
                        !facts.some((fact) => fact.status === 'approved')
                      }
                      onClick={() => { setPreparationOpen(true); setConfirmedSkills(false); }}
                    >
                      {busy
                        ? 'Preparing your CV…'
                        : 'Review the match before drafting'}
                    </Button>
                    {waitingFacts > 0 && (
                      <p className={styles.status}>
                        {waitingFacts}{' '}
                        {waitingFacts === 1 ? 'fact is' : 'facts are'} still
                        waiting for you. Only approved facts go into your draft;
                        you can review the rest later.
                      </p>
                    )}
                    {waitingFacts === 0 &&
                      !facts.some((fact) => fact.status === 'approved') && (
                        <p className={styles.status}>
                          Approve at least one fact to draft your CV.
                        </p>
                      )}
                  </section>
                ) : !resume ? (
                  <div className={styles.emptyCard}>
                    <div>
                      <h3>Create a tailored CV</h3>
                      <p>
                        We’ll draft it from your approved profile facts. You can
                        review every claim before approval.
                      </p>
                    </div>
                    <Button
                      variant="primary"
                      disabled={
                        busy ||
                        !facts.some((fact) => fact.status === 'approved')
                      }
                      onClick={() => { setPreparationOpen(true); setConfirmedSkills(false); }}
                    >
                      Review match before drafting
                    </Button>
                    <Button
                      variant="text"
                      disabled={busy}
                      onClick={() => setReviewFacts(true)}
                    >
                      Review or upload CV facts
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className={styles.cvGrid}>
                      <div className={styles.editor}>
                        {Boolean(content.notes_for_candidate?.length) && (
                          <aside className={styles.status}>
                            <strong>Notes for you (not on your CV)</strong>
                            <ul>
                              {content.notes_for_candidate!.map((note) => (
                                <li key={note}>{note}</li>
                              ))}
                            </ul>
                          </aside>
                        )}
                        {Boolean(content.left_out?.length) && (
                          <details className={styles.history}>
                            <summary>
                              Left out of this draft ({content.left_out!.length}
                              )
                            </summary>
                            <ul>
                              {content.left_out!.map((item) => (
                                <li key={item.fact_id}>
                                  {facts.find(
                                    (fact) => fact.id === item.fact_id,
                                  )?.text ?? 'A fact no longer approved'}
                                  {item.reason ? ` — ${item.reason}` : ''}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        <label className={styles.field}>
                          Name
                          <input
                            required
                            maxLength={200}
                            value={content.name}
                            onChange={(e) => {
                              setConfirmedHeader(false);
                              setContent((current) => ({
                                ...current,
                                name: e.target.value,
                              }));
                            }}
                          />
                        </label>
                        <label className={styles.field}>
                          Contact details (email or phone)
                          <input
                            required
                            maxLength={500}
                            value={content.contact}
                            onChange={(e) => {
                              setConfirmedHeader(false);
                              setContent((current) => ({
                                ...current,
                                contact: e.target.value,
                              }));
                            }}
                          />
                        </label>

                        {content.sections.map((section, sectionIndex) => (
                          <section
                            className={styles.resumeSection}
                            key={`${resume.id}-${sectionIndex}`}
                          >
                            <label className={styles.field}>
                              Section
                              <select
                                value={section.title}
                                onChange={(e) =>
                                  setContent((current) => ({
                                    ...current,
                                    sections: current.sections.map(
                                      (item, index) =>
                                        index === sectionIndex
                                          ? { ...item, title: e.target.value }
                                          : item,
                                    ),
                                  }))
                                }
                              >
                                {[
                                  ...resumeSectionTitles,
                                  ...((
                                    resumeSectionTitles as readonly string[]
                                  ).includes(section.title)
                                    ? []
                                    : [section.title]),
                                ].map((title) => (
                                  <option key={title} value={title}>
                                    {title}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {(section.entries ?? []).map(
                              (entry, entryIndex) => (
                                <div
                                  className={styles.resumeSection}
                                  key={`${sectionIndex}-entry-${entryIndex}`}
                                >
                                  {(
                                    [
                                      ['title', 'Role title'],
                                      ['organisation', 'Organisation'],
                                      ['start', 'Start'],
                                      ['end', 'End'],
                                    ] as const
                                  ).map(([field, label]) => (
                                    <label className={styles.field} key={field}>
                                      {label}
                                      <input
                                        value={entry[field]}
                                        onChange={(e) =>
                                          updateEntry(
                                            sectionIndex,
                                            entryIndex,
                                            {
                                              [field]: e.target.value,
                                            },
                                          )
                                        }
                                      />
                                    </label>
                                  ))}
                                  {renderLine(
                                    {
                                      text: resumeEntryHeader(entry),
                                      fact_ids: entry.fact_ids,
                                    },
                                    `${sectionIndex}-e${entryIndex}`,
                                    (patch) =>
                                      patch.fact_ids &&
                                      updateEntry(sectionIndex, entryIndex, {
                                        fact_ids: patch.fact_ids,
                                      }),
                                    true,
                                  )}
                                  {entry.bullets.map((bullet, bulletIndex) =>
                                    renderLine(
                                      bullet,
                                      `${sectionIndex}-e${entryIndex}-${bulletIndex}`,
                                      (patch) =>
                                        updateEntry(sectionIndex, entryIndex, {
                                          bullets: entry.bullets.map(
                                            (item, bi) =>
                                              bi === bulletIndex
                                                ? { ...item, ...patch }
                                                : item,
                                          ),
                                        }),
                                    ),
                                  )}
                                </div>
                              ),
                            )}
                            {section.bullets.map((bullet, bulletIndex) =>
                              renderLine(
                                bullet,
                                `${sectionIndex}-${bulletIndex}`,
                                (patch) =>
                                  updateBullet(
                                    sectionIndex,
                                    bulletIndex,
                                    patch,
                                  ),
                              ),
                            )}
                            <Button onClick={() => addBullet(sectionIndex)}>
                              Add CV line
                            </Button>
                          </section>
                        ))}
                        <Button onClick={addSection}>Add section</Button>
                        <div className={styles.editorActions}>
                          <Button
                            variant="primary"
                            disabled={busy}
                            onClick={saveResume}
                          >
                            Save new version
                          </Button>
                          {resume.approvedAt && (
                            <span>
                              Editing and saving creates an unapproved draft.
                            </span>
                          )}
                        </div>
                      </div>
                      <aside
                        className={styles.preview}
                        aria-label="CV PDF preview"
                      >
                        <header>
                          <strong>
                            PDF preview · version {resume.version}
                          </strong>
                          <label>
                            Page size{' '}
                            <select
                              value={pageSize}
                              onChange={(e) =>
                                setPageSize(e.target.value as 'A4' | 'LETTER')
                              }
                            >
                              <option value="A4">A4</option>
                              <option value="LETTER">US Letter</option>
                            </select>
                          </label>
                        </header>
                        {!resumeGrounding ? (
                          <p className={styles.status} role="status">
                            Checking your CV against your current approved
                            facts…
                          </p>
                        ) : resumeGrounding.canApprove ? (
                          <iframe
                            title="Tailored CV PDF preview"
                            src={`/api/v1/resumes/${resume.id}/pdf?size=${pageSize}`}
                          />
                        ) : (
                          <p className={styles.status} role="status">
                            The PDF preview is paused while a claim needs
                            attention. Review the flagged claim and its cited
                            fact, then save a corrected version.
                          </p>
                        )}
                        <p>Preview updates when you save a new version.</p>
                      </aside>
                    </div>
                    <section
                      className={styles.approval}
                      aria-label="CV approval"
                    >
                      <div>
                        <h3>Check before approval</h3>
                        <p>
                          {resumeGrounding?.canApprove
                            ? 'All claims cite facts that are approved in your profile. Check the facts and your name and contact details before approving.'
                            : 'Approval is unavailable until every claim has at least one approved fact.'}
                        </p>
                        {resumeGrounding?.ats && (
                          <section className={styles.atsAudit} aria-label="PDF readability check">
                            <h4>PDF readability check</h4>
                            <p className={styles.atsScore}>
                              {resumeGrounding.ats.score === null
                                ? 'Score unavailable'
                                : `${resumeGrounding.ats.score}/100${resumeGrounding.ats.grade ? ` · Grade ${resumeGrounding.ats.grade}` : ''}`}
                            </p>
                            <p>{resumeGrounding.ats.caveat ?? resumeGrounding.ats.disclaimer ?? 'PDF readability checks do not predict whether an employer’s recruitment software will accept or rank your CV.'}</p>
                            {resumeGrounding.ats.issues?.length ? (
                              <ul>
                                {(resumeGrounding.ats.issues ?? []).map((issue, index) => <li key={`ats-issue-${index}`}>{issue}</li>)}
                              </ul>
                            ) : null}
                            {resumeGrounding.ats.checks.length > 0 && (
                              <details className={styles.history}>
                                <summary>View all {resumeGrounding.ats.checks.length} PDF checks</summary>
                                <ul>
                                  {resumeGrounding.ats.checks.map((check) => {
                                    const weight = check.weight ?? 0;
                                    const earned = check.status === 'pass' ? weight : 0;
                                    const status = check.status === 'pass' ? 'Passed' : check.status === 'fail' ? 'Needs attention' : 'Not verified';
                                    return (
                                      <li key={check.id}>
                                        <strong>{check.label}:</strong> {status} · {earned} of {weight} points. {check.detail}{check.fix ? ` ${check.fix}` : ''}
                                      </li>
                                    );
                                  })}
                                </ul>
                              </details>
                            )}
                          </section>
                        )}
                        {(resumeGrounding?.pageCount ?? 0) > 1 && (
                          <p className={styles.status} role="status">
                            This CV runs to {resumeGrounding!.pageCount} pages.
                            Most employers expect one page from students and
                            graduates. Consider removing the weakest lines
                            before you approve.
                          </p>
                        )}
                        {resumeGrounding?.keywords &&
                          resumeGrounding.keywords.covered.length +
                            resumeGrounding.keywords.notEvidenced.length >
                            0 && (
                            <details className={styles.history}>
                              <summary>Job terms this CV shows</summary>
                              <p>
                                Shown by a cited fact:{' '}
                                {resumeGrounding.keywords.covered.join(', ') ||
                                  'none yet'}
                              </p>
                              <p>
                                Not shown by any cited fact:{' '}
                                {resumeGrounding.keywords.notEvidenced.join(
                                  ', ',
                                ) || 'none'}
                                . We never add these for you; add a fact in your
                                own words only if it is true.
                              </p>
                            </details>
                          )}
                        {!resumeHeaderValid && (
                          <p className={styles.alert}>
                            Add your name and a valid email address or phone
                            number, then save this version before approval.
                          </p>
                        )}
                        {resumeHeaderValid && (
                          <p className={styles.status}>
                            Your CV header: <strong>{content.name}</strong> ·{' '}
                            {content.contact}
                          </p>
                        )}
                        <label className={styles.check}>
                          <input
                            type="checkbox"
                            checked={confirmedResume && confirmedHeader}
                            onChange={(e) => {
                              setConfirmedResume(e.target.checked);
                              setConfirmedHeader(e.target.checked);
                            }}
                            disabled={
                              !resumeIsSaved ||
                              !resumeGrounding?.canApprove ||
                              !resumeHeaderValid ||
                              Boolean(resume.approvedAt)
                            }
                          />
                          I checked my name and contact details, and that each
                          CV line matches its supporting facts.
                        </label>
                      </div>
                      <Button
                        variant="primary"
                        disabled={
                          busy ||
                          !resumeIsSaved ||
                          !resumeGrounding?.canApprove ||
                          !resumeHeaderValid ||
                          !confirmedHeader ||
                          !confirmedResume ||
                          Boolean(resume.approvedAt)
                        }
                        onClick={approveResume}
                      >
                        {resume.approvedAt
                          ? 'CV approved'
                          : 'Approve & download PDF'}
                      </Button>
                    </section>
                    {resume.approvedAt && resumeGrounding?.canApprove && (
                      <section
                        className={styles.approval}
                        aria-label="Apply with your approved CV"
                      >
                        <div>
                          <h3>Your approved CV is ready</h3>
                          <p>
                            Download it, then apply yourself on the employer’s
                            site. We never submit an application for you.
                          </p>
                          {!roleUrl && (
                            <p>
                              This role has no saved application link. Use the
                              employer’s site or the instructions in the job
                              description.
                            </p>
                          )}
                        </div>
                        <div className={styles.editorActions}>
                          <Button
                            variant="primary"
                            disabled={busy || !resumeGrounding?.canApprove}
                            onClick={() => void downloadApprovedPdf(resume)}
                          >
                            Download approved PDF
                          </Button>
                          {roleUrl && downloadedResumeId && (
                            <Button disabled={busy} onClick={openEmployer}>
                              Open employer application
                            </Button>
                          )}
                        </div>
                      </section>
                    )}
                    {handoffError && (
                      <p className={styles.alert} role="alert">
                        The PDF downloaded, but the application follow-up could
                        not be saved. {handoffError.message} (
                        {handoffError.code})
                        {handoffError.retryable && (
                          <>
                            {' '}
                            <Button
                              variant="text"
                              disabled={busy}
                              onClick={() => void retryPdfHandoff()}
                            >
                              {busy ? 'Retrying…' : 'Retry follow-up'}
                            </Button>
                          </>
                        )}
                      </p>
                    )}
                    <details className={styles.history}>
                      <summary>Version history ({resumes.length})</summary>
                      {resumes.map((version) => (
                        <div className={styles.historyRow} key={version.id}>
                          <span>
                            Version {version.version}
                            {version.approvedAt ? ' · approved' : ' · draft'}
                          </span>
                          {version.id !== resume.id && version.approvedAt && (
                            <Button
                              disabled={busy}
                              onClick={() => void downloadApprovedPdf(version)}
                            >
                              Download approved PDF
                            </Button>
                          )}
                          {version.id !== resume.id && (
                            <Button
                              disabled={busy}
                              onClick={() => void restoreResume(version.id)}
                            >
                              Restore as new draft
                            </Button>
                          )}
                        </div>
                      ))}
                    </details>
                  </>
                )}
              </section>
              <section
                className={styles.answerSection}
                aria-labelledby="answer-title"
              >
                <header className={styles.sectionHeading}>
                  <div>
                    <p className={styles.kicker}>
                      APPLICATION ANSWERS · 1 CREDIT EACH
                    </p>
                    <h2 id="answer-title">Answer an application question</h2>
                    <p>
                      Draft an answer, review the cited facts, and approve it
                      when it is accurate.
                    </p>
                  </div>
                </header>
                <form className={styles.questionForm} onSubmit={startAnswer}>
                  <label className={styles.field}>
                    Question
                    <input
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder="Paste an application question"
                    />
                  </label>
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={busy || !question.trim()}
                  >
                    Draft answer · 1 credit
                  </Button>
                </form>
                {answers.length > 1 && (
                  <label className={styles.field}>
                    Saved answer
                    <select
                      value={answer?.id ?? ''}
                      onChange={async (e) => {
                        const selected = answers.find(
                          (item) => item.id === e.target.value,
                        );
                        if (selected) {
                          setAnswer(selected);
                          setAnswerGrounding(
                            await api<Grounding>(
                              `/api/v1/answers/${selected.id}/grounding`,
                            ),
                          );
                          setConfirmedAnswer(false);
                        }
                      }}
                    >
                      {answers.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.question}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {answer ? (
                  <div className={styles.answerCard}>
                    <p className={styles.question}>{answer.question}</p>
                    <label className={styles.field}>
                      Your answer
                      <textarea
                        rows={6}
                        value={answer.answer}
                        onChange={(e) =>
                          setAnswer({ ...answer, answer: e.target.value })
                        }
                      />
                    </label>
                    <label className={styles.field}>
                      Supporting approved facts
                      <select
                        multiple
                        value={answer.factIds}
                        onChange={(e) =>
                          setAnswer({
                            ...answer,
                            factIds: Array.from(
                              e.currentTarget.selectedOptions,
                              (option) => option.value,
                            ),
                          })
                        }
                      >
                        {facts
                          .filter((fact) => fact.status === 'approved')
                          .map((fact) => (
                            <option key={fact.id} value={fact.id}>
                              {fact.text}
                            </option>
                          ))}
                      </select>
                    </label>
                    {answerGrounding?.items.flatMap((item) => [
                      ...item.approvedFacts.map((fact) => (
                        <p className={styles.evidence} key={fact.id}>
                          <strong>Approved fact</strong>
                          {fact.text}
                        </p>
                      )),
                      ...item.flags.map((flag) => (
                        <p className={styles.flag} key={flag.code}>
                          {flag.message}
                        </p>
                      )),
                    ])}
                    <div className={styles.answerActions}>
                      <Button onClick={saveAnswer} disabled={busy}>
                        Save answer
                      </Button>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={confirmedAnswer}
                          onChange={(e) => setConfirmedAnswer(e.target.checked)}
                          disabled={
                            !answerGrounding?.canApprove ||
                            Boolean(answer.approvedAt) ||
                            !answerIsSaved
                          }
                        />
                        I checked this answer against its supporting facts.
                      </label>
                      <Button
                        variant="primary"
                        onClick={approveAnswer}
                        disabled={
                          busy ||
                          !answerIsSaved ||
                          !confirmedAnswer ||
                          !answerGrounding?.canApprove ||
                          Boolean(answer.approvedAt)
                        }
                      >
                        {answer.approvedAt
                          ? 'Answer approved'
                          : 'Approve answer'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className={styles.emptyAnswers}>
                    Your drafted answers will appear here. Creating a draft
                    costs 1 credit.
                  </p>
                )}
              </section>
            </>
          )}
        </main>
      </Screen>
    </AppShell>
  );
}
