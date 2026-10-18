import {
  getResumeGrounding,
  getResumeAtsReport,
  getResumeKeywordCoverage,
  getResumePageCount,
} from '@career-workspace/core/resumes';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: async ({ user }) => ({
      ...(await getResumeGrounding(user.id, id)),
      ats: await getResumeAtsReport(user.id, id).catch(() => ({ score: null, grade: null, checks: [], issues: ['The document check could not finish. Try again.'], caveat: 'This checks readable text in your CV. It cannot predict whether an employer’s recruitment software will accept or rank it.' })),
      // Extras must never break the CV screen: on failure they are left out.
      pageCount: await getResumePageCount(user.id, id).catch(() => undefined),
      keywords: await getResumeKeywordCoverage(user.id, id).catch(
        () => undefined,
      ),
    }),
  })(request);
}
