import {
  ApiError,
  createUserFile,
  FileValidationError,
  listDocuments,
  MAX_UPLOAD_BYTES,
} from '@career-workspace/core';
import { authenticateApi, createApiHandler } from '../../../../lib/api-route';
export const runtime = 'nodejs';
export const GET = createApiHandler({
  authenticate: authenticateApi,
  handler: async ({ user }) => listDocuments(user.id),
});
export const POST = createApiHandler({
  authenticate: authenticateApi,
  handler: async ({ user, request }) => {
    if (
      Number(request.headers.get('content-length') ?? 0) >
      MAX_UPLOAD_BYTES + 64 * 1024
    )
      throw new ApiError(
        413,
        'FILE_TOO_LARGE',
        'Upload a PDF or DOCX no larger than 4 MB.',
      );
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(400, 'INVALID_INPUT', 'Choose a document to upload.');
    }
    const file = form.get('file'),
      kind = form.get('kind');
    if (
      !(file instanceof File) ||
      !['portfolio', 'supporting_document'].includes(String(kind))
    )
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Choose a portfolio or supporting document.',
      );
    if (file.size > MAX_UPLOAD_BYTES)
      throw new ApiError(
        413,
        'FILE_TOO_LARGE',
        'Use a document no larger than 4 MB.',
      );
    try {
      return {
        file: await createUserFile(user.id, {
          kind: kind as 'portfolio' | 'supporting_document',
          originalName: file.name,
          contents: new Uint8Array(await file.arrayBuffer()),
        }),
      };
    } catch (error) {
      if (error instanceof FileValidationError)
        throw new ApiError(
          error.code === 'FILE_TOO_LARGE' ? 413 : 400,
          error.code,
          error.message,
        );
      throw error;
    }
  },
});
