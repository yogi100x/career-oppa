import { describe, expect, it } from 'vitest';
import {
  tailoredCvDraftSchema,
  approveResumeSchema,
  hasValidResumeContact,
  initialResumeDraftKey,
  resumeClaims,
  resumeContentSchema,
  resumeEntryHeader,
  resumeFileName,
  sortResumeEntries,
} from './resumes';

describe('resume header approval contract', () => {
  it('allows an empty header on a draft so the user can enter it', () => {
    expect(
      resumeContentSchema.safeParse({
        name: '',
        contact: '',
        sections: [
          {
            title: 'Experience',
            bullets: [{ text: 'A claim.', fact_ids: [] }],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('requires separate confirmation for the user-entered header', () => {
    expect(
      approveResumeSchema.safeParse({ confirmedFactPairs: true }).success,
    ).toBe(false);
    expect(
      approveResumeSchema.safeParse({
        confirmedFactPairs: true,
        confirmedHeader: false,
      }).success,
    ).toBe(false);
    expect(
      approveResumeSchema.parse({
        confirmedFactPairs: true,
        confirmedHeader: true,
      }),
    ).toEqual({
      confirmedFactPairs: true,
      confirmedHeader: true,
      pageSize: 'A4',
    });
  });
});

describe('resume contact validation', () => {
  it('accepts an email embedded in a contact line', () => {
    expect(
      hasValidResumeContact('jane@example.com · linkedin.com/in/jane'),
    ).toBe(true);
  });

  it('accepts a phone number with at least eight digits', () => {
    expect(hasValidResumeContact('+44 (0) 7911 123456')).toBe(true);
    expect(hasValidResumeContact('12345678')).toBe(true);
  });

  it.each([
    '',
    '1234567',
    'Leeds 2019-2023',
    'Worked there from 2019 to 2023',
    '2020–2024',
  ])('rejects a contact line without an email or valid phone: %s', (value) => {
    expect(hasValidResumeContact(value)).toBe(false);
  });
});

describe('CV download file name', () => {
  it.each([
    ['Jane Doe', 'Jane-Doe-CV.pdf'],
    ['  Ananya Śrīnivās ', 'Ananya-Srinivas-CV.pdf'],
    ['Małgorzata O’Neil', 'Malgorzata-O-Neil-CV.pdf'],
    ['अनन्या', 'CV.pdf'],
    ['', 'CV.pdf'],
  ])('names %s as %s', (name, expected) => {
    expect(resumeFileName(name)).toBe(expected);
  });
});

describe('drafted CV shape', () => {
  const draft = {
    name: '',
    contact: '',
    sections: [
      {
        title: 'Education',
        bullets: [
          {
            text: 'BSc Computer Science, predicted 2:1',
            fact_ids: ['00000000-0000-4000-8000-000000000001'],
          },
        ],
        entries: [],
      },
    ],
    notes_for_candidate: ['Add your A-level grades if you have them.'],
    left_out: [],
  };

  it('keeps model notes outside the CV sections', () => {
    expect(tailoredCvDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('rejects a free-text section such as a note or gaps heading', () => {
    expect(
      tailoredCvDraftSchema.safeParse({
        ...draft,
        sections: [
          {
            title: 'Note for Candidate Review',
            bullets: [{ text: 'Check this.', fact_ids: [] }],
            entries: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('still accepts an older stored CV without notes', () => {
    const older = {
      name: '',
      contact: '',
      sections: [{ title: 'Education', bullets: draft.sections[0].bullets }],
    };
    expect(resumeContentSchema.safeParse(older).success).toBe(true);
  });

  it('orders dated entries newest first and lists every checkable line', () => {
    const fact = ['00000000-0000-4000-8000-000000000002'];
    const content = sortResumeEntries({
      name: '',
      contact: '',
      sections: [
        {
          title: 'Experience',
          bullets: [],
          entries: [
            {
              title: 'Tutor',
              organisation: 'Kumon',
              start: 'Jan 2021',
              end: 'Dec 2021',
              fact_ids: fact,
              bullets: [],
            },
            {
              title: 'Intern',
              organisation: 'Acme Ltd',
              start: 'Jun 2023',
              end: 'Present',
              fact_ids: fact,
              bullets: [{ text: 'Drafted posts', fact_ids: fact }],
            },
            {
              title: 'Barista',
              organisation: 'Costa',
              start: 'Sep 2022',
              end: 'May 2023',
              fact_ids: fact,
              bullets: [],
            },
          ],
        },
      ],
    });
    expect(content.sections[0].entries!.map((entry) => entry.title)).toEqual([
      'Intern',
      'Barista',
      'Tutor',
    ]);
    expect(resumeClaims(content).map((claim) => claim.text)).toEqual([
      'Intern, Acme Ltd, Jun 2023 – Present',
      'Drafted posts',
      'Barista, Costa, Sep 2022 – May 2023',
      'Tutor, Kumon, Jan 2021 – Dec 2021',
    ]);
    expect(resumeClaims(content).map((claim) => claim.sectionTitle)).toEqual([
      'Experience',
      'Experience',
      'Experience',
      'Experience',
    ]);
    expect(
      resumeEntryHeader({
        ...content.sections[0].entries![0],
        start: '',
        end: '',
      }),
    ).toBe('Intern, Acme Ltd');
  });

  it('rejects a section with no lines at all', () => {
    expect(
      resumeContentSchema.safeParse({
        name: '',
        contact: '',
        sections: [{ title: 'Experience', bullets: [], entries: [] }],
      }).success,
    ).toBe(false);
  });
});

describe('initial resume draft request key', () => {
  it('reuses one key for retries and reloads on the same role', () => {
    expect(initialResumeDraftKey('role-123')).toBe('prepare:role-123');
    expect(initialResumeDraftKey('role-123')).toBe(
      initialResumeDraftKey('role-123'),
    );
  });

  it('keeps first-draft keys separate across roles', () => {
    expect(initialResumeDraftKey('role-123')).not.toBe(
      initialResumeDraftKey('role-456'),
    );
  });
});
