export const FEATURE_FLAGS = ['practice', 'publishing', 'discovery'] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];
export type FlagConfig = Record<FeatureFlag, boolean>;

/** Unfinished features stay off unless explicitly enabled by configuration. */
export function readFlags(env: Record<string, string | undefined>): FlagConfig {
  return {
    practice: env.FEATURE_PRACTICE === 'true',
    publishing: env.FEATURE_PUBLISHING === 'true',
    discovery: env.FEATURE_DISCOVERY === 'true',
  };
}

/** Route handlers return this response before doing any work for a disabled feature. */
export function guardFeature(flags: FlagConfig, feature: FeatureFlag): Response | null {
  if (flags[feature]) return null;
  return Response.json(
    { error: { code: 'NOT_FOUND', message: 'This feature is not available.' } },
    { status: 404 },
  );
}
