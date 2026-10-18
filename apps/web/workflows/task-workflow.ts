import {
  getTask,
  failTask,
  runNoOpTask,
  startTask,
} from '@career-workspace/core/tasks';
import { ApiError } from '@career-workspace/core';
import { runCvExtraction } from '@career-workspace/core/cv';
import { runContactsSearch } from '@career-workspace/core/contacts';
import { runPublishTask } from '@career-workspace/core/publishing';
import { sleep } from 'workflow';
import { runAccountDeletionTask } from '@career-workspace/core/account-deletion';
import { runRevokedPdfCleanupTask } from '@career-workspace/core/revoked-pdf-cleanup';
import { runDiscoveryTask } from '@career-workspace/core/discovery-task';
import { deleteClerkIdentity } from '../lib/delete-clerk-identity';

export async function processRecordedTask(userId: string, taskId: string) {
  'use workflow';
  let task = await executeRecordedTask(userId, taskId);
  // Poll accepted posts for three minutes even when the callback is delayed.
  // After that the saved post remains pending; its callback or an explicit
  // status check can finish it without creating a new publication key.
  for (
    let check = 0;
    check < 6 &&
    'kind' in task &&
    task.kind === 'publish_post' &&
    task.status === 'running';
    check++
  ) {
    await sleep('30s');
    task = await executeRecordedTask(userId, taskId);
  }
  return task;
}

async function executeRecordedTask(userId: string, taskId: string) {
  'use step';
  const task = await getTask(userId, taskId);
  if (task.kind === 'noop') return runNoOpTask(userId, taskId);
  if (task.kind === 'cv_extract') return runCvExtraction(userId, taskId);
  if (task.kind === 'contacts_search') return runContactsSearch(userId, taskId);
  if (task.kind === 'publish_post') return runPublishTask(userId, taskId);
  if (task.kind === 'account_delete')
    return runAccountDeletionTask(userId, taskId, {
      deleteIdentity: deleteClerkIdentity,
    });
  if (task.kind === 'job_discovery') return runDiscoveryTask(userId, taskId);
  if (task.kind === 'revoked_pdf_cleanup')
    return runRevokedPdfCleanupTask(userId, taskId);
  if (task.status === 'succeeded') return task;
  if (task.status === 'queued' || task.status === 'failed') {
    await startTask(userId, taskId);
    return failTask(userId, taskId, 'UNSUPPORTED_TASK_KIND');
  }
  throw new ApiError(409, 'TASK_NOT_READY', 'This task cannot be started.');
}
