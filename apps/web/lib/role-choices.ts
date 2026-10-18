/** Statuses where a role has no further step worth recommending on home. */
const CLOSED_STATUSES = new Set(['rejected', 'withdrawn']);

/** The newest open role with a next step, for the home next-action card. */
export function pickNextRole<
  T extends { opportunity: { status: string; nextStep: string | null } },
>(roles: T[]): T | undefined {
  return roles.find(
    ({ opportunity }) =>
      !CLOSED_STATUSES.has(opportunity.status) && opportunity.nextStep?.trim(),
  );
}

/** Plain labels for every event type recorded against a role. */
const TIMELINE_LABELS: Record<string, string> = {
  'opportunity.created': 'Role saved',
  'application.handoff_prepared': 'CV handed off for your application',
  'application.confirmed_applied': 'You confirmed your application was sent',
  'application.not_yet': 'Application not sent yet',
  'opportunity.fit_reviewed': 'Fit review completed',
  'answer.drafted': 'Application answer drafted',
  'answer.edited': 'Application answer edited',
  'answer.approved': 'Application answer approved',
  'resume.version_saved': 'Tailored CV version saved',
  'resume.restored': 'Earlier CV version restored',
  'resume.reused': 'CV copied from another role',
  'resume.approved': 'Tailored CV approved',
  'outreach.drafted': 'Outreach message drafted',
  'outreach.edited': 'Outreach message edited',
  'outreach.handed_off': 'Outreach message opened to send',
  'outreach.marked_sent': 'Outreach marked as sent',
  'practice.started': 'Interview practice started',
  'practice.feedback_ready': 'Interview practice feedback ready',
};

export function timelineEventLabel(type: string): string {
  return TIMELINE_LABELS[type] ?? type.replaceAll(/[._]/g, ' ');
}

type CvVersionRow = {
  opportunityId: string;
  version: number;
  approvedAt: string | null;
  pdfFileId: string | null;
};

/** Latest CV per role, plus its newest approved PDF even when a later draft exists. */
export function latestCvPerRole<T extends CvVersionRow>(rows: T[]) {
  const latest = new Map<string, T>();
  const approved = new Map<string, T>();
  for (const row of rows) {
    const current = latest.get(row.opportunityId);
    if (!current || row.version > current.version)
      latest.set(row.opportunityId, row);
    const currentApproved = approved.get(row.opportunityId);
    if (
      row.approvedAt &&
      row.pdfFileId &&
      (!currentApproved || row.version > currentApproved.version)
    )
      approved.set(row.opportunityId, row);
  }
  return [...latest.values()].map((row) => {
    const pdf = approved.get(row.opportunityId);
    return {
      ...row,
      approvedPdf: pdf
        ? { version: pdf.version, fileId: pdf.pdfFileId! }
        : null,
    };
  });
}

/** Empty-table text: filters that hide saved roles must not claim none exist. */
export function emptyRolesMessage(savedRoleCount: number): string {
  return savedRoleCount > 0
    ? 'No roles match your search or filters. Clear them to see all saved roles.'
    : 'No roles saved yet. Add a job link or paste its description to get started.';
}
