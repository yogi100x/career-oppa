import { and, desc, eq, or } from 'drizzle-orm';
import {
  companies,
  contacts,
  getDatabase,
  tasks,
  type Database,
  type Transaction,
} from '@career-workspace/db';
import {
  GetLeadsError,
  revealGetLeadsEmail,
  searchGetLeadsContacts,
  type GetLeadsPerson,
} from '@career-workspace/adapters/getleads';
import { ApiError } from './api';
import { getOpportunity } from './roles';
import { createTask, failTask, getTask, startTask } from './tasks';
import { CreditError, withCredits } from './credits';
import { checkRateLimit } from './rate-limit';
import { isEmailSuppressed } from './suppressions';

/** Per-user contact search limits; every search may call the paid provider. */
export const CONTACTS_SEARCH_PER_MINUTE_LIMIT = 5;
export const CONTACTS_SEARCH_DAILY_LIMIT = 30;

async function checkContactsSearchLimits(
  userId: string,
  database: Database,
) {
  const minute = await checkRateLimit(
    userId,
    'contacts_search',
    { limit: CONTACTS_SEARCH_PER_MINUTE_LIMIT, windowMs: 60_000 },
    database,
  );
  if (!minute.allowed)
    throw new ApiError(
      429,
      'RATE_LIMITED',
      'Wait a minute before starting another contact search.',
    );
  const day = await checkRateLimit(
    userId,
    'contacts_search_daily',
    { limit: CONTACTS_SEARCH_DAILY_LIMIT, windowMs: 24 * 60 * 60_000 },
    database,
  );
  if (!day.allowed)
    throw new ApiError(
      429,
      'RATE_LIMITED',
      'You have reached today\'s contact search limit. Try again tomorrow.',
    );
}

type Searcher = typeof searchGetLeadsContacts;
type EmailRevealer = typeof revealGetLeadsEmail;
class ContactAlreadyRevealed extends Error {}

function normalizeCompanyName(name: string) {
  // Adapts the reference/contact-extract.mjs identity normalization (MIT;
  // license retained at reference/LICENSE) for shared company deduplication.
  return name.trim().normalize('NFC').replace(/\s+/g, ' ').toLowerCase();
}

function normalizeDomain(value: string | null): string | null {
  if (!value) return null;
  const input = value.trim();
  if (!input) return null;
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return hostname.includes('.') && !hostname.includes('..') ? hostname : null;
  } catch {
    return null;
  }
}

async function getOrCreateCompany(
  record: GetLeadsPerson,
  database: Database | Transaction,
) {
  const normalizedName = normalizeCompanyName(record.companyName);
  const domain = normalizeDomain(record.companyDomain ?? record.companyWebsite);
  const where = domain
    ? or(
        eq(companies.domain, domain),
        eq(companies.normalizedName, normalizedName),
      )
    : eq(companies.normalizedName, normalizedName);
  const [existing] = await database
    .select()
    .from(companies)
    .where(where)
    .limit(1);
  if (existing) {
    if (!existing.domain && domain) {
      const [updated] = await database
        .update(companies)
        .set({ domain })
        .where(eq(companies.id, existing.id))
        .returning();
      return updated;
    }
    return existing;
  }
  const [inserted] = await database
    .insert(companies)
    .values({ name: record.companyName, normalizedName, domain })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [raced] = await database.select().from(companies).where(where).limit(1);
  if (!raced)
    throw new ApiError(
      500,
      'COMPANY_SAVE_FAILED',
      'The company could not be saved.',
    );
  return raced;
}

export async function createContactsSearchTask(
  userId: string,
  opportunityId: string,
  requestKey: string,
  database: Database = getDatabase(),
) {
  if (!requestKey.trim() || requestKey.length > 200)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Provide a valid task kind and request key.',
    );
  const { job } = await getOpportunity(userId, opportunityId, database);
  const idempotencyKey = `task:${userId}:${requestKey}`;
  const [existing] = await database
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.userId, userId), eq(tasks.idempotencyKey, idempotencyKey)),
    )
    .limit(1);
  if (existing) {
    if (existing.kind !== 'contacts_search')
      throw new ApiError(
        409,
        'REQUEST_KEY_CONFLICT',
        'This request key belongs to another task.',
      );
    if (existing.input.opportunityId !== opportunityId)
      throw new ApiError(
        409,
        'REQUEST_KEY_CONFLICT',
        'This request key belongs to another contact search.',
      );
    // A queued or failed task is started again by the route, which runs
    // another provider search, so it uses a limit slot like a new search.
    if (existing.status === 'queued' || existing.status === 'failed')
      await checkContactsSearchLimits(userId, database);
    return existing;
  }
  await checkContactsSearchLimits(userId, database);
  const task = await createTask(
    userId,
    'contacts_search',
    requestKey,
    {
      opportunityId,
      companyName: job.company,
      role: job.title,
    },
    database,
  );
  if (task.input.opportunityId !== opportunityId)
    throw new ApiError(
      409,
      'REQUEST_KEY_CONFLICT',
      'This request key belongs to another contact search.',
    );
  return task;
}

