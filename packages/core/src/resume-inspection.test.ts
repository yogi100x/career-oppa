import { describe, expect, it, vi } from 'vitest';
import type { ResumeContent } from '@career-workspace/contracts';
import type { ResumeAtsAudit } from './resume-ats';
import {
  createResumeInspectionCache,
  type ResumePdfInspectionInput,
} from './resume-inspection';
import type { getResumeAtsAudit } from './resume-ats';
import type { renderResumePdf } from '@career-workspace/pdf';

const sample: ResumeContent = {
  name: 'Sam Lee',
  contact: 'sam@example.test',
  sections: [{ title: 'Experience', bullets: [], entries: [] }],
};

const input = (
  overrides: Partial<ResumePdfInspectionInput> = {},
): ResumePdfInspectionInput => ({
  ownerId: 'owner-a',
  resumeId: 'resume-a',
  content: sample,
  pageSize: 'A4',
  ...overrides,
});

const successfulAudit: ResumeAtsAudit = {
  score: 100,
  grade: 'A',
  checks: [],
  extractedText: 'private CV text must not be cached',
  disclaimer: 'Readability only.',
};

describe('bounded resume PDF inspection cache', () => {
  it('coalesces concurrent work, returns page count and audit, and omits extracted CV text', async () => {
    let resolveRender!: (bytes: Uint8Array) => void;
    const render = vi.fn<typeof renderResumePdf>(
      () =>
        new Promise((resolve) => {
          resolveRender = resolve;
        }),
    );
    const audit = vi.fn<typeof getResumeAtsAudit>(async () => successfulAudit);
    const inspect = createResumeInspectionCache({ render, audit });

    const first = inspect(input());
    const second = inspect(input());
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    resolveRender(new TextEncoder().encode('%PDF-1 /Type /Page'));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(audit).toHaveBeenCalledOnce();
    expect(firstResult.pageCount).toBe(1);
    expect(firstResult.ats).toMatchObject({ score: 100, grade: 'A' });
    expect(firstResult.ats).not.toHaveProperty('extractedText');
    firstResult.ats.checks.push({
      id: 'text',
      label: 'mutated',
      status: 'fail',
      weight: 1,
      detail: 'mutated',
    });
    expect(secondResult.ats.checks).toHaveLength(0);
    expect((await inspect(input())).ats.checks).toHaveLength(0);
    expect(render).toHaveBeenCalledOnce();
  });

  it('separates owners, resume ids, content hashes and page sizes', async () => {
    const render = vi.fn<typeof renderResumePdf>(async () =>
      new TextEncoder().encode('%PDF-1 /Type /Page'),
    );
    const audit = vi.fn<typeof getResumeAtsAudit>(async () => successfulAudit);
    const inspect = createResumeInspectionCache({ render, audit });
    await inspect(input());
    await inspect(input({ ownerId: 'owner-b' }));
    await inspect(input({ resumeId: 'resume-b' }));
    await inspect(input({ content: { ...sample, name: 'Alex Smith' } }));
    await inspect(input({ pageSize: 'LETTER' }));
    expect(render).toHaveBeenCalledTimes(5);
  });

  it('evicts the least recently used entry and retries rejected inspections', async () => {
    let renderCalls = 0;
    const render = vi.fn<typeof renderResumePdf>(async () => {
      renderCalls += 1;
      if (renderCalls === 2) throw new Error('recorded render failure');
      return new TextEncoder().encode('%PDF-1 /Type /Page');
    });
    const inspect = createResumeInspectionCache({
      maxEntries: 2,
      render,
      audit: vi.fn<typeof getResumeAtsAudit>(async () => successfulAudit),
    });
    await inspect(input());
    await expect(inspect(input({ resumeId: 'resume-b' }))).rejects.toThrow(
      'recorded render failure',
    );
    await inspect(input({ resumeId: 'resume-b' }));
    await inspect(input({ resumeId: 'resume-c' }));
    await inspect(input());
    expect(render).toHaveBeenCalledTimes(5);
  });
});
