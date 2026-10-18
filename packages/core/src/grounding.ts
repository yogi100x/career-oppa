import { and, eq, inArray } from 'drizzle-orm';
import {
  getDatabase,
  profileFacts,
  type Database,
  type ProfileFact,
  type Transaction,
} from '@career-workspace/db';

export type GroundingClaim = {
  id?: string;
  text: string;
  fact_ids?: string[];
  /** A dated entry header: every word must come from the cited facts. */
  header?: boolean;
  /** The containing CV section, used to resolve single-letter skill names. */
  sectionTitle?: string;
};

export type GroundingFlagCode =
  | 'NO_CLAIMS'
  | 'NO_FACT_REFERENCES'
  | 'FACT_NOT_FOUND_OR_NOT_OWNED'
  | 'FACT_NOT_APPROVED'
  | 'DETAIL_NOT_IN_FACT'
  | 'LEVEL_NOT_IN_FACT';

export type GroundingFlag = {
  code: GroundingFlagCode;
  message: string;
  factId?: string;
};

export type GroundingItem = {
  id?: string;
  text: string;
  fact_ids: string[];
  grounded: boolean;
  flags: GroundingFlag[];
  approvedFacts: Array<Pick<ProfileFact, 'id' | 'text'>>;
};

export type GroundingResult = {
  canApprove: boolean;
  flags: GroundingFlag[];
  items: GroundingItem[];
};

/**
 * Checks that every claim cites at least one existing, user-owned, approved
 * fact. With checkWording, it also checks the claim's details and level words
 * against the cited facts (see checkClaimWording).
 */
export async function checkGrounding(
  userId: string,
  claims: GroundingClaim[],
  database: Database | Transaction = getDatabase(),
  options: { lockFacts?: boolean; checkWording?: boolean } = {},
): Promise<GroundingResult> {
  const allFactIds = [
    ...new Set(claims.flatMap((claim) => claim.fact_ids ?? [])),
  ];
  const validFactIds = allFactIds.filter((id) => UUID_PATTERN.test(id));
  const factQuery = validFactIds.length
    ? database
        .select({
          id: profileFacts.id,
          text: profileFacts.text,
          status: profileFacts.status,
          organisation: profileFacts.organisation,
          role: profileFacts.role,
          startDate: profileFacts.startDate,
          endDate: profileFacts.endDate,
        })
        .from(profileFacts)
        .where(
          and(
            eq(profileFacts.userId, userId),
            inArray(profileFacts.id, validFactIds),
          ),
        )
    : null;
  const facts = factQuery
    ? await (options.lockFacts ? factQuery.for('update') : factQuery)
    : [];
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const resultFlags: GroundingFlag[] = claims.length
    ? []
    : [
        {
          code: 'NO_CLAIMS',
          message: 'Add at least one claim before approval.',
        },
      ];

  const items = claims.map((claim): GroundingItem => {
    const references = [...new Set(claim.fact_ids ?? [])];
    const flags: GroundingFlag[] = [];
    const approvedFacts: GroundingItem['approvedFacts'] = [];

    if (references.length === 0) {
      flags.push({
        code: 'NO_FACT_REFERENCES',
        message: 'Add at least one approved fact for this claim.',
      });
    }

    for (const factId of references) {
      const fact = factById.get(factId);
      if (!fact) {
        flags.push({
          code: 'FACT_NOT_FOUND_OR_NOT_OWNED',
          message: 'This fact is missing or does not belong to this account.',
          factId,
        });
      } else if (fact.status !== 'approved') {
        flags.push({
          code: 'FACT_NOT_APPROVED',
          message: 'Approve this fact before using it in a claim.',
          factId,
        });
      } else {
        approvedFacts.push({ id: fact.id, text: fact.text });
      }
    }
    if (options.checkWording && flags.length === 0)
      flags.push(
        ...checkClaimWording(
          claim.text,
          // Extracted role, organisation and dates count as fact wording too.
          approvedFacts.map((approved) => {
            const fact = factById.get(approved.id)!;
            return [
              fact.text,
              fact.role,
              fact.organisation,
              fact.startDate,
              fact.endDate,
            ]
              .filter(Boolean)
              .join(' · ');
          }),
          { header: claim.header, sectionTitle: claim.sectionTitle },
        ),
      );

    return {
      ...(claim.id === undefined ? {} : { id: claim.id }),
      text: claim.text,
      fact_ids: references,
      grounded: flags.length === 0,
      flags,
      approvedFacts,
    };
  });

  return {
    canApprove:
      resultFlags.length === 0 && items.every((item) => item.grounded),
    flags: resultFlags,
    items,
  };
}

// Words that raise ownership, level or seniority. Each needs a word from the
// same family in a cited fact (delegation versus authorship).
const LEVEL_FAMILIES = [
  ['led', 'lead', 'leads', 'leading', 'leader', 'leadership'],
  ['managed', 'manage', 'manages', 'managing', 'manager', 'management'],
  ['founded', 'founder', 'co-founded', 'cofounded', 'founding'],
  ['owned', 'own', 'owns', 'owner', 'ownership'],
  ['built', 'build', 'builds', 'building'],
  ['expert', 'expertise'],
  ['fluent', 'fluency', 'fluently'],
  ['senior'],
];
const CURRENCY = [
  ['₹', ['₹', 'inr', 'rs', 'rupee', 'lakh', 'crore']],
  ['£', ['£', 'gbp', 'pound']],
  ['$', ['$', 'usd', 'dollar']],
  ['€', ['€', 'eur', 'euro']],
] as const;

