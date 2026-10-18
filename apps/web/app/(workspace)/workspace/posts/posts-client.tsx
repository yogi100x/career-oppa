'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import Link from 'next/link';
import { Button } from '../../../../components/workspace';
import CreditRecovery from '../../../../components/workspace/credit-recovery';
import styles from './posts.module.css';

type ProfileProject = { id: string; title: string; summary: string | null };
type ProfileFact = {
  id: string;
  projectId: string | null;
  text: string;
  status: string;
};
type Post = {
  id: string;
  projectId: string;
  content: string;
  factIds: string[];
  destination: 'copy' | 'social';
  socialConnectionId: string | null;
  approvedContent: string | null;
  approvedDestination: { destination: string; platform: string | null } | null;
  approvedAt: string | null;
  status:
    | 'draft'
    | 'approved'
    | 'copy_ready'
    | 'publishing'
    | 'published'
    | 'failed'
    | 'unknown';
  publicUrl: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  firstAttemptAt: string | null;
};
type Connection = {
  id: string;
  platform: string;
  status: string;
  displayName: string | null;
} | null;
type ApiEnvelope<T> = { data?: T; error?: { code?: string; message?: string } };

async function readApi<T>(response: Response): Promise<ApiEnvelope<T>> {
  return (await response.json()) as ApiEnvelope<T>;
}

function postStatus(post: Post) {
  if (post.status === 'published') return 'Published';
  if (post.status === 'publishing') return 'Checking with provider';
  if (post.status === 'unknown') return 'Not confirmed';
  if (post.status === 'failed') return 'Provider reported a failure';
  if (post.status === 'copy_ready') return 'Approved to copy';
  if (post.status === 'approved') return 'Approved for social';
  return 'Draft';
}

