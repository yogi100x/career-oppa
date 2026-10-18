import type {
  FitScorecard,
  JobSkill,
  JobSkillClassification,
  ResumeContent,
  ResumeReuseAdvice,
} from '@career-workspace/contracts';
import { broadRoleWords, discoveryKeywords } from './discovery-policy';
import { jobTerms, keywordCoverage } from './keyword-coverage';

export type ApprovedResumeFact = { id: string; kind: string; text: string };
type Requirement = Pick<FitScorecard['requirements'][number], 'text' | 'quote' | 'importance' | 'status' | 'fact_ids'>;

export type ClassifyJobSkillsInput = {
  jobText: string;
  jobTitle?: string;
  approvedFacts: ApprovedResumeFact[];
  /** A current fit review is a source of quoted job requirements, never proof of candidate skill. */
  fitRequirements?: Requirement[];
};

const norm = (text: string) => text.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasTerm = (text: string, term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(norm(term))}(?![\\p{L}\\p{N}])`, 'iu').test(norm(text));
const exactTerm = (text: string, term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'u').test(text);
const SAFE_NAMED_SYNONYMS: Record<string, string[]> = {
  '10th': ['ssc', 'class 10', 'class x', 'secondary school certificate', 'gcse'],
  '12th': ['hsc', 'class 12', 'class xii', 'higher secondary', 'a-level', 'a level'],
  cgpa: ['gpa', 'grade point average'],
  'b.tech': ['btech', 'b tech', 'bachelor of technology'],
  bsc: ['b.sc', 'bachelor of science'],
  ba: ['b.a', 'bachelor of arts'],
  msc: ['m.sc', 'master of science'],
  cv: ['resume', 'résumé', 'curriculum vitae'],
};
const namedSpelling = (text: string, term: string) => {
  const matcher = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`,
    'giu',
  );
  for (const match of text.matchAll(matcher)) {
    const before = text.slice(0, match.index);
    if (/[A-Z]/.test(match[0]) && !/(^|[.!?]\s*)$/.test(before)) return match[0];
  }
  return undefined;
};
const requirementIsCondition = (text: string) =>
  /\b(?:visa\s+sponsorship|sponsorship\s+(?:for\s+)?(?:a\s+)?(?:visa|employment)|work authori[sz]ation|right to work|eligible to work|hybrid\s+(?:work|office|schedule|\d)|remote\s+(?:work|role|position|only)|on[- ]?site\s+(?:work|days|attendance)|in[- ]office|relocat(?:e|ion)|commut(?:e|ing))\b/i.test(text);

function isValidQuote(jobText: string, quote: string) {
  return quote.trim().length >= 3 && norm(jobText).includes(norm(quote));
}

