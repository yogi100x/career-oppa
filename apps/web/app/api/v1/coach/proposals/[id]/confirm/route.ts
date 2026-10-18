import { confirmCoachToolProposal } from '@career-workspace/core/coach-toolset';
import { confirmCoachProposalSchema } from '@career-workspace/contracts';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../../lib/api-route';

export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    schema: confirmCoachProposalSchema,
    handler: ({ user }) => confirmCoachToolProposal(user.id, id),
  })(request);
}
