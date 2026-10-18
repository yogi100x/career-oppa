import { describe, expect, it } from 'vitest';
import {
  cvStatusUrl,
  cvFactsForReview,
  extractionNotice,
  restoredCvStep,
  type CvStatus,
} from './activation-flow';

const empty: CvStatus = {
  file: null,
  task: null,
  facts: [],
  state: 'empty',
  factCount: 0,
  approvedCount: 0,
};
const testFact = (id: string, status: string = 'proposed') =>
  ({
    id,
    kind: 'skill',
    text: id,
    source: 'cv',
    status,
  }) as CvStatus['facts'][number];

describe('saved CV activation state', () => {
  it('can restore a specific reused upload without switching to the latest file', () => {
    expect(cvStatusUrl('11111111-1111-4111-8111-111111111111')).toBe(
      '/api/v1/profile/cv?fileId=11111111-1111-4111-8111-111111111111',
    );
    expect(cvStatusUrl()).toBe('/api/v1/profile/cv');
  });

  it('opens saved, ready and empty CV facts for review', () => {
    expect(
      restoredCvStep({
        ...empty,
        file: { id: 'cv', originalName: 'cv.pdf' },
        state: 'ready',
      }),
    ).toBe('facts');
    expect(
      restoredCvStep({ ...empty, file: { id: 'cv', originalName: 'cv.pdf' } }),
    ).toBe('facts');
  });

  it('waits or offers retry when the saved CV task is not ready', () => {
    expect(
      restoredCvStep({
        ...empty,
        file: { id: 'cv', originalName: 'cv.pdf' },
        state: 'reading',
      }),
    ).toBe('cv');
    expect(
      restoredCvStep({
        ...empty,
        file: { id: 'cv', originalName: 'cv.pdf' },
        state: 'failed',
      }),
    ).toBe('cv');
  });

  it('reuses confirmed facts on the CV-only setup path', () => {
    const confirmed = {
      ...empty,
      file: { id: 'cv', originalName: 'cv.pdf' },
      state: 'confirmed' as const,
      approvedCount: 2,
    };
    expect(restoredCvStep(confirmed, true)).toBe('facts');
    expect(restoredCvStep(confirmed, false)).toBeNull();
  });

  it('keeps an account with no saved CV on the first-run choice screen', () => {
    expect(restoredCvStep(empty)).toBeNull();
  });
});

describe('CV extraction notices', () => {
  it('reports newly found facts from the completed extraction', () => {
    expect(
      extractionNotice(
        {
          id: 'task',
          status: 'succeeded',
          output: { newFactCount: 6, duplicateFactCount: 2 },
        },
      ),
    ).toBe('We found 6 new facts in your updated CV.');
  });

  it('reports no new facts while existing proposals remain available for review', () => {
    expect(
      extractionNotice(
        {
          id: 'task',
          status: 'succeeded',
          output: { newFactCount: 0, duplicateFactCount: 2 },
        },
      ),
    ).toBe('Nothing new in this CV.');
  });

  it('reports a repeated extraction with no new facts when no proposals remain', () => {
    expect(
      extractionNotice(
        {
          id: 'task',
          status: 'succeeded',
          output: { newFactCount: 0, duplicateFactCount: 3 },
        },
      ),
    ).toBe('Nothing new in this CV.');
  });

  it('does not reuse old extraction counts for a duplicate upload or missing count data', () => {
    const task = {
      id: 'task',
      status: 'succeeded',
      output: { newFactCount: 6, duplicateFactCount: 0 },
    };
    expect(extractionNotice(task, true)).toBeNull();
    expect(extractionNotice({ id: 'old', status: 'succeeded' })).toBeNull();
  });
});

describe('CV facts shown after extraction or reload', () => {
  const facts = [
    testFact('new-fact'),
    testFact('old-pending-fact'),
    testFact('approved-fact', 'approved'),
  ];

  it('shows only newly inserted proposals just after a successful updated extraction', () => {
    expect(
      cvFactsForReview(
        facts,
        {
          id: 'task',
          status: 'succeeded',
          output: { newFactCount: 1, factIds: ['new-fact'] },
        },
        { freshExtraction: true },
      ).map((fact) => fact.id),
    ).toEqual(['new-fact']);
  });

  it('restores all related pending facts on reload and leaves approved facts hidden', () => {
    expect(cvFactsForReview(facts, null).map((fact) => fact.id)).toEqual([
      'new-fact',
      'old-pending-fact',
    ]);
  });

  it('uses confirmed CV facts only when the CV-only setup path has no pending proposals', () => {
    expect(
      cvFactsForReview([testFact('approved-fact', 'approved')], null, {
        cvOnly: true,
        confirmed: true,
      }).map((fact) => fact.id),
    ).toEqual(['approved-fact']);
  });

  it('keeps pending proposals available when a fresh extraction finds nothing new', () => {
    expect(
      cvFactsForReview(facts, {
        id: 'task',
        status: 'succeeded',
        output: { newFactCount: 0, factIds: [] },
      }, { freshExtraction: true }).map((fact) => fact.id),
    ).toEqual(['new-fact', 'old-pending-fact']);
  });
});