export async function listContacts(
  userId: string,
  opportunityId: string,
  database: Database = getDatabase(),
) {
  await getOpportunity(userId, opportunityId, database);
  const records = await database
    .select({ contact: contacts, companyName: companies.name })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(
      and(
        eq(contacts.userId, userId),
        eq(contacts.opportunityId, opportunityId),
      ),
    )
    .orderBy(desc(contacts.createdAt));
  return records.map(({ contact, companyName }) => ({
    id: contact.id,
    name: contact.name,
    title: contact.title,
    companyName,
    email: contact.email,
    emailStatus: contact.emailStatus,
    revealedAt: contact.revealedAt,
    source: contact.source,
    sourceDate: contact.sourceDate,
    createdAt: contact.createdAt,
  }));
}

/** Returns reveal state only after verifying the row belongs to this user. */
export async function getContact(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new ApiError(404, 'NOT_FOUND', 'Contact not found.');
  const [record] = await database
    .select({ contact: contacts, companyName: companies.name })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.userId, userId), eq(contacts.id, id)))
    .limit(1);
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Contact not found.');
  return {
    id: record.contact.id,
    userId: record.contact.userId,
    opportunityId: record.contact.opportunityId,
    providerContactId: record.contact.providerContactId,
    providerProfileUrl: record.contact.providerProfileUrl,
    name: record.contact.name,
    title: record.contact.title,
    companyName: record.companyName,
    email: record.contact.email,
    emailStatus: record.contact.emailStatus,
    revealedAt: record.contact.revealedAt,
    source: record.contact.source,
    sourceDate: record.contact.sourceDate,
    createdAt: record.contact.createdAt,
  };
}

/** Reveal one owner's contact email; the provider lookup is injected in tests. */
export async function revealContactEmail(
  userId: string,
  contactId: string,
  options: {
    database?: Database;
    reveal?: EmailRevealer;
    now?: () => Date;
  } = {},
) {
  const database = options.database ?? getDatabase();
  const contact = await getContact(userId, contactId, database);
  if (contact.email && contact.revealedAt)
    return { contact, charged: false, alreadyRevealed: true };
  if (contact.email && (await isEmailSuppressed(contact.email, database)))
    throw new ApiError(
      409,
      'CONTACT_SUPPRESSED',
      'This contact is suppressed and cannot be revealed.',
    );
  if (!contact.providerProfileUrl)
    throw new ApiError(
      422,
      'CONTACT_EMAIL_NOT_FOUND',
      'This contact does not have a profile that supports email lookup.',
    );

  const limit = await checkRateLimit(
    userId,
    'contact_reveal',
    { limit: 10, windowMs: 60_000 },
    database,
  );
  if (!limit.allowed)
    throw new ApiError(
      429,
      'RATE_LIMITED',
      'Wait a minute before another email lookup.',
    );

  let savedByThisCall = false;
  let result: { type: string; id: string };
  try {
    // One hold key per contact: the credit hold's unique active key admits a
    // single in-flight reveal, so no row lock is held during the provider call.
    result = await withCredits(
      userId,
      'contact_reveal',
      `contact-reveal:${contactId}`,
      async () => {
        const current = await getContact(userId, contactId, database);
        if (current.email && current.revealedAt)
          throw new ContactAlreadyRevealed();
        let resolved: Awaited<ReturnType<EmailRevealer>>;
        if (current.email) {
          resolved = {
            email: current.email,
            emailStatus: current.emailStatus as
              'unknown' | 'VALID' | 'CATCH_ALL',
          };
        } else {
          try {
            resolved = await (options.reveal ?? revealGetLeadsEmail)(
              current.providerProfileUrl ?? contact.providerProfileUrl!,
            );
          } catch (error) {
            if (error instanceof GetLeadsError)
              throw new ApiError(
                503,
                error.code,
                error.code === 'GETLEADS_NOT_CONFIGURED'
                  ? 'Email lookup is not configured yet.'
                  : 'Email lookup is temporarily unavailable.',
              );
            throw error;
          }
        }
        const saved = await database.transaction(async (tx) => {
          const [locked] = await tx
            .select()
            .from(contacts)
            .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
            .for('update');
          if (!locked)
            throw new ApiError(404, 'NOT_FOUND', 'Contact not found.');
          if (locked.email && locked.revealedAt)
            throw new ContactAlreadyRevealed();
          if (await isEmailSuppressed(resolved.email, tx))
            throw new ApiError(
              409,
              'CONTACT_SUPPRESSED',
              'This contact is suppressed and cannot be revealed.',
            );
          const [updated] = await tx
            .update(contacts)
            .set({
              email: resolved.email,
              emailStatus: resolved.emailStatus,
              revealedAt: (options.now ?? (() => new Date()))(),
            })
            .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
            .returning();
          return { contact: updated, updatedNow: true };
        });
        savedByThisCall = saved.updatedNow;
        return { type: 'contact', id: saved.contact.id };
      },
      { database },
    );
  } catch (error) {
    if (error instanceof ContactAlreadyRevealed)
      return {
        contact: await getContact(userId, contactId, database),
        charged: false,
        alreadyRevealed: true,
      };
    if (error instanceof CreditError && error.code === 'ACTION_IN_PROGRESS') {
      // The same idempotency key can arrive while the first lookup is running.
      // Wait briefly for the contact row lock holder to save the result.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const latest = await getContact(userId, contactId, database);
        if (latest.email && latest.revealedAt)
          return { contact: latest, charged: false, alreadyRevealed: true };
      }
    }
    throw error;
  }
  const latest = await getContact(userId, result.id, database);
  return {
    contact: latest,
    charged: savedByThisCall,
    alreadyRevealed: !savedByThisCall,
  };
}

