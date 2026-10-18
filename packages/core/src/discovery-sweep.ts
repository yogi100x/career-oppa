import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { discoveryCollectionState, discoverySweeps, getDatabase, type Database } from '@career-workspace/db';
import { planDiscoverySweep, discoverySourceBatches, ensureDiscoveryState } from './discovery-catalog';
import { refreshDiscoveryPool } from './discovery-collection';
import { DISCOVERY_SWEEP_SIZE } from './discovery-policy';
import type { fetchDiscoveryCompanyDataset } from '@career-workspace/adapters/discovery-dataset';

export async function prepareScheduledDiscovery(key: string, options: { database?: Database; fetchDataset?: typeof fetchDiscoveryCompanyDataset } = {}) {
  const database = options.database ?? getDatabase();
  await ensureDiscoveryState(database);
  const [state] = await database.select().from(discoveryCollectionState).where(eq(discoveryCollectionState.id, 'global'));
  if (state.currentSweepKey) {
    const [previous] = await database.select().from(discoverySweeps).where(eq(discoverySweeps.key, state.currentSweepKey));
    if (previous && previous.nextIndex < previous.sourceIds.length) {
      // A new daily trigger can resume a failed or breaker-paused sweep.
      if (previous.halted && previous.key !== key) await database.update(discoverySweeps).set({ halted: false, consecutiveFailures: 0 }).where(eq(discoverySweeps.key, previous.key));
      return previous.key;
    }
  }
  await planDiscoverySweep(key, { ...options, all: true });
  await database.update(discoveryCollectionState).set({ currentSweepKey: key }).where(eq(discoveryCollectionState.id, 'global'));
  return key;
}

/** Small DB checkpoint after each wave; a retried step never restarts the directory. */
export async function advanceDiscoverySweep(key: string, options: {
  database?: Database; collect?: typeof refreshDiscoveryPool; clock?: () => number; budgetMs?: number;
} = {}) {
  const database = options.database ?? getDatabase();
  const clock = options.clock ?? Date.now;
  const started = clock();
  const token = randomUUID();
  const owned = await database.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    const [sweep] = await tx.select().from(discoverySweeps).where(eq(discoverySweeps.key, key)).for('update');
    if (!sweep) throw new Error('Collection plan not found.');
    if (sweep.halted || sweep.nextIndex >= sweep.sourceIds.length) return { sweep, claimed: false, busy: false };
    if (sweep.leaseUntil && sweep.leaseUntil > new Date()) return { sweep, claimed: false, busy: true };
    await tx.update(discoverySweeps).set({ leaseToken: token, leaseUntil: new Date(Date.now() + 65_000) }).where(eq(discoverySweeps.key, key));
    return { sweep, claimed: true, busy: false };
  });
  let sweep = owned.sweep;
  if (owned.claimed) {
    let stepCount = 0;
    try {
      while (sweep.nextIndex < sweep.sourceIds.length && !sweep.halted && stepCount < DISCOVERY_SWEEP_SIZE) {
        // Leave room for one bounded wave plus its checkpoint before the 60s limit.
        if (stepCount && clock() - started >= (options.budgetMs ?? 40_000) - 20_000) break;
        const remaining = sweep.sourceIds.slice(sweep.nextIndex, sweep.nextIndex + DISCOVERY_SWEEP_SIZE - stepCount);
        // Keep the exact contiguous order in the plan; do not advance over unvisited boards.
        const counts = new Map<string, number>();
        const wave: string[] = [];
        for (const id of remaining) {
          const provider = id.split(':')[0];
          if ((counts.get(provider) ?? 0) === 6 || wave.length === 18) break;
          counts.set(provider, (counts.get(provider) ?? 0) + 1);
          wave.push(id);
        }
        const result = await (options.collect ?? refreshDiscoveryPool)({ database, sourceIds: wave, sweepKey: key });
        [sweep] = await database.update(discoverySweeps).set({ nextIndex: sweep.nextIndex + wave.length,
          refreshed: sql`${discoverySweeps.refreshed} + ${result.refreshed}`, failed: sql`${discoverySweeps.failed} + ${result.failed}`, skipped: sql`${discoverySweeps.skipped} + ${result.skipped}` })
          .where(and(eq(discoverySweeps.key, key), eq(discoverySweeps.leaseToken, token))).returning();
        if (!sweep) throw new Error('Collection lease expired.');
        await database.update(discoveryCollectionState).set({ cursor: sweep.nextIndex }).where(eq(discoveryCollectionState.id, 'global'));
        stepCount += wave.length;
      }
    } finally {
      await database.update(discoverySweeps).set({ leaseToken: null, leaseUntil: null }).where(and(eq(discoverySweeps.key, key), eq(discoverySweeps.leaseToken, token)));
    }
  }
  return { done: sweep.nextIndex >= sweep.sourceIds.length || sweep.halted, busy: owned.busy,
    processed: sweep.nextIndex, total: sweep.sourceIds.length, refreshed: sweep.refreshed, failed: sweep.failed, skipped: sweep.skipped, halted: sweep.halted };
}

export { discoverySourceBatches };
