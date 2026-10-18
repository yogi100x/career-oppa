import { describe, expect, it } from 'vitest';
import type { FitReviewRequirement } from '@career-workspace/contracts';
import { deriveFitReview } from './fit-review';

const job =
  'Staff nurse, adult ward. Essential: current NMC registration as a Registered Nurse. ' +
  'Desirable: experience with electronic patient records. Must be able to work night shifts in Leeds. ' +
  'Applicants need the right to work in the UK; we cannot offer visa sponsorship.';
const row = (
  overrides: Partial<FitReviewRequirement>,
): FitReviewRequirement => ({
  text: 'Requirement',
  importance: 'essential',
  status: 'unknown',
  fact_ids: [],
  job_quote: 'current NMC registration',
  ...overrides,
});

describe('fit review buckets decided in code', () => {
  it('keeps an unverified essential registration unknown even with other facts', () => {
    const result = deriveFitReview(
      [row({ text: 'NMC registration' })],
      job,
      [false],
      true,
    );
    expect(result.gaps).toEqual([]);
    expect(result.unknowns).toEqual(['NMC registration']);
  });

  it('keeps missing evidence unknown before any facts are approved', () => {
    const result = deriveFitReview(
      [row({ text: 'NMC registration' })],
      job,
      [false],
      false,
    );
    expect(result.gaps).toEqual([]);
    expect(result.unknowns).toEqual(['NMC registration']);
  });

  it('drops a requirement whose quote the job does not contain', () => {
    const result = deriveFitReview(
      [row({ job_quote: 'salary of £40,000', status: 'gap' })],
      job,
      [false],
      true,
    );
    expect(result.strengths).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect(result.dropped).toBe(1);
    expect(result.unknowns[0]).toMatch(/could not be matched to the job text/);
  });

  it('lists job conditions as gaps to consider, essential first', () => {
    const result = deriveFitReview(
      [
        row({
          text: 'Patient records',
          importance: 'desirable',
          status: 'gap',
          job_quote: 'electronic patient records',
        }),
        row({
          text: 'Right to work without sponsorship',
          status: 'constraint',
          job_quote: 'we cannot offer visa sponsorship',
        }),
      ],
      job,
      [false, false],
      true,
    );
    expect(result.gaps.map((gap) => gap.split(' — ')[0])).toEqual([
      'Right to work without sponsorship',
    ]);
    expect(result.unknowns).toContain('Unverified gap: Patient records');
  });

  it('counts a met requirement as a strength only with approved citations', () => {
    const met = row({
      text: 'Night shifts',
      status: 'met',
      fact_ids: ['00000000-0000-4000-8000-000000000001'],
      job_quote: 'work night shifts',
    });
    expect(deriveFitReview([met], job, [true], true).strengths).toHaveLength(1);
    const unsupported = deriveFitReview([met], job, [false], true);
    expect(unsupported.strengths).toEqual([]);
    expect(unsupported.gaps).toEqual([]);
    expect(unsupported.unknowns).toEqual(['Night shifts']);
  });

  it('counts an eligibility fact that meets a job condition as a strength', () => {
    const result = deriveFitReview(
      [
        row({
          text: 'Right to work in the UK',
          status: 'met',
          fact_ids: ['00000000-0000-4000-8000-000000000003'],
          job_quote: 'right to work in the UK',
        }),
        row({
          text: 'No visa sponsorship',
          status: 'gap',
          job_quote: 'we cannot offer visa sponsorship',
        }),
      ],
      job,
      [true, false],
      true,
    );
    expect(result.strengths.map((s) => s.text)).toEqual([
      'Right to work in the UK',
    ]);
    expect(result.gaps[0]).toMatch(/^No visa sponsorship/);
  });

  it('keeps at most five unknowns', () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      row({ text: `Requirement ${index}` }),
    );
    expect(
      deriveFitReview(many, job, Array(7).fill(false), false).unknowns,
    ).toHaveLength(5);
  });
});
