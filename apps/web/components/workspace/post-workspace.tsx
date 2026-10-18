'use client';

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import s from './post-workspace.module.css';

const destinations = [
  'LinkedIn',
  'X',
  'Facebook',
  'Instagram',
  'Threads',
  'Pinterest',
  'Reddit',
  'Bluesky',
];
const projects = [
  {
    name: 'Campus food-waste project',
    proof:
      'A student project exploring how campus kitchens could reduce food waste.',
  },
  {
    name: 'Career portfolio',
    proof: 'A portfolio project collecting selected work and reflections.',
  },
  {
    name: 'Community volunteering',
    proof: 'A volunteering experience you can describe with your own details.',
  },
];
const example =
  'Small changes can make a project easier to use.\n\nThis sample draft is based on the project evidence shown beside the editor. Add your own approved details before sharing.\n\nWhat is one small improvement you have made to a project recently?';
const initialSlides = [
  'A small change can make a project easier to use.',
  'Start with the moment that feels confusing.',
  'Make the next step clear, then ask people what helped.',
];
const initialScript =
  'OPEN\nA small change can make a project easier to use.\n\nMAIN POINT\nAsk which part of the project feels confusing, then make the next step clearer.\n\nCLOSE\nWhat small improvement helped your project?';
type Format = 'Post' | 'Image' | 'Carousel' | 'Video script';
export type PostWorkspaceProps = {
  projects?: { name: string; proof: string }[];
  onPostChange?: (text: string) => void;
  onPreviewPublish?: (details: {
    text: string;
    destination: string;
    when: string;
  }) => void;
  onRewardSubmit?: (details: {
    url: string;
    disclosureConfirmed: boolean;
  }) => void;
};

