import { and, desc, eq } from 'drizzle-orm';
import {
  contacts,
  getDatabase,
  outreachDrafts,
  profileFacts,
  reminders,
  users,
  type Database,
  type Transaction,
} from '@career-workspace/db';
import {
  createOutreachSchema,
  outreachContentSchema,
  outreachHandoffSchema,
  type OutreachContent,
} from '@career-workspace/contracts';
import { generateStructured } from '@career-workspace/adapters/ai';
import { ApiError } from './api';
import { getOpportunity } from './roles';
import { checkGrounding } from './grounding';
import { withCredits } from './credits';
import { recordEvent } from './events';
import { addSuppressionInTransaction, isEmailSuppressed } from './suppressions';

const prompt = new URL(
  '../../adapters/src/ai/prompts/outreach.v2.md',
  import.meta.url,
);
type Store = Database | Transaction;
const isId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );

async function ownContact(userId: string, id: string, database: Store) {
  if (!isId(id)) throw new ApiError(404, 'NOT_FOUND', 'Contact not found.');
  const [contact] = await database
    .select()
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.id, id)));
  if (!contact) throw new ApiError(404, 'NOT_FOUND', 'Contact not found.');
  return contact;
}
async function contactable(userId: string, contactId: string, database: Store) {
  const contact = await ownContact(userId, contactId, database);
  if (!contact.email || !contact.revealedAt)
    throw new ApiError(
      422,
      'EMAIL_NOT_REVEALED',
      'Reveal the contact email before drafting outreach.',
    );
  if (await isEmailSuppressed(contact.email, database))
    throw new ApiError(
      422,
      'CONTACT_SUPPRESSED',
      'This address is on the do-not-contact list. No credits have been charged.',
    );
  return contact;
}

export async function getOutreach(
  userId: string,
  id: string,
  database: Store = getDatabase(),
) {
  if (!isId(id)) throw new ApiError(404, 'NOT_FOUND', 'Draft not found.');
  const [draft] = await database
    .select()
    .from(outreachDrafts)
    .where(and(eq(outreachDrafts.userId, userId), eq(outreachDrafts.id, id)));
  if (!draft) throw new ApiError(404, 'NOT_FOUND', 'Draft not found.');
  return draft;
}
export async function listOutreach(
  userId: string,
  opportunityId: string,
  database: Database = getDatabase(),
) {
  await getOpportunity(userId, opportunityId, database);
  return database
    .select()
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.userId, userId),
        eq(outreachDrafts.opportunityId, opportunityId),
      ),
    )
    .orderBy(desc(outreachDrafts.createdAt));
}

