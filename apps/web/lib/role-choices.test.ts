import { describe, expect, it } from 'vitest';
import {
  emptyRolesMessage,
  latestCvPerRole,
  pickNextRole,
  timelineEventLabel,
} from './role-choices';

const role = (id: string, status: string, nextStep: string | null) => ({
  opportunity: { id, status, nextStep },
});

describe('home next role', () => {
  it('skips rejected and withdrawn roles', () => {
    const roles = [
      role('a', 'withdrawn', 'Save this role for reference'),
      role('b', 'rejected', 'Keep building your search momentum'),
      role('c', 'applied', 'Follow up on your application'),
    ];
    expect(pickNextRole(roles)?.opportunity.id).toBe('c');
  });

  it('returns nothing when only closed roles or blank steps remain', () => {
    expect(
      pickNextRole([role('a', 'withdrawn', 'x'), role('b', 'saved', ' ')]),
    ).toBeUndefined();
  });
});

describe('timeline labels', () => {
  it('names fit review, answer and outreach events in plain words', () => {
    expect(timelineEventLabel('opportunity.fit_reviewed')).toBe(
      'Fit review completed',
    );
    expect(timelineEventLabel('answer.drafted')).toBe(
      'Application answer drafted',
    );
    expect(timelineEventLabel('outreach.handed_off')).toBe(
      'Outreach message opened to send',
    );
  });
});

describe('documents CV rows', () => {
  it('keeps the approved PDF available after a newer draft', () => {
    const rows = [
      { opportunityId: 'r', version: 1, approvedAt: 'x', pdfFileId: 'pdf-1' },
      { opportunityId: 'r', version: 2, approvedAt: null, pdfFileId: null },
      { opportunityId: 's', version: 1, approvedAt: null, pdfFileId: null },
    ];
    const [r, s] = latestCvPerRole(rows);
    expect(r).toMatchObject({
      version: 2,
      approvedPdf: { version: 1, fileId: 'pdf-1' },
    });
    expect(s.approvedPdf).toBeNull();
  });
});

describe('roles empty message', () => {
  it('says no roles match when saved roles are filtered out', () => {
    expect(emptyRolesMessage(3)).toMatch(/No roles match/);
    expect(emptyRolesMessage(0)).toMatch(/No roles saved yet/);
  });
});
