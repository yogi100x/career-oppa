import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  grounding: vi.fn(),
  file: vi.fn(),
  render: vi.fn(),
}));
vi.mock('@career-workspace/core/resumes', () => ({
  getResume: mocks.resume,
  getResumeGrounding: mocks.grounding,
}));
vi.mock('@career-workspace/core', async (original) => ({
  ...(await original<object>()),
  getOwnedUserFile: mocks.file,
}));
vi.mock('@career-workspace/pdf', () => ({ renderResumePdf: mocks.render }));
vi.mock('../../../../../../lib/api-route', () => ({
  authenticateApi: async () => ({ id: 'owner' }),
  manualRouteAccessError: () => null,
  logApiFailure: vi.fn(),
  withRequestId: (_request: Request, response: Response) => response,
}));
import { GET } from './route';
const context = { params: Promise.resolve({ id: 'resume' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resume.mockResolvedValue({
    approvedAt: null,
    pdfFileId: null,
    content: { name: 'Jane Doe' },
    pageSize: 'A4',
  });
  mocks.grounding.mockResolvedValue({ canApprove: true });
  mocks.render.mockResolvedValue(new TextEncoder().encode('%PDF fixture'));
});

describe('approved PDF download boundary', () => {
  it('never returns a draft from the approved-download action', async () => {
    const response = await GET(
      new Request('http://localhost/api/v1/resumes/resume/pdf?approved=1'),
      context,
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('APPROVED_PDF_REQUIRED');
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it('still previews a grounded draft separately', async () => {
    const response = await GET(
      new Request('http://localhost/api/v1/resumes/resume/pdf'),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain(
      'filename="Jane-Doe-CV.pdf"',
    );
    expect(mocks.render).toHaveBeenCalledOnce();
  });
  it('does not render a replacement when approved storage is missing', async () => {
    mocks.resume.mockResolvedValue({
      approvedAt: new Date(),
      pdfFileId: 'file',
      content: {},
      pageSize: 'A4',
    });
    mocks.file.mockResolvedValue(null);
    const response = await GET(
      new Request('http://localhost/api/v1/resumes/resume/pdf?approved=1'),
      context,
    );
    expect(response.status).toBe(503);
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it('rejects a flagged draft preview', async () => {
    mocks.grounding.mockResolvedValue({ canApprove: false });
    const response = await GET(
      new Request('http://localhost/api/v1/resumes/resume/pdf'),
      context,
    );
    expect(response.status).toBe(409);
    expect(mocks.render).not.toHaveBeenCalled();
  });
});
