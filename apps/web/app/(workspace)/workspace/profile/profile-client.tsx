'use client';

import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Button } from '../../../../components/workspace';
import styles from './profile.module.css';
import ProfilePreferencesForm from './profile-preferences';

type FactKind =
  | 'experience'
  | 'skill'
  | 'education'
  | 'achievement'
  | 'certification'
  | 'project'
  | 'volunteering'
  | 'responsibility'
  | 'language'
  | 'eligibility';
type FactStatus = 'proposed' | 'approved' | 'rejected';
type ProfileFact = {
  id: string;
  kind: FactKind;
  text: string;
  organisation?: string | null;
  role?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  source: 'cv' | 'user' | 'chat' | 'project';
  status: FactStatus;
  sourceFileId: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
};
type Project = {
  id: string;
  title: string;
  summary: string;
  links: string[];
  claims: ProfileFact[];
  createdAt: string;
  updatedAt: string;
};
type Task = {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  output: { textLength?: number; factIds?: string[] } | null;
  error: string | null;
};
type ApiBody<T> = { data?: T; error?: { code?: string; message?: string } };
type UploadState = { fileName: string; task: Task };
type ProjectForm = {
  title: string;
  summary: string;
  links: string;
  claim: string;
};

const emptyProjectForm: ProjectForm = {
  title: '',
  summary: '',
  links: '',
  claim: '',
};

function safeMessage(code?: string): string {
  switch (code) {
    case 'INVALID_CV':
      return 'Upload a PDF or DOCX file with readable text.';
    case 'UNSUPPORTED_FILE_TYPE':
      return 'Upload a PDF or DOCX file.';
    case 'FILE_TOO_LARGE':
      return 'This file is larger than 4 MB. Try a smaller copy.';
    case 'CV_TOO_LONG':
      return 'This CV is too long to read. Try a shorter version.';
    case 'CV_NEEDS_TEXT':
      return 'We could not find readable text in this file. Try another copy.';
    case 'CV_EXTRACTION_FAILED':
      return 'Your CV is saved, but we could not read its text. Try another copy.';
    case 'AI_NOT_CONFIGURED':
      return 'Your CV is saved. AI fact extraction is not configured yet.';
    default:
      return 'We could not save that change. Please try again.';
  }
}

function statusText(task: Task): string {
  if (task.status === 'queued')
    return 'Your CV is saved and waiting to be processed.';
  if (task.status === 'running')
    return 'Your CV is saved. We are reading its text.';
  if (task.status === 'succeeded')
    return 'Your CV is saved and its facts are ready to review.';
  if (task.error === 'AI_NOT_CONFIGURED' && task.output?.textLength) {
    return 'Your CV was saved and its text was read. AI fact extraction is not configured yet.';
  }
  return safeMessage(task.error ?? undefined);
}

function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

async function readApi<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiBody<T>;
  if (!response.ok) throw new Error(safeMessage(body.error?.code));
  if (!body.data)
    throw new Error('The server returned an incomplete response.');
  return body.data;
}

