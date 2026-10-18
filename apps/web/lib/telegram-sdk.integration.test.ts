import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPostgresState } from '@chat-adapter/state-pg';
import { createDatabase } from '@career-workspace/db';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('Chat SDK PostgreSQL state', () => {
  const keyPrefix = `chat-sdk-test-${randomUUID()}`;
  let poolA: ReturnType<typeof createDatabase>['pool'];
  let poolB: ReturnType<typeof createDatabase>['pool'];
  let stateA: ReturnType<typeof createPostgresState>;
  let stateB: ReturnType<typeof createPostgresState>;

  beforeAll(() => {
    const databaseName = new URL(testDatabaseUrl!).pathname;
    if (databaseName !== '/career_workspace_test') {
      throw new Error('DATABASE_TEST_URL must target career_workspace_test.');
    }

    poolA = createDatabase(testDatabaseUrl!).pool;
    poolB = createDatabase(testDatabaseUrl!).pool;
    stateA = createPostgresState({
      client: poolA,
      autoCreateSchema: false,
      keyPrefix,
    });
    stateB = createPostgresState({
      client: poolB,
      autoCreateSchema: false,
      keyPrefix,
    });
  });

  afterAll(async () => {
    if (stateA) await stateA.disconnect();
    if (stateB) await stateB.disconnect();
    if (poolA) {
      await poolA.query(
        'DELETE FROM chat_state_subscriptions WHERE key_prefix = $1',
        [keyPrefix],
      );
      await poolA.query('DELETE FROM chat_state_locks WHERE key_prefix = $1', [
        keyPrefix,
      ]);
      await poolA.query('DELETE FROM chat_state_cache WHERE key_prefix = $1', [
        keyPrefix,
      ]);
      await poolA.query('DELETE FROM chat_state_lists WHERE key_prefix = $1', [
        keyPrefix,
      ]);
      await poolA.query('DELETE FROM chat_state_queues WHERE key_prefix = $1', [
        keyPrefix,
      ]);
      await poolA.end();
    }
    if (poolB) await poolB.end();
  });

  it('shares state and distributed locks across independent adapter instances', async () => {
    await Promise.all([stateA.connect(), stateB.connect()]);

    await stateA.set('cross-instance-value', { available: true });
    await expect(stateB.get('cross-instance-value')).resolves.toEqual({
      available: true,
    });

    const firstLock = await stateA.acquireLock('telegram:private-chat', 30_000);
    expect(firstLock).not.toBeNull();
    await expect(
      stateB.acquireLock('telegram:private-chat', 30_000),
    ).resolves.toBeNull();
    await stateA.releaseLock(firstLock!);
    const lockAfterRelease = await stateB.acquireLock(
      'telegram:private-chat',
      30_000,
    );
    expect(lockAfterRelease).not.toBeNull();
    await stateB.releaseLock(lockAfterRelease!);
  });
});
