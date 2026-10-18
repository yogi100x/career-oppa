import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  getDatabase,
  posts,
  projects,
  profileFacts,
  socialConnections,
  publishingEvents,
  tasks,
  users,
  type Database,
  type Transaction,
} from '@career-workspace/db';
import {
  postContentSchema,
  editPostSchema,
  approvePostSchema,
} from '@career-workspace/contracts';
import { generateStructured } from '@career-workspace/adapters/ai';
import {
  publishZernioPost,
  getZernioPost,
  findZernioPost,
  type ZernioPost,
} from '@career-workspace/adapters/zernio';
import { ApiError } from './api';
import { checkGrounding } from './grounding';
import { withCredits } from './credits';
import { recordEvent } from './events';
import { createTask, getTask, startTask } from './tasks';

const prompt = new URL(
  '../../adapters/src/ai/prompts/post.v1.md',
  import.meta.url,
);
type Store = Database | Transaction;
export async function getPost(
  userId: string,
  id: string,
  db: Store = getDatabase(),
) {
  if (!/^[0-9a-f-]{36}$/i.test(id))
    throw new ApiError(404, 'NOT_FOUND', 'Post not found.');
  const [post] = await db
    .select()
    .from(posts)
    .where(and(eq(posts.id, id), eq(posts.userId, userId)));
  if (!post) throw new ApiError(404, 'NOT_FOUND', 'Post not found.');
  return post;
}
export async function listPosts(userId: string, db: Database = getDatabase()) {
  return db
    .select()
    .from(posts)
    .where(eq(posts.userId, userId))
    .orderBy(desc(posts.createdAt));
}
export async function createPost(
  userId: string,
  projectId: string,
  key: string,
  options: { database?: Database; generate?: typeof generateStructured } = {},
) {
  const db = options.database ?? getDatabase();
  if (!/^[0-9a-f-]{36}$/i.test(projectId) || !key.trim() || key.length > 100)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Choose a project and provide a request key.',
    );
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!project) throw new ApiError(404, 'NOT_FOUND', 'Project not found.');
  const facts = await db
    .select()
    .from(profileFacts)
    .where(
      and(
        eq(profileFacts.userId, userId),
        eq(profileFacts.projectId, projectId),
        eq(profileFacts.status, 'approved'),
      ),
    );
  if (!facts.length)
    throw new ApiError(
      422,
      'NO_APPROVED_FACTS',
      'Approve project facts before drafting a post.',
    );
  if (
    !options.generate &&
    (!process.env.OPENROUTER_API_KEY ||
      process.env.OPENROUTER_API_KEY.startsWith('REPLACE_WITH_'))
  )
    throw new ApiError(
      503,
      'AI_NOT_CONFIGURED',
      'AI drafting is not configured. No credits have been charged.',
    );
  const result = await withCredits(
    userId,
    'post_draft',
    `post:${projectId}:${key}`,
    async () => {
      const generated = await (options.generate ?? generateStructured)(
        prompt,
        postContentSchema,
        { project, approvedFacts: facts.map(({ id, text }) => ({ id, text })) },
      );
      const content = postContentSchema.parse(generated.object);
      const saved = await db.transaction(async (tx) => {
        const grounding = await checkGrounding(
          userId,
          [{ text: content.content, fact_ids: content.fact_ids }],
          tx,
          { lockFacts: true },
        );
        if (
          !grounding.canApprove ||
          content.fact_ids.some((id) => !facts.some((f) => f.id === id))
        )
          throw new ApiError(
            422,
            'UNGROUNDED_CONTENT',
            'The draft needs approved project facts. No credits have been charged.',
          );
        const [post] = await tx
          .insert(posts)
          .values({
            userId,
            projectId,
            content: content.content,
            factIds: content.fact_ids,
            promptVersion: generated.promptVersion,
            model: generated.model,
          })
          .returning();
        await recordEvent(
          {
            userId,
            type: 'post.drafted',
            subjectType: 'post',
            subjectId: post.id,
          },
          tx,
        );
        return post;
      });
      return { type: 'post', id: saved.id };
    },
    { database: db },
  );
  return getPost(userId, result.id, db);
}
async function destination(
  userId: string,
  kind: string,
  connectionId: string | null,
  db: Store,
) {
  if (kind === 'copy')
    return {
      destination: 'copy',
      connectionId: null,
      accountId: null,
      platform: null,
    };
  if (!connectionId)
    throw new ApiError(
      422,
      'CONNECTION_REQUIRED',
      'Connect an account before choosing social publishing.',
    );
  const [connection] = await db
    .select()
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.id, connectionId),
        eq(socialConnections.userId, userId),
      ),
    );
  if (
    !connection ||
    connection.status !== 'connected' ||
    !connection.providerAccountId
  )
    throw new ApiError(
      422,
      'CONNECTION_REQUIRED',
      'Reconnect this account before publishing.',
    );
  return {
    destination: 'social',
    connectionId,
    accountId: connection.providerAccountId,
    platform: connection.platform,
  };
}
export async function editPost(
  userId: string,
  id: string,
  input: unknown,
  db: Database = getDatabase(),
) {
  const parsed = editPostSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Check the post text, facts and destination.',
    );
  return db.transaction(async (tx) => {
    await getPost(userId, id, tx);
    const [post] = await tx
      .select()
      .from(posts)
      .where(eq(posts.id, id))
      .for('update');
    if (post.firstAttemptAt)
      throw new ApiError(
        409,
        'POST_ALREADY_ATTEMPTED',
        'This post has already been submitted. Copy its text or create a new draft.',
      );
    await destination(
      userId,
      parsed.data.destination,
      parsed.data.connectionId,
      tx,
    );
    const [saved] = await tx
      .update(posts)
      .set({
        content: parsed.data.content,
        factIds: parsed.data.fact_ids,
        destination: parsed.data.destination,
        socialConnectionId:
          parsed.data.destination === 'copy' ? null : parsed.data.connectionId,
        approvedContent: null,
        approvedDestination: null,
        approvedAt: null,
        status: 'draft',
        updatedAt: new Date(),
      })
      .where(eq(posts.id, id))
      .returning();
    return saved;
  });
}
export async function approvePost(
  userId: string,
  id: string,
  input: unknown,
  db: Database = getDatabase(),
) {
  const parsed = approvePostSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      'REVIEW_REQUIRED',
      'Confirm the exact text and destination after reviewing the cited facts.',
    );
  return db.transaction(async (tx) => {
    await getPost(userId, id, tx);
    const [post] = await tx
      .select()
      .from(posts)
      .where(eq(posts.id, id))
      .for('update');
    if (post.firstAttemptAt)
      throw new ApiError(
        409,
        'POST_ALREADY_ATTEMPTED',
        'This post has already been submitted.',
      );
    if (
      post.content !== parsed.data.content ||
      post.destination !== parsed.data.destination ||
      post.socialConnectionId !== parsed.data.connectionId
    )
      throw new ApiError(
        409,
        'REVIEW_CHANGED',
        'The text or destination changed. Review the saved draft again.',
      );
    const grounding = await checkGrounding(
      userId,
      [{ text: post.content, fact_ids: post.factIds }],
      tx,
      { lockFacts: true },
    );
    const projectFacts = await tx
      .select()
      .from(profileFacts)
      .where(
        and(
          eq(profileFacts.userId, userId),
          eq(profileFacts.projectId, post.projectId),
          eq(profileFacts.status, 'approved'),
        ),
      );
    if (
      !grounding.canApprove ||
      post.factIds.some((id) => !projectFacts.some((f) => f.id === id))
    )
      throw new ApiError(
        422,
        'UNGROUNDED_CONTENT',
        'Every claim needs an approved project fact before approval.',
      );
    const target = await destination(
      userId,
      post.destination,
      post.socialConnectionId,
      tx,
    );
    const previousTarget = post.approvedDestination;
    const sameApprovedTarget =
      previousTarget !== null &&
      previousTarget.destination === target.destination &&
      previousTarget.connectionId === target.connectionId &&
      previousTarget.accountId === target.accountId &&
      previousTarget.platform === target.platform;
    if (
      post.approvedAt &&
      post.approvedContent === post.content &&
      sameApprovedTarget &&
      post.status ===
        (target.destination === 'copy' ? 'copy_ready' : 'approved')
    )
      return post;
    const [saved] = await tx
      .update(posts)
      .set({
        approvedContent: post.content,
        approvedDestination: target,
        approvedAt: new Date(),
        status: target.destination === 'copy' ? 'copy_ready' : 'approved',
        updatedAt: new Date(),
      })
      .where(eq(posts.id, id))
      .returning();
    await recordEvent(
      {
        userId,
        type: 'post.approved',
        subjectType: 'post',
        subjectId: id,
        data: { destination: target.destination },
      },
      tx,
    );
    return saved;
  });
}

