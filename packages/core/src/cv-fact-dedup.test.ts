import { describe, expect, it } from 'vitest';
import {
  deduplicateCvFacts,
  isDuplicateCvFact,
  type CvFactForDedup,
} from './cv-fact-dedup';

const fact = (
  text: string,
  overrides: Partial<CvFactForDedup> = {},
): CvFactForDedup => ({ kind: 'experience', text, ...overrides });

describe('CV fact near-duplicate checks', () => {
  it('normalizes punctuation, case, and spacing', () => {
    expect(
      isDuplicateCvFact(
        fact('Built, reliable software!'),
        fact(' built reliable   software '),
      ),
    ).toBe(true);
  });
  it('catches very close wording', () => {
    const result = deduplicateCvFacts(
      [
        fact(
          'Managed delivery of secure customer account services for a large retail product team across three annual releases in five regional markets reliably',
        ),
      ],
      [
        fact(
          'Managed delivery of secure customer account services for a large retail product team across three annual releases in five regional markets',
        ),
      ],
    );
    expect(result).toEqual({
      newFacts: [],
      duplicateFactCount: 1,
      duplicateFactIds: [],
    });
  });
  it('keeps numeric punctuation and percent markers in long close matches', () => {
    const prefix =
      'Led delivery of reliable customer account services for a large retail product team across multiple annual releases in several regional markets while improving conversion by ';
    expect(
      isDuplicateCvFact(
        fact(`${prefix}20% through careful testing and rollout`),
        fact(`${prefix}20 through careful testing and rollout`),
      ),
    ).toBe(false);
    expect(
      isDuplicateCvFact(
        fact(`${prefix}1.5 points through careful testing and rollout`),
        fact(`${prefix}1 5 points through careful testing and rollout`),
      ),
    ).toBe(false);
  });
  it('still deduplicates punctuation and case changes around numbers', () => {
    expect(
      isDuplicateCvFact(
        fact('Improved reliable service by 20 percent.'),
        fact('improved, reliable service by 20 percent'),
      ),
    ).toBe(true);
  });
  it.each([
    ['Managed a team of 5 engineers', 'Managed a team of 6 engineers'],
    [
      'Managed 5 engineers across 3 sites',
      'Managed 3 engineers across 5 sites',
    ],
    [
      'Worked from March 2022 to June 2023',
      'Worked from March 2021 to June 2023',
    ],
    [
      'Worked from March 2021 to June 2023',
      'Worked from June 2023 to March 2021',
    ],
    ['Built payroll systems at Acme', 'Built payroll systems at Beta'],
    ['Worked with Acme and Beta', 'Worked with Beta and Acme'],
    ['Led the hiring team', 'Never led the hiring team'],
    ['Built C++ tools', 'Built C# tools'],
    ['Improved success by 70%', 'Improved success by 70'],
  ])('keeps changed meaningful detail: %s / %s', (left, right) => {
    expect(isDuplicateCvFact(fact(left), fact(right))).toBe(false);
  });
  it.each([
    [
      'Awarded expected first class honours degree in computer science from the university',
      'Awarded first class honours degree in computer science from the university',
    ],
    [
      'Achieved predicted upper second class result in the final software engineering degree exams',
      'Achieved upper second class result in the final software engineering degree exams',
    ],
    [
      'Successfully co-led the migration of the customer billing platform to a modern cloud setup',
      'Successfully led the migration of the customer billing platform to a modern cloud setup',
    ],
  ])('keeps a changed qualifier word: %s / %s', (left, right) => {
    expect(isDuplicateCvFact(fact(left), fact(right))).toBe(false);
  });
  it('keeps a CV fact when only one side has an organisation or dates', () => {
    expect(
      isDuplicateCvFact(
        fact('Managed social media accounts', { organisation: 'Acme' }),
        fact('Managed social media accounts'),
      ),
    ).toBe(false);
    expect(
      isDuplicateCvFact(
        fact('Managed social media accounts', { startDate: '2021' }),
        fact('Managed social media accounts'),
      ),
    ).toBe(false);
    expect(
      isDuplicateCvFact(
        fact('Managed social media accounts', { organisation: 'Acme' }),
        fact('managed social media accounts.', { organisation: 'acme' }),
      ),
    ).toBe(true);
  });
  it('keeps different structured organisation, role, and dates separate', () => {
    expect(
      isDuplicateCvFact(
        fact('Improved release reliability', { organisation: 'Acme' }),
        fact('Improved release reliability', { organisation: 'Beta' }),
      ),
    ).toBe(false);
    expect(
      isDuplicateCvFact(
        fact('Improved release reliability', { role: 'Engineer' }),
        fact('Improved release reliability', { role: 'Manager' }),
      ),
    ).toBe(false);
    expect(
      isDuplicateCvFact(
        fact('Improved release reliability', { startDate: '2021' }),
        fact('Improved release reliability', { startDate: '2022' }),
      ),
    ).toBe(false);
  });
  it('deduplicates repeated candidates in one extraction', () => {
    const result = deduplicateCvFacts(
      [fact('Created team dashboards'), fact('Created team dashboards.')],
      [],
    );
    expect(result).toEqual({
      newFacts: [fact('Created team dashboards')],
      duplicateFactCount: 1,
      duplicateFactIds: [],
    });
  });
  it('returns existing match IDs but does not surface rejected facts', () => {
    const result = deduplicateCvFacts(
      [fact('Built stable APIs'), fact('Managed a team of 3')],
      [
        { ...fact('Built stable APIs'), id: 'approved-id', status: 'approved' },
        {
          ...fact('Managed a team of 3'),
          id: 'rejected-id',
          status: 'rejected',
        },
      ],
    );
    expect(result).toMatchObject({
      duplicateFactCount: 2,
      duplicateFactIds: ['approved-id'],
    });
  });
});
