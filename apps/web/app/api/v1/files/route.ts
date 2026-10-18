import {
  ApiError,
  createUserFile,
  FileValidationError,
  MAX_UPLOAD_BYTES,
} from '@career-workspace/core';
import {
  authenticateApi,
  logApiFailure,
  manualRouteAccessError,
  withRequestId,
} from '../../../../lib/api-route';

export const runtime = 'nodejs';

const MAX_REQUEST_BYTES = 4_500_000;

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const user = await authenticateApi(request);
  const accessError = manualRouteAccessError(user);
  if (!user) return accessError!;
  if (accessError) return accessError;

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return errorResponse(
      413,
      'FILE_TOO_LARGE',
      'Files must be 4 MB or smaller.',
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(
      400,
      'INVALID_INPUT',
      'Send one file using the file field.',
    );
  }

  const uploads = form.getAll('file');
  if (uploads.length !== 1 || !(uploads[0] instanceof File)) {
    return errorResponse(
      400,
      'INVALID_INPUT',
      'Send one file using the file field.',
    );
  }

  const upload = uploads[0];
  if (upload.size > MAX_UPLOAD_BYTES) {
    return errorResponse(
      413,
      'FILE_TOO_LARGE',
      'Files must be 4 MB or smaller.',
    );
  }

  try {
    const file = await createUserFile(user.id, {
      kind: 'cv_upload',
      originalName: upload.name,
      contents: new Uint8Array(await upload.arrayBuffer()),
    });
    return Response.json(
      { data: file },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof ApiError)
      return errorResponse(error.status, error.code, error.message);
    if (error instanceof FileValidationError) {
      const status = error.code === 'FILE_TOO_LARGE' ? 413 : 400;
      return errorResponse(status, error.code, error.message);
    }
    const requestId = logApiFailure(request, 'INTERNAL_ERROR');
    return withRequestId(
      errorResponse(
        500,
        'INTERNAL_ERROR',
        'The file could not be saved. Try again.',
      ),
      requestId,
    );
  }
}
