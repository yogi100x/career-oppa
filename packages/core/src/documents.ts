import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  getDatabase,
  files,
  jobs,
  opportunities,
  projects,
  resumeVersions,
  type Database,
} from '@career-workspace/db';
import { getCvUploadState } from './cv-upload-state';
export async function listDocuments(
  userId: string,
  database: Database = getDatabase(),
) {
  const documents = await database
    .select({
      id: resumeVersions.id,
      opportunityId: resumeVersions.opportunityId,
      version: resumeVersions.version,
      approvedAt: resumeVersions.approvedAt,
      pdfFileId: resumeVersions.pdfFileId,
      jobTitle: jobs.title,
      company: jobs.company,
      createdAt: resumeVersions.createdAt,
    })
    .from(resumeVersions)
    .innerJoin(
      opportunities,
      eq(resumeVersions.opportunityId, opportunities.id),
    )
    .innerJoin(jobs, eq(opportunities.jobId, jobs.id))
    .where(
      and(
        eq(resumeVersions.userId, userId),
        eq(opportunities.userId, userId),
        eq(jobs.userId, userId),
      ),
    )
    .orderBy(desc(resumeVersions.createdAt), desc(resumeVersions.version))
    .limit(100);
  const uploads = await database
    .select({
      id: files.id,
      kind: files.kind,
      originalName: files.originalName,
      createdAt: files.createdAt,
    })
    .from(files)
    .where(
      and(
        eq(files.userId, userId),
        inArray(files.kind, ['cv_upload', 'portfolio', 'supporting_document']),
      ),
    )
    .orderBy(desc(files.createdAt))
    .limit(100);
  const uploadsWithCvState = await Promise.all(
    uploads.map(async (upload) => {
      if (upload.kind !== 'cv_upload') return upload;
      const status = await getCvUploadState(userId, upload.id, database);
      return {
        ...upload,
        cvUploadState: {
          state: status.state,
          factCount: status.factCount,
          approvedCount: status.approvedCount,
          task: status.task
            ? { id: status.task.id, status: status.task.status }
            : null,
        },
      };
    }),
  );
  const portfolios = await database
    .select({ id: projects.id, title: projects.title, links: projects.links })
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt))
    .limit(100);
  return {
    documents,
    uploads: uploadsWithCvState,
    portfolios: portfolios.filter((project) => project.links.length),
  };
}
