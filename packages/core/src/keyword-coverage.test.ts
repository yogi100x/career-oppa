import { describe, expect, it } from 'vitest';
import { jobTerms, keywordCoverage } from './keyword-coverage';

const job =
  'Graduate Data Analyst at Northwind Ltd, Pune. You will use SQL and Python to build ' +
  'dashboards in Power BI. Minimum 60% in 10th and 12th, and a CGPA of 7 or above. ' +
  'Strong communication and data analysis skills. Knowledge of Excel is a plus.';

describe('keyword coverage report', () => {
  it('picks job terms without the company, place or sentence starts', () => {
    const terms = jobTerms(job, ['Northwind Ltd', 'Pune']);
    expect(terms).toEqual(
      expect.arrayContaining([
        'sql',
        'python',
        'power bi',
        'cgpa',
        '10th',
        '12th',
        'excel',
      ]),
    );
    expect(terms).not.toContain('northwind');
    expect(terms).not.toContain('pune');
    expect(terms).not.toContain('you');
  });

  it('counts UK and India synonyms and lists what no cited fact shows', () => {
    const result = keywordCoverage(
      job,
      [
        'Class 12 (HSC): 82%',
        'SSC 2019: 91%',
        'B.Tech, GPA 8.1',
        'Built Excel reports for a college fest; basic Python',
      ],
      ['Northwind Ltd', 'Pune'],
    );
    expect(result.covered).toEqual(
      expect.arrayContaining(['12th', '10th', 'cgpa', 'python', 'excel']),
    );
    expect(result.notEvidenced).toEqual(expect.arrayContaining(['sql']));
    expect(result.covered).not.toContain('sql');
  });
});
