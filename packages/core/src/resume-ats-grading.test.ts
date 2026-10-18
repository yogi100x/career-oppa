import { describe, expect, it } from 'vitest';
import { gradeResumeAtsScore, type ResumeAtsCheck } from './resume-ats';

const passingChecks: ResumeAtsCheck[] = [
  {
    id: 'text',
    label: 'Text',
    status: 'pass',
    weight: 25,
    detail: '',
  },
  {
    id: 'unicode',
    label: 'Unicode',
    status: 'pass',
    weight: 5,
    detail: '',
  },
  {
    id: 'hidden',
    label: 'Hidden text',
    status: 'pass',
    weight: 5,
    detail: '',
  },
];

describe('resume readability grade caps', () => {
  it('caps the grade at C if text or Unicode preservation fails or is unknown', () => {
    expect(
      gradeResumeAtsScore(95, [
        ...passingChecks,
        { ...passingChecks[1]!, status: 'fail' },
      ]),
    ).toBe('C');
    expect(
      gradeResumeAtsScore(95, [
        ...passingChecks,
        { ...passingChecks[0]!, status: 'unknown' },
      ]),
    ).toBe('C');
  });

  it('caps the grade at B when any other check fails or is unknown', () => {
    expect(
      gradeResumeAtsScore(95, [
        ...passingChecks,
        { ...passingChecks[2]!, status: 'fail' },
      ]),
    ).toBe('B');
    expect(
      gradeResumeAtsScore(95, [
        ...passingChecks,
        { ...passingChecks[2]!, status: 'unknown' },
      ]),
    ).toBe('B');
  });

  it('leaves an A available only when every check passes', () => {
    expect(gradeResumeAtsScore(95, passingChecks)).toBe('A');
  });
});
