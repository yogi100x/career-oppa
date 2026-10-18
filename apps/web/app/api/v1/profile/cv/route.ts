import {
  getCvUploadState,
  createCvReadTask,
} from '@career-workspace/core/cv-upload-state';
import { ApiError } from '@career-workspace/core';
import {
  createApiHandler,
  authenticateApi,
} from '../../../../../lib/api-route';
import { dispatchCvRead } from '../../../../../lib/cv-read-workflow';
import { POST as uploadFile } from '../../files/route';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => {
      const fileId =
        new URL(request.url).searchParams.get('fileId') ?? undefined;
      if (
        fileId !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          fileId,
        )
      )
        throw new ApiError(400, 'INVALID_INPUT', 'The CV file ID is invalid.');
      return getCvUploadState(user.id, fileId);
    },
  })(request);
}

export async function POST(request: Request): Promise<Response> {
  // The common file handler validates and hashes bytes under the owner lock.
  // Only a genuinely new upload consumes the upload allowance.
  const uploaded = await uploadFile(request);
  if (!uploaded.ok) return uploaded;
  const { data: file } = (await uploaded.json()) as {
    data: { id: string; originalName: string; duplicate?: boolean };
  };
  const response = await createApiHandler({
    authenticate: authenticateApi,
    handler: async ({ user }) => {
      const result = await createCvReadTask(user.id, file.id);
      const workflowRunId = await dispatchCvRead(
        user.id,
        result.task,
        result.shouldStart,
      );
      return {
        file,
        ...result,
        duplicate: Boolean(file.duplicate),
        workflowRunId,
      };
    },
  })(request);
  return response.ok
    ? new Response(response.body, { status: 201, headers: response.headers })
    : response;
}