export type PublishingProviders = {
  publish: typeof publishZernioPost;
  get: typeof getZernioPost;
  find: typeof findZernioPost;
};
const providers: PublishingProviders = {
  publish: publishZernioPost,
  get: getZernioPost,
  find: findZernioPost,
};
async function applyProviderPost(
  userId: string,
  id: string,
  response: ZernioPost,
  db: Database,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${response._id}, 0))`,
    );
    await getPost(userId, id, tx);
    const [post] = await tx
      .select()
      .from(posts)
      .where(eq(posts.id, id))
      .for('update');
    const target = post.approvedDestination;
    const platform = response.platforms?.find(
      (p) =>
        p.accountId === target?.accountId && p.platform === target?.platform,
    );
    // A top-level status alone cannot prove that the approved account published it.
    const status =
      platform?.status === 'published'
        ? 'published'
        : platform?.status === 'failed'
          ? 'failed'
          : 'publishing';
    const [saved] = await tx
      .update(posts)
      .set({
        providerPostId: response._id,
        status: post.status === 'published' ? 'published' : status,
        publicUrl:
          platform?.status === 'published' &&
          platform.platformPostUrl?.startsWith('https://')
            ? platform.platformPostUrl
            : post.publicUrl,
        attemptId: null,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, id))
      .returning();
    const pending = await tx
      .select()
      .from(publishingEvents)
      .where(
        and(
          eq(publishingEvents.providerPostId, response._id),
          isNull(publishingEvents.appliedAt),
        ),
      )
      .orderBy(publishingEvents.createdAt);
    let current = saved;
    for (const event of pending) {
      const value = event.payload;
      if (
        value.accountId !== target?.accountId ||
        value.platform !== target?.platform
      )
        continue;
      if (
        value.status === 'published' ||
        (value.status === 'failed' && current.status !== 'published')
      ) {
        [current] = await tx
          .update(posts)
          .set({
            status: value.status,
            publicUrl:
              value.status === 'published' &&
              value.publicUrl?.startsWith('https://')
                ? value.publicUrl
                : current.publicUrl,
            attemptId: null,
            updatedAt: new Date(),
          })
          .where(eq(posts.id, id))
          .returning();
      }
      await tx
        .update(publishingEvents)
        .set({ appliedAt: new Date() })
        .where(eq(publishingEvents.id, event.id));
    }
    if (current.status === 'published' || current.status === 'failed')
      await tx
        .update(tasks)
        .set({
          status: current.status === 'published' ? 'succeeded' : 'failed',
          output: { postId: id, publicationStatus: current.status },
          error: current.status === 'failed' ? 'PUBLISHING_FAILED' : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.userId, userId),
            eq(tasks.idempotencyKey, `task:${userId}:publish:${id}`),
          ),
        );
    return current;
  });
}
export async function publishPost(
  userId: string,
  id: string,
  options: {
    database?: Database;
    providers?: PublishingProviders;
    now?: Date;
  } = {},
) {
  const db = options.database ?? getDatabase();
  const api = options.providers ?? providers;
  const now = options.now ?? new Date();
  const initial = await getPost(userId, id, db);
  if (initial.status === 'published' || initial.status === 'copy_ready')
    return initial;
  if (
    !initial.approvedAt ||
    !initial.approvedDestination ||
    initial.approvedContent !== initial.content
  )
    throw new ApiError(
      422,
      'REVIEW_REQUIRED',
      'Approve the exact text and destination before publishing.',
    );
  if (
    !options.providers &&
    (!process.env.ZERNIO_API_KEY ||
      process.env.ZERNIO_API_KEY.startsWith('REPLACE_WITH_'))
  )
    throw new ApiError(
      503,
      'PUBLISHING_NOT_CONFIGURED',
      'Publishing is not configured. Your approved draft is safe to copy.',
    );
  const attempt = randomUUID();
  const post = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(posts)
      .where(and(eq(posts.id, id), eq(posts.userId, userId)))
      .for('update');
    if (locked.status === 'published') return locked;
    if (
      !locked.approvedAt ||
      !locked.approvedDestination ||
      locked.approvedContent !== locked.content ||
      locked.destination !== 'social'
    )
      throw new ApiError(
        422,
        'REVIEW_REQUIRED',
        'Approve the saved text and destination before publishing.',
      );
    if (
      locked.attemptId &&
      locked.attemptAt &&
      now.getTime() - locked.attemptAt.getTime() < 120000
    )
      throw new ApiError(
        409,
        'PUBLISHING_IN_PROGRESS',
        'Publishing is being checked. Wait before trying again.',
      );
    const target = await destination(
      userId,
      locked.destination,
      locked.socialConnectionId,
      tx,
    );
    if (
      target.destination !== locked.approvedDestination?.destination ||
      target.connectionId !== locked.approvedDestination?.connectionId ||
      target.accountId !== locked.approvedDestination?.accountId ||
      target.platform !== locked.approvedDestination?.platform
    )
      throw new ApiError(
        409,
        'DESTINATION_CHANGED',
        'The connected account changed. Create and review a new draft.',
      );
    const grounding = await checkGrounding(
      userId,
      [{ text: locked.content, fact_ids: locked.factIds }],
      tx,
      { lockFacts: true },
    );
    if (!grounding.canApprove)
      throw new ApiError(
        422,
        'UNGROUNDED_CONTENT',
        'The cited facts changed. Copy the draft and review its claims.',
      );
    const [claimed] = await tx
      .update(posts)
      .set({
        attemptId: attempt,
        attemptAt: now,
        status: 'publishing',
        updatedAt: now,
      })
      .where(eq(posts.id, id))
      .returning();
    return claimed;
  });
  if (post.status === 'published') return post;
  const target = post.approvedDestination!;
  try {
    const connection = await db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.id, target.connectionId!));
    if (post.firstAttemptAt) {
      const existing = post.providerPostId
        ? await api.get(post.providerPostId)
        : await api.find({
            profileId: connection[0].providerProfileId!,
            accountId: target.accountId!,
            platform: target.platform!,
            content: post.approvedContent!,
            fromDate: new Date(post.firstAttemptAt.getTime() - 60000),
          });
      if (existing) return applyProviderPost(userId, id, existing, db);
      if (now.getTime() - post.firstAttemptAt.getTime() >= 24 * 60 * 60 * 1000)
        throw new ApiError(
          409,
          'PUBLICATION_UNCERTAIN',
          'The provider could not confirm this post. Copy the text; another automatic submission could duplicate it.',
        );
    }
    await db
      .update(posts)
      .set({ firstAttemptAt: post.firstAttemptAt ?? now })
      .where(and(eq(posts.id, id), eq(posts.attemptId, attempt)));
    return await db.transaction(async (tx) => {
      // Finish saving the provider response before deletion can start.
      // NO KEY UPDATE permits an early callback's foreign-key check.
      const [owner] = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .for('no key update');
      if (!owner || owner.deletionRequestedAt)
        throw new ApiError(
          403,
          'ACCOUNT_DELETION_PENDING',
          'Account deletion is in progress. This post will not be submitted.',
        );
      const response = await api.publish({
        content: post.approvedContent!,
        platform: target.platform!,
        accountId: target.accountId!,
        idempotencyKey: post.idempotencyKey,
      });
      return applyProviderPost(userId, id, response, db);
    });
  } catch (error) {
    await db
      .update(posts)
      .set({
        status: 'unknown',
        errorCode:
          error instanceof ApiError ? error.code : 'PROVIDER_UNCERTAIN',
        attemptId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(posts.id, id), eq(posts.attemptId, attempt)));
    throw error instanceof ApiError
      ? error
      : new ApiError(
          503,
          'PROVIDER_UNCERTAIN',
          'Publishing could not be confirmed. Your draft is saved; retry checks the provider first.',
        );
  }
}

export async function recordPublishingCallback(
  eventId: string,
  providerPostId: string,
  payload: {
    status: string;
    accountId?: string;
    platform?: string;
    publicUrl?: string;
  },
  db: Database = getDatabase(),
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${providerPostId}, 0))`,
    );
    if (!payload.accountId || !payload.platform)
      return { duplicate: false, ignored: true };
    const [owner] = await tx
      .select({ userId: users.id })
      .from(socialConnections)
      .innerJoin(users, eq(users.id, socialConnections.userId))
      .where(
        and(
          eq(socialConnections.providerAccountId, payload.accountId),
          eq(socialConnections.platform, payload.platform),
          eq(socialConnections.status, 'connected'),
          isNull(users.deletionRequestedAt),
        ),
      );
    if (!owner) return { duplicate: false, ignored: true };
    const [event] = await tx
      .insert(publishingEvents)
      .values({
        userId: owner.userId,
        providerEventId: eventId,
        providerPostId,
        payload,
      })
      .onConflictDoNothing()
      .returning();
    if (!event) return { duplicate: true };
    const [post] = await tx
      .select()
      .from(posts)
      .where(eq(posts.providerPostId, providerPostId))
      .for('update');
    if (!post) return { duplicate: false, pending: true };
    if (
      payload.accountId !== post.approvedDestination?.accountId ||
      payload.platform !== post.approvedDestination?.platform
    )
      return { duplicate: false, ignored: true };
    if (
      payload.status === 'published' ||
      (payload.status === 'failed' && post.status !== 'published')
    )
      await tx
        .update(posts)
        .set({
          status: payload.status,
          publicUrl:
            payload.status === 'published' &&
            payload.publicUrl?.startsWith('https://')
              ? payload.publicUrl
              : post.publicUrl,
          attemptId: null,
          updatedAt: new Date(),
        })
        .where(eq(posts.id, post.id));
    const finalStatus =
      post.status === 'published' || payload.status === 'published'
        ? 'published'
        : payload.status;
    if (finalStatus === 'published' || finalStatus === 'failed')
      await tx
        .update(tasks)
        .set({
          status: finalStatus === 'published' ? 'succeeded' : 'failed',
          output: { postId: post.id, publicationStatus: finalStatus },
          error: finalStatus === 'failed' ? 'PUBLISHING_FAILED' : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.userId, post.userId),
            eq(tasks.idempotencyKey, `task:${post.userId}:publish:${post.id}`),
          ),
        );
    await tx
      .update(publishingEvents)
      .set({ appliedAt: new Date() })
      .where(eq(publishingEvents.id, event.id));
    return { duplicate: false };
  });
}

