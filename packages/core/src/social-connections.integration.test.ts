import { randomUUID } from 'node:crypto';
import { createAccountDeletionTask } from './account-deletion';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  socialConnections,
  users,
  type Database,
} from '@career-workspace/db';
import {
  createZernioProfile,
  disconnectZernioAccount,
  getZernioConnectUrl,
  listZernioAccounts,
} from '@career-workspace/adapters/zernio';
import {
  completeSocialConnection,
  disconnectSocialConnection,
  getSocialConnection,
  startSocialConnection,
} from './social-connections';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('private social account connections', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let ownerId: string;
  let otherId: string;
  const ownerClerkId = `social-owner-${randomUUID()}`;
  const otherClerkId = `social-other-${randomUUID()}`;
  const profileId = `profile-${randomUUID()}`;
  const accountId = `account-${randomUUID()}`;

  beforeAll(async () => {
    if (new URL(testDatabaseUrl!).pathname !== '/career_workspace_test')
      throw new Error('Use career_workspace_test only.');
    ({ database: db, pool } = createDatabase(testDatabaseUrl!));
    const rows = await db
      .insert(users)
      .values([{ clerkId: ownerClerkId }, { clerkId: otherClerkId }])
      .returning();
    [ownerId, otherId] = rows.map((row) => row.id);
  });
  afterAll(async () => {
    await db.delete(users).where(eq(users.clerkId, ownerClerkId));
    await db.delete(users).where(eq(users.clerkId, otherClerkId));
    await pool.end();
  });

  it('requires explicit platform and callback configuration before contacting the provider', async () => {
    const createProfile = vi.fn<typeof createZernioProfile>();
    await expect(
      startSocialConnection(ownerId, {
        database: db,
        platform: undefined,
        appUrl: 'https://app.example.test',
        provider: {
          createProfile,
          getConnectUrl: getZernioConnectUrl,
          listAccounts: listZernioAccounts,
          disconnectAccount: disconnectZernioAccount,
        },
      }),
    ).rejects.toMatchObject({
      code: 'SOCIAL_PLATFORM_NOT_CONFIGURED',
      status: 503,
    });
    await expect(
      startSocialConnection(ownerId, {
        database: db,
        platform: 'linkedin',
        appUrl: 'http://example.test',
        provider: {
          createProfile,
          getConnectUrl: getZernioConnectUrl,
          listAccounts: listZernioAccounts,
          disconnectAccount: disconnectZernioAccount,
        },
      }),
    ).rejects.toMatchObject({
      code: 'SOCIAL_CALLBACK_NOT_CONFIGURED',
      status: 503,
    });
    expect(createProfile).not.toHaveBeenCalled();
  });

  it('starts hosted authorization, verifies the returned account against the owned provider profile, and disconnects', async () => {
    const provider = {
      createProfile: vi.fn(async (userId: string) => {
        expect(userId).toBe(ownerId);
        return profileId;
      }),
      getConnectUrl: vi.fn(
        async (profile: string, platform: string, callback: string) => {
          expect([profile, platform, callback]).toEqual([
            profileId,
            'linkedin',
            'https://app.example.test/api/v1/social-connections/callback',
          ]);
          return 'https://zernio.com/connect/linkedin?opaque=1';
        },
      ),
      listAccounts: vi.fn(async (profile: string) => {
        expect(profile).toBe(profileId);
        return [
          {
            _id: accountId,
            profileId,
            platform: 'linkedin',
            username: 'ada',
            displayName: 'Ada Lovelace',
            isActive: true,
          },
        ];
      }),
      disconnectAccount: vi.fn(async (id: string) => {
        expect(id).toBe(accountId);
      }),
    };
    provider.getConnectUrl.mockRejectedValueOnce(
      new Error('Recorded link request failure'),
    );
    await expect(
      startSocialConnection(ownerId, {
        database: db,
        platform: 'linkedin',
        appUrl: 'https://app.example.test',
        provider,
      }),
    ).rejects.toThrow('Recorded link request failure');
    const [retained] = await db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, ownerId));
    expect(retained.providerProfileId).toBe(profileId);
    const started = await startSocialConnection(ownerId, {
      database: db,
      platform: 'linkedin',
      appUrl: 'https://app.example.test',
      provider,
    });
    expect(provider.createProfile).toHaveBeenCalledTimes(1);
    expect(started.authUrl).toMatch(/^https:\/\/zernio\.com\//);
    expect(started.connection).toMatchObject({
      platform: 'linkedin',
      status: 'pending',
    });
    expect(await getSocialConnection(otherId, db)).toBeNull();

    await expect(
      completeSocialConnection(
        otherId,
        { platform: 'linkedin', profileId, accountId },
        { database: db, provider },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      completeSocialConnection(
        ownerId,
        { platform: 'linkedin', profileId: 'another-profile', accountId },
        { database: db, provider },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      completeSocialConnection(
        ownerId,
        { platform: 'linkedin', profileId, accountId: 'unverified-account' },
        { database: db, provider },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(provider.listAccounts).toHaveBeenCalledTimes(1);

    provider.listAccounts.mockResolvedValueOnce([
      {
        _id: accountId,
        profileId,
        platform: 'twitter',
        username: 'ada',
        displayName: 'Ada Lovelace',
        isActive: true,
      },
    ]);
    await expect(
      completeSocialConnection(
        ownerId,
        { platform: 'linkedin', profileId, accountId },
        { database: db, provider },
      ),
    ).rejects.toMatchObject({ status: 404 });

    const connected = await completeSocialConnection(
      ownerId,
      { platform: 'linkedin', profileId, accountId },
      { database: db, provider },
    );
    expect(connected).toMatchObject({
      platform: 'linkedin',
      status: 'connected',
      displayName: 'Ada Lovelace',
    });
    expect(
      await completeSocialConnection(
        ownerId,
        { platform: 'linkedin', profileId, accountId },
        { database: db, provider },
      ),
    ).toEqual(connected);
    const disconnected = await disconnectSocialConnection(ownerId, {
      database: db,
      provider,
    });
    expect(disconnected).toMatchObject({ status: 'disconnected' });
    expect(provider.disconnectAccount).toHaveBeenCalledTimes(1);
    expect(
      (
        await db
          .select()
          .from(socialConnections)
          .where(eq(socialConnections.userId, ownerId))
      )[0].providerAccountId,
    ).toBe(accountId);
  });
  it('saves a new provider profile before deletion can start and rejects later connection attempts', async () => {
    let releaseProfile!: () => void;
    let profileStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      profileStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });
    const provider = {
      createProfile: vi.fn(async () => {
        profileStarted();
        await release;
        return 'deletion-race-profile';
      }),
      getConnectUrl: vi.fn(async () => 'https://zernio.com/connect/linkedin'),
      listAccounts: vi.fn(async () => []),
      disconnectAccount: vi.fn(async () => undefined),
    };
    const options = {
      database: db,
      platform: 'linkedin',
      appUrl: 'https://app.example.test',
      provider,
    };
    const connecting = startSocialConnection(otherId, options);
    await started;
    const deleting = createAccountDeletionTask(otherId, randomUUID(), db);
    try {
      const [before] = await db
        .select()
        .from(users)
        .where(eq(users.id, otherId));
      expect(before.deletionRequestedAt).toBeNull();
    } finally {
      releaseProfile();
    }
    await connecting;
    await deleting;
    const [connection] = await db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, otherId));
    expect(connection.providerProfileId).toBe('deletion-race-profile');
    await expect(startSocialConnection(otherId, options)).rejects.toMatchObject(
      { status: 403, code: 'ACCOUNT_DELETION_PENDING' },
    );
    await expect(
      completeSocialConnection(
        otherId,
        {
          platform: 'linkedin',
          profileId: connection.providerProfileId,
          accountId: 'late-account',
        },
        options,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.createProfile).toHaveBeenCalledTimes(1);
    expect(provider.listAccounts).not.toHaveBeenCalled();
  });
});
