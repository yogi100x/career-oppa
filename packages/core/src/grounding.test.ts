import { describe, expect, it } from 'vitest';
import { checkClaimWording } from './grounding';

const codes = (claim: string, facts: string[]) =>
  checkClaimWording(claim, facts).map((flag) => flag.code);

describe('claim wording gate', () => {
  it('flags an invented team, number and employer citing an unrelated fact', () => {
    const flags = checkClaimWording('Led a team of 10 at Google', [
      'Python (basic)',
    ]);
    expect(flags.map((flag) => flag.message).join(' ')).toMatch(/10/);
    expect(flags.map((flag) => flag.message).join(' ')).toMatch(/Google/);
    expect(flags.map((flag) => flag.code)).toContain('LEVEL_NOT_IN_FACT');
  });

  it('passes wording that stays inside the cited fact', () => {
    expect(
      codes('Organised 12 weekly volunteer shifts at Oxfam, Leeds', [
        'Organised 12 weekly volunteer shifts for Oxfam in Leeds (2023)',
      ]),
    ).toEqual([]);
    expect(
      codes('Programming: Python, SQL', ['Python (basic)', 'SQL and Excel']),
    ).toEqual([]);
    expect(
      codes('Programming Languages: Python, SQL', ['Python (basic)', 'SQL']),
    ).toEqual([]);
    expect(codes('Technical Skills: Java', ['Python (basic)'])).toEqual([
      'DETAIL_NOT_IN_FACT',
    ]);
  });

  it('turns a member into a leader only when the fact says so', () => {
    expect(
      codes('Led the robotics society outreach', [
        'Member of the robotics society',
      ]),
    ).toEqual(['LEVEL_NOT_IN_FACT']);
    expect(
      codes('Led the robotics society outreach', [
        'Outreach lead, robotics society',
      ]),
    ).toEqual([]);
  });

  it('checks money, grades and dates against the fact', () => {
    expect(
      codes('Raised ₹50,000 for the food bank', [
        'Raised Rs 50,000 for the food bank',
      ]),
    ).toEqual([]);
    expect(
      codes('Raised £50,000 for the food bank', [
        'Raised Rs 50,000 for the food bank',
      ]),
    ).toEqual(['DETAIL_NOT_IN_FACT']);
    expect(
      codes('Achieved 2:1 in BSc Economics, June 2024', [
        'BSc Economics, predicted 2:1, graduating 2024',
      ]),
    ).toEqual(['DETAIL_NOT_IN_FACT', 'LEVEL_NOT_IN_FACT']);
    expect(
      codes('BSc Economics, predicted 2:1', [
        'BSc Economics, predicted 2:1, graduating 2024',
      ]),
    ).toEqual([]);
    expect(codes('Scored 95% in Class 12', ['Class 12: 59%'])).toEqual([
      'DETAIL_NOT_IN_FACT',
    ]);
  });

  it('does not treat the first word of a sentence as a name', () => {
    expect(
      codes('Tutored students in maths. Prepared weekly worksheets', [
        'Tutored students in maths and prepared weekly worksheets',
      ]),
    ).toEqual([]);
  });

  it('ignores sentence punctuation after an evidenced named skill', () => {
    expect(codes('Used Python.', ['Used Python for a student project.'])).toEqual([]);
    expect(codes('Skills: Excel.', ['Used Excel for reports.'])).toEqual([]);
    expect(codes('Skills: Excel.', ['I excel at teamwork.'])).toContain('DETAIL_NOT_IN_FACT');
  });

  it('requires case-sensitive evidence when a common word names a skill', () => {
    expect(codes('Skills: Excel', ['I excel at teamwork.'])).toEqual([
      'DETAIL_NOT_IN_FACT',
    ]);
    expect(codes('Excel', ['I excel at teamwork.'])).toEqual([
      'DETAIL_NOT_IN_FACT',
    ]);
    expect(codes('Skills: Go', ['Willing to go the extra mile.'])).toEqual([
      'DETAIL_NOT_IN_FACT',
    ]);
    expect(codes('Skills: Go', ['Built a Google integration.'])).toEqual([
      'DETAIL_NOT_IN_FACT',
    ]);
    expect(codes('Skills: SQL', ['Worked with sql databases.'])).toEqual([]);
    expect(codes('Go programming', ['Willing to go the extra mile.'])).toEqual([
      'DETAIL_NOT_IN_FACT',
    ]);
    expect(codes('Skills: Excel, Go', ['Excel spreadsheets', 'Built services in Go'])).toEqual([]);
    expect(codes('Skills: Excel', ['Prepared weekly spreadsheets'])).toEqual([
      'DETAIL_NOT_IN_FACT',
    ]);
    expect(codes('Skills: C', ['Used c programming.'])).toEqual([]);
    expect(codes('Skills: R', ['Used r programming.'])).toEqual([]);
    expect(codes('Skills: Spreadsheets', ['Prepared weekly spreadsheets'])).toEqual([]);
  });

  it('checks C and R only in a skills label or skills section', () => {
    expect(codes('Skills: C', ['A developer with firmware experience'])).toEqual([
      'DETAIL_NOT_IN_FACT',
    ]);
    expect(codes('Achieved grade C in Maths', ['Maths GCSE grade c'])).toEqual([]);
    expect(codes('Plan C rollout', ['plan c rollout'])).toEqual([]);
    expect(
      checkClaimWording('C programming', ['Used c for firmware'], {
        sectionTitle: 'Technical Skills',
      }),
    ).toEqual([]);
    expect(
      checkClaimWording('R', ['Used r for statistical analysis'], {
        sectionTitle: 'Skills',
      }),
    ).toEqual([]);
    expect(
      checkClaimWording('C programming', ['Used c for firmware'], {
        sectionTitle: 'Education',
      }),
    ).toEqual([]);
    expect(
      checkClaimWording('C', ['Maths GCSE grade B'], {
        sectionTitle: 'Skills',
      }),
    ).toContainEqual(expect.objectContaining({ code: 'DETAIL_NOT_IN_FACT' }));
  });

  it('keeps Java, SQL and AWS whole-word boundaries in both directions', () => {
    expect(codes('Skills: Java', ['Built JavaScript applications'])).toContain(
      'DETAIL_NOT_IN_FACT',
    );
    expect(codes('Skills: JavaScript', ['Built Java applications'])).toContain(
      'DETAIL_NOT_IN_FACT',
    );
    expect(codes('Skills: SQL', ['Worked with MySQL'])).toContain(
      'DETAIL_NOT_IN_FACT',
    );
    expect(codes('Skills: MySQL', ['Worked with SQL'])).toContain(
      'DETAIL_NOT_IN_FACT',
    );
    expect(codes('Skills: AWS', ['Reviewed laws and regulations'])).toContain(
      'DETAIL_NOT_IN_FACT',
    );
    expect(codes('Skills: AWS', ['Passed laws exam'])).toContain(
      'DETAIL_NOT_IN_FACT',
    );
  });

  it('matches ordinary programming skill names without case sensitivity, including sentence starts', () => {
    for (const skill of ['Python', 'Java', 'JavaScript', 'TypeScript', 'SQL', 'AWS']) {
      expect(codes(`Skills: ${skill}`, [`Built a ${skill.toLowerCase()} project.`])).toEqual([]);
      expect(codes(`${skill} development`, [`${skill.toLowerCase()} development experience.`])).toEqual([]);
      expect(codes(`${skill} development`, ['Built a different project.'])).toEqual([
        'DETAIL_NOT_IN_FACT',
      ]);
    }
  });
});


