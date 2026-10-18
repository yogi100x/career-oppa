import { sql } from 'drizzle-orm';
import { publicJobDiscoveryJobs } from '@career-workspace/db';

const genericWords = new Set([
  'about', 'across', 'additional', 'also', 'and', 'are', 'build', 'candidate',
  'company', 'experience', 'for', 'from', 'have', 'including', 'into', 'join',
  'looking', 'more', 'our', 'role', 'team', 'the', 'their', 'this', 'through',
  'using', 'we', 'will', 'with', 'you', 'your', 'years', 'work', 'working',
  'skills', 'strong', 'excellent', 'ability', 'required', 'preferred', 'must',
  'job', 'responsibilities', 'requirements', 'opportunity', 'people', 'new',
]);

export const broadRoleWords = new Set([
  'administrator', 'analyst', 'architect', 'associate', 'coordinator',
  'consultant', 'designer', 'director', 'engineer', 'executive', 'head',
  'lead', 'manager', 'officer', 'principal', 'professional', 'specialist',
  'staff', 'senior', 'junior',
]);

export function discoveryKeywords(text: string, minimumLength = 3): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/g) ?? [])
    .map(word => word.replace(/[.-]+$/, ''))
    .filter(word => word.length >= minimumLength && !genericWords.has(word)))];
}

export function matchesTargetRoleTerms(titleTerms: Iterable<string>, targetTerms: string[]) {
  const title = new Set(titleTerms);
  const specificTerms = targetTerms.filter(term => !broadRoleWords.has(term));
  return specificTerms.length
    ? specificTerms.some(term => title.has(term))
    : targetTerms.length > 0 && targetTerms.every(term => title.has(term));
}

export const DISCOVERY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const DISCOVERY_HOST_CONCURRENCY = 6;
export const DISCOVERY_BATCH_SIZE = 18;
export const DISCOVERY_SWEEP_SIZE = 180;
export const DISCOVERY_DATASET_CACHE_MS = 24 * 60 * 60_000;
export const DISCOVERY_FAILURE_LIMIT = 50;
export const DISCOVERY_PROVIDERS = ['greenhouse', 'lever', 'ashby'] as const;

// A title keep-list bounds the shared pool before any full descriptions are stored.
const starterRoles = /\b(software|developer|frontend|front.end|backend|back.end|full.stack|typescript|javascript|python|devops|cloud|platform|infrastructure|sre|site reliability|data|analytics|analyst|product|design|designer|ux|ui|marketing|content|communications|finance|financial|accounting|accountant|operations|graduate|intern|internship|trainee|apprentice|apprenticeship)\b/i;
export function keepDiscoveryTitle(title: string, targetRoles: string[]) {
  if (starterRoles.test(title)) return true;
  const titleTerms = discoveryKeywords(title, 2);
  return targetRoles.some(role =>
    matchesTargetRoleTerms(titleTerms, discoveryKeywords(role, 2)),
  );
}
export function discoveryFreshness(now = new Date()) {
  return sql`coalesce(${publicJobDiscoveryJobs.postedAt}, ${publicJobDiscoveryJobs.firstSeenAt}) >= ${new Date(now.getTime() - DISCOVERY_MAX_AGE_MS)} AND coalesce(${publicJobDiscoveryJobs.postedAt}, ${publicJobDiscoveryJobs.firstSeenAt}) <= ${now} AND ${publicJobDiscoveryJobs.lastSeenAt} >= ${new Date(now.getTime() - DISCOVERY_MAX_AGE_MS)}`;
}
