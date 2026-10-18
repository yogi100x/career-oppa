import { beforeEach, describe, expect, it, vi } from 'vitest';

const extractText = vi.hoisted(() => vi.fn());
vi.mock('@career-workspace/adapters/cv-text', () => ({
  extractCvText: extractText,
}));

import type { ResumeContent } from '@career-workspace/contracts';
import { getResumeAtsAudit } from './resume-ats';

const resume: ResumeContent = {
  name: 'Sam Lee',
  contact: 'sam@example.test · London',
  sections: [
    {
      title: 'Experience',
      bullets: [{ text: 'Built useful tools for a local team', fact_ids: [] }],
      entries: [],
    },
  ],
};

beforeEach(() => extractText.mockReset());

describe('resume text integrity checks', () => {
  it('fails and lowers the grade when the extracted name is missing', async () => {
    extractText.mockResolvedValue(
      'sam@example.test · London\nExperience\nBuilt useful tools for a local team',
    );
    const result = await getResumeAtsAudit(resume, new Uint8Array([1]), {
      generatedByRenderer: true,
    });

    expect(result.score).toBe(75);
    expect(result.grade).toBe('C');
    expect(result.checks.find(({ id }) => id === 'text')?.status).toBe('fail');
  });

  it('fails text integrity and Unicode checks when an accented name is changed', async () => {
    const accented: ResumeContent = { ...resume, name: 'Ananya Śrīnivās' };
    extractText.mockResolvedValue(
      'Ananya Srinivas\nsam@example.test · London\nExperience\nBuilt useful tools for a local team',
    );
    const result = await getResumeAtsAudit(accented, new Uint8Array([1]), {
      generatedByRenderer: true,
    });

    expect(result.score).toBe(70);
    expect(result.grade).toBe('C');
    expect(result.checks.find(({ id }) => id === 'text')?.status).toBe('fail');
    expect(result.checks.find(({ id }) => id === 'unicode')?.status).toBe(
      'fail',
    );
  });
});
