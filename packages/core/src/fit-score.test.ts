import { describe, expect, it } from 'vitest';
import {
  fitScoreBandLabels,
  type FitReviewRequirement,
} from '@career-workspace/contracts';
import { calculateFitScore } from './fit-score';

const requirement = (
  text: string,
  importance: FitReviewRequirement['importance'],
  status: FitReviewRequirement['status'],
  job_quote: string,
): FitReviewRequirement => ({
  text,
  importance,
  status,
  job_quote,
  fact_ids: [],
});
const run = (
  requirements: FitReviewRequirement[],
  extra: Partial<Parameters<typeof calculateFitScore>[0]> = {},
) =>
  calculateFitScore({
    requirements,
    jobText:
      'Requires SQL and Python. Salary £40,000–£50,000. Hybrid working with visa sponsorship available.',
    grounding: requirements.map((row) => row.status === 'met'),
    evidenceTexts: requirements.map((row) =>
      row.status === 'met' ? [row.text] : [],
    ),
    evidenceAvailable: true,
    jobTitle: 'Data Analyst',
    targetRoles: ['Data Analyst', 'Researcher'],
    ...extra,
  });

describe('deterministic fit score', () => {
  it('weights essentials three times more than desirables', () => {
    const result = run(
      [
        requirement('SQL', 'essential', 'met', 'Requires SQL'),
        requirement('Python', 'desirable', 'gap', 'Preferred: Python'),
      ],
      { jobText: 'Requires SQL. Preferred: Python.' },
    );
    expect(result.score).toBe(4.4);
    expect(result.band).toBe('worth_a_try');
    expect(result.factors.cvMatch).toMatchObject({
      met: 1,
      total: 2,
      unknown: 0,
      weightedMet: 3,
      weightedTotal: 3.5,
    });
    expect(result.matched).toEqual(['SQL']);
    expect(result.gaps).toEqual(['Python']);
  });

  it('caps an essential clear gap at 3.4', () => {
    const result = run(
      [
        requirement('SQL', 'essential', 'gap', 'Essential: Requires SQL'),
        ...Array.from({ length: 10 }, (_, index) =>
          requirement(
            `Python ${index}`,
            'essential',
            'met',
            `Essential: requires Python ${index}`,
          ),
        ),
      ],
      {
        jobText:
          'Essential: Requires SQL. ' +
          Array.from(
            { length: 10 },
            (_, index) => `Essential: requires Python ${index}.`,
          ).join(' '),
      },
    );
    expect(result.score).toBe(3.4);
    expect(result.band).toBe('not_now');
    expect(result.capReason).toBe('essential_gap');
  });

  it('caps mostly unknown essential requirements at 3.9', () => {
    const result = run(
      [
        requirement('SQL', 'essential', 'met', 'Requires SQL'),
        requirement('Python', 'essential', 'unknown', 'and Python'),
        requirement('Cloud', 'essential', 'unknown', 'cloud experience'),
        ...Array.from({ length: 20 }, (_, index) =>
          requirement(
            `Desirable ${index}`,
            'desirable',
            'met',
            `Desirable ${index} preferred`,
          ),
        ),
      ],
      {
        jobText:
          'Requires SQL and Python and cloud experience. ' +
          Array.from(
            { length: 20 },
            (_, index) => `Desirable ${index} preferred.`,
          ).join(' '),
      },
    );
    expect(result.score).toBe(3.9);
  });

  it('turns ungrounded matches into unknown and never awards their points', () => {
    const result = run(
      [requirement('SQL', 'essential', 'met', 'Requires SQL')],
      { grounding: [false] },
    );
    expect(result.score).toBeNull();
    expect(result.band).toBe('more_evidence_needed');
    expect(result.matched).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect(result.nextAction).toContain(
      'Add or confirm approved experience evidence',
    );
    expect(result.requirements[0]).toMatchObject({
      status: 'unknown',
      fact_ids: [],
      nominalWeight: 3,
      weight: 0,
      contribution: 0,
    });
  });

  it('shows every raw-score contribution and includes fact IDs only for grounded matches', () => {
    const factId = '123e4567-e89b-42d3-a456-426614174000';
    const result = run([
      {
        ...requirement('SQL', 'essential', 'met', 'Requires SQL'),
        fact_ids: [factId],
      },
      requirement('Python', 'desirable', 'unknown', 'and Python'),
    ]);
    expect(result.score).toBe(5);
    expect(result.rawScore).toBe(5);
    expect(result.factors.cvMatch).toMatchObject({
      weightedMet: 3,
      weightedTotal: 3,
      unknown: 1,
    });
    expect(result.requirements).toEqual([
      expect.objectContaining({
        text: 'SQL',
        status: 'met',
        fact_ids: [factId],
        nominalWeight: 3,
        weight: 3,
        contribution: 4,
      }),
      expect.objectContaining({
        text: 'Python',
        status: 'unknown',
        fact_ids: [],
        nominalWeight: 0.5,
        weight: 0,
        contribution: 0,
      }),
    ]);
  });

  it('returns no score when there are no approved facts', () => {
    const result = run(
      [requirement('SQL', 'essential', 'gap', 'Requires SQL')],
      { evidenceAvailable: false },
    );
    expect(result.score).toBeNull();
    expect(result.band).toBe('more_evidence_needed');
  });

  it('ignores quotes not present in the job and lowers confidence', () => {
    const result = run([
      requirement('SQL', 'essential', 'met', 'Must know COBOL'),
    ]);
    expect(result.score).toBeNull();
    expect(result.factors.cvMatch.total).toBe(0);
    expect(result.checks).toContain(
      'Review the job text because some requirement quotes could not be verified.',
    );
    expect(result.evidence.cvMatch).toBe('unknown');
  });

  it('keeps work eligibility and work location as flags, outside the score', () => {
    const base = run([requirement('SQL', 'essential', 'met', 'Requires SQL')]);
    const withFlags = run([
      requirement('SQL', 'essential', 'met', 'Requires SQL'),
      requirement(
        'Visa sponsorship',
        'essential',
        'constraint',
        'visa sponsorship available',
      ),
      requirement(
        'Hybrid location',
        'essential',
        'constraint',
        'Hybrid working',
      ),
    ]);
    expect(withFlags.score).toBe(3.9);
    expect(withFlags.factors.cvMatch.weightedTotal).toBe(
      base.factors.cvMatch.weightedTotal,
    );
    expect(withFlags.factors.constraints.map(({ kind }) => kind)).toEqual([
      'work_authorisation',
      'location',
    ]);
  });

  it('flags explicit visa sponsorship and on-site attendance requirements', () => {
    const result = run(
      [
        requirement('SQL', 'essential', 'met', 'Requires SQL'),
        requirement(
          'Visa sponsorship',
          'essential',
          'constraint',
          'We provide visa sponsorship.',
        ),
        requirement(
          'Office attendance',
          'essential',
          'constraint',
          'The role requires three on-site days per week.',
        ),
      ],
      {
        jobText:
          'Requires SQL. We provide visa sponsorship. The role requires three on-site days per week.',
      },
    );
    expect(result.factors.constraints.map(({ kind }) => kind)).toEqual([
      'work_authorisation',
      'location',
    ]);
  });

  it.each([
    ['Hybrid cloud deployments', 'Our team builds hybrid cloud deployments.'],
    ['Remote monitoring', 'Develop remote monitoring tools for our platform.'],
    ['Visual design', 'Create visual designs for customer dashboards.'],
    [
      'Professional development',
      'We sponsor professional development for early-career employees.',
    ],
  ])('does not treat %s as an eligibility condition', (text, quote) => {
    const result = run([requirement(text, 'essential', 'met', quote)], {
      jobText: quote,
    });
    expect(result.score).toBe(5);
    expect(result.factors.constraints).toEqual([]);
    if (text === 'Professional development')
      expect(result.factors.culture).toEqual({
        status: 'stated',
        evidence: 'professional development',
      });
    else
      expect(result.factors.culture).toEqual({
        status: 'not_stated',
        evidence: null,
      });
  });

  it.each([
    'Working hours are 9 to 5',
    'The start date is 1 December',
    'Grade cut-off is level 6',
    'Graduation year must be 2024',
    'At least 5 years experience required',
    'Essential: 5+ years Kubernetes',
  ])('keeps explicit job condition outside the numeric score: %s', (quote) => {
    const result = run(
      [requirement('Job condition', 'essential', 'unknown', quote)],
      { jobText: quote },
    );
    expect(result.factors.constraints).toMatchObject([
      { kind: 'other', status: 'unknown' },
    ]);
    expect(result.score).toBeNull();
  });

  it('counts identical quotes once and keeps the conservative conflicting status', () => {
    const matched = requirement(
      'SQL',
      'essential',
      'met',
      'Essential: Requires SQL',
    );
    const duplicate = run([matched, matched], {
      jobText: 'Essential: Requires SQL',
    });
    expect(duplicate.score).toBe(5);
    expect(duplicate.factors.cvMatch).toMatchObject({
      total: 1,
      weightedTotal: 3,
    });
    expect(duplicate.requirements).toHaveLength(1);

    const conflict = run(
      [
        matched,
        requirement('SQL', 'essential', 'gap', 'Essential: Requires SQL'),
        ...Array.from({ length: 10 }, (_, index) =>
          requirement(
            `Python ${index}`,
            'essential',
            'met',
            `Essential: requires Python ${index}`,
          ),
        ),
      ],
      {
        jobText:
          'Essential: Requires SQL. ' +
          Array.from(
            { length: 10 },
            (_, index) => `Essential: requires Python ${index}.`,
          ).join(' '),
      },
    );
    expect(conflict.score).toBe(3.4);
    expect(conflict.requirements).toHaveLength(11);
    expect(conflict.requirements[0].status).toBe('gap');
  });

  it('shows literal compensation and culture evidence and target alignment as factors', () => {
    const result = run([
      requirement('SQL', 'essential', 'met', 'Requires SQL'),
    ]);
    expect(result.factors.compensation).toMatchObject({
      status: 'stated',
      evidence: 'Salary £40,000–£50,000',
    });
    expect(result.factors.culture).toMatchObject({
      status: 'stated',
      evidence: 'Hybrid working',
    });
    expect(result.factors.targetRoleAlignment).toEqual({
      status: 'aligned',
      matchedRole: 'Data Analyst',
    });
  });

  it('does not infer compensation, culture, target alignment, or confidence from missing details', () => {
    const result = run([], {
      jobText: 'Requires care and attention.',
      jobTitle: 'Support Assistant',
      targetRoles: ['Data Analyst'],
    });
    expect(result.score).toBeNull();
    expect(result.factors.compensation).toEqual({
      status: 'not_stated',
      evidence: null,
    });
    expect(result.factors.culture).toEqual({
      status: 'not_stated',
      evidence: null,
    });
    expect(result.factors.targetRoleAlignment).toEqual({
      status: 'not_aligned',
      matchedRole: null,
    });
    expect(result.confidence).toBe('low');
  });

  it('does not claim high confidence while the red-flags dimension remains unknown', () => {
    const result = run(
      [requirement('SQL', 'essential', 'met', 'Requires SQL')],
      {
        jobText: 'Requires SQL. Salary £40,000. Hybrid working. Team of four.',
        targetRoles: ['Data Analyst'],
      },
    );
    expect(result.evidence).toMatchObject({
      cvMatch: 'supported',
      targetRoleAlignment: 'supported',
      compensation: 'supported',
      culture: 'supported',
      redFlags: 'unknown',
    });
    expect(result.confidence).toBe('medium');
  });

  it('uses discovery role matching so broad shared words do not imply alignment', () => {
    const result = run([], {
      jobTitle: 'DevOps Engineer',
      targetRoles: ['Software Engineer'],
    });
    expect(result.factors.targetRoleAlignment).toEqual({
      status: 'not_aligned',
      matchedRole: null,
    });
  });

  it('recognizes UX as a specific target role term', () => {
    const result = run([], {
      jobTitle: 'UX Designer',
      targetRoles: ['UX Designer'],
    });
    expect(result.factors.targetRoleAlignment).toEqual({
      status: 'aligned',
      matchedRole: 'UX Designer',
    });
  });

  it('marks CV evidence unknown when there are no approved facts or every row is unknown', () => {
    const noFacts = run(
      [requirement('SQL', 'essential', 'gap', 'Requires SQL')],
      { evidenceAvailable: false },
    );
    const unknownRows = run([
      requirement('SQL', 'essential', 'unknown', 'Requires SQL'),
    ]);
    expect(noFacts.evidence.cvMatch).toBe('unknown');
    expect(unknownRows.evidence.cvMatch).toBe('unknown');
    expect(unknownRows.score).toBeNull();
  });

  it('shows the status of eligibility flags and lowers confidence for unresolved eligibility', () => {
    const result = run([
      requirement('SQL', 'essential', 'met', 'Requires SQL'),
      requirement(
        'Work eligibility',
        'essential',
        'gap',
        'visa sponsorship available',
      ),
    ]);
    expect(result.factors.constraints[0]).toMatchObject({
      kind: 'work_authorisation',
      status: 'gap',
    });
    expect(result.confidence).toBe('low');
    expect(result.checks[0]).toContain(
      'Confirm work eligibility: Work eligibility',
    );
    expect(result.nextAction).toContain(
      'Confirm work eligibility: Work eligibility',
    );
  });

  it('shows protected attribute requirements only as neutral excluded flags', () => {
    const baseline = run(
      [requirement('SQL', 'essential', 'met', 'Requires SQL')],
      { jobText: 'Requires SQL and Python and cloud experience.' },
    );
    const result = run(
      [
        requirement('SQL', 'essential', 'met', 'Requires SQL'),
        requirement('Nationality', 'essential', 'gap', 'and Python'),
        requirement('Age', 'desirable', 'met', 'cloud experience'),
      ],
      { jobText: 'Requires SQL and Python and cloud experience.' },
    );
    expect(result.factors.cvMatch).toMatchObject({
      total: 1,
      weightedTotal: 3,
    });
    expect(result.gaps).toEqual([]);
    expect(result.matched).toEqual(['SQL']);
    expect(result.score).toBe(baseline.score);
    expect(result.confidence).toBe(baseline.confidence);
    expect(result.factors.constraints).toEqual([
      {
        kind: 'other',
        status: 'unknown',
        text: 'Job condition excluded from fit scoring',
        quote: 'and Python',
      },
      {
        kind: 'other',
        status: 'unknown',
        text: 'Job condition excluded from fit scoring',
        quote: 'cloud experience',
      },
    ]);
  });

  it('uses the requested calm band labels', () => {
    expect(fitScoreBandLabels.stretch).toBe('Stretch');
    expect(fitScoreBandLabels.not_now).toBe('Not now');
  });

  it('does not score a model constraint label unless the quote states a real condition', () => {
    const result = run(
      [
        requirement(
          'Kubernetes',
          'essential',
          'constraint',
          'Requires Kubernetes',
        ),
      ],
      { jobText: 'Requires Kubernetes' },
    );
    expect(result.factors.constraints).toEqual([]);
    expect(result.requirements[0]).toMatchObject({
      status: 'unknown',
      weight: 0,
    });
  });

  it('requires the cited approved fact to mention the requirement', () => {
    const result = run(
      [requirement('Kubernetes', 'essential', 'met', 'Requires Kubernetes')],
      {
        jobText: 'Requires Kubernetes',
        evidenceTexts: [['Managed a team of five engineers']],
      },
    );
    expect(result.score).toBeNull();
    expect(result.requirements[0].status).toBe('unknown');
  });

  it('requires cited fact terms to agree with both the model description and job quote', () => {
    const result = run(
      [
        requirement(
          'Kubernetes expertise',
          'essential',
          'met',
          'Requires cloud-native deployment',
        ),
      ],
      {
        jobText: 'Requires cloud-native deployment',
        evidenceTexts: [['Kubernetes expertise across production systems']],
      },
    );
    expect(result.score).toBeNull();
    expect(result.requirements[0].status).toBe('unknown');
  });

  it.each([
    ['Excel', 'Must use Excel', 'I excel at team work'],
    ['Go', 'Must use Go', 'I go the extra mile'],
  ])(
    'does not treat lowercase polysemy as evidence for %s skill experience',
    (skill, quote, fact) => {
      const result = run([requirement(skill, 'essential', 'met', quote)], {
        jobText: quote,
        evidenceTexts: [[fact]],
      });
      expect(result.score).toBeNull();
      expect(result.requirements[0].status).toBe('unknown');
    },
  );

  it('deduplicates by job quote even when the model paraphrases requirement text', () => {
    const result = run([
      requirement('SQL reporting', 'essential', 'met', 'Requires SQL'),
      requirement('SQL knowledge', 'desirable', 'met', 'Requires SQL'),
    ]);
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0].importance).toBe('essential');
    expect(result.factors.cvMatch.weightedTotal).toBe(3);
  });

  it('marks unsupported gap labels unverified instead of awarding a gap-based cap', () => {
    const result = run([
      requirement('SQL', 'essential', 'gap', 'Requires SQL'),
    ]);
    expect(result.score).toBeNull();
    expect(result.requirements[0]).toMatchObject({
      status: 'unknown',
      gapVerification: 'unverified',
    });
  });

  it.each([
    'Python is not required',
    'Python preferred but not required',
    'Candidates must not use Python',
  ])('does not verify a gap from negated priority wording: %s', (quote) => {
    const result = run([requirement('Python', 'essential', 'gap', quote)], {
      jobText: quote,
    });
    expect(result.score).toBeNull();
    expect(result.capReason).toBeNull();
    expect(result.requirements[0]).toMatchObject({
      status: 'unknown',
      gapVerification: 'unverified',
    });
  });

  it('does not let a desirable gap quote become an essential cap after deduplication', () => {
    const result = run(
      [
        requirement('Python', 'essential', 'met', 'Preferred: Python'),
        requirement(
          'Python scripting',
          'desirable',
          'gap',
          'Preferred: Python',
        ),
      ],
      { jobText: 'Preferred: Python' },
    );
    expect(result.score).toBeNull();
    expect(result.capReason).toBeNull();
    expect(result.requirements).toMatchObject([
      {
        importance: 'essential',
        status: 'unknown',
        gapVerification: 'unverified',
      },
    ]);
  });

  it('caps desirable-only evidence at 4.4 with low confidence', () => {
    const result = run(
      [requirement('SQL', 'desirable', 'met', 'Preferred: SQL')],
      { jobText: 'Preferred: SQL' },
    );
    expect(result.score).toBe(4.4);
    expect(result.capReason).toBe('thin_evidence');
    expect(result.confidence).toBe('low');
  });

  it('counts an unknown essential eligibility condition in the unknown-majority cap', () => {
    const result = run(
      [
        requirement('SQL', 'essential', 'met', 'Requires SQL'),
        requirement(
          'Visa sponsorship',
          'essential',
          'unknown',
          'Visa sponsorship is required',
        ),
        requirement(
          'Office attendance',
          'essential',
          'unknown',
          'The role requires three on-site days per week',
        ),
      ],
      {
        jobText:
          'Requires SQL. Visa sponsorship is required. The role requires three on-site days per week.',
      },
    );
    expect(result.score).toBe(3.9);
    expect(result.capReason).toBe('mostly_unknown_essentials');
  });
});
