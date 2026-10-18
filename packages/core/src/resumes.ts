import { and, desc, eq } from 'drizzle-orm';
import {
  getDatabase,
  profileFacts,
  resumeVersions,
  opportunities,
  users,
  creditHolds,
  type Database,
} from '@career-workspace/db';
import {
  resumeClaims,
  resumeContentSchema,
  sortResumeEntries,
  tailoredCvDraftSchema,
  type ResumeContent,
} from '@career-workspace/contracts';
import {
  generateStructured,
  tailorCvPrompt,
} from '@career-workspace/adapters/ai';
import { ApiError } from './api';
import { getOpportunity } from './roles';
import { checkGrounding } from './grounding';
import { getResumePreparation } from './resume-preparation-service';
import { rankResumeContentForRole } from './resume-preparation';
import { getResumePdfInspection } from './resume-inspection';
import { keywordCoverage } from './keyword-coverage';
import { CreditError, withCredits } from './credits';
import { recordEvent } from './events';

export async function getResume(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new ApiError(404, 'NOT_FOUND', 'CV version not found.');
  const [resume] = await database
    .select()
    .from(resumeVersions)
    .where(and(eq(resumeVersions.userId, userId), eq(resumeVersions.id, id)));
  if (!resume) throw new ApiError(404, 'NOT_FOUND', 'CV version not found.');
  return resume;
}
export async function listResumeVersions(
  userId: string,
  opportunityId: string,
  database: Database = getDatabase(),
) {
  await getOpportunity(userId, opportunityId, database);
  return database
    .select()
    .from(resumeVersions)
    .where(
      and(
        eq(resumeVersions.userId, userId),
        eq(resumeVersions.opportunityId, opportunityId),
      ),
    )
    .orderBy(desc(resumeVersions.version));
}
export async function getResumeGrounding(
  userId: string,
  id: string,
  database: Database = getDatabase(),
  options: { checkWording?: boolean } = {},
) {
  const resume = await getResume(userId, id, database);
  return checkGrounding(
    userId,
    resumeClaims(resume.content),
    database,
    // Recheck wording for every version, including older approved CVs, so a
    // newly detected unsupported claim blocks preview and download.
    { checkWording: options.checkWording ?? true },
  );
}

/** Job terms the CV's cited approved facts show, and the ones they do not. */
export async function getResumeKeywordCoverage(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  const resume = await getResume(userId, id, database);
  const { job } = await getOpportunity(userId, resume.opportunityId, database);
  const grounding = await checkGrounding(
    userId,
    resumeClaims(resume.content),
    database,
  );
  return keywordCoverage(
    job.text,
    grounding.items.flatMap((item) => item.approvedFacts.map((f) => f.text)),
    [job.company, job.location ?? ''],
  );
}

/** Renders the version at its page size and counts pages (one A4 page is the target). */
export async function getResumePageCount(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  const resume = await getResume(userId, id, database);
  const inspection = await getResumePdfInspection({
    ownerId: userId, resumeId: resume.id, content: resume.content,
    pageSize: resume.pageSize === 'LETTER' ? 'LETTER' : 'A4',
  });
  return inspection.pageCount;
}

