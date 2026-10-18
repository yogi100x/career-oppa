import { desc, eq } from 'drizzle-orm';
import { ACTIONS, balance, MONTHLY_ALLOWANCE } from '@career-workspace/core';
import { getFitReviewEligibility } from '@career-workspace/core/fit-review';
import { listCreditPacks } from '@career-workspace/core/payments';
import { getDatabase, ledgerEntries } from '@career-workspace/db';
import { authenticateApi, createApiHandler } from '../../../../lib/api-route';

export const runtime = 'nodejs';
export const GET = createApiHandler({
  authenticate: authenticateApi,
  handler: async ({ user }) => {
    const database = getDatabase();
    // Balance initializes this month's grant; read history after it so a new
    // user sees that grant in the same response.
    const credits = await balance(user.id, { database });
    const history = await database
      .select({
        id: ledgerEntries.id,
        amount: ledgerEntries.amount,
        bucket: ledgerEntries.bucket,
        kind: ledgerEntries.kind,
        createdAt: ledgerEntries.createdAt,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, user.id))
      .orderBy(desc(ledgerEntries.createdAt))
      .limit(40);

    return {
      ...credits,
      ...(await getFitReviewEligibility(user.id, database)),
      allowance: MONTHLY_ALLOWANCE,
      actions: ACTIONS,
      history,
      packs: listCreditPacks(),
    };
  },
});
