import { z } from 'zod';

export const profileFactKind = z.enum([
  'experience',
  'skill',
  'education',
  'achievement',
  'certification',
  'project',
  'volunteering',
  'responsibility',
  'language',
  'eligibility',
]);
export const profileFactSource = z.enum(['cv', 'user', 'chat', 'project']);
export const profileFactStatus = z.enum(['proposed', 'approved', 'rejected']);
export const createProfileFact = z
  .object({ kind: profileFactKind, text: z.string().trim().min(1).max(10_000) })
  .strict();

export const profileFact = z.object({
  id: z.uuid(),
  kind: profileFactKind,
  text: z.string(),
  organisation: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  sourceQuote: z.string().nullable().optional(),
  source: profileFactSource,
  status: profileFactStatus,
  sourceFileId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const listProfileFacts = z.object({ facts: z.array(profileFact) });

export const patchProfileFact = z
  .object({
    text: z.string().trim().min(1).max(10_000).optional(),
    status: profileFactStatus.optional(),
  })
  .strict()
  .refine((value) => value.text !== undefined || value.status !== undefined);

const safeLink = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'https:' || protocol === 'http:';
}, 'Use an HTTP or HTTPS link.');

export const projectClaimInput = z.object({
  kind: profileFactKind,
  text: z.string().trim().min(1).max(10_000),
});

export const createProject = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(10_000).default(''),
    links: z.array(safeLink).max(20).default([]),
    claims: z.array(projectClaimInput).max(100).default([]),
  })
  .strict();

export const patchProject = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(10_000).optional(),
    links: z.array(safeLink).max(20).optional(),
    claims: z.array(projectClaimInput).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const project = z.object({
  id: z.uuid(),
  title: z.string(),
  summary: z.string(),
  links: z.array(z.string()),
  claims: z.array(profileFact),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const listProjects = z.object({ projects: z.array(project) });

export type ProfileFactKind = z.infer<typeof profileFactKind>;
export type ProfileFactSource = z.infer<typeof profileFactSource>;
export type ProfileFactStatus = z.infer<typeof profileFactStatus>;
export type ProfileFact = z.infer<typeof profileFact>;
export type PatchProfileFact = z.infer<typeof patchProfileFact>;
export type ProjectClaimInput = z.infer<typeof projectClaimInput>;
export type CreateProject = z.infer<typeof createProject>;
export type PatchProject = z.infer<typeof patchProject>;
export type ProjectRecord = z.infer<typeof project>;

export const profilePreferences = z
  .object({
    targetRoles: z.array(z.string().trim().min(1).max(200)).max(20),
    preferredLocation: z.string().trim().max(200),
    workPreference: z.enum(['any', 'remote', 'hybrid', 'onsite']),
    paperSize: z.enum(['A4', 'LETTER']),
    cvName: z.string().trim().max(200).optional(),
    cvContact: z.string().trim().max(500).optional(),
  })
  .strict();
export type ProfilePreferences = z.infer<typeof profilePreferences>;
