import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const state = vi.hoisted(() => ({ start: vi.fn(), recordFailure: vi.fn() }));
vi.mock('@career-workspace/core/discovery', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordDiscoveryStartFailure: state.recordFailure,
}));
vi.mock('workflow/api', () => ({ start: state.start }));

function request(secret = 'cron-secret') {
  return new Request('http://localhost:3000/api/cron/job-discovery', {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

beforeEach(() => {
  state.recordFailure.mockReset().mockResolvedValue(undefined);
  state.start.mockReset().mockResolvedValue({ runId: 'workflow-1' });
  vi.stubEnv('CRON_SECRET', 'cron-secret');
  vi.stubEnv('FEATURE_DISCOVERY', 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('daily job discovery cron trigger', () => {
  it('keeps exactly one discovery trigger at 07:00 UTC each day', () => {
    const config = JSON.parse(readFileSync(new URL('../../../../vercel.json', import.meta.url), 'utf8'));
    expect(config.crons.filter((entry: { path: string }) => entry.path === '/api/cron/job-discovery'))
      .toEqual([{ path: '/api/cron/job-discovery', schedule: '0 7 * * *' }]);
  });
  it('requires the exact configured bearer secret', async () => {
    expect((await GET(request('wrong'))).status).toBe(401);
    expect((await GET(request(''))).status).toBe(401);
    expect(state.start).not.toHaveBeenCalled();
  });

  it('does not start the workflow while discovery is disabled', async () => {
    vi.stubEnv('FEATURE_DISCOVERY', 'false');
    expect((await GET(request())).status).toBe(404);
    expect(state.start).not.toHaveBeenCalled();
  });

  it('starts one shared-pool workflow for an authorized cron call', async () => {
    const response = await GET(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { workflowRunId: 'workflow-1' } });
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.start.mock.calls[0]?.[1]).toEqual([expect.stringMatching(/^scheduled:\d{4}-\d{2}-\d{2}$/)]);
  });

  it('returns a safe error when the workflow cannot start', async () => {
    state.start.mockRejectedValueOnce(new Error('private transport detail'));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(state.recordFailure).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({
      error: { code: 'WORKFLOW_START_FAILED', message: 'The scheduled refresh could not be started.' },
    });
  });
});
