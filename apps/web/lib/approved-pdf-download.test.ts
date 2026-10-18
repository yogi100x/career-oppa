import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createApprovedPdfHandoff,
  downloadApprovedResumePdf,
} from './approved-pdf-download';

afterEach(() => vi.unstubAllGlobals());

describe('approved PDF actions', () => {
  it('preserves the server guidance and does not retry a revoked approval', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        {
          error: {
            code: 'APPROVED_PDF_REQUIRED',
            message: 'Approve this CV again before downloading or applying.',
          },
        },
        { status: 409 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      downloadApprovedResumePdf({
        opportunityId: 'role',
        resumeId: 'resume',
      }),
    ).rejects.toMatchObject({
      message: 'Approve this CV again before downloading or applying.',
      code: 'APPROVED_PDF_REQUIRED',
      retryable: false,
      stage: 'download',
      downloaded: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a skipped check-in for a role that has already advanced', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({
            data: { outcome: 'skipped', reason: 'role_already_advanced' },
          }),
        ),
    );
    await expect(createApprovedPdfHandoff('role', 'resume')).resolves.toBe(
      'skipped',
    );
  });

  it('allows check-in retry after a temporary server failure without downloading twice', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: 'UNAVAILABLE', message: 'Please try again.' } },
            { status: 503 },
          ),
        ),
    );
    await expect(
      createApprovedPdfHandoff('role', 'resume'),
    ).rejects.toMatchObject({
      message: 'Please try again.',
      retryable: true,
      stage: 'handoff',
      downloaded: true,
    });
  });
});
