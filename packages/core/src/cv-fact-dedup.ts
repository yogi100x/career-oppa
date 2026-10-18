export type CvFactForDedup = {
  kind: string;
  text: string;
  organisation?: string | null;
  role?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  id?: string;
  status?: string;
};

export function normalizeCvFactText(value: string): string {
  return (
    value
      .normalize('NFKC')
      .toLowerCase()
      // Preserve these language markers before punctuation is removed.
      .replace(/\bc\+\+/giu, ' cplusplus ')
      .replace(/\bc#/giu, ' csharp ')
      // Keep percentages distinct from bare quantities. Accept either decimal
      // separator, which is commonly used across CV locales.
      .replace(
        /(\d+)(?:[.,](\d+))?\s*%/gu,
        (_match, whole: string, fraction?: string) =>
          `${whole}${fraction ? `.${fraction}` : ''} percent`,
      )
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  );
}

const negations = new Set([
  'no',
  'not',
  'never',
  'without',
  'cannot',
  'can',
  'unable',
  'unavailable',
  'none',
  'neither',
  'nor',
]);
const months = new Set([
  'jan',
  'january',
  'feb',
  'february',
  'mar',
  'march',
  'apr',
  'april',
  'may',
  'jun',
  'june',
  'jul',
  'july',
  'aug',
  'august',
  'sep',
  'sept',
  'september',
  'oct',
  'october',
  'nov',
  'november',
  'dec',
  'december',
]);
const numberWords = new Set([
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
  'hundred',
  'thousand',
  'million',
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'dozen',
  'half',
]);
const seasons = new Set(['spring', 'summer', 'autumn', 'fall', 'winter']);
// One of these words changes what a fact claims, so it must match exactly.
const qualifiers = new Set([
  'expected',
  'predicted',
  'pending',
  'ongoing',
  'acting',
  'interim',
  'junior',
  'assistant',
  'co',
]);
const tokens = (value: string) =>
  normalizeCvFactText(value).split(' ').filter(Boolean);

function protectedTokens(value: string): string[] {
  const parts =
    value.normalize('NFKC').match(/c\+\+|c#|[\p{L}\p{N}]+/giu) ?? [];
  const protectedValues: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (
      lower === 'c++' ||
      lower === 'c#' ||
      /\d/u.test(part) ||
      negations.has(lower) ||
      months.has(lower) ||
      numberWords.has(lower) ||
      seasons.has(lower) ||
      qualifiers.has(lower) ||
      /^[A-Z][\p{L}\p{N}]*$/u.test(part)
    ) {
      protectedValues.push(lower);
    }
  }
  return protectedValues;
}

function numericSignature(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .match(/(?<![\p{L}\p{N}])[+-]?\d+(?:[.,]\d+)*(?:\s*%|\s*\+)?/gu) ?? []
  ).map((number) => number.replace(/\s+/gu, ''));
}

function structuredConflict(
  left: CvFactForDedup,
  right: CvFactForDedup,
): boolean {
  for (const field of [
    'organisation',
    'role',
    'startDate',
    'endDate',
  ] as const) {
    const a = normalizeCvFactText(left[field] ?? '');
    const b = normalizeCvFactText(right[field] ?? '');
    // Role keeps the old rule; a one-sided employer or date keeps the CV fact.
    if (field === 'role' ? a && b && a !== b : a !== b) return true;
  }
  return false;
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / union.size;
}

/** Pairwise check; protected details must match before fuzzy text comparison. */
export function isDuplicateCvFact(
  candidate: CvFactForDedup,
  existing: CvFactForDedup,
): boolean {
  if (
    candidate.kind !== existing.kind ||
    structuredConflict(candidate, existing)
  )
    return false;
  const left = normalizeCvFactText(candidate.text);
  const right = normalizeCvFactText(existing.text);
  if (!left || !right) return false;
  if (
    JSON.stringify(numericSignature(candidate.text)) !==
    JSON.stringify(numericSignature(existing.text))
  )
    return false;
  if (left === right) return true;
  if (
    JSON.stringify(protectedTokens(candidate.text)) !==
    JSON.stringify(protectedTokens(existing.text))
  )
    return false;
  return jaccard(tokens(candidate.text), tokens(existing.text)) >= 0.9;
}

export function deduplicateCvFacts<T extends CvFactForDedup>(
  candidates: T[],
  existing: CvFactForDedup[],
): { newFacts: T[]; duplicateFactCount: number; duplicateFactIds: string[] } {
  const newFacts: T[] = [];
  const seen: CvFactForDedup[] = [...existing];
  let duplicateFactCount = 0;
  const duplicateFactIds = new Set<string>();
  for (const candidate of candidates) {
    const duplicate = seen.find((fact) => isDuplicateCvFact(candidate, fact));
    if (duplicate) {
      duplicateFactCount += 1;
      if (duplicate.id && duplicate.status !== 'rejected')
        duplicateFactIds.add(duplicate.id);
    } else {
      newFacts.push(candidate);
      seen.push(candidate);
    }
  }
  return {
    newFacts,
    duplicateFactCount,
    duplicateFactIds: [...duplicateFactIds],
  };
}
