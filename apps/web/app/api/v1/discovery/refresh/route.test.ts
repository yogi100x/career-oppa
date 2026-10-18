import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
vi.mock('server-only', () => ({}));

const state = vi.hoisted(() => ({
  allowed: true,
  taskStatus: 'queued' as 'queued' | 'running' | 'succeeded' | 'failed',
  existingTask: null as null | Record<string, unknown>,
  checkRateLimit: vi.fn(),
  createTask: vi.fn(),
  start: vi.fn(),
}));
vi.mock('../../../../../lib/api-route', async () => {
  const { createApiHandler } = await import('@career-workspace/core');
  return {
    createApiHandler,
    authenticateApi: async () => ({ id: 'discovery-test-user', role: 'candidate', deletionRequestedAt: null }),
  };
});
vi.mock('@career-workspace/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkRateLimit: state.checkRateLimit,
}));
vi.mock('@career-workspace/db', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDatabase: () => ({
    select: () => ({
      from: () => ({ where: async () => state.existingTask ? [state.existingTask] : [] }),
    }),
  }),
}));
vi.mock('drizzle-orm', () => ({ and: (...values: unknown[]) => values, eq: (...values: unknown[]) => values }));
vi.mock('@career-workspace/core/tasks', () => ({
  createTask: state.createTask,
}));
vi.mock('workflow/api', () => ({ start: state.start }));

function request(key = 'discovery-refresh-key') {
  return new Request('http://localhost:3000/api/v1/discovery', {
    method: 'POST',
    headers: { 'idempotency-key': key },
  });
}

beforeEach(() => {
  state.allowed = true;
  state.existingTask = null;
  state.taskStatus = 'queued';
  state.checkRateLimit.mockReset().mockImplementation(async () => ({ allowed: state.allowed }));
  state.createTask.mockReset().mockImplementation(async (_userId: string, kind: string, key: string) => ({
    id: 'task-1', userId: 'discovery-test-user', kind, status: state.taskStatus, idempotencyKey: key,
  }));
  state.start.mockReset().mockResolvedValue({ runId: 'workflow-1' });
  vi.stubEnv('FEATURE_DISCOVERY', 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('manual discovery refresh endpoint', () => {
  it('requires a request key before making a task', async () => {
    expect((await POST(request(''))).status).toBe(400);
    expect(state.createTask).not.toHaveBeenCalled();
  });

  it('applies the per-user refresh limit', async () => {
    state.allowed = false;
    expect((await POST(request())).status).toBe(429);
    expect(state.createTask).not.toHaveBeenCalled();
  });

  it('starts one idempotent shared-pool task', async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(state.createTask).toHaveBeenCalledWith('discovery-test-user', 'job_discovery', 'discovery:discovery-refresh-key');
    expect(state.start).toHaveBeenCalledTimes(1);
  });

  it('does not rate limit or restart an already-running task with the same key', async () => {
    state.existingTask = { id: 'task-1', status: 'running', userId: 'discovery-test-user' };
    expect((await POST(request())).status).toBe(200);
    expect(state.checkRateLimit).not.toHaveBeenCalled();
    expect(state.createTask).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
  });

  it('retries a failed task with the same key without consuming a new refresh limit', async () => {
    state.existingTask = { id: 'task-1', status: 'failed', userId: 'discovery-test-user' };
    expect((await POST(request())).status).toBe(202);
    expect(state.checkRateLimit).not.toHaveBeenCalled();
    expect(state.start).toHaveBeenCalledTimes(1);
  });

  it('keeps refresh unavailable while discovery is disabled', async () => {
    vi.stubEnv('FEATURE_DISCOVERY', 'false');
    expect((await POST(request())).status).toBe(404);
    expect(state.createTask).not.toHaveBeenCalled();
  });
});