export default function ProfileClient({
  children,
  applicationMode = false,
  onFactsChange,
}: {
  children?: ReactNode;
  applicationMode?: boolean;
  onFactsChange?: (facts: ProfileFact[]) => void;
}) {
  const [facts, setFacts] = useState<ProfileFact[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [editingFactId, setEditingFactId] = useState<string | null>(null);
  const [factDraft, setFactDraft] = useState('');
  const [busyFactId, setBusyFactId] = useState<string | null>(null);
  const [factError, setFactError] = useState<string | null>(null);
  const [manualFactKind, setManualFactKind] = useState<FactKind>('experience');
  const [manualFactText, setManualFactText] = useState('');
  const [savingManualFact, setSavingManualFact] = useState(false);
  const [projectForm, setProjectForm] = useState<ProjectForm>(emptyProjectForm);
  const [savingProject, setSavingProject] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    setLoadError(null);
    try {
      const [factResponse, projectResponse] = await Promise.all([
        fetch('/api/v1/profile/facts', { cache: 'no-store' }),
        fetch('/api/v1/projects', { cache: 'no-store' }),
      ]);
      const [factData, projectData] = await Promise.all([
        readApi<{ facts: ProfileFact[] }>(factResponse),
        readApi<{ projects: Project[] }>(projectResponse),
      ]);
      setFacts(factData.facts);
      setProjects(projectData.projects);
      setProfileLoaded(true);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message === 'We could not save that change. Please try again.'
            ? 'We could not load your profile. Please try again.'
            : error.message
          : 'We could not load your profile. Please try again.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (profileLoaded) onFactsChange?.(facts);
  }, [facts, profileLoaded, onFactsChange]);

  useEffect(() => {
    if (!upload || !['queued', 'running'].includes(upload.task.status)) return;

    let stopped = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/v1/tasks/${upload.task.id}`, {
          cache: 'no-store',
        });
        const data = await readApi<Task>(response);
        if (stopped) return;
        setUpload((current) =>
          current ? { ...current, task: data } : current,
        );
        if (data.status === 'succeeded') await loadProfile();
      } catch (error) {
        if (!stopped) {
          setUploadError(
            error instanceof Error
              ? error.message
              : 'We could not check CV progress.',
          );
        }
      }
    }, 1200);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [upload, loadProfile]);

  async function submitCv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || uploading) return;

    setUploading(true);
    setUploadError(null);
    setUpload(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch('/api/v1/profile/cv', {
        method: 'POST',
        body,
      });
      const data = await readApi<{
        file: { originalName: string };
        task: Task;
      }>(response);
      setUpload({ fileName: data.file.originalName, task: data.task });
      setFile(null);
      const picker = document.getElementById(
        'cv-file',
      ) as HTMLInputElement | null;
      if (picker) picker.value = '';
      if (data.task.status === 'succeeded') await loadProfile();
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : 'We could not upload this CV.',
      );
    } finally {
      setUploading(false);
    }
  }

  async function updateFact(
    fact: ProfileFact,
    update: { text?: string; status?: FactStatus },
  ) {
    setBusyFactId(fact.id);
    setFactError(null);
    try {
      const response = await fetch(`/api/v1/profile/facts/${fact.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      const data = await readApi<ProfileFact>(response);
      setFacts((current) =>
        current.map((item) => (item.id === fact.id ? data : item)),
      );
      setEditingFactId(null);
    } catch (error) {
      setFactError(
        error instanceof Error
          ? error.message
          : 'We could not update this fact.',
      );
    } finally {
      setBusyFactId(null);
    }
  }

  async function submitManualFact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!manualFactText.trim() || savingManualFact) return;
    setSavingManualFact(true);
    setFactError(null);
    try {
      await readApi<ProfileFact>(
        await fetch('/api/v1/profile/facts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: manualFactKind,
            text: manualFactText.trim(),
          }),
        }),
      );
      setManualFactText('');
      await loadProfile();
    } catch (error) {
      setFactError(
        error instanceof Error
          ? error.message
          : 'We could not add this profile fact.',
      );
    } finally {
      setSavingManualFact(false);
    }
  }

  function beginProjectEdit(project: Project) {
    setEditingProjectId(project.id);
    setProjectForm({
      title: project.title,
      summary: project.summary,
      links: project.links.join('\n'),
      claim: '',
    });
    setProjectError(null);
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingProject) return;
    setSavingProject(true);
    setProjectError(null);
    const links = projectForm.links
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
    const claims = projectForm.claim.trim()
      ? [{ kind: 'project' as const, text: projectForm.claim.trim() }]
      : [];

    try {
      const existing = editingProjectId;
      const response = await fetch(
        existing ? `/api/v1/projects/${existing}` : '/api/v1/projects',
        {
          method: existing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: projectForm.title.trim(),
            summary: projectForm.summary.trim(),
            links,
            claims,
          }),
        },
      );
      await readApi<Project>(response);
      setProjectForm(emptyProjectForm);
      setEditingProjectId(null);
      await loadProfile();
    } catch (error) {
      setProjectError(
        error instanceof Error
          ? error.message
          : 'We could not save this project.',
      );
    } finally {
      setSavingProject(false);
    }
  }

  async function deleteProject(projectId: string) {
    setProjectError(null);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const body = (await response.json()) as ApiBody<unknown>;
        throw new Error(safeMessage(body.error?.code));
      }
      setDeleteProjectId(null);
      await loadProfile();
    } catch (error) {
      setProjectError(
        error instanceof Error
          ? error.message
          : 'We could not delete this project.',
      );
    }
  }

  const proposedCount = facts.filter(
    (fact) => fact.status === 'proposed',
  ).length;
  const factGroups = (
    [
      ['education', 'Education'],
      ['experience', 'Experience'],
      ['volunteering', 'Volunteering'],
      ['responsibility', 'Positions of responsibility'],
      ['project', 'Projects'],
      ['achievement', 'Achievements'],
      ['certification', 'Certifications'],
      ['skill', 'Skills'],
      ['language', 'Languages'],
      ['eligibility', 'Right to work (used only to check fit)'],
    ] as const
  )
    .map(([kind, title]) => ({
      kind,
      title,
      facts: facts.filter((fact) => fact.kind === kind),
    }))
    .filter((group) => group.facts.length > 0);

  async function approveGroup(group: ProfileFact[]) {
    for (const fact of group.filter((item) => item.status === 'proposed'))
      await updateFact(fact, { status: 'approved' });
  }

  return (
    <div
      className={
        applicationMode ? styles.applicationProfile : styles.profileScroll
      }
    >
      {loadError && (
        <p className={styles.error} role="alert">
          {loadError}{' '}
          <button
            type="button"
            onClick={() => {
              if (!profileLoaded) setLoading(true);
              void loadProfile();
            }}
          >
            Try again
          </button>
        </p>
      )}

      {!applicationMode && <ProfilePreferencesForm />}
      <section className={styles.section} aria-labelledby="cv-heading">
        <div className={styles.sectionHeading}>
          <h2 id="cv-heading">Add a CV</h2>
          <p>Upload a PDF or DOCX. You choose which facts to keep.</p>
        </div>
        <div className={styles.panel}>
          <form className={styles.uploadForm} onSubmit={submitCv}>
            <label className={styles.field} htmlFor="cv-file">
              Choose a CV file
              <input
                className={styles.fileInput}
                id="cv-file"
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <div className={styles.actions}>
              <Button
                variant="primary"
                type="submit"
                disabled={!file || uploading}
              >
                {uploading ? 'Uploading…' : 'Upload CV'}
              </Button>
              {file && <span className={styles.meta}>{file.name}</span>}
            </div>
          </form>
          {uploadError && (
            <p className={styles.error} role="alert">
              {uploadError}
            </p>
          )}
          {upload && (
            <p className={styles.feedback} role="status" aria-live="polite">
              {upload.fileName}: {statusText(upload.task)}
            </p>
          )}
          {applicationMode && (
            <p className={styles.meta}>
              If this CV cannot be read or has no useful facts, add one below in
              your own words. New facts need your approval before they can be
              used.
            </p>
          )}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="facts-heading">
        <div className={styles.sectionHeading}>
          <h2 id="facts-heading">Facts about your experience</h2>
          <p>
            {loading
              ? 'Loading saved facts…'
              : profileLoaded
                ? `${proposedCount} waiting for your review`
                : 'Your facts are unavailable until your profile loads.'}
          </p>
        </div>
        {applicationMode && profileLoaded && (
          <form className={styles.panel} onSubmit={submitManualFact}>
            <h3>Add a fact in your own words</h3>
            <p className={styles.meta}>
              Use a real detail about your experience, skills, education, or
              achievements. It will start as proposed for you to review.
            </p>
            <label className={styles.field}>
              Type of fact
              <select
                value={manualFactKind}
                onChange={(event) =>
                  setManualFactKind(event.target.value as FactKind)
                }
                disabled={savingManualFact}
              >
                <option value="experience">Experience</option>
                <option value="skill">Skill</option>
                <option value="education">Education</option>
                <option value="achievement">Achievement</option>
                <option value="certification">Certification</option>
                <option value="project">Project</option>
                <option value="volunteering">Volunteering</option>
                <option value="responsibility">
                  Position of responsibility
                </option>
                <option value="language">Language</option>
                <option value="eligibility">
                  Right to work (only if you want it checked)
                </option>
              </select>
            </label>
            <label className={styles.field}>
              Fact
              <textarea
                required
                maxLength={10000}
                value={manualFactText}
                onChange={(event) => setManualFactText(event.target.value)}
                disabled={savingManualFact}
                placeholder="For example: I coordinated a four-person team project."
              />
            </label>
            <div className={styles.actions}>
              <Button
                variant="secondary"
                type="submit"
                disabled={savingManualFact || !manualFactText.trim()}
              >
                {savingManualFact ? 'Adding fact…' : 'Add proposed fact'}
              </Button>
            </div>
          </form>
        )}
        {loading ? (
          <p className={styles.empty} role="status">
            Loading your facts…
          </p>
        ) : !profileLoaded ? (
          <p className={styles.empty} role="status">
            Your saved facts are unavailable until your profile loads.
          </p>
        ) : facts.length === 0 ? (
          <p className={styles.empty}>
            No facts yet. Upload a CV or add a fact above, then approve the
            details you want to use for this application.
          </p>
        ) : (
          factGroups.map((group) => {
            const waiting = group.facts.filter(
              (fact) => fact.status === 'proposed',
            ).length;
            return (
              <div
                className={styles.factList}
                key={group.kind}
                role="group"
                aria-label={group.title}
              >
                <div className={styles.factHeader}>
                  <h3>
                    {group.title} ({group.facts.length})
                  </h3>
                  {waiting > 0 && (
                    <Button
                      variant="secondary"
                      disabled={busyFactId !== null}
                      onClick={() => void approveGroup(group.facts)}
                    >
                      Approve all {waiting} in {group.title}
                    </Button>
                  )}
                </div>
                {group.facts.map((fact) => (
                  <article className={styles.fact} key={fact.id}>
                    <div className={styles.factHeader}>
                      <div className={styles.actions}>
                        <span className={styles.badge}>{fact.kind}</span>
                        <span className={styles.meta}>From {fact.source}</span>
                      </div>
                      <span
                        className={`${styles.badge} ${styles[fact.status]}`}
                      >
                        {fact.status}
                      </span>
                    </div>
                    {editingFactId === fact.id ? (
                      <label className={styles.field}>
                        Edit this fact
                        <textarea
                          className={styles.factEdit}
                          value={factDraft}
                          onChange={(event) => setFactDraft(event.target.value)}
                        />
                      </label>
                    ) : (
                      <>
                        <p className={styles.factText}>{fact.text}</p>
                        {(fact.role || fact.organisation || fact.startDate) && (
                          <p className={styles.meta}>
                            {[
                              fact.role,
                              fact.organisation,
                              [fact.startDate, fact.endDate]
                                .filter(Boolean)
                                .join(' – '),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        )}
                      </>
                    )}
                    <div className={styles.actions}>
                      {editingFactId === fact.id ? (
                        <>
                          <Button
                            variant="primary"
                            disabled={
                              busyFactId === fact.id || !factDraft.trim()
                            }
                            onClick={() =>
                              void updateFact(fact, { text: factDraft.trim() })
                            }
                          >
                            {busyFactId === fact.id ? 'Saving…' : 'Save edit'}
                          </Button>
                          <Button
                            variant="text"
                            disabled={busyFactId === fact.id}
                            onClick={() => setEditingFactId(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="text"
                            disabled={busyFactId === fact.id}
                            onClick={() => {
                              setEditingFactId(fact.id);
                              setFactDraft(fact.text);
                            }}
                          >
                            Edit
                          </Button>
                          {fact.status === 'proposed' ? (
                            <>
                              <Button
                                variant="primary"
                                disabled={busyFactId === fact.id}
                                onClick={() =>
                                  void updateFact(fact, { status: 'approved' })
                                }
                              >
                                Approve
                              </Button>
                              <Button
                                variant="text"
                                disabled={busyFactId === fact.id}
                                onClick={() =>
                                  void updateFact(fact, { status: 'rejected' })
                                }
                              >
                                Reject
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="text"
                              disabled={busyFactId === fact.id}
                              onClick={() =>
                                void updateFact(fact, { status: 'proposed' })
                              }
                            >
                              Return to review
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            );
          })
        )}
        {factError && (
          <p className={styles.error} role="alert">
            {factError}
          </p>
        )}
      </section>

      {!applicationMode && (
        <section className={styles.section} aria-labelledby="projects-heading">
          <div className={styles.sectionHeading}>
            <h2 id="projects-heading">Projects</h2>
            <p>Save work you want to use as evidence in future applications.</p>
          </div>
          <div className={styles.projectGrid}>
            <div className={styles.projectList}>
              {!profileLoaded && loading ? (
                <p className={styles.empty} role="status">
                  Loading your projects…
                </p>
              ) : !profileLoaded ? (
                <p className={styles.empty} role="status">
                  Your saved projects are unavailable until your profile loads.
                </p>
              ) : projects.length === 0 ? (
                <p className={styles.empty}>No projects saved yet.</p>
              ) : (
                projects.map((project) => (
                  <article className={styles.project} key={project.id}>
                    <div className={styles.projectHeader}>
                      <h3>{project.title}</h3>
                      <span className={styles.meta}>
                        {project.claims.length} claims
                      </span>
                    </div>
                    <p className={styles.factText}>{project.summary}</p>
                    {project.claims.length > 0 && (
                      <ul
                        className={styles.claims}
                        aria-label={`Claims for ${project.title}`}
                      >
                        {project.claims.map((claim) => (
                          <li className={styles.claim} key={claim.id}>
                            <span>{claim.text}</span>
                            <span
                              className={`${styles.badge} ${styles[claim.status]}`}
                            >
                              {claim.status}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {project.links.length > 0 && (
                      <div
                        className={styles.linkList}
                        aria-label={`Links for ${project.title}`}
                      >
                        {project.links.map((link) => {
                          const href = safeLink(link);
                          return href ? (
                            <a
                              href={href}
                              key={link}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {link}
                            </a>
                          ) : (
                            <span key={link}>{link}</span>
                          );
                        })}
                      </div>
                    )}
                    <div className={styles.actions}>
                      <Button
                        variant="text"
                        onClick={() => beginProjectEdit(project)}
                      >
                        Edit project
                      </Button>
                      {deleteProjectId === project.id ? (
                        <>
                          <Button
                            variant="primary"
                            onClick={() => void deleteProject(project.id)}
                          >
                            Confirm delete
                          </Button>
                          <Button
                            variant="text"
                            onClick={() => setDeleteProjectId(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="text"
                          onClick={() => setDeleteProjectId(project.id)}
                        >
                          Delete project
                        </Button>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>

            <form
              className={`${styles.panel} ${styles.projectForm}`}
              onSubmit={saveProject}
            >
              <h3>{editingProjectId ? 'Edit project' : 'Add a project'}</h3>
              <label className={styles.field}>
                Project name
                <input
                  required
                  maxLength={160}
                  value={projectForm.title}
                  onChange={(event) =>
                    setProjectForm((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                />
              </label>
              <label className={styles.field}>
                What did you work on?
                <textarea
                  required
                  maxLength={4000}
                  value={projectForm.summary}
                  onChange={(event) =>
                    setProjectForm((current) => ({
                      ...current,
                      summary: event.target.value,
                    }))
                  }
                />
              </label>
              <label className={styles.field}>
                Links, one per line
                <textarea
                  value={projectForm.links}
                  onChange={(event) =>
                    setProjectForm((current) => ({
                      ...current,
                      links: event.target.value,
                    }))
                  }
                />
              </label>
              <label className={styles.field}>
                Add a claim for review (optional)
                <textarea
                  value={projectForm.claim}
                  onChange={(event) =>
                    setProjectForm((current) => ({
                      ...current,
                      claim: event.target.value,
                    }))
                  }
                  placeholder="A specific contribution or result"
                />
              </label>
              <div className={styles.actions}>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={savingProject}
                >
                  {savingProject
                    ? 'Saving…'
                    : editingProjectId
                      ? 'Save project'
                      : 'Add project'}
                </Button>
                {editingProjectId && (
                  <Button
                    variant="text"
                    type="button"
                    onClick={() => {
                      setEditingProjectId(null);
                      setProjectForm(emptyProjectForm);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
              {projectError && (
                <p className={styles.error} role="alert">
                  {projectError}
                </p>
              )}
              {editingProjectId && (
                <p className={styles.meta}>
                  New claims are added as proposed facts; existing fact review
                  states stay the same.
                </p>
              )}
            </form>
          </div>
        </section>
      )}
      {children}
    </div>
  );
}
