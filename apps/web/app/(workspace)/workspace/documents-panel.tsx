'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Screen } from '../../../components/workspace';
import {
  ApprovedPdfFlowError,
  createApprovedPdfHandoff,
  downloadApprovedResumePdf,
  type ApprovedPdfFlowStage,
  type ApprovedPdfHandoffOutcome,
} from '../../../lib/approved-pdf-download';
import { latestCvPerRole } from '../../../lib/role-choices';
import styles from './workspace-content.module.css';

type DocumentRow = {
  id: string;
  opportunityId: string;
  version: number;
  approvedAt: string | null;
  pdfFileId: string | null;
  jobTitle: string;
  company: string;
  createdAt: string;
};
type Upload = {
  id: string;
  kind: string;
  originalName: string | null;
  createdAt: string;
  cvUploadState?: {
    state: 'reading' | 'ready' | 'confirmed' | 'failed' | 'empty';
    factCount: number;
    approvedCount: number;
    task: { id: string; status: string } | null;
  };
};
type Portfolio = { id: string; title: string; links: string[] };
type ApiBody<T> = { data?: T; error?: { message?: string } };
type ApprovedPdf = {
  id: string;
  opportunityId: string;
  version: number;
};
type PdfAction = {
  message: string;
  error: boolean;
  retryStage?: ApprovedPdfFlowStage;
};