const plain = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\d),(?=\d)/g, '$1');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const HEADER_STOP_WORDS = new Set(
  'a an and at for in of on the to with present current'.split(' '),
);
const CASE_SENSITIVE_SKILLS = new Set([
  'excel',
  'go',
  'swift',
  'spark',
  'rust',
]);
const NAMED_SKILLS = new Set([
  ...CASE_SENSITIVE_SKILLS,
  'c',
  'r',
  'python',
  'java',
  'javascript',
  'typescript',
  'sql',
  'aws',
  'c++',
  'c#',
]);
const exactWord = (text: string, word: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}($|[^\\p{L}\\p{N}])`, 'u').test(
    text,
  );
const hasWord = (text: string, word: string): boolean => {
  if (exactWord(text, word)) return true;
  // "Jun", "June" and "Sept" name the same month as their other forms.
  const month =
    word.length >= 3 ? MONTHS.find((name) => name.startsWith(word)) : undefined;
  return Boolean(
    month &&
    [month, month.slice(0, 3), month.slice(0, 4)].some((form) =>
      exactWord(text, form),
    ),
  );
};

/**
 * Checks claim wording against the cited facts: every number, money amount,
 * date and capitalised name must appear in a cited fact, and level words such
 * as "led" or "expert" need the same word family there. Returns one flag per
 * unsupported detail with a reason the candidate can act on.
 */
export function checkClaimWording(
  claim: string,
  factTexts: string[],
  options: { header?: boolean; sectionTitle?: string } = {},
): GroundingFlag[] {
  const facts = plain(factTexts.join(' \n '));
  const text = plain(claim);
  const missing = new Set<string>();
  const flags: GroundingFlag[] = [];

  // A role header (title, organisation, dates) must come from the facts word
  // for word, like a title check: no promoted titles or renamed employers.
  if (options.header)
    for (const [word] of text.matchAll(/[\p{L}][\p{L}'’.&+-]*/gu))
      if (
        !HEADER_STOP_WORDS.has(word) &&
        word.length > 1 &&
        !hasWord(facts, word.replace(/[.’']+$/, ''))
      )
        missing.add(word);

  for (const [number] of text.matchAll(/\d+(?:\.\d+)?/g))
    if (!new RegExp(`(^|[^\\d.])${escape(number)}(?!\\d)`).test(facts))
      missing.add(number);
  for (const [symbol, words] of CURRENCY)
    if (claim.includes(symbol) && !words.some((word) => facts.includes(word)))
      missing.add(symbol);
  // Capitalised words, skipping the first word of each sentence.
  for (const match of claim.matchAll(/\p{Lu}[\p{L}\p{N}&'’.+#-]*/gu)) {
    const before = claim.slice(0, match.index).trimEnd();
    const word = plain(match[0]).replace(/[.’']+$/, '');
    const sectionIsSkills = /\b(?:skills?|languages|technologies|tools|competenc(?:y|ies))\b/i.test(options.sectionTitle ?? '');
    const hasSkillsLabel = /\b(?:skills?|languages|technologies|tools|competenc(?:y|ies))\s*:\s*[^!?]*$/i.test(
      claim.slice(0, match.index),
    );
    const isSingleLetterSkill = word === 'c' || word === 'r';
    const isSkillsContext = sectionIsSkills || hasSkillsLabel;
    if (isSingleLetterSkill && !isSkillsContext) continue;
    const isCaseSensitiveSkill = CASE_SENSITIVE_SKILLS.has(word);
    const isNamedSkill = NAMED_SKILLS.has(word);
    const isMonth = word.length >= 3 && MONTHS.some((month) => month.startsWith(word));
    if ((!before || /[.!?•]$/.test(before)) && !isNamedSkill) continue;
    // A short group label such as "Programming Languages:" is not a claim.
    if (/^[^:.]{1,40}:/.test(claim) && match.index! < claim.indexOf(':'))
      continue;
    const present = isMonth
      ? hasWord(facts, word)
      : isCaseSensitiveSkill
        ? new RegExp(
            `(^|[^\\p{L}\\p{N}])${escape(match[0].replace(/[.’']+$/, ''))}($|[^\\p{L}\\p{N}])`,
            'u',
          ).test(factTexts.join(' \n '))
        : hasWord(facts, word);
    if ((word.length > 1 || isNamedSkill) && !present) missing.add(match[0]);
  }
  for (const detail of missing)
    flags.push({
      code: 'DETAIL_NOT_IN_FACT',
      message: `“${detail}” does not appear in the cited fact. Remove it or cite a fact that says it.`,
    });

  for (const family of LEVEL_FAMILIES) {
    const used = family.find((word) => hasWord(text, word));
    if (used && !family.some((word) => hasWord(facts, word)))
      flags.push({
        code: 'LEVEL_NOT_IN_FACT',
        message: `“${used}” claims more than the cited fact says. Use the fact’s own wording.`,
      });
  }
  // A predicted or expected result must not read as achieved.
  for (const qualifier of ['predicted', 'expected', 'pursuing'])
    if (hasWord(facts, qualifier) && !hasWord(text, qualifier))
      flags.push({
        code: 'LEVEL_NOT_IN_FACT',
        message: `The cited fact says “${qualifier}”. Keep that word so the line does not read as already achieved.`,
      });
  return flags;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
