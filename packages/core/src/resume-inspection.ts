import { createHash } from 'node:crypto';
import type { ResumeContent } from '@career-workspace/contracts';
import {
  countPdfPages,
  renderResumePdf,
  type ResumePageSize,
} from '@career-workspace/pdf';
import { getResumeAtsAudit, type ResumeAtsAudit } from './resume-ats';

export type ResumePdfInspection = {
  pageCount: number;
  ats: Omit<ResumeAtsAudit, 'extractedText'>;
};

export type ResumePdfInspectionInput = {
  ownerId: string;
  resumeId: string;
  content: ResumeContent;
  pageSize: ResumePageSize;
};

type Dependencies = {
  maxEntries?: number;
  render?: typeof renderResumePdf;
  audit?: typeof getResumeAtsAudit;
};

function cacheKey(input: ResumePdfInspectionInput): string {
  const contentHash = createHash('sha256')
    .update(JSON.stringify(input.content) ?? '')
    .digest('hex');
  return JSON.stringify([
    input.ownerId,
    input.resumeId,
    contentHash,
    input.pageSize,
  ]);
}

function copyInspection(value: ResumePdfInspection): ResumePdfInspection {
  return {
    pageCount: value.pageCount,
    ats: {
      score: value.ats.score,
      grade: value.ats.grade,
      disclaimer: value.ats.disclaimer,
      checks: value.ats.checks.map((check) => ({ ...check })),
    },
  };
}

/**
 * Creates a bounded per-process cache for immutable PDF inspection results.
 * It stores no PDF bytes or extracted CV text; ownership and grounding must be
 * checked by the caller on every request before using this cache.
 */
export function createResumeInspectionCache(dependencies: Dependencies = {}) {
  const maxEntries = dependencies.maxEntries ?? 64;
  if (!Number.isInteger(maxEntries) || maxEntries < 1)
    throw new Error('Resume inspection cache size must be a positive integer.');
  const render = dependencies.render ?? renderResumePdf;
  const audit = dependencies.audit ?? getResumeAtsAudit;
  const entries = new Map<string, Promise<ResumePdfInspection>>();

  return async (
    input: ResumePdfInspectionInput,
  ): Promise<ResumePdfInspection> => {
    const key = cacheKey(input);
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key);
      entries.set(key, cached);
      return cached.then(copyInspection);
    }

    const pending = (async () => {
      const bytes = await render(input.content, input.pageSize);
      const [auditResult, pageCount] = await Promise.all([
        audit(input.content, bytes, {
          generatedByRenderer: true,
          pageSize: input.pageSize,
        }),
        Promise.resolve(countPdfPages(bytes)),
      ]);
      return {
        pageCount,
        ats: {
          score: auditResult.score,
          grade: auditResult.grade,
          checks: auditResult.checks,
          disclaimer: auditResult.disclaimer,
        },
      };
    })();

    entries.set(key, pending);
    void pending.catch(() => {
      if (entries.get(key) === pending) entries.delete(key);
    });
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    return pending.then(copyInspection);
  };
}

export const getResumePdfInspection = createResumeInspectionCache();