export async function saveResumeVersion(
  userId: string,
  opportunityId: string,
  content: ResumeContent,
  options: {
    database?: Database;
    promptVersion?: string;
    model?: string;
    restoredFromId?: string;
    reusedFromId?: string;
    requestKey?: string;
    pageSize?: 'A4' | 'LETTER';
  } = {},
) {
  const database = options.database ?? getDatabase();
  await getOpportunity(userId, opportunityId, database);
  const validated = resumeContentSchema.safeParse(content);
  if (!validated.success)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Check the CV sections and bullets.',
    );
  // Dated roles are always stored newest first.
  const ordered = sortResumeEntries(validated.data);
  const grounding = await checkGrounding(
    userId,
    resumeClaims(ordered),
    database,
    { checkWording: true },
  );
  return database.transaction(async (tx) => {
    await tx
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.id, opportunityId),
          eq(opportunities.userId, userId),
        ),
      )
      .for('update');
    if (options.requestKey) {
      const [existing] = await tx
        .select()
        .from(resumeVersions)
        .where(
          and(
            eq(resumeVersions.userId, userId),
            eq(resumeVersions.opportunityId, opportunityId),
            eq(resumeVersions.requestKey, options.requestKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (
          existing.restoredFromId !== (options.restoredFromId ?? null) ||
          existing.reusedFromId !== (options.reusedFromId ?? null)
        )
          throw new ApiError(
            409,
            'REQUEST_KEY_CONFLICT',
            'This request key was already used for a different saved CV.',
          );
        return existing;
      }
    }
    const [latest] = await tx
      .select({ version: resumeVersions.version })
      .from(resumeVersions)
      .where(
        and(
          eq(resumeVersions.userId, userId),
          eq(resumeVersions.opportunityId, opportunityId),
        ),
      )
      .orderBy(desc(resumeVersions.version))
      .limit(1);
    const [profile] = await tx
      .select({ paperSize: users.paperSize })
      .from(users)
      .where(eq(users.id, userId));
    // Edits and restores pass their version's size; new drafts follow the
    // user's current paper preference.
    const pageSize =
      options.pageSize ??
      (profile?.paperSize as 'A4' | 'LETTER' | undefined) ??
      'A4';
    const [resume] = await tx
      .insert(resumeVersions)
      .values({
        userId,
        opportunityId,
        content: ordered,
        version: Number(latest?.version ?? 0) + 1,
        pageSize,
        groundingFlags: grounding.items.flatMap((item, index) =>
          item.grounded
            ? []
            : [{ index, codes: item.flags.map((flag) => flag.code) }],
        ),
        promptVersion: options.promptVersion,
        model: options.model,
        restoredFromId: options.restoredFromId,
        reusedFromId: options.reusedFromId,
        requestKey: options.requestKey,
      })
      .returning();
    await recordEvent(
      {
        userId,
        type: options.reusedFromId
          ? 'resume.reused'
          : options.restoredFromId
            ? 'resume.restored'
            : 'resume.version_saved',
        subjectType: 'opportunity',
        subjectId: opportunityId,
        data: { resumeId: resume.id, version: resume.version, ...(options.reusedFromId ? { reusedFromId: options.reusedFromId } : {}) },
      },
      tx,
    );
    return resume;
  });
}
export async function editResume(
  userId: string,
  id: string,
  content: ResumeContent,
  database: Database = getDatabase(),
) {
  const previous = await getResume(userId, id, database);
  return saveResumeVersion(userId, previous.opportunityId, content, {
    database,
    pageSize: previous.pageSize as 'A4' | 'LETTER',
  });
}
export async function restoreResume(
  userId: string,
  id: string,
  database: Database = getDatabase(),
) {
  const previous = await getResume(userId, id, database);
  return saveResumeVersion(userId, previous.opportunityId, previous.content, {
    database,
    restoredFromId: previous.id,
    pageSize: previous.pageSize as 'A4' | 'LETTER',
  });
}
export async function createTailoredResume(
  userId: string,
  opportunityId: string,
  key: string,
  options: {
    database?: Database;
    generate?: typeof generateStructured;
    confirmedSkills?: boolean;
    preparationToken?: string;
    /** Server-computed only: fresh output from getResumePreparation for this user and role, never request data. */
    preparation?: Awaited<ReturnType<typeof getResumePreparation>>;
  } = {},
) {
  const database = options.database ?? getDatabase();
  const { job } = await getOpportunity(userId, opportunityId, database);
  if (!key.trim() || key.length > 150) throw new ApiError(400, 'INVALID_INPUT', 'Provide a request key.');
  const completed = await getCompletedTailoredResume(userId, opportunityId, key, database);
  if (completed) return completed;
  const preparation = options.preparation ?? await getResumePreparation(userId, opportunityId, database);
  if (options.confirmedSkills !== true || options.preparationToken !== preparation.token)
    throw new ApiError(409, 'RESUME_PREPARATION_REQUIRED', 'Review the current skill gaps and confirm before spending 3 credits. No credits were charged.');
  const facts = await database
    .select({
      id: profileFacts.id,
      kind: profileFacts.kind,
      text: profileFacts.text,
      role: profileFacts.role,
      organisation: profileFacts.organisation,
      start: profileFacts.startDate,
      end: profileFacts.endDate,
    })
    .from(profileFacts)
    .where(
      and(eq(profileFacts.userId, userId), eq(profileFacts.status, 'approved')),
    );
  if (!facts.length)
    throw new ApiError(
      422,
      'NO_APPROVED_FACTS',
      'Approve some profile facts before drafting a CV.',
    );
  const [header] = await database
    .select({ name: users.cvName, contact: users.cvContact })
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
  if (!key.trim() || key.length > 150)
    throw new ApiError(400, 'INVALID_INPUT', 'Provide a request key.');
  const creditKey = `resume:${opportunityId}:${key}`;
  let result: { type: string; id: string };
  try {
    result = await withCredits(
      userId,
      'tailor_cv',
      creditKey,
      async () => {
        const generated = await (options.generate ?? generateStructured)(
          tailorCvPrompt,
          tailoredCvDraftSchema,
          {
            jobText: job.text,
            approvedFacts: facts,
            supportedSkills: [
              ...preparation.skills.buckets.existing,
              ...preparation.skills.buckets.supportedByResume,
            ].map(({ skill }) => skill),
          },
          { temperature: 0 },
        );
        // Name and contact details are personal data, not draftable claims:
        // never take them from the model. Use the header the student last
        // confirmed (blank the first time); they still check it before approval.
        const content = {
          ...generated.object,
          name: header?.name ?? '',
          contact: header?.contact ?? '',
        };
        const ranked = rankResumeContentForRole({ content, requirements: preparation.requirements, matchedSkills: [...preparation.skills.buckets.existing, ...preparation.skills.buckets.supportedByResume].map(skill => skill.skill) });
        const resume = await saveResumeVersion(userId, opportunityId, ranked, {
          database,
          promptVersion: generated.promptVersion,
          model: generated.model,
        });
        return { type: 'resume', id: resume.id };
      },
      { database },
    );
  } catch (error) {
    if (error instanceof CreditError) throw error;
    // Only promise that no credits were charged after the ledger confirms the
    // reservation was released. A failed or ambiguous lookup stays generic.
    try {
      const holds = await database
        .select({ status: creditHolds.status })
        .from(creditHolds)
        .where(
          and(
            eq(creditHolds.userId, userId),
            eq(creditHolds.idempotencyKey, `${userId}:${creditKey}`),
          ),
        );
      if (holds.length > 0 && holds.every((hold) => hold.status === 'released'))
        throw new ApiError(
          502,
          'RESUME_NOT_CHARGED',
          'The CV draft could not be completed. No credits were charged. Try again.',
        );
    } catch (statusError) {
      if (statusError instanceof ApiError) throw statusError;
    }
    throw error;
  }
  return getResume(userId, result.id, database);
}

