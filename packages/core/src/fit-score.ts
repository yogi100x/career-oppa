import type {
  FitReviewRequirement,
  FitScorecard,
} from '@career-workspace/contracts';
import { discoveryKeywords, matchesTargetRoleTerms } from './discovery-policy';

export type CalculateFitScoreInput = {
  requirements: FitReviewRequirement[];
  jobText: string;
  grounding: boolean[];
  /** Approved fact text in the same order as requirements; used to reject unrelated citations. */
  evidenceTexts?: string[][];
  evidenceAvailable: boolean;
  jobTitle: string;
  targetRoles: string[];
};
const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');
const weight = (r: FitReviewRequirement) =>
  r.importance === 'essential' ? 3 : 0.5;
const protectedPattern =
  /\b(age|gender|nationality|citizen(?:ship)?|national origin|ethnicity|race|caste|religion|disability|name|prestige|prestigious|elite university|top[- ]tier university|school ranking)\b/i;

export function conditionKind(
  quote: string,
): 'work_authorisation' | 'location' | 'other' | null {
  if (
    /\b(?:visa\s+(?:sponsorship|sponsor(?:ed|ing)?)|sponsor(?:s|ed|ing)\s+(?:(?:a|the)\s+)?(?:work\s+)?(?:visa|employment visa|work authori[sz]ation)|work authori[sz]ation|right to work|eligible to work|legally authori[sz]ed to work|need(?:s)?\s+(?:visa\s+)?sponsorship|requir(?:e|es|ed|ing)\s+(?:visa\s+)?sponsorship|visa\s+(?:is\s+)?required)\b/i.test(
      quote,
    )
  )
    return 'work_authorisation';
  if (
    /\b(?:hybrid\s+(?:work(?:ing)?|office|schedule|arrangement|attendance)|remote\s+(?:work(?:ing)?|role|position|job|workplace|first|only|arrangement|schedule)|(?:on[- ]site|onsite)\s+(?:work(?:ing)?|role|position|days?|attendance|presence|requirement|schedule)|(?:work|working|office attendance|attendance).{0,35}(?:remote|on[- ]site|onsite|in[- ]office)|in[- ]office|office attendance|relocation\s+(?:required|requirement)|relocate to|commut(?:e|ing)|\d+\s+days?\s+(?:per|in)\s+week)\b/i.test(
      quote,
    )
  )
    return 'location';
  if (
    /\b(?:working hours?|hours of work|shift pattern|shift work|weekend work|start date|available to start|starting date|grade cut[- ]?off|graduation year|graduate(?:d)? in \d{4}|\d{4} graduates?|\d+\+? years?(?:\s+(?:of\s+)?(?:relevant\s+)?(?:work\s+)?experience)?|minimum of \d+ years?)\b/i.test(
      quote,
    )
  )
    return 'other';
  return null;
}