function detectedTerms(text: string, exclude: string[] = []) {
  const symbolicSkills = [...text.matchAll(/\bC(?:\+\+|#)(?![\p{L}\p{N}])/giu)].map(match => norm(match[0]));
  return [...new Set([...jobTerms(text, exclude), ...symbolicSkills])].map((skill) => ({
    skill,
    spelling: namedSpelling(text, skill),
  }));
}

function detectedSkills(jobText: string, fitRequirements?: Requirement[], jobTitle = '') {
  const isRoleTitle = (skill: string) => {
    const titleWords = norm(jobTitle).split(/[^a-z0-9+#]+/).filter(Boolean);
    return broadRoleWords.has(norm(skill))
      || (norm(skill) === norm(jobTitle) && titleWords.some((word) => broadRoleWords.has(word)));
  };
  const rows = fitRequirements?.filter((row) =>
    isValidQuote(jobText, row.quote) && !requirementIsCondition(`${row.text} ${row.quote}`),
  );
  if (rows?.length) {
    const result: { skill: string; priority: JobSkill['priority']; quote: string; spelling?: string }[] = [];
    const unclassified: string[] = [];
    for (const row of rows) {
      const terms = detectedTerms(`Requirement ${row.quote}`, ['requirement', 'essential', 'desirable']);
      if (!terms.length) {
        unclassified.push(row.text);
        continue;
      }
      for (const term of terms.filter(({ skill }) => !isRoleTitle(skill))) result.push({
        skill: term.skill,
        priority: row.importance,
        quote: row.quote,
        spelling: term.spelling,
      });
    }
    return { items: dedupeSkills(result), incomplete: result.length === 0 || unclassified.length > 0, unclassified };
  }
  const terms = detectedTerms(jobText).filter(({ skill }) => !isRoleTitle(skill));
  return {
    items: terms.map(({ skill, spelling }) => ({ skill, priority: 'unknown' as const, quote: '', spelling })),
    incomplete: true,
    unclassified: fitRequirements?.filter((row) => isValidQuote(jobText, row.quote)).map((row) => row.text) ?? [],
  };
}

function dedupeSkills<T extends { skill: string; priority: JobSkill['priority']; quote: string }>(items: T[]) {
  const seen = new Map<string, T>();
  for (const item of items) {
    const key = norm(item.skill);
    const old = seen.get(key);
    if (!old || (old.priority !== 'essential' && item.priority === 'essential')) seen.set(key, item);
  }
  return [...seen.values()];
}

function matchingFacts(skill: string, facts: ApprovedResumeFact[], spelling?: string) {
  const candidates = [skill];
  return facts.filter((fact) => fact.text.split(/[;!?\n]|\.(?=\s|$)/).some((sentence) => {
    // A named term in a denial or a future wish is not evidence of current skill.
    if (/\b(?:no (?:experience|knowledge|skills?|background)|never (?:used|learnt|learned|worked)|(?:have not|haven['’]t|has not|hasn['’]t|do not|don['’]t) (?:used?|learnt|learned|know|worked)|(?:want|hope|plan|aim) to (?:learn|study))\b/i.test(sentence)) return false;
    return candidates.some((candidate) => spelling
      ? exactTerm(sentence, spelling) ||
        (SAFE_NAMED_SYNONYMS[norm(candidate)] ?? []).some((synonym) => hasTerm(sentence, synonym))
      : keywordCoverage(`Evidence includes ${candidate.toUpperCase()}`, [sentence]).covered.length > 0
        || hasTerm(sentence, candidate));
  }));
}

/** Categorizes job terms against current approved facts; old fit-review status is never accepted as evidence. */
export function classifyJobSkills(input: ClassifyJobSkillsInput): JobSkillClassification {
  const detected = detectedSkills(input.jobText, input.fitRequirements, input.jobTitle);
  const buckets: JobSkillClassification['buckets'] = { existing: [], supportedByResume: [], gaps: [] };
  for (const item of detected.items) {
    const facts = matchingFacts(item.skill, input.approvedFacts, item.spelling);
    const kind = facts.length === 0 ? 'gap' : facts.some((fact) => fact.kind === 'skill') ? 'existing' : 'supported_by_resume';
    const row: JobSkill = {
      id: `skill:${encodeURIComponent(norm(item.skill))}`,
      skill: item.skill,
      kind,
      priority: item.priority,
      factIds: facts.map((fact) => fact.id),
      ...(item.quote ? { requirementQuote: item.quote } : {}),
    };
    if (kind === 'existing') buckets.existing.push(row);
    else if (kind === 'supported_by_resume') buckets.supportedByResume.push(row);
    else buckets.gaps.push(row);
  }
  for (const list of Object.values(buckets)) list.sort((a, b) =>
    Number(b.priority === 'essential') - Number(a.priority === 'essential') || a.skill.localeCompare(b.skill),
  );
  return {
    buckets,
    incompleteDetection: detected.incomplete || detected.unclassified.length > 0,
    incompleteRequirements: detected.unclassified,
  };
}

const STOP = new Set('a an and are as at be but by for from in into is it of on or the this to with we will you your our'.split(' '));
const MIN_REUSE_TOKENS = 20;
function tokens(text: string) {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}+#./-]+/gu) ?? [])
    .map((token) => token.replace(/^[./-]+|[./-]+$/g, ''))
    .filter((token) => token.length > 1 && !STOP.has(token)));
}
function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  return overlap / (left.size + right.size - overlap);
}

const LEVEL_TERMS = [
  ['intern', 'internship', 'graduate', 'trainee'],
  ['junior', 'entry-level', 'entry level'],
  ['mid-level', 'mid level', 'intermediate'],
  ['senior'],
  ['staff', 'principal'],
] as const;
function level(title: string) {
  const normalized = norm(title);
  const hits = LEVEL_TERMS.flatMap((terms, index) => terms.some((term) => hasTerm(normalized, term)) ? [index] : []);
  return hits.length === 1 ? hits[0] : null;
}

export type CompareJobDescriptionInput = {
  jobText: string;
  priorJobText: string;
  jobTitle?: string;
  priorJobTitle?: string;
};
/** Deterministic recommendation only; it never edits or reuses a resume by itself. */
export function compareJobDescriptionSimilarity(input: CompareJobDescriptionInput): ResumeReuseAdvice {
  const currentTokens = tokens(input.jobText);
  const priorTokens = tokens(input.priorJobText);
  const similarity = jaccard(currentTokens, priorTokens);
  const currentLevel = level(input.jobTitle ?? '');
  const priorLevel = level(input.priorJobTitle ?? '');
  if (currentLevel !== null && priorLevel !== null && currentLevel !== priorLevel)
    return { similarity, action: 'generate', reason: 'seniority_mismatch' };
  if (currentTokens.size < MIN_REUSE_TOKENS || priorTokens.size < MIN_REUSE_TOKENS)
    return { similarity: 0, action: 'generate', reason: 'similarity_low' };
  if (similarity >= 0.72) return { similarity, action: 'reuse', reason: 'similarity_high' };
  if (similarity >= 0.45) return { similarity, action: 'edit', reason: 'similarity_medium' };
  return { similarity, action: 'generate', reason: 'similarity_low' };
}

export type RankResumeContentInput = {
  content: ResumeContent;
  requirements: Array<{ text: string; importance: 'essential' | 'desirable'; status?: string }>;
  matchedSkills: string[];
};
function relevance(text: string, input: RankResumeContentInput) {
  const source = norm(text);
  const essential = input.requirements.filter((row) => row.importance === 'essential').flatMap((row) => discoveryKeywords(row.text, 2));
  const other = input.requirements.filter((row) => row.importance !== 'essential').flatMap((row) => discoveryKeywords(row.text, 2));
  const skills = input.matchedSkills.flatMap((skill) => discoveryKeywords(skill, 2));
  return new Set(essential.filter((word) => hasTerm(source, word))).size * 4
    + new Set(other.filter((word) => hasTerm(source, word))).size
    + new Set(skills.filter((word) => hasTerm(source, word))).size * 2;
}

/** Ranks existing material only. Text, citations and dated-entry chronology are preserved. */
export function rankResumeContentForRole(input: RankResumeContentInput): ResumeContent {
  const matchedSkillTerms = input.matchedSkills.flatMap((skill) => discoveryKeywords(skill, 2));
  const sectionRelevance = (section: ResumeContent['sections'][number]) => relevance(
    `${section.title} ${section.bullets.map((line) => line.text).join(' ')} ${(section.entries ?? []).map((entry) => `${entry.title} ${entry.organisation} ${entry.bullets.map((line) => line.text).join(' ')}`).join(' ')}`,
    input,
  );
  const hasMatchedSkill = (section: ResumeContent['sections'][number]) =>
    section.title === 'Skills' && matchedSkillTerms.some((term) =>
      section.bullets.some((bullet) => hasTerm(bullet.text, term)),
    );
  const indexed = input.content.sections.map((section, index) => ({ section, index }));
  indexed.sort((a, b) => {
    if (a.section.title === 'Summary' && b.section.title !== 'Summary') return -1;
    if (b.section.title === 'Summary' && a.section.title !== 'Summary') return 1;
    const aMatchedSkills = hasMatchedSkill(a.section);
    const bMatchedSkills = hasMatchedSkill(b.section);
    if (aMatchedSkills !== bMatchedSkills) return aMatchedSkills ? -1 : 1;
    return sectionRelevance(b.section) - sectionRelevance(a.section) || a.index - b.index;
  });
  return {
    ...input.content,
    sections: indexed.map(({ section }) => section.title === 'Projects'
      ? { ...section, bullets: [...section.bullets].sort((a, b) => relevance(b.text, input) - relevance(a.text, input)) }
      : section),
  };
}