/** Read an owned paid result before rate limiting a completed replay. */
export async function getCompletedTailoredResume(
  userId: string,
  opportunityId: string,
  key: string,
  database: Database = getDatabase(),
) {
  await getOpportunity(userId, opportunityId, database);
  if (!key.trim() || key.length > 150)
    throw new ApiError(400, 'INVALID_INPUT', 'Provide a request key.');
  const [settled] = await database
    .select()
    .from(creditHolds)
    .where(
      and(
        eq(creditHolds.userId, userId),
        eq(
          creditHolds.idempotencyKey,
          `${userId}:resume:${opportunityId}:${key}`,
        ),
        eq(creditHolds.status, 'settled'),
      ),
    )
    .limit(1);
  if (!settled?.resultId || settled.resultType !== 'resume') return null;
  const resume = await getResume(userId, settled.resultId, database);
  if (resume.opportunityId !== opportunityId)
    throw new ApiError(409, 'REQUEST_KEY_CONFLICT', 'This request key belongs to a different role.');
  return resume;
}

/** Return an owned completed copy before applying limits to new work. */
export async function getCompletedResumeReuse(
  userId: string,
  opportunityId: string,
  sourceResumeId: string,
  requestKey: string,
  database: Database = getDatabase(),
) {
  if (!requestKey.trim() || requestKey.length > 150)
    throw new ApiError(400, 'INVALID_INPUT', 'Provide a request key.');
  await getOpportunity(userId, opportunityId, database);
  const [existing] = await database.select().from(resumeVersions).where(and(
    eq(resumeVersions.userId, userId),
    eq(resumeVersions.opportunityId, opportunityId),
    eq(resumeVersions.requestKey, requestKey),
  )).limit(1);
  if (existing && (existing.reusedFromId !== sourceResumeId || existing.restoredFromId !== null))
    throw new ApiError(409, 'REQUEST_KEY_CONFLICT', 'This request key was already used for a different saved CV.');
  return existing ?? null;
}

export async function reuseTailoredResume(
  userId: string,
  opportunityId: string,
  sourceResumeId: string,
  options: { requestKey: string; database?: Database },
) {
  const database = options.database ?? getDatabase();
  const requestKey = options.requestKey;
  if (!requestKey.trim() || requestKey.length > 150)
    throw new ApiError(400, 'INVALID_INPUT', 'Provide a request key.');
  await getOpportunity(userId, opportunityId, database);
  const source = await getResume(userId, sourceResumeId, database);
  if (source.opportunityId === opportunityId)
    throw new ApiError(409, 'RESUME_ALREADY_FOR_ROLE', 'This CV already belongs to this role. Open it or restore an earlier version.');
  return saveResumeVersion(userId, opportunityId, source.content, { database, reusedFromId: source.id, requestKey, pageSize: source.pageSize === 'LETTER' ? 'LETTER' : 'A4' });
}

/** Audits exactly the PDF bytes generated by our fixed renderer; no AI. */
export async function getResumeAtsReport(userId: string, resumeId: string, database: Database = getDatabase()) {
  const resume = await getResume(userId, resumeId, database);
  const pageSize = resume.pageSize === 'LETTER' ? 'LETTER' : 'A4';
  const inspection = await getResumePdfInspection({
    ownerId: userId, resumeId: resume.id, content: resume.content, pageSize,
  });
  return inspection.ats;
}