export function PostWorkspace({
  projects: projectOptions = projects,
  onPostChange,
  onPreviewPublish,
  onRewardSubmit,
}: PostWorkspaceProps) {
  const [suggestion, setSuggestion] = useState<{
    base: string;
    text: string;
  } | null>(null);
  const [project, setProject] = useState(0);
  const [format, setFormat] = useState<Format>('Post');
  const [text, setText] = useState(example);
  const [slides, setSlides] = useState(initialSlides);
  const [script, setScript] = useState(initialScript);
  const [destination, setDestination] = useState(destinations[0]);
  const [timing, setTiming] = useState<'now' | 'schedule'>('now');
  const [scheduleAt, setScheduleAt] = useState('');
  const [approved, setApproved] = useState(false);
  const [publishedPreview, setPublishedPreview] = useState(false);
  const [publicationState, setPublicationState] = useState<
    'Preview only' | 'Outcome uncertain' | 'Failed · draft kept'
  >('Preview only');
  const [imageUrl, setImageUrl] = useState('');
  const [imageName, setImageName] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [postUrl, setPostUrl] = useState('');
  const [disclosure, setDisclosure] = useState(false);
  const [rewardStatus, setRewardStatus] = useState<
    | 'Not submitted'
    | 'Pending review'
    | 'Approved'
    | 'Rejected'
    | 'Monthly cap reached'
  >('Not submitted');
  const [rewardMessage, setRewardMessage] = useState('');
  const [seenRewardUrls, setSeenRewardUrls] = useState<string[]>([]);
  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );

  const currentProject = projectOptions[project] ?? projectOptions[0];
  const formatText =
    format === 'Carousel'
      ? slides.join('\n\n')
      : format === 'Video script'
        ? script
        : text;
  const previewText = useMemo(
    () => formatText.trim() || 'Your post preview will appear here.',
    [formatText],
  );
  const updateText = (value: string) => {
    setText(value);
    setApproved(false);
    setPublishedPreview(false);
    onPostChange?.(value);
  };
  const updateSlide = (index: number, value: string) => {
    setSlides((old) => old.map((slide, i) => (i === index ? value : slide)));
    setApproved(false);
    setPublishedPreview(false);
  };
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(formatText);
      setCopyMessage('Copied to clipboard.');
    } catch {
      setCopyMessage(
        'Copy is unavailable here. Select the preview text and copy it.',
      );
    }
  };
  const uploadImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 8 * 1024 * 1024) {
      setCopyMessage('Choose an image under 8 MB.');
      event.target.value = '';
      return;
    }
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(URL.createObjectURL(file));
    setImageName(file.name);
    setApproved(false);
    setPublishedPreview(false);
  };
  let validPostUrl = false;
  try {
    validPostUrl = new URL(postUrl.trim()).protocol === 'https:';
  } catch {
    validPostUrl = false;
  }
  const submitReward = () => {
    let parsed: URL;
    try {
      parsed = new URL(postUrl.trim());
    } catch {
      return;
    }
    if (parsed.protocol !== 'https:' || !disclosure) return;
    [...parsed.searchParams.keys()]
      .filter(
        (key) =>
          key.toLowerCase().startsWith('utm_') ||
          ['fbclid', 'gclid', 'ref'].includes(key.toLowerCase()),
      )
      .forEach((key) => parsed.searchParams.delete(key));
    parsed.hash = '';
    parsed.searchParams.sort();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const canonical = parsed.toString().replace(/\/$/, '');
    if (seenRewardUrls.includes(canonical)) {
      setRewardMessage(
        'This post link has already been submitted. Each post can earn a reward once.',
      );
      return;
    }
    setRewardMessage(
      'Sample submission received. No credits have been granted.',
    );
    setSeenRewardUrls((old) => [...old, canonical]);
    setRewardStatus('Pending review');
    onRewardSubmit?.({ url: canonical, disclosureConfirmed: disclosure });
  };
  const previewPublication = () => {
    if (
      !approved ||
      (timing === 'schedule' &&
        (!scheduleAt || new Date(scheduleAt).getTime() <= Date.now()))
    )
      return;
    const when =
      timing === 'now' ? 'Immediately' : new Date(scheduleAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    setPublishedPreview(true);
    onPreviewPublish?.({ text: formatText, destination, when });
  };

  if (!currentProject)
    return (
      <p className={s.empty}>Add a project to choose evidence for a post.</p>
    );
  return (
    <div className={s.workspace}>
      <div className={s.notice}>
        <strong>Preview only</strong>
        <span>
          Sample draft · No AI call, account connection, post, or credit change
          happens here.
        </span>
      </div>
      <div className={s.grid}>
        <section className={s.editor} aria-label="Post editor">
          <div className={s.field}>
            <label htmlFor="post-project">Project evidence</label>
            <select
              id="post-project"
              value={project}
              onChange={(e) => {
                setProject(Number(e.target.value));
                setApproved(false);
                setPublishedPreview(false);
              }}
            >
              {projectOptions.map((item, index) => (
                <option value={index} key={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
            <p className={s.proof}>{currentProject.proof}</p>
          </div>
          <div
            className={s.formatTabs}
            role="tablist"
            aria-label="Content format"
          >
            {(['Post', 'Image', 'Carousel', 'Video script'] as Format[]).map(
              (item) => (
                <button
                  type="button"
                  role="tab"
                  tabIndex={format === item ? 0 : -1}
                  onKeyDown={(event) => {
                    const formats: Format[] = [
                      'Post',
                      'Image',
                      'Carousel',
                      'Video script',
                    ];
                    const index = formats.indexOf(item);
                    const next =
                      event.key === 'ArrowRight'
                        ? (index + 1) % 4
                        : event.key === 'ArrowLeft'
                          ? (index + 3) % 4
                          : event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? 3
                              : -1;
                    if (next >= 0) {
                      event.preventDefault();
                      setFormat(formats[next]);
                      setApproved(false);
                      setPublishedPreview(false);
                      (
                        event.currentTarget.parentElement?.children[
                          next
                        ] as HTMLButtonElement
                      )?.focus();
                    }
                  }}
                  aria-selected={format === item}
                  key={item}
                  onClick={() => {
                    setFormat(item);
                    setApproved(false);
                    setPublishedPreview(false);
                  }}
                >
                  {item}
                </button>
              ),
            )}
          </div>
          {format === 'Post' && (
            <div className={s.field}>
              <label htmlFor="post-draft-text">Post text</label>
              <textarea
                id="post-draft-text"
                value={text}
                maxLength={3000}
                onChange={(e) => updateText(e.target.value)}
                rows={9}
              />
              <small>{text.length} / 3,000 characters</small>
              <button
                type="button"
                className={s.secondary}
                onClick={() =>
                  setSuggestion({
                    base: text,
                    text: 'A useful project starts with a clear next step.\n\nDescribe the problem you worked on, the contribution you can support with evidence, and what you learned.\n\nWhat would you improve next?',
                  })
                }
              >
                Show sample rewrite
              </button>
              {suggestion && (
                <div className={s.proof}>
                  <strong>Suggested wording · sample</strong>
                  <p>{suggestion.text}</p>
                  {suggestion.base !== text && (
                    <p>
                      Your draft changed after this suggestion. Your edits are
                      kept; request a new sample to continue.
                    </p>
                  )}
                  <div className={s.actions}>
                    <button
                      type="button"
                      className={s.secondary}
                      disabled={suggestion.base !== text}
                      onClick={() => {
                        updateText(suggestion.text);
                        setSuggestion(null);
                      }}
                    >
                      Apply sample rewrite
                    </button>
                    <button
                      type="button"
                      className={s.quiet}
                      onClick={() => setSuggestion(null)}
                    >
                      Keep my draft
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {format === 'Image' && (
            <div className={s.field}>
              <label htmlFor="post-image">
                Attach an image from your device
              </label>
              <input
                id="post-image"
                type="file"
                accept="image/*"
                onChange={uploadImage}
              />
              <p className={s.help}>
                Images stay in this browser preview. Nothing is uploaded.
              </p>
              {imageUrl && (
                <div className={s.uploadPreview}>
                  <img src={imageUrl} alt={`Local preview: ${imageName}`} />
                  <span>{imageName}</span>
                  <button
                    type="button"
                    onClick={() => {
                      URL.revokeObjectURL(imageUrl);
                      setImageUrl('');
                      setImageName('');
                      setApproved(false);
                      setPublishedPreview(false);
                    }}
                  >
                    Remove image
                  </button>
                </div>
              )}
              <label>
                Caption
                <textarea
                  value={text}
                  maxLength={3000}
                  onChange={(e) => updateText(e.target.value)}
                  rows={5}
                />
              </label>
            </div>
          )}
          {format === 'Carousel' && (
            <div className={s.field}>
              <p className={s.help}>
                Edit each sample slide. This is a text preview; no slides are
                generated.
              </p>
              {slides.map((slide, index) => (
                <label key={index}>
                  Slide {index + 1}
                  <textarea
                    value={slide}
                    maxLength={250}
                    rows={3}
                    onChange={(e) => updateSlide(index, e.target.value)}
                  />
                </label>
              ))}
              <button
                type="button"
                className={s.quiet}
                onClick={() => {
                  setSlides((old) => [...old, 'Add your next point.']);
                  setApproved(false);
                  setPublishedPreview(false);
                }}
              >
                Add slide
              </button>
            </div>
          )}
          {format === 'Video script' && (
            <label className={s.field}>
              Script
              <textarea
                value={script}
                maxLength={3000}
                rows={10}
                onChange={(e) => {
                  setScript(e.target.value);
                  setApproved(false);
                  setPublishedPreview(false);
                }}
              />
              <small>
                Script preview only. It cannot be published from this screen.
              </small>
            </label>
          )}
          <div className={s.actions}>
            <button type="button" className={s.secondary} onClick={copyText}>
              Copy text
            </button>
            <span role="status">{copyMessage}</span>
          </div>
        </section>
        <section className={s.previewPanel} aria-label="Post preview">
          <div className={s.sectionHead}>
            <div>
              <small>Preview</small>
              <h2>
                {format === 'Carousel'
                  ? 'Carousel text'
                  : format === 'Video script'
                    ? 'Video script'
                    : destination}
              </h2>
            </div>
            <span className={s.sampleTag}>Example content</span>
          </div>
          <article className={s.socialCard}>
            <header>
              <span className={s.avatar}>Y</span>
              <span>
                <strong>Your name</strong>
                <small>Sample account · {destination}</small>
              </span>
            </header>
            <p className={s.previewBody}>{previewText}</p>
            {imageUrl && (
              <img
                className={s.postImage}
                src={imageUrl}
                alt="Uploaded post preview"
              />
            )}
          </article>
          <div className={s.approval}>
            <strong>Review before sharing</strong>
            <p>
              Destination and exact text are shown below. Any edit clears
              approval.
            </p>
            <label>
              Destination
              <select
                aria-label="Destination"
                value={destination}
                onChange={(e) => {
                  setDestination(e.target.value);
                  setApproved(false);
                  setPublishedPreview(false);
                }}
              >
                {destinations.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <div className={s.radioRow}>
              <label>
                <input
                  type="radio"
                  checked={timing === 'now'}
                  onChange={() => {
                    setTiming('now');
                    setApproved(false);
                    setPublishedPreview(false);
                  }}
                />{' '}
                Immediately
              </label>
              <label>
                <input
                  type="radio"
                  checked={timing === 'schedule'}
                  onChange={() => {
                    setTiming('schedule');
                    setApproved(false);
                    setPublishedPreview(false);
                  }}
                />{' '}
                Schedule
              </label>
            </div>
            {timing === 'schedule' && (
              <label>
                Post date and time
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(e) => {
                    setScheduleAt(e.target.value);
                    setApproved(false);
                    setPublishedPreview(false);
                  }}
                />
              </label>
            )}
            <details>
              <summary>Review exact text</summary>
              <pre>{formatText}</pre>
            </details>
            {format === 'Video script' ? (
              <p className={s.help}>
                Video scripts are for reference and cannot be published as
                posts.
              </p>
            ) : (
              <>
                <label className={s.check}>
                  <input
                    type="checkbox"
                    checked={approved}
                    onChange={(e) => {
                      setApproved(e.target.checked);
                      setPublishedPreview(false);
                    }}
                  />{' '}
                  I approve this exact text, destination, and timing.
                </label>
                <button
                  type="button"
                  className={s.primary}
                  disabled={
                    !approved ||
                    !formatText.trim() ||
                    (timing === 'schedule' &&
                      (!scheduleAt ||
                        new Date(scheduleAt).getTime() <= Date.now()))
                  }
                  onClick={previewPublication}
                >
                  Preview publication
                </button>
              </>
            )}
            {publishedPreview && (
              <div className={s.published} role="status">
                <strong>Preview publication · {publicationState}</strong>
                <span>
                  Review target: {destination} ·{' '}
                  {timing === 'now'
                    ? 'Immediately'
                    : new Date(scheduleAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                  .
                </span>
                {publicationState === 'Outcome uncertain' && (
                  <span>
                    Check the destination before any retry. No automatic retry
                    is offered.
                  </span>
                )}
                {publicationState === 'Failed · draft kept' && (
                  <span>
                    The draft remains available to copy. No post was sent.
                  </span>
                )}
                <span>No post was sent from this preview.</span>
                <label>
                  Sample outcome
                  <select
                    aria-label="Sample outcome"
                    value={publicationState}
                    onChange={(e) =>
                      setPublicationState(
                        e.target.value as typeof publicationState,
                      )
                    }
                  >
                    <option>Preview only</option>
                    <option>Outcome uncertain</option>
                    <option>Failed · draft kept</option>
                  </select>
                </label>
              </div>
            )}
          </div>
        </section>
      </div>
      <section className={s.reward} aria-labelledby="reward-title">
        <div className={s.sectionHead}>
          <div>
            <small>UGC reward preview</small>
            <h2 id="reward-title">Share a post and submit it for review</h2>
          </div>
          <span className={s.rewardPill}>10 credits per approved post</span>
        </div>
        <p>
          Submitting does not earn credits immediately. An admin reviews each
          post. Up to 3 approved posts can earn credits each month; approval
          does not depend on saying something positive. The monthly cap can mean
          an approved post earns 0 credits.
        </p>
        <div className={s.rewardGrid}>
          <label>
            Post URL
            <input
              type="url"
              aria-label="Post URL"
              placeholder="https://…"
              value={postUrl}
              onChange={(e) => setPostUrl(e.target.value)}
            />
            <small className={s.help}>
              Use an https:// link. Duplicate links are refused in this preview.
            </small>
          </label>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={disclosure}
              onChange={(e) => setDisclosure(e.target.checked)}
            />{' '}
            I confirm the post clearly discloses that it is incentivized.
          </label>
          <button
            type="button"
            className={s.secondary}
            disabled={!postUrl.trim() || !disclosure || !validPostUrl}
            onClick={submitReward}
          >
            Preview reward submission
          </button>
          <label className={s.state}>
            Preview reward state
            <select
              aria-label="Preview reward state"
              value={rewardStatus}
              onChange={(e) =>
                setRewardStatus(e.target.value as typeof rewardStatus)
              }
            >
              <option>Not submitted</option>
              <option>Pending review</option>
              <option>Approved</option>
              <option>Rejected</option>
              <option>Monthly cap reached</option>
            </select>
          </label>
        </div>
        {rewardMessage && <p role="status">{rewardMessage}</p>}
        <div className={s.rewardStatus} role="status">
          Status: <strong>{rewardStatus}</strong>
          {rewardStatus === 'Pending review' && (
            <span>
              {' '}
              · This is a sample status. Credits have not been granted.
            </span>
          )}
          {rewardStatus === 'Approved' && (
            <span>
              {' '}
              · A real approved submission earns 10 credits only if the monthly
              cap has room; otherwise it earns 0.
            </span>
          )}
          {rewardStatus === 'Rejected' && (
            <span>
              {' '}
              · A real reviewer would provide a reason. This sample may also
              show a duplicate link.
            </span>
          )}
          {rewardStatus === 'Monthly cap reached' && (
            <span>
              {' '}
              · Approved · 0 credits. The three rewarded posts for this month
              have already been used.
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

export default PostWorkspace;
