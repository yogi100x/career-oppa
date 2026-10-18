import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  getDatabase,
  fitReviews,
  jobs,
  opportunities,
  users,
  type Database,
} from '@career-workspace/db';
import type { CreateJob } from '@career-workspace/contracts';
import {
  fetchJobPage,
  extractJobText,
  LinkFetchError,
} from '@career-workspace/adapters';
import { ApiError } from './api';
import { recordEvent } from './events';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const canonicalText = (value: string) =>
  value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
export function canonicalJobUrl(input: string): string {
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new ApiError(400, 'UNSAFE_URL', 'Use an ordinary website link.');
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

export async function createJob(
  userId: string,
  input: CreateJob,
  options: {
    database?: Database;
    fetch?: typeof fetchJobPage;
    source?: 'extension';
  } = {},
) {
  const database = options.database ?? getDatabase();
  const url = input.url ? canonicalJobUrl(input.url) : null;
  const urlHash = url ? hash(url) : null;
  if (urlHash) {
    const [existing] = await database
      .select({ opportunity: opportunities, job: jobs })
      .from(jobs)
      .innerJoin(
        opportunities,
        and(eq(opportunities.jobId, jobs.id), eq(opportunities.userId, userId)),
      )
      .where(and(eq(jobs.userId, userId), eq(jobs.canonicalUrlHash, urlHash)));
    if (existing) return existing;
  }
  let text = input.text;
  let fetchedAt: Date | null = null;
  if (!text && url) {
    try {
      const page = await (options.fetch ?? fetchJobPage)(url);
      text = extractJobText(page.text, page.contentType);
      fetchedAt = new Date();
    } catch (error) {
      if (error instanceof LinkFetchError)
        throw new ApiError(
          error.code === 'UNSAFE_URL' ? 400 : 422,
          error.code,
          error.message,
        );
      throw error;
    }
  }
  if (!text || text.trim().length < 120)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Paste the full role description.',
    );
  const jobText = text.trim();
  if (jobText.length > 100_000)
    throw new ApiError(
      422,
      'NEEDS_PASTE',
      'This page has too much text. Paste the role description instead.',
    );
  const textHash = hash(url ? jobText : canonicalText(jobText));
  const textHashCandidates = url ? [] : [...new Set([textHash, hash(jobText)])];
  return database.transaction(async (tx) => {
    // The user's lock serialises a same-link race and the two inserts commit together.
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (urlHash) {
      const [existing] = await tx
        .select({ opportunity: opportunities, job: jobs })
        .from(jobs)
        .innerJoin(
          opportunities,
          and(
            eq(opportunities.jobId, jobs.id),
            eq(opportunities.userId, userId),
          ),
        )
        .where(
          and(eq(jobs.userId, userId), eq(jobs.canonicalUrlHash, urlHash)),
        );
      if (existing) return existing;
    }
    if (textHashCandidates.length) {
      const [existing] = await tx
        .select({ opportunity: opportunities, job: jobs })
        .from(jobs)
        .innerJoin(
          opportunities,
          and(
            eq(opportunities.jobId, jobs.id),
            eq(opportunities.userId, userId),
          ),
        )
        .where(
          and(
            eq(jobs.userId, userId),
            inArray(jobs.textHash, textHashCandidates),
          ),
        )
        .limit(1);
      if (existing) return existing;
    }
    const [job] = await tx
      .insert(jobs)
      .values({
        userId,
        title: input.title,
        company: input.company,
        location: input.location || null,
        url,
        canonicalUrlHash: urlHash,
        textHash,
        text: jobText,
        source: options.source ?? (input.text ? 'paste' : 'url'),
        fetchedAt,
      })
      .returning();
    const [opportunity] = await tx
      .insert(opportunities)
      .values({ userId, jobId: job.id })
      .returning();
    await recordEvent(
      {
        userId,
        type: 'opportunity.created',
        subjectType: 'opportunity',
        subjectId: opportunity.id,
        data: { title: job.title, company: job.company },
      },
      tx,
    );
    return { job, opportunity };
  });
}

export async function listOpportunities(
  userId: string,
  database: Database = getDatabase(),
) {
  return database
    .select({
      opportunity: opportunities,
      job: jobs,
      fitBand: sql<import('@career-workspace/contracts').FitScoreBand | null>`(select scorecard->>'band' from ${fitReviews} where ${fitReviews.opportunityId} = ${opportunities.id} and ${fitReviews.userId} = ${userId} order by ${fitReviews.createdAt} desc limit 1)`,
      hasFitReview: sql<boolean>`exists (select 1 from ${fitReviews} where ${fitReviews.opportunityId} = ${opportunities.id} and ${fitReviews.userId} = ${userId})`,
    })
    .from(opportunities)
    .innerJoin(
      jobs,
      and(eq(jobs.id, opportunities.jobId), eq(jobs.userId, userId)),
    )
    .where(eq(opportunities.userId, userId))
    .orderBy(desc(opportunities.createdAt));
}
export async function getOpportunity(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new ApiError(404, 'NOT_FOUND', 'Role not found.');
  const [record] = await database
    .select({ opportunity: opportunities, job: jobs })
    .from(opportunities)
    .innerJoin(
      jobs,
      and(eq(jobs.id, opportunities.jobId), eq(jobs.userId, userId)),
    )
    .where(and(eq(opportunities.userId, userId), eq(opportunities.id, id)));
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Role not found.');
  return record;
}
