import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { fitReviews, getDatabase, jobs, opportunities, profileFacts, resumeVersions, type Database } from '@career-workspace/db';
import { getOpportunity } from './roles';
import { classifyJobSkills, compareJobDescriptionSimilarity } from './resume-preparation';

/** Read-only, free checks using current owned facts; no model calls. */
export async function getResumePreparation(userId: string, opportunityId: string, database: Database = getDatabase()) {
  const { job } = await getOpportunity(userId, opportunityId, database);
  const facts = await database.select().from(profileFacts).where(and(eq(profileFacts.userId, userId), eq(profileFacts.status, 'approved'))).orderBy(profileFacts.id);
  const [review] = await database.select().from(fitReviews).where(and(eq(fitReviews.userId, userId), eq(fitReviews.opportunityId, opportunityId))).orderBy(desc(fitReviews.createdAt)).limit(1);
  // These are job requirements, not a claim that historical citations remain approved.
  const requirements = (review?.scorecard?.requirements ?? []).map(({ text, quote, importance }) => ({
    text, quote, importance, status: 'unknown' as const, fact_ids: [] as string[],
  }));
  const skills = classifyJobSkills({ jobText: job.text, jobTitle: job.title, approvedFacts: facts, fitRequirements: requirements });
  const previous = await database.select({ resume: resumeVersions, job: jobs }).from(resumeVersions)
    .innerJoin(opportunities, and(eq(opportunities.id, resumeVersions.opportunityId), eq(opportunities.userId, userId)))
    .innerJoin(jobs, and(eq(jobs.id, opportunities.jobId), eq(jobs.userId, userId)))
    .where(eq(resumeVersions.userId, userId)).orderBy(desc(resumeVersions.createdAt)).limit(100);
  const seenRoles = new Set<string>();
  const reuse = previous.flatMap(({ resume, job: previousJob }) => {
    if (resume.opportunityId === opportunityId) return [];
    if (seenRoles.has(resume.opportunityId)) return [];
    seenRoles.add(resume.opportunityId);
    const advice = compareJobDescriptionSimilarity({ jobText: job.text, priorJobText: previousJob.text, jobTitle: job.title, priorJobTitle: previousJob.title });
    return [{ ...advice, resumeId: resume.id, opportunityId: resume.opportunityId, title: previousJob.title, company: previousJob.company, approved: Boolean(resume.approvedAt) }];
  }).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  const token = createHash('sha256').update(JSON.stringify({
    userId, opportunityId, jobTitle: job.title, job: job.text, requirements,
    facts: facts.map(({ id, text, kind, role, organisation, startDate, endDate, updatedAt }) => ({ id, text, kind, role, organisation, startDate, endDate, updatedAt })),
  })).digest('hex');
  return { token, skills, requirements, reuse };
}
