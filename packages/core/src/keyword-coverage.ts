/**
 * Diagnostic only: which of the job's terms the CV's cited facts already show.
 * It never edits a CV or suggests adding a term the facts do not support.
 */

// Interchangeable forms, including UK and India conventions.
const SYNONYMS = [
  ['cv', 'resume', 'résumé', 'curriculum vitae'],
  [
    '10th',
    'ssc',
    'class 10',
    'class x',
    'secondary school certificate',
    'gcse',
  ],
  [
    '12th',
    'hsc',
    'class 12',
    'class xii',
    'higher secondary',
    'a-level',
    'a level',
  ],
  ['cgpa', 'gpa', 'grade point average'],
  ['b.tech', 'btech', 'b tech', 'bachelor of technology'],
  ['bsc', 'b.sc', 'bachelor of science'],
  ['ba', 'b.a', 'bachelor of arts'],
  ['msc', 'm.sc', 'master of science'],
  ['javascript', 'js'],
  ['typescript', 'ts'],
  ['excel', 'spreadsheet', 'spreadsheets'],
  ['powerpoint', 'presentation', 'presentations'],
  ['postgresql', 'postgres'],
  ['machine learning', 'ml'],
  ['amazon web services', 'aws'],
  ['customer service', 'customer support', 'customer-facing'],
];

// Lower-case skill phrases worth tracking when a job mentions them.
const COMMON_SKILLS = [
  'communication',
  'teamwork',
  'problem solving',
  'problem-solving',
  'data analysis',
  'customer service',
  'stakeholder',
  'project management',
  'spreadsheet',
  'research',
  'presentation',
  'writing',
  'sales',
  'marketing',
  'budgeting',
  'scheduling',
  'coding',
  'programming',
  'testing',
  'design',
  'analytics',
  'accounting',
  'teaching',
  'tutoring',
  'mentoring',
];

const IGNORED = new Set(
  (
    'a an and are as at be by for from in is it of on or our the this to we will with you your ' +
    'about all also any apply applicant applicants candidate candidates company day days role roles job jobs ' +
    'team teams work working must should may can able experience year years month months week weeks ' +
    'january february march april may june july august september october november december ' +
    'monday tuesday wednesday thursday friday saturday sunday uk india ltd limited plc inc llp ' +
    'essential desirable required preferred responsibilities requirements about benefits salary'
  ).split(' '),
);

const normal = (value: string) =>
  value.toLowerCase().replace(/\s+/g, ' ').trim();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (text: string, term: string) =>
  new RegExp(`(?<![a-z0-9])${escape(term)}(?![a-z0-9])`).test(text);
const forms = (term: string) =>
  SYNONYMS.find((group) => group.includes(term)) ?? [term];

/** Picks up to 20 terms from the job: names, acronyms, grades and common skills. */
export function jobTerms(jobText: string, exclude: string[] = []): string[] {
  const skip = new Set([
    ...IGNORED,
    ...exclude.flatMap((value) => normal(value).split(/[^a-z0-9.+#-]+/)),
  ]);
  const counts = new Map<string, number>();
  const add = (term: string) => {
    const key = normal(term).replace(/[.,;:]+$/, '');
    if (key.length < 2 || skip.has(key)) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  // Capitalised names and acronyms ("Power BI", "SQL"), skipping the word
  // that only starts a sentence.
  // ponytail: a sentence-initial skill ("Excel is a plus") is missed; an
  // AI-extracted keyword list would catch it if this proves too narrow.
  const word = '(?:[A-Z][A-Za-z0-9+#.]*[A-Za-z0-9+#]|[A-Z]{2,})';
  for (const match of jobText.matchAll(
    new RegExp(`(?<![.!?\\n]\\s)(?<!^)\\b${word}(?: ${word})*\\b`, 'g'),
  ))
    add(match[0]);
  // Grades and school levels such as 10th, 12th, 2:1, 60%.
  for (const match of jobText.matchAll(/\b(?:10th|12th|\d:\d|\d{2}%)/gi))
    add(match[0]);
  const lower = normal(jobText);
  for (const skill of COMMON_SKILLS) if (has(lower, skill)) add(skill);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([term]) => term);
}

export function keywordCoverage(
  jobText: string,
  citedFactTexts: string[],
  exclude: string[] = [],
) {
  const facts = normal(citedFactTexts.join(' \n '));
  const covered: string[] = [];
  const notEvidenced: string[] = [];
  for (const term of jobTerms(jobText, exclude))
    (forms(term).some((form) => has(facts, form))
      ? covered
      : notEvidenced
    ).push(term);
  return { covered, notEvidenced };
}
