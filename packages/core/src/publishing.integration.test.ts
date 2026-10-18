import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  users,
  projects,
  profileFacts,
  socialConnections,
  posts,
  publishingEvents,
  events,
  type Database,
} from '@career-workspace/db';
import { createRecordedResponseGenerator } from '@career-workspace/adapters/ai';
import { balance } from './credits';
import {
  createPost,
  editPost,
  approvePost,
  getPost,
  publishPost,
  recordPublishingCallback,
  type PublishingProviders,
} from './publishing';
const integration = process.env.DATABASE_TEST_URL ? describe : describe.skip;
integration('reviewed and reconciled publishing', () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>['pool'];
  let userId: string,
    otherId: string,
    projectId: string,
    factId: string,
    connectionId: string;
  const providerIds: string[] = [];
  beforeAll(async () => {
    ({ database: db, pool } = createDatabase(process.env.DATABASE_TEST_URL!));
    const people = await db
      .insert(users)
      .values([
        { clerkId: `publishing-a-${randomUUID()}` },
        { clerkId: `publishing-b-${randomUUID()}` },
      ])
      .returning();
    [userId, otherId] = people.map((p) => p.id);
    const [project] = await db
      .insert(projects)
      .values({ userId, title: 'Accessible form' })
      .returning();
    projectId = project.id;
    const [fact] = await db
      .insert(profileFacts)
      .values({
        userId,
        projectId,
        kind: 'achievement',
        text: 'Built an accessible form.',
        source: 'project',
        status: 'approved',
      })
      .returning();
    factId = fact.id;
    const [connection] = await db
      .insert(socialConnections)
      .values({
        userId,
        providerProfileId: `profile-${randomUUID()}`,
        providerAccountId: `account-${randomUUID()}`,
        platform: 'linkedin',
        status: 'connected',
      })
      .returning();
    connectionId = connection.id;
  });
  afterAll(async () => {
    if (db) {
      if (providerIds.length)
        await db
          .delete(publishingEvents)
          .where(inArray(publishingEvents.providerPostId, providerIds));
      await db.delete(users).where(inArray(users.id, [userId, otherId]));
    }
    if (pool) await pool.end();
  });
  async function draft(key: string) {
    return createPost(userId, projectId, key, {
      database: db,
      generate: createRecordedResponseGenerator({
        'post.v1': {
          content: 'I built an accessible form.',
          fact_ids: [factId],
        },
      }),
    });
  }
  async function approved(key: string) {
    const post = await draft(key);
    await editPost(
      userId,
      post.id,
      {
        content: post.content,
        fact_ids: post.factIds,
        destination: 'social',
        connectionId,
      },
      db,
    );
    return approvePost(
      userId,
      post.id,
      {
        content: post.content,
        destination: 'social',
        connectionId,
        confirmed: true,
      },
      db,
    );
  }
  function api(providerId: string): PublishingProviders {
    return {
      publish: vi.fn(async () => ({
        _id: providerId,
        status: 'scheduled' as const,
        platforms: [
          {
            platform: 'linkedin',
            accountId: `irrelevant`,
            status: 'scheduled',
          },
        ],
      })),
      get: vi.fn(async () => {
        throw new Error('not found');
      }),
      find: vi.fn(async () => null),
    };
  }
  it('charges one credit once, resets approval on edit and refuses another owner', async () => {
    const post = await draft('review');
    expect((await draft('review')).id).toBe(post.id);
    expect((await balance(userId, { database: db })).available).toBe(29);
    await expect(getPost(otherId, post.id, db)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      approvePost(
        userId,
        post.id,
        {
          content: 'Changed',
          destination: 'copy',
          connectionId: null,
          confirmed: true,
        },
        db,
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
    const saved = await approvePost(
      userId,
      post.id,
      {
        content: post.content,
        destination: 'copy',
        connectionId: null,
        confirmed: true,
      },
      db,
    );
    expect(saved.approvedContent).toBe(post.content);
    expect(saved.status).toBe('copy_ready');
    const approvalEvents = () =>
      db
        .select()
        .from(events)
        .where(
          and(
            eq(events.userId, userId),
            eq(events.subjectType, 'post'),
            eq(events.subjectId, post.id),
            eq(events.type, 'post.approved'),
          ),
        );
    const eventBeforeReplay = (await approvalEvents()).length;
    expect(
      await approvePost(
        userId,
        post.id,
        {
          content: post.content,
          destination: 'copy',
          connectionId: null,
          confirmed: true,
        },
        db,
      ),
    ).toEqual(saved);
    expect((await approvalEvents()).length).toBe(eventBeforeReplay);
    const edited = await editPost(
      userId,
      post.id,
      {
        content: 'Edited form text.',
        fact_ids: [factId],
        destination: 'copy',
        connectionId: null,
      },
      db,
    );
    expect(edited.approvedAt).toBeNull();
    expect(edited.status).toBe('draft');
  });
  it('keeps an accepted request pending, applies a signed-route event once and does not regress published', async () => {
    const post = await approved('accepted');
    const id = `post-${randomUUID()}`;
    providerIds.push(id);
    const provider = api(id);
    const accepted = await publishPost(userId, post.id, {
      database: db,
      providers: provider,
    });
    expect(accepted.status).toBe('publishing');
    const payload = {
      status: 'published',
      accountId: accepted.approvedDestination!.accountId!,
      platform: 'linkedin',
      publicUrl: 'https://example.com/published',
    };
    const eventId = randomUUID();
    await recordPublishingCallback(eventId, id, payload, db);
    expect(
      await recordPublishingCallback(eventId, id, payload, db),
    ).toMatchObject({ duplicate: true });
    await recordPublishingCallback(
      randomUUID(),
      id,
      { ...payload, status: 'failed' },
      db,
    );
    expect((await getPost(userId, post.id, db)).status).toBe('published');
    await publishPost(userId, post.id, { database: db, providers: provider });
    expect(provider.publish).toHaveBeenCalledTimes(1);
  });
  it('reconciles a lost response before retry and keeps the original key', async () => {
    const post = await approved('lost');
    const id = `lost-${randomUUID()}`;
    providerIds.push(id);
    const provider = api(id);
    provider.publish = vi.fn(async () => {
      throw new Error('lost response');
    });
    await expect(
      publishPost(userId, post.id, { database: db, providers: provider }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
    provider.find = vi.fn(async () => ({
      _id: id,
      status: 'published' as const,
      platforms: [
        {
          platform: 'linkedin',
          accountId: post.approvedDestination!.accountId!,
          status: 'published',
        },
      ],
    }));
    expect(
      (
        await publishPost(userId, post.id, {
          database: db,
          providers: provider,
        })
      ).status,
    ).toBe('published');
    expect(provider.publish).toHaveBeenCalledTimes(1);
    expect(provider.find).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.publish).mock.calls[0][0].idempotencyKey).toBe(
      post.idempotencyKey,
    );
  });
  it('refuses an uncertain new submission after the 24 hour provider window and preserves text', async () => {
    const post = await approved('expired');
    const id = `expired-${randomUUID()}`;
    const provider = api(id);
    await db
      .update(posts)
      .set({
        firstAttemptAt: new Date(Date.now() - 25 * 3600000),
        status: 'unknown',
      })
      .where(eq(posts.id, post.id));
    await expect(
      publishPost(userId, post.id, { database: db, providers: provider }),
    ).rejects.toMatchObject({ code: 'PUBLICATION_UNCERTAIN' });
    expect(provider.publish).not.toHaveBeenCalled();
    expect((await getPost(userId, post.id, db)).content).toBe(post.content);
  });
  it('replays a callback that arrived before the provider response was saved', async () => {
    const post = await approved('early');
    const id = `early-${randomUUID()}`;
    providerIds.push(id);
    const provider = api(id);
    provider.publish = vi.fn(async () => {
      await recordPublishingCallback(
        randomUUID(),
        id,
        {
          status: 'published',
          accountId: post.approvedDestination!.accountId!,
          platform: 'linkedin',
        },
        db,
      );
      return { _id: id, status: 'scheduled' as const };
    });
    expect(
      (
        await publishPost(userId, post.id, {
          database: db,
          providers: provider,
        })
      ).status,
    ).toBe('published');
  });
  it('uses one provider submission for concurrent attempts', async () => {
    const post = await approved('concurrent');
    const id = `concurrent-${randomUUID()}`;
    providerIds.push(id);
    const provider = api(id);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.publish = vi.fn(async () => {
      await pending;
      return { _id: id, status: 'scheduled' as const };
    });
    const first = publishPost(userId, post.id, {
      database: db,
      providers: provider,
    });
    await vi.waitFor(() => expect(provider.publish).toHaveBeenCalledTimes(1));
    await expect(
      publishPost(userId, post.id, { database: db, providers: provider }),
    ).rejects.toMatchObject({ code: 'PUBLISHING_IN_PROGRESS' });
    release();
    await first;
    expect(provider.publish).toHaveBeenCalledTimes(1);
  });
  it('reuses the original key only after reconciliation within the provider window', async () => {
    const post = await approved('same-key');
    const id = `same-key-${randomUUID()}`;
    providerIds.push(id);
    const provider = api(id);
    const sequence: string[] = [];
    provider.publish = vi.fn(async () => {
      sequence.push('publish');
      throw new Error('timeout');
    });
    await expect(
      publishPost(userId, post.id, { database: db, providers: provider }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
    provider.find = vi.fn(async () => {
      sequence.push('find');
      return null;
    });
    await expect(
      publishPost(userId, post.id, { database: db, providers: provider }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
    expect(sequence).toEqual(['publish', 'find', 'publish']);
    expect(
      vi
        .mocked(provider.publish)
        .mock.calls.map((call) => call[0].idempotencyKey),
    ).toEqual([post.idempotencyKey, post.idempotencyKey]);
  });
  it('does not submit or retain callbacks once deletion is requested', async () => {
    const post = await approved('deleting');
    const id = `deleting-${randomUUID()}`;
    await db
      .update(users)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(users.id, userId));
    try {
      const provider = api(id);
      await expect(
        publishPost(userId, post.id, { database: db, providers: provider }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' });
      expect(provider.publish).not.toHaveBeenCalled();
      const event = await recordPublishingCallback(
        randomUUID(),
        id,
        {
          status: 'published',
          accountId: post.approvedDestination!.accountId!,
          platform: 'linkedin',
        },
        db,
      );
      expect(event).toMatchObject({ ignored: true });
      expect(
        await db
          .select()
          .from(publishingEvents)
          .where(eq(publishingEvents.providerPostId, id)),
      ).toHaveLength(0);
    } finally {
      await db
        .update(users)
        .set({ deletionRequestedAt: null })
        .where(eq(users.id, userId));
    }
  });
});
