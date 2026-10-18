import { and, eq } from 'drizzle-orm';
import {
  getDatabase,
  socialConnections,
  users,
  type Database,
} from '@career-workspace/db';
import {
  createZernioProfile,
  disconnectZernioAccount,
  getZernioConnectUrl,
  listZernioAccounts,
  ZernioError,
} from '@career-workspace/adapters/zernio';
import { ApiError } from './api';

const knownPlatforms = new Set([
  'linkedin',
  'twitter',
  'instagram',
  'facebook',
  'tiktok',
  'youtube',
  'pinterest',
  'reddit',
  'bluesky',
  'threads',
  'googlebusiness',
  'telegram',
  'snapchat',
  'whatsapp',
  'discord',
  'slack',
]);
type Provider = {
  createProfile: typeof createZernioProfile;
  getConnectUrl: typeof getZernioConnectUrl;
  listAccounts: typeof listZernioAccounts;
  disconnectAccount: typeof disconnectZernioAccount;
};
type Options = {
  database?: Database;
  provider?: Provider;
  platform?: string;
  appUrl?: string;
};
const zernio: Provider = {
  createProfile: createZernioProfile,
  getConnectUrl: getZernioConnectUrl,
  listAccounts: listZernioAccounts,
  disconnectAccount: disconnectZernioAccount,
};

function configuredPlatform(value: string | undefined) {
  const platform = value?.trim().toLowerCase();
  if (
    !platform ||
    platform.startsWith('replace_with_') ||
    !knownPlatforms.has(platform)
  )
    throw new ApiError(
      503,
      'SOCIAL_PLATFORM_NOT_CONFIGURED',
      'Choose a supported publishing platform in server configuration first.',
    );
  return platform;
}

function configuredAppUrl(value?: string) {
  const configured = value ?? process.env.APP_URL;
  if (!configured || configured.startsWith('REPLACE_WITH_'))
    throw new ApiError(
      503,
      'SOCIAL_CALLBACK_NOT_CONFIGURED',
      'The publishing return URL is not configured yet.',
    );
  try {
    const url = new URL(configured);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && url.hostname === 'localhost')
    )
      throw new Error('invalid protocol');
    return url;
  } catch {
    throw new ApiError(
      503,
      'SOCIAL_CALLBACK_NOT_CONFIGURED',
      'The publishing return URL must be a configured HTTPS app URL.',
    );
  }
}

function mapProviderError(error: unknown): never {
  if (error instanceof ZernioError)
    throw new ApiError(
      error.code === 'NOT_CONFIGURED' ? 503 : 502,
      error.code === 'NOT_CONFIGURED'
        ? 'ZERNIO_NOT_CONFIGURED'
        : 'SOCIAL_PROVIDER_ERROR',
      error.code === 'NOT_CONFIGURED'
        ? 'Social account connections are not configured yet.'
        : 'The social provider could not complete this request.',
    );
  throw error;
}

function connectionView(record: typeof socialConnections.$inferSelect) {
  return {
    id: record.id,
    platform: record.platform,
    status: record.status as 'pending' | 'connected' | 'disconnected',
    displayName: record.displayName,
    updatedAt: record.updatedAt,
  };
}

export async function getSocialConnection(
  userId: string,
  database: Database = getDatabase(),
) {
  const [record] = await database
    .select()
    .from(socialConnections)
    .where(eq(socialConnections.userId, userId))
    .limit(1);
  return record ? connectionView(record) : null;
}

async function lockActiveUser(
  userId: string,
  database: Pick<Database, 'select'>,
) {
  const [user] = await database
    .select({ deletionRequestedAt: users.deletionRequestedAt })
    .from(users)
    .where(eq(users.id, userId))
    .for('no key update');
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
  if (user.deletionRequestedAt)
    throw new ApiError(
      403,
      'ACCOUNT_DELETION_PENDING',
      'Account deletion is in progress.',
    );
}

