import { getOwnedUserFile } from '@career-workspace/core';
import { getResume, getResumeGrounding } from '@career-workspace/core/resumes';
import { ApiError } from '@career-workspace/core';
import { renderResumePdf, type ResumePageSize } from '@career-workspace/pdf';
import { resumeFileName } from '@career-workspace/contracts';
import {
  authenticateApi,
  logApiFailure,
  manualRouteAccessError,
  withRequestId,
} from '../../../../../../lib/api-route';

export const runtime = 'nodejs';

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

function pdfResponse(bytes: Uint8Array, filename: string): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': String(bytes.byteLength),
      'Content-Type': 'application/pdf',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await authenticateApi(request);
  const accessError = manualRouteAccessError(user);
  if (!user) return accessError!;
  if (accessError) return accessError;

  try {
    const { id } = await context.params;
    const resume = await getResume(user.id, id);
    const approvedDownload =
      new URL(request.url).searchParams.get('approved') === '1';
    if (approvedDownload && (!resume.approvedAt || !resume.pdfFileId))
      return errorResponse(
        409,
        'APPROVED_PDF_REQUIRED',
        'Approve this CV again before downloading or applying.',
      );
    const grounding = await getResumeGrounding(user.id, id);
    if (!grounding.canApprove)
      return errorResponse(
        409,
        'RESUME_NOT_GROUNDED',
        'Review the flagged bullets before previewing or downloading this CV.',
      );
    const requestedSize = new URL(request.url).searchParams.get('size');
    if (requestedSize && requestedSize !== 'A4' && requestedSize !== 'LETTER')
      return errorResponse(400, 'INVALID_INPUT', 'Choose A4 or US Letter.');

    if (resume.approvedAt && resume.pdfFileId) {
      try {
        const saved = await getOwnedUserFile(user.id, resume.pdfFileId);
        if (saved?.kind === 'resume_pdf')
          return pdfResponse(
            saved.contents,
            resumeFileName(resume.content.name),
          );
        if (approvedDownload)
          return errorResponse(
            503,
            'STORAGE_READ_FAILED',
            'Your approved PDF could not be read. Please try again.',
          );
        logApiFailure(request, 'STORAGE_READ_FAILED');
      } catch (error) {
        if (error instanceof ApiError)
          return errorResponse(error.status, error.code, error.message);
        // Keep the preview available from the immutable version content,
        // but record that the stored approved PDF could not be read.
        if (approvedDownload)
          return errorResponse(
            503,
            'STORAGE_READ_FAILED',
            'Your approved PDF could not be read. Please try again.',
          );
        logApiFailure(request, 'STORAGE_READ_FAILED');
      }
    }

    const pageSize: ResumePageSize = resume.approvedAt
      ? resume.pageSize === 'LETTER'
        ? 'LETTER'
        : 'A4'
      : ((requestedSize as ResumePageSize | null) ?? 'A4');
    const bytes = await renderResumePdf(resume.content, pageSize);
    return pdfResponse(bytes, resumeFileName(resume.content.name));
  } catch (error) {
    if (error instanceof ApiError)
      return errorResponse(error.status, error.code, error.message);
    const requestId = logApiFailure(request, 'INTERNAL_ERROR');
    return withRequestId(
      errorResponse(
        500,
        'INTERNAL_ERROR',
        'The CV preview could not be created. Try again.',
      ),
      requestId,
    );
  }
}
