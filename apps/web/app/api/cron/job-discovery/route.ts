import { guardFeature, readFlags } from '@career-workspace/core';
import { recordDiscoveryStartFailure } from '@career-workspace/core/discovery';
import { start } from 'workflow/api';
import { refreshDiscoveryWorkflow } from '../../../../workflows/job-discovery-workflow';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Not authorized.' } }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const disabled = guardFeature(readFlags(process.env), 'discovery');
  if (disabled) return disabled;
  try {
    const workflow = await start(refreshDiscoveryWorkflow, [`scheduled:${new Date().toISOString().slice(0, 10)}`]);
    return Response.json({ data: { workflowRunId: workflow.runId } }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    await recordDiscoveryStartFailure().catch(() => undefined);
    return Response.json({ error: { code: 'WORKFLOW_START_FAILED', message: 'The scheduled refresh could not be started.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
