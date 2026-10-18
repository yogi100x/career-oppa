import { getResumePreparation } from '@career-workspace/core/resume-preparation-service';
import { getOpportunity } from '@career-workspace/core/roles';
import {
  createTailoredResume,
  getCompletedTailoredResume,
  getCompletedResumeReuse,
  reuseTailoredResume,
  listResumeVersions,
} from '@career-workspace/core/resumes';
import { ApiError, checkRateLimit } from '@career-workspace/core';
import {
  authenticateApi,
  createApiHandler,
} from '../../../../../../lib/api-route';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: ({ user }) => listResumeVersions(user.id, id),
  })(request);
}
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return createApiHandler({
    authenticate: authenticateApi,
    handler: async ({ user }) => {
      await getOpportunity(user.id, id);
      const key = request.headers.get('idempotency-key') ?? '';
      if (!key)
        throw new ApiError(400, 'INVALID_INPUT', 'Provide a request key.');
      let input: unknown;
      try { input = await request.json(); } catch { throw new ApiError(400, 'INVALID_INPUT', 'Confirm the skill check before creating a draft.'); }
      if (!input || typeof input !== 'object') throw new ApiError(400, 'INVALID_INPUT', 'Confirm the skill check before creating a draft.');
      const body = input as Record<string, unknown>;
      if (body.action === 'reuse') {
        if (typeof body.resumeId !== 'string') throw new ApiError(400, 'INVALID_INPUT', 'Choose a saved CV to reuse.');
        const completed = await getCompletedResumeReuse(user.id, id, body.resumeId, key);
        if (completed) return completed;
        const limit = await checkRateLimit(user.id, 'resume_reuse', { limit: 5, windowMs: 60_000 });
        if (!limit.allowed)
          throw new ApiError(429, 'RATE_LIMITED', 'Wait a minute before copying another CV.');
        return reuseTailoredResume(user.id, id, body.resumeId, { requestKey: key });
      }
      if (body.confirmedSkills !== true || typeof body.preparationToken !== 'string')
        throw new ApiError(409, 'RESUME_PREPARATION_REQUIRED', 'Review the skill check and confirm before spending 3 credits.');
      const completed = await getCompletedTailoredResume(user.id, id, key);
      if (completed) return completed;
      const confirmationLimit = await checkRateLimit(user.id, 'resume_confirmation', { limit: 30, windowMs: 60_000 });
      if (!confirmationLimit.allowed)
        throw new ApiError(429, 'RATE_LIMITED', 'Wait a minute before checking CV preparation again.');
      const preparation = await getResumePreparation(user.id, id);
      if (body.preparationToken !== preparation.token)
        throw new ApiError(409, 'RESUME_PREPARATION_REQUIRED', 'Review the current skill gaps and confirm before spending 3 credits. No credits were charged.');
      const limit = await checkRateLimit(user.id, 'tailor_cv', {
        limit: 5,
        windowMs: 60_000,
      });
      if (!limit.allowed)
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Wait a minute before drafting another CV.',
        );
      return createTailoredResume(user.id, id, key, { confirmedSkills: true, preparationToken: body.preparationToken, preparation });
    },
  })(request);
}
