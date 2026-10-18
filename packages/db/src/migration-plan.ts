export type MigrationEntry = { idx: number; when: number; tag: string };

/** Drizzle records timestamps, but existing installs can contain holes in a branched history. */
export function getPendingMigrations(
  entries: MigrationEntry[],
  appliedTimestamps: Set<number>,
): MigrationEntry[] {
  return [...entries]
    .sort((a, b) => a.idx - b.idx)
    .filter((entry) => !appliedTimestamps.has(entry.when));
}
