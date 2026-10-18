import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  upload: vi.fn(),
  read: vi.fn(),
  lookup: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('../../../../../lib/api-route', async () => ({
  ...(await import('@career-workspace/core')),
  authenticateApi: async () => ({ id: 'owner', role: 'candidate' }),
}));
vi.mock('../../files/route', () => ({ POST: state.upload }));
vi.mock('@career-workspace/core/cv-upload-state', () => ({
  createCvReadTask: state.read,
  getCvUploadState: state.lookup,
}));
vi.mock('../../../../../lib/cv-read-workflow', () => ({
  dispatchCvRead: state.dispatch,
}));
import { GET, POST } from './route';
beforeEach(() => {
  vi.clearAllMocks();
  state.upload.mockImplementation(async () =>
    Response.json(
      { data: { id: 'file', originalName: 'CV.pdf', duplicate: true } },
      { status: 201 },
    ),
  );
  state.read.mockResolvedValue({
    task: { id: 'task', status: 'succeeded' },
    shouldStart: false,
  });
});
it('returns a duplicate saved file and its completed read without starting another task', async () => {
  const response = await POST(
    new Request('http://localhost/api/v1/profile/cv', { method: 'POST' }),
  );
  expect(response.status).toBe(201);
  expect((await response.json()).data).toMatchObject({
    duplicate: true,
    file: { id: 'file' },
    task: { status: 'succeeded' },
  });
  expect(state.read).toHaveBeenCalledWith('owner', 'file');
  expect(state.dispatch).toHaveBeenCalledWith(
    'owner',
    expect.anything(),
    false,
  );
});
it('reports saved state on an owned read', async () => {
  state.lookup.mockResolvedValue({
    file: { id: 'file' },
    state: 'ready',
    facts: [],
  });
  const response = await GET(new Request('http://localhost/api/v1/profile/cv'));
  expect(response.status).toBe(200);
  expect(state.lookup).toHaveBeenCalledWith('owner', undefined);
});
it('looks up a requested saved CV by ID instead of switching to the latest upload', async () => {
  const fileId = '11111111-1111-4111-8111-111111111111';
  state.lookup.mockResolvedValue({
    file: { id: fileId },
    state: 'ready',
    facts: [],
  });
  const response = await GET(
    new Request(`http://localhost/api/v1/profile/cv?fileId=${fileId}`),
  );
  expect(response.status).toBe(200);
  expect(state.lookup).toHaveBeenCalledWith('owner', fileId);
});
it('rejects an invalid requested CV ID before querying storage', async () => {
  const response = await GET(
    new Request('http://localhost/api/v1/profile/cv?fileId=not-a-uuid'),
  );
  expect(response.status).toBe(400);
  expect(state.lookup).not.toHaveBeenCalled();
});
it('does not create a task when saving the file failed', async () => {
  state.upload.mockResolvedValue(
    Response.json({ error: { code: 'INVALID_FILE' } }, { status: 400 }),
  );
  expect(
    (
      await POST(
        new Request('http://localhost/api/v1/profile/cv', { method: 'POST' }),
      )
    ).status,
  ).toBe(400);
  expect(state.read).not.toHaveBeenCalled();
});

it('keeps the workflow run identifier for newly queued reads', async () => {
  state.read.mockResolvedValue({
    task: { id: 'task', status: 'queued' },
    shouldStart: true,
  });
  state.dispatch.mockResolvedValue('workflow-run');
  const response = await POST(
    new Request('http://localhost/api/v1/profile/cv', { method: 'POST' }),
  );
  expect((await response.json()).data.workflowRunId).toBe('workflow-run');
});