describe('single-letter skills in common CV labels', () => {
  it.each(['Skills: Node.js, C', 'Skills: Vue.js, C', 'Skills: e.g. C', 'Languages: C, Python'])(
    'flags unsupported C in %s', (claim) => {
      expect(checkClaimWording(claim, ['Built Node.js and Vue.js services with Python, e.g. web applications.'])
        .some((flag) => flag.message.includes('“C”'))).toBe(true);
    },
  );
  it.each(['Skills', 'LanguageS', 'Technologies', 'Tools', 'Core Competencies', 'Competency'])(
    'checks C and R in the %s section and label', (sectionTitle) => {
      for (const letter of ['C', 'R']) {
        expect(checkClaimWording(`${letter}, Python`, ['Built Python applications'], { sectionTitle })
          .some((flag) => flag.message.includes(`“${letter}”`))).toBe(true);
        expect(checkClaimWording(`${sectionTitle}: ${letter}`, ['Built Python applications'])
          .some((flag) => flag.message.includes(`“${letter}”`))).toBe(true);
        expect(checkClaimWording(`${letter}, Python`, [`Built Python applications with ${letter.toLowerCase()}`], { sectionTitle })).toEqual([]);
      }
    },
  );
  it('keeps the approved wording compatibility examples', () => {
    expect(checkClaimWording('Skills: C', ['Built firmware in c'])).toEqual([]);
    expect(checkClaimWording('Achieved grade C in Maths', ['Maths GCSE grade c'])).toEqual([]);
    expect(checkClaimWording('Plan C rollout', ['plan c rollout'])).toEqual([]);
  });
});
