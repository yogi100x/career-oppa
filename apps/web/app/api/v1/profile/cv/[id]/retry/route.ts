import {
  createCvReadTask,
  getCvUploadState,
} from '@career-workspace/core/cv-upload-state';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../../lib/api-route';
import { dispatchCvRead } from '../../../../../../../lib/cv-read-workflow';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: async ({ user }) => {
      const result = await createCvReadTask(user.id, id, { retry: true });
      await dispatchCvRead(user.id, result.task, result.shouldStart);
      const state = await getCvUploadState(user.id, id);
      return { file: state.file, ...result };
    },
  })(request);
}
