import { ApiError, getOwnedUserFile } from '@career-workspace/core';
import {
  authenticateApi,
  logApiFailure,
  manualRouteAccessError,
  withRequestId,
} from '../../../../../lib/api-route';

export const runtime = 'nodejs';

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

function encodeFilename(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await authenticateApi(request);
  const accessError = manualRouteAccessError(user);
  if (!user) return accessError!;
  if (accessError) return accessError;

  try {
    const { id } = await params;
    const file = await getOwnedUserFile(user.id, id);
    if (!file) return errorResponse(404, 'NOT_FOUND', 'File not found.');

    const body = new ArrayBuffer(file.contents.byteLength);
    new Uint8Array(body).set(file.contents);
    return new Response(body, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeFilename(file.originalName ?? 'download')}`,
        'Content-Length': String(file.contents.byteLength),
        'Content-Type': file.contentType ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof ApiError)
      return errorResponse(error.status, error.code, error.message);
    const requestId = logApiFailure(request, 'INTERNAL_ERROR');
    return withRequestId(
      errorResponse(
        500,
        'INTERNAL_ERROR',
        'The file could not be downloaded. Try again.',
      ),
      requestId,
    );
  }
}
