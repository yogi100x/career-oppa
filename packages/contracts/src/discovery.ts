import { z } from 'zod';
import { fitScoreBandSchema } from './fit-score';

export const DISCOVERY_MIN_ACTIVE_JOBS = 50;

export const discoveryProviderSchema = z.enum(['greenhouse', 'lever', 'ashby']);
export type DiscoveryProvider = z.infer<typeof discoveryProviderSchema>;
export const discoveredJobSchema = z.object({
  id: z.uuid(),
  sourceId: z.string(),
  provider: discoveryProviderSchema,
  externalId: z.string(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  workMode: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
  url: z.url(),
  text: z.string(),
  postedAt: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  active: z.boolean(),
});
export type DiscoveredJob = z.infer<typeof discoveredJobSchema>;
export const discoveryMatchSchema = z.object({
  job: discoveredJobSchema,
  matchedTerms: z.array(z.string()),
  factIds: z.array(z.uuid()),
  reasons: z.array(z.string()),
  savedOpportunityId: z.uuid().nullable(),
  fitBand: fitScoreBandSchema.nullable().optional(),
});
export type DiscoveryMatch = z.infer<typeof discoveryMatchSchema>;
export const discoverySourceStatusSchema = z.object({
  id: z.string(),
  provider: discoveryProviderSchema,
  company: z.string(),
  board: z.string(),
  status: z.enum(['idle', 'running', 'succeeded', 'failed']),
  lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  error: z.string().nullable(),
  activeJobCount: z.number().int().nonnegative(),
  verifiedAt: z.string().nullable().optional(),
  deadUntilAt: z.string().nullable().optional(),
  nextRetryAt: z.string().nullable().optional(),
  failureCount: z.number().int().nonnegative().optional(),
});
export const discoveryCollectionSchema = z.object({
  catalogBoards: z.number().int().nonnegative(),
  verifiedBoards: z.number().int().nonnegative(),
  deadBoards: z.number().int().nonnegative(),
  refusedBoards: z.number().int().nonnegative(),
  datasetFetchedAt: z.string().nullable(),
  datasetError: z.string().nullable(),
  cursor: z.number().int().nonnegative(),
});
export const discoveryFeedSchema = z.object({
  profileReady: z.boolean(),
  targetRoles: z.array(z.string()),
  matches: z.array(discoveryMatchSchema),
  sources: z.array(discoverySourceStatusSchema),
  totalActiveJobs: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
  sourceTotal: z.number().int().nonnegative().optional(),
  collection: discoveryCollectionSchema.optional(),
});
export type DiscoveryFeed = z.infer<typeof discoveryFeedSchema>;
