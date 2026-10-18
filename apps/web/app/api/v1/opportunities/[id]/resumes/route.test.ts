import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  getOpportunity: vi.fn(),
  getCompleted: vi.fn(),
  getCompletedReuse: vi.fn(),
  reuse: vi.fn(),
  create: vi.fn(),
  rateLimit: vi.fn(),
  preparation: vi.fn(),
}));

vi.mock('../../../../../../lib/api-route', async () => {
  const { createApiHandler } = await import('@career-workspace/core');
  return {
    createApiHandler,
    authenticateApi: async () => ({ id: 'resume-route-user', role: 'candidate' }),
  };
});
vi.mock('@career-workspace/core/resume-preparation-service', () => ({ getResumePreparation: state.preparation }));
vi.mock('@career-workspace/core/roles', () => ({
  getOpportunity: state.getOpportunity,
}));
vi.mock('@career-workspace/core/resumes', () => ({
  createTailoredResume: state.create,
  getCompletedTailoredResume: state.getCompleted,
  getCompletedResumeReuse: state.getCompletedReuse,
  listResumeVersions: vi.fn(),
  reuseTailoredResume: state.reuse,
}));
vi.mock('@career-workspace/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkRateLimit: state.rateLimit,
}));

const { POST } = await import('./route');
const context = { params: Promise.resolve({ id: 'role-123' }) };

function request(body: unknown) {
  return new Request('http://localhost:3000/api/v1/opportunities/role-123/resumes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-123' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.getOpportunity.mockResolvedValue({ opportunity: { id: 'role-123' } });
  state.getCompleted.mockResolvedValue(null);
  state.getCompletedReuse.mockResolvedValue(null);
  state.preparation.mockResolvedValue({ token: 'token' });
  state.reuse.mockResolvedValue({ id: 'reused-version' });
  state.create.mockResolvedValue({ id: 'paid-version' });
  state.rateLimit.mockResolvedValue({ allowed: true });
});
afterEach(() => vi.restoreAllMocks());

describe('tailored resume request replay', () => {
  it('returns a completed paid result before applying the minute limit', async () => {
    state.getCompleted.mockResolvedValue({ id: 'paid-replay' });
    const response = await POST(request({ confirmedSkills: true, preparationToken: 'token' }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: 'paid-replay' } });
    expect(state.rateLimit).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('checks the minute limit and creates a new paid result when no replay exists', async () => {
    const response = await POST(request({ confirmedSkills: true, preparationToken: 'token' }), context);
    expect(response.status).toBe(200);
    expect(state.getCompleted).toHaveBeenCalledWith('resume-route-user', 'role-123', 'key-123');
    expect(state.rateLimit).toHaveBeenCalledTimes(2);
    expect(state.create).toHaveBeenCalledWith('resume-route-user', 'role-123', 'key-123', {
      confirmedSkills: true,
      preparationToken: 'token',
      preparation: { token: 'token' },
    });
    expect(state.preparation).toHaveBeenCalledOnce();
  });

  it('routes reuse requests by their key before checking paid replay', async () => {
    const response = await POST(request({ action: 'reuse', resumeId: 'source-id' }), context);
    expect(response.status).toBe(200);
    expect(state.reuse).toHaveBeenCalledWith('resume-route-user', 'role-123', 'source-id', {
      requestKey: 'key-123',
    });
    expect(state.getCompleted).not.toHaveBeenCalled();
    expect(state.rateLimit).toHaveBeenCalledWith('resume-route-user', 'resume_reuse', { limit: 5, windowMs: 60_000 });
  });

  it('blocks repeated free copies before saving another version', async () => {
    state.rateLimit.mockResolvedValue({ allowed: false });
    const response = await POST(request({ action: 'reuse', resumeId: 'source-id' }), context);
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe('RATE_LIMITED');
    expect(state.reuse).not.toHaveBeenCalled();
  });

  it('rejects a stale preparation before consuming a minute slot', async () => {
    const response = await POST(request({ confirmedSkills: true, preparationToken: 'stale' }), context);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('RESUME_PREPARATION_REQUIRED');
    expect(state.rateLimit).toHaveBeenCalledExactlyOnceWith('resume-route-user', 'resume_confirmation', { limit: 30, windowMs: 60_000 });
    expect(state.create).not.toHaveBeenCalled();
  });

  it('returns a completed copy even after all five reuse slots are used', async () => {
    state.getCompletedReuse.mockResolvedValue({ id: 'copy-replay' });
    state.rateLimit.mockResolvedValue({ allowed: false });
    const response = await POST(request({ action: 'reuse', resumeId: 'source-id' }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: 'copy-replay' } });
    expect(state.rateLimit).not.toHaveBeenCalled();
    expect(state.reuse).not.toHaveBeenCalled();
  });

  it('limits confirmation attempts before reading preparation', async () => {
    state.rateLimit.mockResolvedValue({ allowed: false });
    const response = await POST(request({ confirmedSkills: true, preparationToken: 'stale' }), context);
    expect(response.status).toBe(429);
    expect(state.preparation).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });
});
