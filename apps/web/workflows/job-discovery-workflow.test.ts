import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ prepare: vi.fn(), advance: vi.fn(), sleep: vi.fn() }));
vi.mock('@career-workspace/core/discovery', () => ({ prepareScheduledDiscovery: state.prepare, advanceDiscoverySweep: state.advance }));
vi.mock('workflow', () => ({ sleep: state.sleep }));
import { refreshDiscoveryWorkflow } from './job-discovery-workflow';

describe('daily full-directory workflow', () => {
  beforeEach(() => { state.prepare.mockReset().mockResolvedValue('saved-sweep'); state.advance.mockReset(); state.sleep.mockReset().mockResolvedValue(undefined); });
  it('chains as many small durable steps as needed to cover the entire saved directory', async () => {
    let calls = 0;
    state.advance.mockImplementation(async key => {
      expect(key).toBe('saved-sweep');
      calls++;
      return { done: calls === 100, processed: calls * 180, total: 18_000 };
    });
    await expect(refreshDiscoveryWorkflow('scheduled:2026-10-16')).resolves.toMatchObject({ done: true, processed: 18_000 });
    expect(state.prepare).toHaveBeenCalledWith('scheduled:2026-10-16');
    expect(state.advance).toHaveBeenCalledTimes(100);
  });
  it('waits for an interrupted step lease instead of abandoning the saved sweep', async () => {
    state.advance.mockResolvedValueOnce({ done: false, busy: true, processed: 18, total: 180 })
      .mockResolvedValueOnce({ done: true, busy: false, processed: 180, total: 180 });
    await expect(refreshDiscoveryWorkflow('scheduled:2026-10-16')).resolves.toMatchObject({ processed: 180 });
    expect(state.sleep).toHaveBeenCalledWith('65s');
    expect(state.advance).toHaveBeenCalledTimes(2);
  });
  it('resumes the persisted plan and stops when the failure breaker pauses it', async () => {
    state.advance.mockResolvedValue({ done: true, halted: true, processed: 72, total: 18_000 });
    await expect(refreshDiscoveryWorkflow('scheduled:2026-10-16')).resolves.toMatchObject({ halted: true, processed: 72 });
    expect(state.advance).toHaveBeenCalledOnce();
  });
});