export function hasRequirementEvidenceOverlap(
  text: string,
  evidence: string,
): boolean {
  const stop = new Set([
    'a',
    'an',
    'and',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'in',
    'into',
    'is',
    'of',
    'on',
    'or',
    'the',
    'to',
    'with',
    'years',
    'experience',
    'knowledge',
    'skills',
    'skill',
    'ability',
    'proficiency',
    'familiarity',
    'strong',
    'good',
    'excellent',
    'required',
    'requirements',
  ]);
  const tokens = (value: string) =>
    normalise(value)
      .replace(/[^a-z0-9+#]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !stop.has(t));
  const terms = tokens(text);
  const evidenceTerms = new Set(tokens(evidence));
  // These named skills are also common lowercase words. Preserve their usual
  // product/language capitalization so "excel at teamwork" and "go further"
  // cannot prove Microsoft Excel or Go language experience.
  for (const skill of ['Excel', 'Go']) {
    if (
      terms.includes(skill.toLowerCase()) &&
      !new RegExp(`\\b${skill}\\b`).test(evidence)
    )
      return false;
  }
  return terms.some((term) => evidenceTerms.has(term));
}

function evidenceSupports(
  requirement: FitReviewRequirement,
  evidence: string,
): boolean {
  return (
    hasRequirementEvidenceOverlap(requirement.text, evidence) &&
    hasRequirementEvidenceOverlap(requirement.job_quote, evidence)
  );
}

const priorityNegated = (quote: string) =>
  /\b(?:not|never|optional|without)\s+(?:essential|required|mandatory|necessary|preferred|desirable|helpful|advantageous|a plus|a must)\b|\bmust\s+not\b|\b(?:is|are|was|were)\s+not\s+(?:essential|required|mandatory|necessary|preferred|desirable)\b/i.test(
    quote,
  );
const isExplicitEssential = (quote: string) =>
  !priorityNegated(quote) &&
  /\b(essential|must[- ]have|must|required|minimum|at least|mandatory)\b/i.test(
    quote,
  );
const isExplicitDesirable = (quote: string) =>
  !priorityNegated(quote) &&
  /\b(preferred|desirable|nice to have|a plus|advantageous|helpful|bonus)\b/i.test(
    quote,
  );

export function isVerifiedGap(
  requirement: FitReviewRequirement,
  evidenceAvailable: boolean,
): boolean {
  if (requirement.status !== 'gap' || !evidenceAvailable) return false;
  return requirement.importance === 'essential'
    ? isExplicitEssential(requirement.job_quote)
    : isExplicitDesirable(requirement.job_quote);
}
function targetAlignment(title: string, roles: string[]) {
  if (!title.trim() || !roles.length || roles.every((r) => !r.trim()))
    return { status: 'unknown' as const, matchedRole: null };
  const words = discoveryKeywords(title, 2);
  const matchedRole =
    roles
      .map(clean)
      .find((r) => matchesTargetRoleTerms(words, discoveryKeywords(r, 2))) ??
    null;
  return {
    status: matchedRole ? ('aligned' as const) : ('not_aligned' as const),
    matchedRole,
  };
}
function bandFor(score: number | null): FitScorecard['band'] {
  if (score === null) return 'more_evidence_needed';
  if (score >= 4.5) return 'strong_fit';
  if (score >= 4) return 'worth_a_try';
  if (score >= 3.5) return 'stretch';
  return 'not_now';
}
const literal = (job: string, pattern: RegExp) =>
  pattern.exec(job)?.[0]?.trim() ?? null;

export function calculateFitScore(input: CalculateFitScoreInput): FitScorecard {
  const job = normalise(input.jobText);
  const rows: Array<{
    r: FitReviewRequirement;
    status: 'met' | 'gap' | 'unknown';
    verification: 'verified' | 'unverified' | null;
    ids: string[];
  }> = [];
  const constraints: Array<
    FitScorecard['factors']['constraints'][number] & {
      essential: boolean;
      neutralExcluded?: boolean;
    }
  > = [];
  let invalidQuotes = 0;
  const grouped = new Map<string, number[]>();
  input.requirements.forEach((r, i) => {
    const q = normalise(r.job_quote);
    if (q.length < 3 || !job.includes(q)) {
      invalidQuotes++;
      return;
    }
    if (protectedPattern.test(`${r.text} ${r.job_quote}`)) {
      constraints.push({
        kind: 'other',
        status: 'unknown',
        text: 'Job condition excluded from fit scoring',
        quote: r.job_quote.trim(),
        essential: false,
        neutralExcluded: true,
      });
      return;
    }
    const key = q;
    grouped.set(key, [...(grouped.get(key) ?? []), i]);
  });
  for (const indexes of grouped.values()) {
    const source = indexes.map((i) => input.requirements[i]);
    const first = source[0];
    const kind = conditionKind(first.job_quote);
    const essential = source.some((r) => r.importance === 'essential');
    const statuses = indexes.map((i) => {
      const r = input.requirements[i];
      const cited = (input.evidenceTexts?.[i] ?? []).some((t) =>
        evidenceSupports(r, t),
      );
      if (
        r.status === 'met' &&
        input.grounding[i] &&
        cited &&
        input.evidenceAvailable
      )
        return 'met' as const;
      if (
        isVerifiedGap(
          { ...r, importance: essential ? 'essential' : 'desirable' },
          input.evidenceAvailable,
        )
      )
        return 'gap' as const;
      return 'unknown' as const;
    });
    const status = statuses.includes('gap')
      ? 'gap'
      : statuses.includes('unknown')
        ? 'unknown'
        : 'met';
    if (kind) {
      const flagStatus = source.some((r) => r.status === 'gap')
        ? 'gap'
        : source.some((r) => r.status === 'constraint')
          ? 'unknown'
          : status;
      constraints.push({
        kind,
        status: flagStatus,
        text: source.map((r) => clean(r.text)).join(' / '),
        quote: first.job_quote.trim(),
        essential,
      });
      continue;
    }
    const texts = [...new Set(source.map((r) => clean(r.text)))];
    const r: FitReviewRequirement = {
      ...first,
      text: texts.join(' / '),
      importance: essential ? 'essential' : 'desirable',
      status,
      fact_ids: [],
    };
    const ids =
      status === 'met'
        ? [...new Set(indexes.flatMap((i) => input.requirements[i].fact_ids))]
        : [];
    rows.push({
      r,
      status,
      verification: source.some((x) => x.status === 'gap')
        ? status === 'gap'
          ? 'verified'
          : 'unverified'
        : null,
      ids,
    });
  }
  const assessed = rows;
  const met = assessed.filter((x) => x.status === 'met');
  const gaps = assessed.filter((x) => x.status === 'gap');
  const unknowns = assessed.filter((x) => x.status === 'unknown');
  const essentials = assessed.filter((x) => x.r.importance === 'essential');
  const essentialGaps = gaps.filter((x) => x.r.importance === 'essential');
  const essentialUnknowns = unknowns.filter(
    (x) => x.r.importance === 'essential',
  );
  const essentialConditionCount = constraints.filter((x) => x.essential).length;
  const totalEssential = essentials.length + essentialConditionCount;
  const unknownEssentialCount =
    essentialUnknowns.length +
    constraints.filter((x) => x.essential && x.status === 'unknown').length;
  const denominator = assessed
    .filter((x) => x.status !== 'unknown')
    .reduce((n, x) => n + weight(x.r), 0);
  const metWeight = met.reduce((n, x) => n + weight(x.r), 0);
  const rawScore =
    input.evidenceAvailable && denominator > 0
      ? 1 + (4 * metWeight) / denominator
      : null;
  let score = rawScore;
  let capReason: FitScorecard['capReason'] = null;
  if (score !== null && essentialGaps.length && score > 3.4) {
    score = 3.4;
    capReason = 'essential_gap';
  }
  if (
    score !== null &&
    totalEssential > 0 &&
    unknownEssentialCount > totalEssential / 2 &&
    score > 3.9
  ) {
    score = 3.9;
    capReason ??= 'mostly_unknown_essentials';
  }
  const noEssentialAssessed = essentials.every((x) => x.status === 'unknown');
  if (score !== null && noEssentialAssessed && score > 4.4) {
    score = 4.4;
    capReason ??= 'thin_evidence';
  }
  if (score !== null) score = Math.round(score * 10) / 10;
  const sorted = [...assessed].sort(
    (a, b) =>
      Number(b.r.importance === 'essential') -
      Number(a.r.importance === 'essential'),
  );
  const requirements = sorted.map((x) => ({
    text: x.r.text,
    quote: x.r.job_quote.trim(),
    importance: x.r.importance,
    status: x.status,
    gapVerification: x.verification,
    fact_ids: x.status === 'met' ? x.ids : [],
    nominalWeight: weight(x.r),
    weight: x.status === 'unknown' ? 0 : weight(x.r),
    contribution:
      x.status === 'met' && denominator > 0
        ? (4 * weight(x.r)) / denominator
        : 0,
  }));
  const alignment = targetAlignment(input.jobTitle, input.targetRoles);
  const compensation = literal(
    input.jobText,
    /(?:salary|compensation|pay range|CTC|INR)[^.!?\n]{0,100}|₹\s?\d[\d,.]*(?:\s?(?:lakh|lakhs|LPA|crore))?|£\s?\d[\d,]*(?:\s?[-–]\s?£?\s?\d[\d,]*)?|\$\s?\d[\d,]*(?:\s?[-–]\s?\$?\s?\d[\d,]*)?|€\s?\d[\d,.]*(?:\s?[-–]\s?€?\s?\d[\d,.]*)?/i,
  );
  const culture = literal(
    input.jobText,
    /(?:remote[- ]first|fully remote|hybrid\s+(?:working|work|office|schedule|arrangement)|on[- ]site|in[- ]office|distributed team|small team|team of \d+|fast[- ]paced|collaborative culture|professional development|learning and development)/i,
  );
  const cvStatus =
    !input.evidenceAvailable ||
    !assessed.length ||
    unknowns.length === assessed.length
      ? 'unknown'
      : unknowns.length
        ? 'partial'
        : 'supported';
  const evidence: FitScorecard['evidence'] = {
    cvMatch: cvStatus,
    targetRoleAlignment:
      alignment.status === 'unknown'
        ? 'unknown'
        : alignment.status === 'aligned'
          ? 'supported'
          : 'partial',
    compensation: compensation ? 'supported' : 'unknown',
    culture: culture ? 'supported' : 'unknown',
    redFlags: invalidQuotes ? 'partial' : 'unknown',
  };
  const unresolved = constraints.filter(
    (c) => !c.neutralExcluded && c.status !== 'met',
  );
  const majorityUnknown =
    totalEssential > 0 && unknownEssentialCount > totalEssential / 2;
  const confidence: FitScorecard['confidence'] =
    cvStatus === 'unknown' ||
    alignment.status === 'unknown' ||
    unresolved.length ||
    majorityUnknown ||
    noEssentialAssessed
      ? 'low'
      : Object.values(evidence).every((x) => x === 'supported')
        ? 'high'
        : Object.values(evidence).filter((x) => x === 'unknown').length >= 2
          ? 'low'
          : 'medium';
  const checks: string[] = [];
  for (const c of unresolved)
    checks.push(
      `Confirm ${c.kind === 'work_authorisation' ? 'work eligibility' : c.kind === 'location' ? 'location fit' : 'this condition'}: ${c.text} (job quote: “${c.quote}”).`,
    );
  for (const x of [...essentialGaps, ...essentialUnknowns])
    checks.push(
      `${x.status === 'gap' ? 'Review' : 'Confirm'} essential requirement: ${x.r.text} (job quote: “${x.r.job_quote.trim()}”).`,
    );
  for (const x of [...gaps, ...unknowns].filter(
    (x) => x.r.importance === 'desirable',
  ))
    checks.push(
      `${x.status === 'gap' ? 'Review' : 'Confirm'} desirable requirement: ${x.r.text} (job quote: “${x.r.job_quote.trim()}”).`,
    );
  if (invalidQuotes)
    checks.push(
      'Review the job text because some requirement quotes could not be verified.',
    );
  if (alignment.status === 'unknown')
    checks.push('Add your target roles to check how this title aligns.');
  if (alignment.status === 'not_aligned')
    checks.push(
      'Check whether this role fits your goals despite not matching a listed target role.',
    );
  if (!compensation)
    checks.push('Check the compensation range with the employer.');
  if (!culture)
    checks.push('Ask about team structure and working arrangements.');
  const uniqueChecks = [...new Set(checks)].slice(0, 3);
  const unwork = unresolved.find((c) => c.kind === 'work_authorisation');
  const unloc = unresolved.find((c) => c.kind === 'location');
  const essentialGap = essentialGaps[0],
    essentialUnknown = essentialUnknowns[0];
  const nextAction = !rawScore
    ? 'Add or confirm approved experience evidence before relying on a numeric score.'
    : unwork
      ? `Confirm work eligibility: ${unwork.text} (job quote: “${unwork.quote}”).`
      : unloc
        ? `Confirm location fit: ${unloc.text} (job quote: “${unloc.quote}”).`
        : essentialGap
          ? `Review the essential gap: ${essentialGap.r.text} (job quote: “${essentialGap.r.job_quote.trim()}”).`
          : essentialUnknown
            ? `Confirm evidence for the essential requirement: ${essentialUnknown.r.text} (job quote: “${essentialUnknown.r.job_quote.trim()}”).`
            : alignment.status !== 'aligned'
              ? 'Check whether this role fits your target roles before preparing a CV.'
              : 'Prepare a role-specific CV using the confirmed matches shown here.';
  return {
    score,
    band: bandFor(score),
    rawScore,
    capReason,
    confidence,
    nextAction,
    requirements,
    factors: {
      cvMatch: {
        met: met.length,
        total: assessed.length,
        unknown: unknowns.length,
        weightedMet: metWeight,
        weightedTotal: denominator,
      },
      targetRoleAlignment: alignment,
      compensation: {
        status: compensation ? 'stated' : 'not_stated',
        evidence: compensation,
      },
      culture: { status: culture ? 'stated' : 'not_stated', evidence: culture },
      constraints: constraints.map(
        ({ essential: _e, neutralExcluded: _n, ...c }) => c,
      ),
    },
    checks: uniqueChecks,
    matched: sorted
      .filter((x) => x.status === 'met')
      .slice(0, 3)
      .map((x) => x.r.text),
    gaps: sorted
      .filter((x) => x.status === 'gap')
      .slice(0, 3)
      .map((x) => x.r.text),
    evidence,
  };
}