export default function DocumentsPanel() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [uploadKind, setUploadKind] = useState('supporting_document');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null);
  const [pdfActions, setPdfActions] = useState<Record<string, PdfAction>>({});
  const [retryBusyId, setRetryBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const response = await fetch('/api/v1/documents', { cache: 'no-store' });
      const body = (await response.json()) as ApiBody<{
        documents: DocumentRow[];
        uploads?: Upload[];
        portfolios?: Portfolio[];
      }>;
      if (!response.ok)
        throw new Error(body.error?.message ?? 'Your CVs could not be loaded.');
      setRows(body.data?.documents ?? []);
      setUploads(body.data?.uploads ?? []);
      setPortfolios(body.data?.portfolios ?? []);
      setLoaded(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Your CVs could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const retryLoad = () => {
    if (!loaded) setLoading(true);
    void load();
  };

  const latest = useMemo(() => latestCvPerRole(rows), [rows]);
  const approvedPdfs = useMemo(() => {
    const byRole = new Map<string, ApprovedPdf>();
    for (const row of rows) {
      if (!row.approvedAt || !row.pdfFileId) continue;
      const current = byRole.get(row.opportunityId);
      if (!current || row.version > current.version)
        byRole.set(row.opportunityId, {
          id: row.id,
          opportunityId: row.opportunityId,
          version: row.version,
        });
    }
    return byRole;
  }, [rows]);

  function finishPdfAction(
    resumeId: string,
    outcome: ApprovedPdfHandoffOutcome,
  ) {
    const message =
      outcome === 'skipped'
        ? 'PDF downloaded. This role has moved beyond preparation, so no new check-in was created.'
        : 'PDF downloaded. Your application check-in is ready.';
    setPdfActions((current) => ({
      ...current,
      [resumeId]: { message, error: false },
    }));
  }

  async function runPdfAction(
    pdf: ApprovedPdf,
    mode: 'download' | 'handoff' = 'download',
  ) {
    if (pdfBusyId) return;
    setPdfBusyId(pdf.id);
    setPdfActions((current) => ({
      ...current,
      [pdf.id]: {
        message: mode === 'handoff' ? 'Saving check-in…' : 'Downloading PDF…',
        error: false,
      },
    }));
    try {
      if (mode === 'handoff') {
        finishPdfAction(
          pdf.id,
          await createApprovedPdfHandoff(pdf.opportunityId, pdf.id),
        );
      } else {
        const result = await downloadApprovedResumePdf({
          opportunityId: pdf.opportunityId,
          resumeId: pdf.id,
        });
        finishPdfAction(pdf.id, result.handoff);
      }
    } catch (cause) {
      if (cause instanceof ApprovedPdfFlowError) {
        const message = cause.downloaded
          ? `PDF downloaded. ${cause.message}`
          : cause.message;
        if (
          [
            'APPROVED_PDF_REQUIRED',
            'RESUME_NOT_GROUNDED',
            'RESUME_HEADER_REQUIRED',
          ].includes(cause.code)
        ) {
          setNotice(message);
          setRows((current) =>
            current.map((row) =>
              row.id === pdf.id
                ? { ...row, approvedAt: null, pdfFileId: null }
                : row,
            ),
          );
          await load();
        }
        setPdfActions((current) => ({
          ...current,
          [pdf.id]: {
            message,
            error: true,
            ...(cause.retryable ? { retryStage: cause.stage } : {}),
          },
        }));
      } else {
        setPdfActions((current) => ({
          ...current,
          [pdf.id]: {
            message: 'The PDF action could not be completed. Try again later.',
            error: true,
          },
        }));
      }
    } finally {
      setPdfBusyId(null);
    }
  }

  async function uploadDocument() {
    if (!uploadFile || uploadBusy) return;
    setUploadBusy(true);
    setError('');
    setNotice('');
    try {
      const data = new FormData();
      data.set('file', uploadFile);
      data.set('kind', uploadKind);
      const response = await fetch('/api/v1/documents', {
        method: 'POST',
        body: data,
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error?.message ?? 'The document could not be saved.',
        );
      setNotice('Document saved.');
      setUploadFile(null);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The document could not be saved.',
      );
    } finally {
      setUploadBusy(false);
    }
  }

  async function readCvAgain(file: Upload) {
    if (retryBusyId) return;
    setRetryBusyId(file.id);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/v1/profile/cv/${file.id}/retry`, {
        method: 'POST',
      });
      const body = (await response.json()) as ApiBody<{
        task: { status: string };
        shouldStart: boolean;
      }>;
      if (!response.ok)
        throw new Error(body.error?.message ?? 'Your CV could not be read.');
      setNotice(
        body.data?.task.status === 'running'
          ? 'Your CV is being read.'
          : 'Your CV is queued to be read.',
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Your CV could not be read.',
      );
    } finally {
      setRetryBusyId(null);
    }
  }
  return (
    <Screen
      title="My documents"
      description="Your uploaded CVs, tailored versions, portfolios and supporting documents."
    >
      <div className={styles.feed}>
        <section className={styles.documents} aria-labelledby="uploads-title">
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="uploads-title">Uploaded CVs and supporting documents</h2>
              <p>
                Open your original files without using credits. PDF and DOCX, up
                to 4 MB.
              </p>
            </div>
          </div>
          {loading && !loaded ? (
            <p role="status">Loading your documents…</p>
          ) : (
            loaded && (
              <>
                {uploads.length ? (
                  <div className={styles.tableScroll}>
                    <table className={styles.documentTable}>
                      <thead>
                        <tr>
                          <th scope="col">Document</th>
                          <th scope="col">Type</th>
                          <th scope="col">CV reading</th>
                          <th scope="col">Open</th>
                        </tr>
                      </thead>
                      <tbody>
                        {uploads.map((file) => (
                          <tr key={file.id}>
                            <td>{file.originalName || 'Untitled document'}</td>
                            <td>
                              {file.kind === 'cv_upload'
                                ? 'Master CV'
                                : file.kind === 'portfolio'
                                  ? 'Portfolio'
                                  : 'Supporting document'}
                            </td>
                            <td>
                              {file.kind === 'cv_upload' && (
                                <div>
                                  <span>
                                    {file.cvUploadState?.state === 'reading'
                                      ? 'Reading your CV…'
                                      : file.cvUploadState?.state === 'ready'
                                        ? `Ready to review (${file.cvUploadState.factCount - file.cvUploadState.approvedCount} ${file.cvUploadState.factCount - file.cvUploadState.approvedCount === 1 ? 'fact' : 'facts'})`
                                        : file.cvUploadState?.state ===
                                            'confirmed'
                                          ? `Facts confirmed (${file.cvUploadState.approvedCount})`
                                          : file.cvUploadState?.state ===
                                              'failed'
                                            ? 'Could not read'
                                            : file.cvUploadState?.task
                                                  ?.status === 'succeeded'
                                              ? 'No facts found'
                                              : 'Not read yet'}
                                  </span>
                                  {file.cvUploadState?.state !== 'reading' && (
                                    <div>
                                      <Button
                                        variant="text"
                                        disabled={retryBusyId !== null}
                                        onClick={() => void readCvAgain(file)}
                                      >
                                        {retryBusyId === file.id
                                          ? 'Queueing…'
                                          : 'Read again'}
                                      </Button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </td>
                            <td>
                              <a href={`/api/v1/files/${file.id}`}>
                                Download {file.originalName || 'document'}
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className={styles.empty}>
                    No uploaded documents yet. Upload your master CV from Your
                    profile, or add a portfolio or supporting document here.
                  </p>
                )}
                <div className={styles.documentUpload}>
                  <label>
                    Document type
                    <select
                      value={uploadKind}
                      onChange={(e) => setUploadKind(e.target.value)}
                    >
                      <option value="supporting_document">
                        Supporting document
                      </option>
                      <option value="portfolio">Portfolio</option>
                    </select>
                  </label>
                  <label>
                    Document file
                    <input
                      type="file"
                      accept=".pdf,.docx"
                      onChange={(e) =>
                        setUploadFile(e.target.files?.[0] ?? null)
                      }
                    />
                  </label>
                  <Button
                    onClick={() => void uploadDocument()}
                    disabled={!uploadFile || uploadBusy}
                  >
                    {uploadBusy ? 'Saving document…' : 'Save document'}
                  </Button>
                </div>
                {notice && <p role="status">{notice}</p>}
                {portfolios.length > 0 && (
                  <>
                    <h3>Project portfolio links</h3>
                    {portfolios.map((project) => (
                      <div key={project.id}>
                        <strong>{project.title}</strong>
                        <ul>
                          {project.links
                            .filter((link) => /^https?:\/\//.test(link))
                            .map((link) => (
                              <li key={link}>
                                <a
                                  href={link}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {link}
                                </a>
                              </li>
                            ))}
                        </ul>
                      </div>
                    ))}
                  </>
                )}
              </>
            )
          )}
        </section>
        <section className={styles.documents} aria-labelledby="cv-list-title">
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="cv-list-title">Tailored CVs</h2>
              <p>Open a draft to keep editing, or download its approved PDF.</p>
            </div>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}{' '}
              <button type="button" onClick={retryLoad}>
                Try again
              </button>
            </p>
          )}
          {loading && !loaded ? (
            <p className={styles.empty} role="status">
              Loading your CVs…
            </p>
          ) : !loaded ? null : latest.length ? (
            <div className={styles.tableScroll}>
              <table className={styles.documentTable}>
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Latest version</th>
                    <th scope="col">Saved</th>
                    <th scope="col">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.map((document) => {
                    const approvedPdf = approvedPdfs.get(
                      document.opportunityId,
                    );
                    const pdfAction = approvedPdf
                      ? pdfActions[approvedPdf.id]
                      : undefined;
                    return (
                      <tr key={document.id}>
                        <td>
                          <strong>{document.jobTitle}</strong>
                          <small>{document.company}</small>
                        </td>
                        <td>
                          <span>
                            {document.approvedAt
                              ? `Approved · v${document.version}`
                              : `Draft · v${document.version}`}
                          </span>
                        </td>
                        <td>
                          {new Date(document.createdAt).toLocaleDateString(
                            'en-GB',
                            { day: 'numeric', month: 'short', year: 'numeric' },
                          )}
                        </td>
                        <td>
                          <div className={styles.documentActions}>
                            <Link
                              href={`/workspace/roles/${document.opportunityId}/resume`}
                            >
                              Edit CV
                            </Link>
                            {approvedPdf && (
                              <div>
                                <Button
                                  variant="text"
                                  disabled={pdfBusyId !== null}
                                  onClick={() => void runPdfAction(approvedPdf)}
                                >
                                  {approvedPdf.version === document.version
                                    ? 'Download PDF'
                                    : `Download approved v${approvedPdf.version} PDF`}
                                </Button>
                                {pdfAction?.message && (
                                  <p
                                    role={pdfAction.error ? 'alert' : 'status'}
                                  >
                                    {pdfAction.message}
                                    {pdfAction.retryStage && (
                                      <Button
                                        variant="text"
                                        disabled={pdfBusyId !== null}
                                        onClick={() =>
                                          void runPdfAction(
                                            approvedPdf,
                                            pdfAction.retryStage === 'handoff'
                                              ? 'handoff'
                                              : 'download',
                                          )
                                        }
                                      >
                                        {pdfAction.retryStage === 'handoff'
                                          ? 'Retry check-in'
                                          : 'Retry PDF download'}
                                      </Button>
                                    )}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={styles.empty}>
              No tailored CVs yet. Open a role and prepare an application to
              create one.
            </p>
          )}
        </section>
      </div>
    </Screen>
  );
}
