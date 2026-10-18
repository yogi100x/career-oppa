import { approveResume } from '@career-workspace/core/resume-approval';
import { approveResumeSchema } from '@career-workspace/contracts';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: approveResumeSchema,
    handler: ({ user, input }) => approveResume(user.id, id, input),
  })(request);
}
