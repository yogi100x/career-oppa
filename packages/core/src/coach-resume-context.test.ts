import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coachReaders } from './coach';

const mocks = vi.hoisted(() => ({
  getOpportunity: vi.fn(),
  getFitReviews: vi.fn(),
  getResumePreparation: vi.fn(),
  listResumeVersions: vi.fn(),
  getResumeAtsReport: vi.fn(),
}));

vi.mock('./roles', () => ({
  getOpportunity: mocks.getOpportunity,
  listOpportunities: vi.fn(),
}));
vi.mock('./fit-review', () => ({ getFitReviews: mocks.getFitReviews }));
vi.mock('./resume-preparation-service', () => ({
  getResumePreparation: mocks.getResumePreparation,
}));
vi.mock('./resumes', () => ({
  listResumeVersions: mocks.listResumeVersions,
  getResumeAtsReport: mocks.getResumeAtsReport,
}));

const role = {
  opportunity: { id: 'role-id', status: 'saved' },
  job: { id: 'job-id', title: 'Engineer', company: 'Example', text: 'Role' },
};
const review = {
  scorecard: { score: 4, band: 'strong_fit' },
  requirements: [{ text: 'TypeScript' }],
  gaps: ['Cloud experience'],
  strengths: [{ text: 'TypeScript' }],
  unknowns: [],
  outdated: false,
};
const skill = (index: number) => ({
  id: `skill-${index}`,
  skill: `Skill ${index}`,
  kind: 'existing',
  priority: 'essential',
  factIds: [],
});
const preparation = {
  skills: {
    buckets: {
      existing: Array.from({ length: 25 }, (_, index) => skill(index)),
      supportedByResume: Array.from({ length: 25 }, (_, index) => skill(index)),
      gaps: Array.from({ length: 25 }, (_, index) => skill(index)),
    },
    incompleteDetection: false,
    incompleteRequirements: Array.from({ length: 25 }, (_, index) => `Requirement ${index}`),
  },
  requirements: Array.from({ length: 25 }, (_, index) => ({ text: `Requirement ${index}` })),
  reuse: Array.from({ length: 5 }, (_, index) => ({ resumeId: `resume-${index}` })),
};

describe('coach resume context', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getOpportunity.mockResolvedValue(role);
    mocks.getFitReviews.mockResolvedValue([review]);
    mocks.getResumePreparation.mockResolvedValue(preparation);
    mocks.listResumeVersions.mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('logs a safe message and keeps the owned role and fit review when preparation fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getResumePreparation.mockRejectedValue(
      new Error('password=secret and private job text'),
    );

    const result = await coachReaders('user-id', {} as never).role('role-id');

    expect(mocks.getOpportunity).toHaveBeenCalledWith(
      'user-id',
      'role-id',
      expect.anything(),
    );
    expect(result).toMatchObject({
      ...role,
      fitReview: review,
      resumePreparation: null,
      resumeAts: null,
      resumeSummary: null,
    });
    expect(log).toHaveBeenCalledOnce();
    const logEntry = JSON.parse(log.mock.calls[0]![0] as string) as Record<string, string>;
    expect(logEntry).toEqual({
      event: 'coach_resume_context_failure',
      message: 'Optional resume preparation could not be loaded.',
      opportunityId: 'role-id',
    });
    expect(log.mock.calls[0]![0]).not.toContain('password=secret');
    expect(log.mock.calls[0]![0]).not.toContain('private job text');
    expect(log.mock.calls[0]![0]).not.toContain('user-id');
  });

  it('keeps good preparation when the version list fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listResumeVersions.mockRejectedValue(new Error('versions unavailable'));

    const result = await coachReaders('user-id', {} as never).role('role-id');

    expect(result.resumePreparation).toMatchObject({
      skills: { buckets: { existing: preparation.skills.buckets.existing.slice(0, 20) } },
    });
    expect(result.resumeAts).toBeNull();
    expect(result.resumeSummary).toContain('PDF readability is unavailable');
    expect(log).toHaveBeenCalledOnce();
  });

  it('keeps good preparation when the readability report fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listResumeVersions.mockResolvedValue([{ id: 'resume-id' }]);
    mocks.getResumeAtsReport.mockRejectedValue(new Error('report unavailable'));

    const result = await coachReaders('user-id', {} as never).role('role-id');

    expect(result.resumePreparation).not.toBeNull();
    expect(result.resumeAts).toBeNull();
    expect(result.resumeSummary).toContain('PDF readability is unavailable');
    expect(log).toHaveBeenCalledOnce();
  });

  it('caps skill bucket lists sent to the coach', async () => {
    const result = await coachReaders('user-id', {} as never).role('role-id');

    expect(result.resumePreparation?.skills.buckets.existing).toHaveLength(20);
    expect(result.resumePreparation?.skills.buckets.supportedByResume).toHaveLength(20);
    expect(result.resumePreparation?.skills.buckets.gaps).toHaveLength(20);
    expect(result.resumePreparation?.skills.incompleteRequirements).toHaveLength(20);
    expect(result.resumePreparation?.requirements).toHaveLength(20);
    expect(result.resumePreparation?.reuse).toHaveLength(3);
  });

  it('does not turn an ownership failure into an optional resume-context failure', async () => {
    mocks.getOpportunity.mockRejectedValue(new Error('role not found'));

    await expect(coachReaders('user-id', {} as never).role('role-id')).rejects.toThrow(
      'role not found',
    );
    expect(mocks.getResumePreparation).not.toHaveBeenCalled();
  });
});
