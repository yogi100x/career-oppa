import { sleep } from 'workflow';
import { prepareScheduledDiscovery, advanceDiscoverySweep } from '@career-workspace/core/discovery';

/** One daily run chains small steps until the complete saved directory is visited. */
export async function refreshDiscoveryWorkflow(key: string) {
  'use workflow';
  const sweepKey = await prepareStep(key);
  let progress = await collectStep(sweepKey);
  while (!progress.done) {
    if (progress.busy) await sleep('65s');
    progress = await collectStep(sweepKey);
  }
  return progress;
}
async function prepareStep(key: string) {
  'use step';
  return prepareScheduledDiscovery(key);
}
async function collectStep(key: string) {
  'use step';
  return advanceDiscoverySweep(key);
}
