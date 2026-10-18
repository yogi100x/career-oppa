import { getResumePreparation } from '@career-workspace/core/resume-preparation-service';
import { authenticateApi, createApiHandler } from '../../../../../../../lib/api-route';

export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createApiHandler({ authenticate: authenticateApi, handler: ({ user }) => getResumePreparation(user.id, id) })(request);
}