export async function createOutreach(
  userId: string,
  opportunityId: string,
  input: { contactId: string },
  key: string,
  options: { database?: Database; generate?: typeof generateStructured } = {},
) {
  const parsed = createOutreachSchema.safeParse(input);
  if (!parsed.success || !key.trim() || key.length > 150)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Choose a contact and provide a request key.',
    );
  const database = options.database ?? getDatabase();
  const { job } = await getOpportunity(userId, opportunityId, database);
  const contact = await contactable(userId, input.contactId, database);
  if (contact.opportunityId !== opportunityId)
    throw new ApiError(404, 'NOT_FOUND', 'Contact not found for this role.');
  const facts = await database
    .select({ id: profileFacts.id, text: profileFacts.text })
    .from(profileFacts)
    .where(
      and(eq(profileFacts.userId, userId), eq(profileFacts.status, 'approved')),
    );
  if (!facts.length)
    throw new ApiError(
      422,
      'NO_APPROVED_FACTS',
      'Approve facts in your profile before drafting outreach.',
    );
  const [candidate] = await database
    .select({ name: users.cvName })
    .from(users)
    .where(eq(users.id, userId));
  if (
    !options.generate &&
    (!process.env.OPENROUTER_API_KEY ||
      process.env.OPENROUTER_API_KEY.startsWith('REPLACE_WITH_'))
  )
    throw new ApiError(
      503,
      'AI_NOT_CONFIGURED',
      'AI drafting is not configured yet. Your credits have not been charged.',
    );
  const result = await withCredits(
    userId,
    'outreach_draft',
    `outreach:${opportunityId}:${contact.id}:${key}`,
    async () => {
      const generated = await (options.generate ?? generateStructured)(
        prompt,
        outreachContentSchema,
        {
          job: { title: job.title, company: job.company, text: job.text },
          contact: { name: contact.name, title: contact.title },
          candidateName: candidate?.name ?? '',
          approvedFacts: facts,
        },
      );
      const content = outreachContentSchema.parse(generated.object);
      const saved = await database.transaction(async (tx) => {
        await contactable(userId, contact.id, tx);
        const grounding = await checkGrounding(
          userId,
          [{ text: content.body, fact_ids: content.fact_ids }],
          tx,
          { lockFacts: true },
        );
        if (!grounding.canApprove)
          throw new ApiError(
            422,
            'UNGROUNDED_CONTENT',
            'The draft contains unsupported claims. Your credits have not been charged.',
          );
        const [draft] = await tx
          .insert(outreachDrafts)
          .values({
            userId,
            opportunityId,
            contactId: contact.id,
            subject: content.subject,
            body: content.body,
            factIds: content.fact_ids,
            promptVersion: generated.promptVersion,
            model: generated.model,
          })
          .returning();
        await recordEvent(
          {
            userId,
            type: 'outreach.drafted',
            subjectType: 'opportunity',
            subjectId: opportunityId,
            data: { outreachId: draft.id, contactId: contact.id },
          },
          tx,
        );
        return draft;
      });
      return { type: 'outreach', id: saved.id };
    },
    { database },
  );
  return getOutreach(userId, result.id, database);
}

export async function editOutreach(
  userId: string,
  id: string,
  input: OutreachContent,
  database: Database = getDatabase(),
) {
  const content = outreachContentSchema.safeParse(input);
  if (!content.success)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Check the draft and its supporting facts.',
    );
  return database.transaction(async (tx) => {
    await getOutreach(userId, id, tx);
    const [draft] = await tx
      .select()
      .from(outreachDrafts)
      .where(and(eq(outreachDrafts.userId, userId), eq(outreachDrafts.id, id)))
      .for('update');
    if (draft.status === 'marked_sent')
      throw new ApiError(
        409,
        'ALREADY_SENT',
        'Create a new draft to change an email already marked sent.',
      );
    const [saved] = await tx
      .update(outreachDrafts)
      .set({
        subject: content.data.subject,
        body: content.data.body,
        factIds: content.data.fact_ids,
        status: 'draft',
        handoffMethod: null,
        handedOffAt: null,
        updatedAt: new Date(),
      })
      .where(eq(outreachDrafts.id, id))
      .returning();
    await recordEvent(
      {
        userId,
        type: 'outreach.edited',
        subjectType: 'opportunity',
        subjectId: draft.opportunityId,
        data: { outreachId: id },
      },
      tx,
    );
    return saved;
  });
}

export async function handoffOutreach(
  userId: string,
  id: string,
  input: {
    confirmed: true;
    subject: string;
    body: string;
    method: 'copy' | 'mailto';
  },
  database: Database = getDatabase(),
) {
  const parsed = outreachHandoffSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Confirm the exact draft before copying or opening your email app.',
    );
  return database.transaction(async (tx) => {
    await getOutreach(userId, id, tx);
    const [draft] = await tx
      .select()
      .from(outreachDrafts)
      .where(and(eq(outreachDrafts.userId, userId), eq(outreachDrafts.id, id)))
      .for('update');
    const contact = await contactable(userId, draft.contactId, tx);
    if (
      draft.subject !== parsed.data.subject ||
      draft.body !== parsed.data.body
    )
      throw new ApiError(
        409,
        'DRAFT_CHANGED',
        'The draft changed. Review and confirm the current text.',
      );
    if (draft.status === 'marked_sent')
      throw new ApiError(
        409,
        'ALREADY_SENT',
        'This draft has already been marked sent.',
      );
    const grounding = await checkGrounding(
      userId,
      [{ text: draft.body, fact_ids: draft.factIds }],
      tx,
      { lockFacts: true },
    );
    if (!grounding.canApprove)
      throw new ApiError(
        422,
        'UNGROUNDED_CONTENT',
        'Approve the supporting facts before handoff.',
      );
    if (draft.status !== 'handed_off' || draft.handoffMethod !== input.method) {
      await tx
        .update(outreachDrafts)
        .set({
          status: 'handed_off',
          handoffMethod: input.method,
          handedOffAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(outreachDrafts.id, id));
      await recordEvent(
        {
          userId,
          type: 'outreach.handed_off',
          subjectType: 'opportunity',
          subjectId: draft.opportunityId,
          data: { outreachId: id, method: input.method },
        },
        tx,
      );
    }
    return {
      recipient: contact.email!,
      subject: draft.subject,
      body: draft.body,
      mailtoUrl: `mailto:${encodeURIComponent(contact.email!)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`,
    };
  });
}

