import { adjustUserLedger } from '@career-workspace/core/rewards';
import { ledgerAdjustmentSchema } from '@career-workspace/contracts';
import { authenticateApi, createApiHandler, withApiCors } from '../../../../../lib/api-route';

export const runtime = 'nodejs';
export const POST = async (request: Request) => withApiCors(await createApiHandler({
  authenticate: authenticateApi,
  admin: true,
  schema: ledgerAdjustmentSchema,
  handler: ({ user, input, request: incoming }) => adjustUserLedger(
    user.id,
    input,
    incoming.headers.get('Idempotency-Key') ?? '',
  ),
})(request), request);