/** Plain task body used by the Vercel Workflow wrapper and real DB tests. */
export async function runContactsSearch(
  userId: string,
  taskId: string,
  options: { database?: Database; search?: Searcher; now?: () => Date } = {},
) {
  const database = options.database ?? getDatabase();
  const task = await getTask(userId, taskId, database);
  if (task.kind !== 'contacts_search')
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'This is not a contact search task.',
    );
  if (task.status === 'succeeded') return task;
  await startTask(userId, taskId, database);

  try {
    const opportunityId =
      typeof task.input.opportunityId === 'string'
        ? task.input.opportunityId
        : '';
    const { job } = await getOpportunity(userId, opportunityId, database);
    const people = await (options.search ?? searchGetLeadsContacts)({
      companyName: job.company,
      role: job.title,
      limit: 25,
    });
    const searchedAt = (options.now ?? (() => new Date()))();

    return await database.transaction(async (tx) => {
      const saved = [];
      for (const person of people) {
        const company = await getOrCreateCompany(person, tx);
        const [contact] = await tx
          .insert(contacts)
          .values({
            userId,
            opportunityId,
            companyId: company.id,
            providerContactId: person.providerContactId,
            providerProfileUrl: person.providerProfileUrl,
            name: person.name,
            title: person.title,
            emailStatus: person.emailStatus,
            source: 'getleads',
            sourceDate: person.refreshedAt ?? searchedAt,
          })
          .onConflictDoUpdate({
            target: [
              contacts.userId,
              contacts.opportunityId,
              contacts.providerContactId,
            ],
            set: {
              companyId: company.id,
              providerProfileUrl: person.providerProfileUrl,
              name: person.name,
              title: person.title,
              emailStatus: person.emailStatus,
              sourceDate: person.refreshedAt ?? searchedAt,
            },
          })
          .returning();
        saved.push(contact);
      }
      const [completed] = await tx
        .update(tasks)
        .set({
          status: 'succeeded',
          output: {
            contactIds: saved.map(({ id }) => id),
            count: saved.length,
          },
          error: null,
          updatedAt: searchedAt,
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.userId, userId),
            eq(tasks.status, 'running'),
          ),
        )
        .returning();
      if (!completed)
        throw new ApiError(
          409,
          'TASK_NOT_RUNNING',
          'This search task is no longer running.',
        );
      return completed;
    });
  } catch (error) {
    const code =
      error instanceof ApiError
        ? error.code
        : typeof error === 'object' && error && 'code' in error
          ? String(error.code)
          : 'CONTACTS_SEARCH_FAILED';
    return failTask(
      userId,
      taskId,
      /^[A-Z_0-9]{1,64}$/.test(code) ? code : 'CONTACTS_SEARCH_FAILED',
      database,
    );
  }
}
