'use client';

type ApiErrorBody = {
  error?: { code?: string; message?: string };
};
type HandoffBody = {
  data?:
    | { outcome: 'created' | 'existing'; handoff: { id: string } }
    | { outcome: 'skipped'; reason: 'role_already_advanced' };
};

export type ApprovedPdfHandoffOutcome = 'created' | 'existing' | 'skipped';
export type ApprovedPdfFlowStage = 'download' | 'handoff';

export class ApprovedPdfFlowError extends Error {
  constructor(
    message: string,
    readonly options: {
      code: string;
      stage: ApprovedPdfFlowStage;
      retryable: boolean;
      downloaded: boolean;
    },
  ) {
    super(message);
    this.name = 'ApprovedPdfFlowError';
  }

  get code() {
    return this.options.code;
  }

  get stage() {
    return this.options.stage;
  }

  get retryable() {
    return this.options.retryable;
  }

  get downloaded() {
    return this.options.downloaded;
  }
}

function transientStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function responseError(response: Response) {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return {
      code: body.error?.code ?? 'REQUEST_FAILED',
      message: body.error?.message ?? 'The request could not be completed.',
    };
  } catch {
    return {
      code: 'REQUEST_FAILED',
      message: 'The request could not be completed.',
    };
  }
}

function networkError(stage: ApprovedPdfFlowStage, downloaded: boolean) {
  const message =
    stage === 'handoff'
      ? 'The PDF downloaded, but its application check-in could not be reached. Check your connection and try again.'
      : 'The approved PDF could not be downloaded. Check your connection and try again.';
  return new ApprovedPdfFlowError(message, {
    code: 'NETWORK_ERROR',
    stage,
    retryable: true,
    downloaded,
  });
}

export async function createApprovedPdfHandoff(
  opportunityId: string,
  resumeId: string,
): Promise<ApprovedPdfHandoffOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/v1/application-handoffs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        opportunityId,
        source: 'approved_pdf',
        resumeId,
      }),
    });
  } catch {
    throw networkError('handoff', true);
  }

  if (!response.ok) {
    const error = await responseError(response);
    throw new ApprovedPdfFlowError(error.message, {
      code: error.code,
      stage: 'handoff',
      retryable: transientStatus(response.status),
      downloaded: true,
    });
  }

  let body: HandoffBody;
  try {
    body = (await response.json()) as HandoffBody;
  } catch {
    throw new ApprovedPdfFlowError(
      'The PDF downloaded, but the application check-in response was incomplete.',
      {
        code: 'INVALID_HANDOFF_RESPONSE',
        stage: 'handoff',
        retryable: false,
        downloaded: true,
      },
    );
  }
  const outcome = body.data?.outcome;
  if (outcome === 'created' || outcome === 'existing' || outcome === 'skipped')
    return outcome;
  throw new ApprovedPdfFlowError(
    'The PDF downloaded, but the application check-in response was incomplete.',
    {
      code: 'INVALID_HANDOFF_RESPONSE',
      stage: 'handoff',
      retryable: false,
      downloaded: true,
    },
  );
}

export async function downloadApprovedResumePdf(input: {
  opportunityId: string;
  resumeId: string;
}): Promise<{ downloaded: true; handoff: ApprovedPdfHandoffOutcome }> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/resumes/${encodeURIComponent(input.resumeId)}/pdf?approved=1`,
      {
        cache: 'no-store',
      },
    );
  } catch {
    throw networkError('download', false);
  }

  if (!response.ok) {
    const error = await responseError(response);
    throw new ApprovedPdfFlowError(error.message, {
      code: error.code,
      stage: 'download',
      retryable: transientStatus(response.status),
      downloaded: false,
    });
  }
  if (!response.headers.get('content-type')?.includes('application/pdf'))
    throw new ApprovedPdfFlowError(
      'The server did not return an approved PDF.',
      {
        code: 'INVALID_PDF_RESPONSE',
        stage: 'download',
        retryable: false,
        downloaded: false,
      },
    );

  try {
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download =
      response.headers
        .get('content-disposition')
        ?.match(/filename="([^"]+)"/)?.[1] ?? 'CV.pdf';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    throw networkError('download', false);
  }

  const handoff = await createApprovedPdfHandoff(
    input.opportunityId,
    input.resumeId,
  );
  return { downloaded: true, handoff };
}