export async function createPublishTask(
  userId: string,
  id: string,
  db: Database = getDatabase(),
) {
  const post = await getPost(userId, id, db);
  if (!post.approvedAt || post.destination !== 'social')
    throw new ApiError(
      422,
      'REVIEW_REQUIRED',
      'Approve the exact text and social account first.',
    );
  return createTask(
    userId,
    'publish_post',
    `publish:${id}`,
    { postId: id },
    db,
  );
}
export async function runPublishTask(
  userId: string,
  taskId: string,
  options: { database?: Database; providers?: PublishingProviders } = {},
) {
  const db = options.database ?? getDatabase();
  const task = await getTask(userId, taskId, db);
  if (task.kind !== 'publish_post' || typeof task.input.postId !== 'string')
    throw new ApiError(400, 'INVALID_TASK', 'This is not a publishing task.');
  if (task.status === 'succeeded') return task;
  if (task.status === 'queued' || task.status === 'failed')
    await startTask(userId, taskId, db);
  try {
    const post = await publishPost(userId, task.input.postId, options);
    if (post.status === 'published' || post.status === 'failed')
      await db
        .update(tasks)
        .set({
          status: post.status === 'published' ? 'succeeded' : 'failed',
          output: { postId: post.id, publicationStatus: post.status },
          error: post.status === 'failed' ? 'PUBLISHING_FAILED' : null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));
    return getTask(userId, taskId, db);
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'PUBLISHING_IN_PROGRESS'))
      await db
        .update(tasks)
        .set({
          status: 'failed',
          error: error instanceof ApiError ? error.code : 'PROVIDER_UNCERTAIN',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.userId, userId),
            eq(tasks.status, 'running'),
          ),
        );
    throw error;
  }
}