/** Create or reuse this user's dedicated Zernio profile and start hosted OAuth. */
export async function startSocialConnection(
  userId: string,
  options: Options = {},
) {
  const database = options.database ?? getDatabase();
  const provider = options.provider ?? zernio;
  const platform = configuredPlatform(
    options.platform ?? process.env.PUBLISHING_PLATFORM,
  );
  const callback = new URL(
    '/api/v1/social-connections/callback',
    configuredAppUrl(options.appUrl),
  );
  const record = await database.transaction(async (tx) => {
    await lockActiveUser(userId, tx);
    let [record] = await tx
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, userId))
      .limit(1);

    if (record?.status === 'connected')
      throw new ApiError(
        409,
        'SOCIAL_ACCOUNT_ALREADY_CONNECTED',
        'Disconnect your current social account before connecting another one.',
      );
    if (record && record.platform !== platform)
      throw new ApiError(
        409,
        'SOCIAL_PLATFORM_LOCKED',
        'A different platform is already selected for this profile.',
      );

    let providerProfileId = record?.providerProfileId ?? null;
    if (!providerProfileId) {
      try {
        providerProfileId = await provider.createProfile(userId);
      } catch (error) {
        mapProviderError(error);
      }
    }

    const now = new Date();
    if (!record) {
      const [inserted] = await tx
        .insert(socialConnections)
        .values({
          userId,
          providerProfileId,
          platform,
          status: 'pending',
          updatedAt: now,
        })
        .onConflictDoNothing({ target: socialConnections.userId })
        .returning();
      record = inserted;
      if (!record) {
        const [raced] = await tx
          .select()
          .from(socialConnections)
          .where(eq(socialConnections.userId, userId))
          .limit(1);
        if (!raced)
          throw new ApiError(
            500,
            'SOCIAL_CONNECTION_SAVE_FAILED',
            'The social connection could not be saved.',
          );
        if (raced.platform !== platform)
          throw new ApiError(
            409,
            'SOCIAL_PLATFORM_LOCKED',
            'A different platform is already selected for this profile.',
          );
        record = raced;
      }
    } else {
      const [updated] = await tx
        .update(socialConnections)
        .set({ providerProfileId, status: 'pending', updatedAt: now })
        .where(
          and(
            eq(socialConnections.id, record.id),
            eq(socialConnections.userId, userId),
          ),
        )
        .returning();
      record = updated;
    }

    if (!record?.providerProfileId)
      throw new ApiError(
        500,
        'SOCIAL_CONNECTION_SAVE_FAILED',
        'The social connection could not be saved.',
      );
    return record;
  });
  // Commit the owned provider ID before requesting a hosted link. A failed
  // link request must not erase the profile needed for retry or deletion.
  try {
    const authUrl = await provider.getConnectUrl(
      record.providerProfileId!,
      platform,
      callback.toString(),
    );
    return { connection: connectionView(record), authUrl };
  } catch (error) {
    mapProviderError(error);
  }
}

/** Trust no callback identity fields until the provider confirms account ownership. */
export async function completeSocialConnection(
  userId: string,
  callback: {
    platform: string | null;
    profileId: string | null;
    accountId: string | null;
  },
  options: Options = {},
) {
  const database = options.database ?? getDatabase();
  const provider = options.provider ?? zernio;
  return database.transaction(async (tx) => {
    await lockActiveUser(userId, tx);
    const [record] = await tx
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, userId))
      .limit(1);
    if (!record || !record.providerProfileId)
      throw new ApiError(
        404,
        'SOCIAL_CONNECTION_NOT_FOUND',
        'Social connection not found.',
      );
    if (
      callback.platform !== record.platform ||
      callback.profileId !== record.providerProfileId ||
      !callback.accountId
    )
      throw new ApiError(
        404,
        'SOCIAL_CONNECTION_NOT_FOUND',
        'Social connection not found.',
      );

    let accounts: Awaited<ReturnType<typeof listZernioAccounts>>;
    try {
      accounts = await provider.listAccounts(record.providerProfileId);
    } catch (error) {
      mapProviderError(error);
    }
    const account = accounts.find(
      (candidate) =>
        candidate._id === callback.accountId &&
        candidate.profileId === record.providerProfileId &&
        candidate.platform === record.platform,
    );
    if (!account || !account.isActive)
      throw new ApiError(
        404,
        'SOCIAL_CONNECTION_NOT_FOUND',
        'Social connection not found.',
      );
    if (record.status === 'connected') {
      if (record.providerAccountId !== account._id)
        throw new ApiError(
          409,
          'SOCIAL_ACCOUNT_MISMATCH',
          'A different social account is already connected.',
        );
      return connectionView(record);
    }

    const [updated] = await tx
      .update(socialConnections)
      .set({
        providerAccountId: account._id,
        displayName: account.displayName ?? account.username ?? null,
        status: 'connected',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(socialConnections.userId, userId),
          eq(socialConnections.id, record.id),
        ),
      )
      .returning();
    if (!updated)
      throw new ApiError(
        404,
        'SOCIAL_CONNECTION_NOT_FOUND',
        'Social connection not found.',
      );
    return connectionView(updated);
  });
}

export async function disconnectSocialConnection(
  userId: string,
  options: Options = {},
) {
  const database = options.database ?? getDatabase();
  const provider = options.provider ?? zernio;
  return database.transaction(async (tx) => {
    await lockActiveUser(userId, tx);
    const [record] = await tx
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.userId, userId))
      .limit(1);
    if (!record)
      throw new ApiError(
        404,
        'SOCIAL_CONNECTION_NOT_FOUND',
        'Social connection not found.',
      );
    if (record.status === 'connected' && record.providerAccountId) {
      try {
        await provider.disconnectAccount(record.providerAccountId);
      } catch (error) {
        mapProviderError(error);
      }
    }
    const [updated] = await tx
      .update(socialConnections)
      .set({ status: 'disconnected', updatedAt: new Date() })
      .where(
        and(
          eq(socialConnections.userId, userId),
          eq(socialConnections.id, record.id),
        ),
      )
      .returning();
    return connectionView(updated);
  });
}