export default function PostsClient() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [projects, setProjects] = useState<ProfileProject[]>([]);
  const [facts, setFacts] = useState<ProfileFact[]>([]);
  const [connection, setConnection] = useState<Connection>(null);
  const [projectId, setProjectId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [content, setContent] = useState('');
  const [factIds, setFactIds] = useState<string[]>([]);
  const [destination, setDestination] = useState<'copy' | 'social'>('copy');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [postResponse, projectResponse, factResponse, connectionResponse] =
      await Promise.all([
        fetch('/api/v1/posts', { cache: 'no-store' }),
        fetch('/api/v1/projects', { cache: 'no-store' }),
        fetch('/api/v1/profile/facts', { cache: 'no-store' }),
        fetch('/api/v1/social-connections', { cache: 'no-store' }),
      ]);
    const [postBody, projectBody, factBody, connectionBody] = await Promise.all(
      [
        readApi<Post[]>(postResponse),
        readApi<{ projects: ProfileProject[] }>(projectResponse),
        readApi<{ facts: ProfileFact[] }>(factResponse),
        readApi<Connection>(connectionResponse),
      ],
    );
    if (!postResponse.ok)
      throw new Error(postBody.error?.message ?? 'Posts could not be loaded.');
    if (!projectResponse.ok)
      throw new Error(
        projectBody.error?.message ?? 'Projects could not be loaded.',
      );
    if (!factResponse.ok)
      throw new Error(
        factBody.error?.message ?? 'Approved facts could not be loaded.',
      );
    if (!connectionResponse.ok)
      throw new Error(
        connectionBody.error?.message ??
          'Social account status could not be loaded.',
      );
    setPosts(postBody.data ?? []);
    setProjects(projectBody.data?.projects ?? []);
    setFacts(factBody.data?.facts ?? []);
    setConnection(connectionBody.data ?? null);
    setProjectId(
      (current) => current || projectBody.data?.projects[0]?.id || '',
    );
    setSelectedId((current) =>
      current && (postBody.data ?? []).some((post) => post.id === current)
        ? current
        : ((postBody.data ?? [])[0]?.id ?? ''),
    );
    setLoaded(true);
    setError('');
  }, []);

  useEffect(() => {
    let active = true;
    void load()
      .catch(() => {
        if (active)
          setError('Your saved posts could not be loaded. Try again.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  const selected = posts.find((post) => post.id === selectedId) ?? null;
  const approvedFacts = useMemo(
    () =>
      facts.filter(
        (fact) =>
          fact.projectId === selected?.projectId && fact.status === 'approved',
      ),
    [facts, selected?.projectId],
  );
  const selectedProject = projects.find(
    (project) => project.id === selected?.projectId,
  );
  const projectApprovedFacts = facts.filter(
    (fact) => fact.projectId === projectId && fact.status === 'approved',
  );

  useEffect(() => {
    if (!selected) {
      setContent('');
      setFactIds([]);
      setDestination('copy');
      setConfirmed(false);
      return;
    }
    setContent(selected.content);
    setFactIds(selected.factIds ?? []);
    setDestination(selected.destination ?? 'copy');
    setConfirmed(false);
  }, [selectedId, selected?.updatedAt]);

  async function retryLoad() {
    setError('');
    if (!loaded) setLoading(true);
    try {
      await load();
    } catch {
      setError('Your saved posts could not be loaded. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('draft');
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/v1/posts', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ projectId }),
      });
      const body = await readApi<Post>(response);
      if (!response.ok || !body.data)
        throw new Error(
          body.error?.message ?? 'The post could not be drafted.',
        );
      await load();
      setSelectedId(body.data.id);
      setNotice('Draft saved. Check every line against your project evidence.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The post could not be drafted.',
      );
    } finally {
      setBusy('');
    }
  }

  async function saveDraft() {
    if (!selected) return;
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/v1/posts/${selected.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content,
          fact_ids: factIds,
          destination,
          connectionId:
            destination === 'social' ? (connection?.id ?? null) : null,
        }),
      });
      const body = await readApi<Post>(response);
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? 'The draft could not be saved.');
      await load();
      setNotice('Draft changes saved. Review again before approval.');
      setConfirmed(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The draft could not be saved.',
      );
    } finally {
      setBusy('');
    }
  }

  async function approve() {
    if (!selected) return;
    setBusy('approve');
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/v1/posts/${selected.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content,
          destination,
          connectionId:
            destination === 'social' ? (connection?.id ?? null) : null,
          confirmed: true,
        }),
      });
      const body = await readApi<Post>(response);
      if (!response.ok || !body.data)
        throw new Error(
          body.error?.message ?? 'The post could not be approved.',
        );
      await load();
      setNotice(
        destination === 'copy'
          ? 'Exact text approved for copying. It has not been published.'
          : 'Exact text and social account approved. It has not been published.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The post could not be approved.',
      );
    } finally {
      setBusy('');
    }
  }

  async function copyApproved() {
    if (!selected) return;
    const text = selected.approvedContent ?? selected.content;
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Approved text copied. You can paste and publish it yourself.');
      setError('');
    } catch {
      setError(
        'Clipboard access was blocked. Select and copy the approved text below.',
      );
    }
  }

  async function connectAccount() {
    setBusy('connect');
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/v1/social-connections', {
        method: 'POST',
      });
      const body = await readApi<{ authUrl: string }>(response);
      if (!response.ok || !body.data?.authUrl)
        throw new Error(
          body.error?.message ?? 'Account connection is not configured yet.',
        );
      window.location.assign(body.data.authUrl);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Account connection could not start.',
      );
    } finally {
      setBusy('');
    }
  }

  async function disconnectAccount() {
    if (
      !window.confirm(
        'Disconnect this social account? Saved post drafts will remain.',
      )
    )
      return;
    setBusy('disconnect');
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/v1/social-connections', {
        method: 'DELETE',
      });
      const body = await readApi<Connection>(response);
      if (!response.ok)
        throw new Error(
          body.error?.message ?? 'The account could not be disconnected.',
        );
      await load();
      setNotice('Social account disconnected. Your drafts are still saved.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The account could not be disconnected.',
      );
    } finally {
      setBusy('');
    }
  }

  async function publish() {
    if (!selected) return;
    setBusy('publish');
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/v1/posts/${selected.id}/publish`, {
        method: 'POST',
      });
      const body = await readApi<{ task: { id: string; status: string } }>(
        response,
      );
      if (!response.ok || !body.data?.task)
        throw new Error(body.error?.message ?? 'Publishing could not start.');
      setNotice('Publishing is being checked. This may take a moment.');
      const taskId = body.data.task.id;
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const taskResponse = await fetch(`/api/v1/tasks/${taskId}`, {
          cache: 'no-store',
        });
        const taskBody = await readApi<{ status: string }>(taskResponse);
        if (!taskResponse.ok || !taskBody.data)
          throw new Error(
            taskBody.error?.message ??
              'Publishing status could not be checked.',
          );
        if (
          taskBody.data.status === 'queued' ||
          taskBody.data.status === 'running'
        )
          continue;
        await load();
        if (taskBody.data.status === 'succeeded') {
          const postResponse = await fetch(`/api/v1/posts/${selected.id}`, {
            cache: 'no-store',
          });
          const postBody = await readApi<Post>(postResponse);
          if (postBody.data?.status === 'published') setNotice('Published.');
          else
            setNotice(
              'The task finished, but the post is not marked published. Check its status before acting.',
            );
        } else {
          setError(
            'The provider could not confirm publication. Your approved text is still saved; review status before trying again.',
          );
        }
        return;
      }
      setNotice(
        'Publishing is still being checked. Return later to see the result.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Publishing status could not be checked.',
      );
    } finally {
      setBusy('');
    }
  }

  if (!loaded) {
    return (
      <div className={styles.page}>
        <header className={styles.pageHeading}>
          <div>
            <p>From your real project evidence</p>
            <h1>Posts</h1>
            <span>
              Review the words and where they go before anything leaves this
              workspace.
            </span>
          </div>
        </header>
        {loading ? (
          <p role="status">Loading your posts…</p>
        ) : (
          <section aria-label="Posts unavailable">
            <p className={styles.error} role="alert">
              {error || 'Your saved posts could not be loaded. Try again.'}
            </p>
            <Button variant="secondary" onClick={() => void retryLoad()}>
              Try again
            </Button>
          </section>
        )}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHeading}>
        <div>
          <p>From your real project evidence</p>
          <h1>Posts</h1>
          <span>
            Review the words and where they go before anything leaves this
            workspace.
          </span>
        </div>
        <form
          className={styles.newPost}
          onSubmit={(event) => void createDraft(event)}
        >
          <label htmlFor="post-project">Project</label>
          <select
            id="post-project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            disabled={!projects.length}
          >
            {!projects.length && <option value="">Add a project first</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={
              busy !== '' || !projectId || projectApprovedFacts.length === 0
            }
          >
            {busy === 'draft' ? 'Drafting…' : 'Draft post · 1 credit'}
          </button>
        </form>
      </header>
      {projects.length > 0 &&
        projectId &&
        projectApprovedFacts.length === 0 && (
          <p className={styles.guidance}>
            Approve at least one fact for this project before drafting a post.{' '}
            <Link href="/workspace/profile">Review project facts</Link>
          </p>
        )}
      <p className={styles.guidance}>
        Drafting uses AI to suggest words from your approved project facts.
        Every post stays a draft until you review and approve its exact text and
        destination.
      </p>
      {error && (
        <>
          <p className={styles.error} role="alert">
            {error}
          </p>
          <CreditRecovery message={error} />
        </>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">Loading your posts…</p>
      ) : (
        <div className={styles.workspace}>
          <section className={styles.list} aria-labelledby="post-list-title">
            <div className={styles.sectionHeading}>
              <h2 id="post-list-title">Your drafts</h2>
              <span>{posts.length}</span>
            </div>
            {posts.length === 0 ? (
              <p className={styles.empty}>
                No posts yet. Choose a project with approved facts to start a
                draft.
              </p>
            ) : (
              <ul>
                {posts.map((post) => (
                  <li key={post.id}>
                    <button
                      type="button"
                      aria-current={selectedId === post.id ? 'true' : undefined}
                      onClick={() => {
                        setSelectedId(post.id);
                        setError('');
                        setNotice('');
                      }}
                    >
                      <span>
                        {projects.find(
                          (project) => project.id === post.projectId,
                        )?.title ?? 'Project post'}
                      </span>
                      <small>
                        {post.content.slice(0, 84) || 'Untitled draft'}
                      </small>
                      <em>{postStatus(post)}</em>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className={styles.editor} aria-label="Post editor">
            {!selected ? (
              <div className={styles.emptyEditor}>
                <h2>Start with a project</h2>
                <p>
                  Choose a project with approved evidence. Drafts that cannot be
                  grounded in approved facts stay blocked.
                </p>
                <Link href="/workspace/profile">
                  Review your profile and projects
                </Link>
              </div>
            ) : (
              <>
                <div className={styles.editorHeading}>
                  <div>
                    <small>{selectedProject?.title ?? 'Project'}</small>
                    <h2>Edit and review</h2>
                  </div>
                  <span className={styles.status} data-status={selected.status}>
                    {postStatus(selected)}
                  </span>
                </div>
                <label className={styles.field} htmlFor="post-text">
                  Post text
                  <textarea
                    id="post-text"
                    rows={10}
                    value={content}
                    disabled={Boolean(selected.firstAttemptAt)}
                    onChange={(event) => {
                      setContent(event.target.value);
                      setConfirmed(false);
                    }}
                    maxLength={5000}
                  />
                </label>
                <div className={styles.evidence}>
                  <h3>Approved project facts</h3>
                  {approvedFacts.length ? (
                    <ul>
                      {approvedFacts.map((fact) => (
                        <li key={fact.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={factIds.includes(fact.id)}
                              onChange={(event) => {
                                setFactIds((current) =>
                                  event.target.checked
                                    ? [...new Set([...current, fact.id])]
                                    : current.filter((id) => id !== fact.id),
                                );
                                setConfirmed(false);
                              }}
                              disabled={Boolean(selected.firstAttemptAt)}
                            />
                            <span>{fact.text}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>
                      No approved facts belong to this project.{' '}
                      <Link href="/workspace/profile">
                        Review project facts
                      </Link>{' '}
                      before approving this post.
                    </p>
                  )}
                </div>
                <fieldset className={styles.destination}>
                  <legend>Where should it go?</legend>
                  <label>
                    <input
                      type="radio"
                      name="post-destination"
                      value="copy"
                      checked={destination === 'copy'}
                      onChange={() => {
                        setDestination('copy');
                        setConfirmed(false);
                      }}
                      disabled={Boolean(selected.firstAttemptAt)}
                    />
                    Copy text for me to publish
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="post-destination"
                      value="social"
                      checked={destination === 'social'}
                      onChange={() => {
                        setDestination('social');
                        setConfirmed(false);
                      }}
                      disabled={
                        !connection ||
                        connection.status !== 'connected' ||
                        Boolean(selected.firstAttemptAt)
                      }
                    />
                    Publish through{' '}
                    {connection?.platform ?? 'a connected account'}
                  </label>
                  {connection?.status === 'connected' ? (
                    <div>
                      <p>
                        Connected to{' '}
                        {connection.displayName ?? connection.platform}.
                      </p>
                      <button
                        type="button"
                        disabled={busy !== ''}
                        onClick={() => void disconnectAccount()}
                      >
                        Disconnect account
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy !== ''}
                      onClick={() => void connectAccount()}
                    >
                      Connect a social account
                    </button>
                  )}
                </fieldset>
                {selected.approvedAt && (
                  <p className={styles.approvedNote}>
                    Approved text is saved. Approval does not publish it.
                  </p>
                )}
                {selected.status === 'unknown' && (
                  <p className={styles.caution}>
                    The provider has not confirmed whether this post went live.
                    Check status before another attempt.
                  </p>
                )}
                {selected.status === 'failed' && (
                  <p className={styles.caution}>
                    The provider reported a failure. Your approved text remains
                    available to copy.
                  </p>
                )}
                {selected.status === 'published' && selected.publicUrl && (
                  <p>
                    <a
                      href={selected.publicUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View published post
                    </a>
                  </p>
                )}
                <div className={styles.controls}>
                  <button
                    type="button"
                    disabled={busy !== '' || Boolean(selected.firstAttemptAt)}
                    onClick={() => void saveDraft()}
                  >
                    {busy === 'save' ? 'Saving…' : 'Save draft'}
                  </button>
                  {selected.approvedAt ? (
                    <button type="button" onClick={() => void copyApproved()}>
                      Copy approved text
                    </button>
                  ) : (
                    <>
                      <label className={styles.confirm}>
                        <input
                          type="checkbox"
                          checked={confirmed}
                          onChange={(event) =>
                            setConfirmed(event.target.checked)
                          }
                        />
                        I reviewed the exact text and destination.
                      </label>
                      <button
                        type="button"
                        disabled={
                          busy !== '' ||
                          !confirmed ||
                          approvedFacts.length === 0 ||
                          factIds.length === 0
                        }
                        onClick={() => void approve()}
                      >
                        {busy === 'approve'
                          ? 'Approving…'
                          : 'Approve this exact post'}
                      </button>
                    </>
                  )}
                  {selected.approvedAt &&
                    selected.destination === 'social' &&
                    selected.status !== 'published' && (
                      <button
                        type="button"
                        disabled={busy !== ''}
                        onClick={() => void publish()}
                      >
                        {busy === 'publish'
                          ? 'Checking…'
                          : selected.status === 'unknown' ||
                              selected.status === 'failed'
                            ? 'Check status · free'
                            : 'Publish · free'}
                      </button>
                    )}
                </div>
                {selected.approvedContent && (
                  <details className={styles.approvedPreview}>
                    <summary>Approved text</summary>
                    <p>{selected.approvedContent}</p>
                  </details>
                )}
              </>
            )}
          </section>
        </div>
      )}
      <footer className={styles.footer}>
        <Link href="/workspace">Back to your workspace</Link>
      </footer>
    </div>
  );
}
