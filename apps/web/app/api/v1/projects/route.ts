import { createProject, listProjects } from '@career-workspace/core';
import { createProject as createProjectInput } from '@career-workspace/contracts';
import { authenticateApi, createApiHandler } from '../../../../lib/api-route';

export const runtime = 'nodejs';

const getProjects = createApiHandler({
  authenticate: authenticateApi,
  handler: async ({ user }) => ({ projects: await listProjects(user.id) }),
});

const postProject = createApiHandler({
  authenticate: authenticateApi,
  schema: createProjectInput,
  handler: ({ user, input }) => createProject(user.id, input),
});

export function GET(request: Request) {
  return getProjects(request);
}

export async function POST(request: Request) {
  const response = await postProject(request);
  if (!response.ok) return response;
  return new Response(response.body, {
    status: 201,
    headers: response.headers,
  });
}
