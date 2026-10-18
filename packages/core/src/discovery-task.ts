import { ApiError } from './api';
import { refreshDiscoveryPool } from './discovery';
import { failTask, getTask, startTask, succeedTask } from './tasks';
import { getDatabase, type Database } from '@career-workspace/db';

/** Runs the user-visible refresh request; the refreshed pool remains shared. */
export async function runDiscoveryTask(
  userId: string,
  taskId: string,
  database: Database = getDatabase(),
) {
  const task = await getTask(userId, taskId, database);
  if (task.kind !== 'job_discovery')
    throw new ApiError(400, 'INVALID_INPUT', 'This is not a discovery task.');
  if (task.status === 'succeeded' || task.status === 'running') return task;
  try {
    await startTask(userId, taskId, database);
  } catch (error) {
    const latest = await getTask(userId, taskId, database);
    if (latest.status === 'running' || latest.status === 'succeeded') return latest;
    throw error;
  }
  try {
    const result = await refreshDiscoveryPool({ database });
    if (result.failed > 0 && result.refreshed === 0) {
      return await failTask(userId, taskId, 'DISCOVERY_SOURCES_UNAVAILABLE', database);
    }
    return await succeedTask(userId, taskId, {
      refreshed: result.refreshed,
      failed: result.failed,
      skipped: result.skipped,
    }, database);
  } catch {
    await failTask(userId, taskId, 'DISCOVERY_REFRESH_FAILED', database);
    throw new ApiError(503, 'DISCOVERY_REFRESH_FAILED', 'The job refresh could not be completed.');
  }
}