export async function markOutreachSent(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  return database.transaction(async (tx) => {
    await getOutreach(userId, id, tx);
    const [draft] = await tx
      .select()
      .from(outreachDrafts)
      .where(and(eq(outreachDrafts.userId, userId), eq(outreachDrafts.id, id)))
      .for('update');
    if (draft.status === 'marked_sent') return draft;
    if (draft.status !== 'handed_off')
      throw new ApiError(
        409,
        'NOT_HANDED_OFF',
        'Copy the draft or open it in your email app before marking it sent.',
      );
    const now = new Date();
    const [saved] = await tx
      .update(outreachDrafts)
      .set({ status: 'marked_sent', markedSentAt: now, updatedAt: now })
      .where(eq(outreachDrafts.id, id))
      .returning();
    const contact = await ownContact(userId, draft.contactId, tx);
    if (
      !draft.repliedAt &&
      !draft.optedOutAt &&
      contact.email &&
      !(await isEmailSuppressed(contact.email, tx))
    ) {
      await tx
        .insert(reminders)
        .values({
          userId,
          opportunityId: draft.opportunityId,
          contactId: draft.contactId,
          outreachId: id,
          title: `Follow up with ${contact.name}`,
          dueAt: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
        })
        .onConflictDoNothing();
    }
    await recordEvent(
      {
        userId,
        type: 'outreach.marked_sent',
        subjectType: 'opportunity',
        subjectId: draft.opportunityId,
        data: { outreachId: id, confirmation: 'candidate_reported' },
      },
      tx,
    );
    return saved;
  });
}

export async function markContactOutcome(
  userId: string,
  contactId: string,
  outcome: 'reply' | 'opt_out',
  database: Database = getDatabase(),
) {
  const contact = await ownContact(userId, contactId, database);
  return database.transaction(async (tx) => {
    const now = new Date();
    if (outcome === 'opt_out') {
      if (!contact.email)
        throw new ApiError(
          422,
          'EMAIL_NOT_REVEALED',
          'Reveal the contact address before recording an email opt-out.',
        );
      await addSuppressionInTransaction(
        userId,
        { email: contact.email, reason: 'Opt-out reported by the candidate' },
        tx,
      );
    }
    await tx
      .update(outreachDrafts)
      .set({
        ...(outcome === 'reply' ? { repliedAt: now } : { optedOutAt: now }),
        updatedAt: now,
      })
      .where(
        and(
          eq(outreachDrafts.userId, userId),
          eq(outreachDrafts.contactId, contactId),
        ),
      );
    await tx
      .update(reminders)
      .set({ status: 'stopped', updatedAt: now })
      .where(
        and(
          eq(reminders.userId, userId),
          eq(reminders.contactId, contactId),
          eq(reminders.status, 'pending'),
        ),
      );
    await recordEvent(
      {
        userId,
        type:
          outcome === 'reply'
            ? 'contact.reply_recorded'
            : 'contact.opt_out_recorded',
        subjectType: 'opportunity',
        subjectId: contact.opportunityId,
        data: { contactId },
      },
      tx,
    );
    return { contactId, outcome };
  });
}
