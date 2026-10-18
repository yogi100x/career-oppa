import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, users } from '@career-workspace/db';
import {
  getProfilePreferences,
  saveProfilePreferences,
} from './profile-preferences';
import { createUserFile } from './files';
import { listDocuments } from './documents';
import type { PrivateStorage } from '@career-workspace/adapters/storage';
const connection = process.env.DATABASE_TEST_URL;
(connection ? describe : describe.skip)(
  'profile preferences and document ownership',
  () => {
    const { database, pool } = createDatabase(connection!);
    let owner: string, other: string;
    beforeAll(async () => {
      const rows = await database
        .insert(users)
        .values([
          { clerkId: `prefs-a-${randomUUID()}` },
          { clerkId: `prefs-b-${randomUUID()}` },
        ])
        .returning();
      [owner, other] = rows.map((row) => row.id);
    });
    afterAll(async () => {
      for (const id of [owner, other])
        await database.delete(users).where(eq(users.id, id));
      await pool.end();
    });
    it('saves target roles, location and paper size only for the supplied owner', async () => {
      expect(await getProfilePreferences(owner, database)).toEqual({
        targetRoles: [],
        preferredLocation: '',
        workPreference: 'any',
        paperSize: 'A4',
        cvName: '',
        cvContact: '',
      });
      const input = {
        targetRoles: ['Product engineer'],
        preferredLocation: 'London',
        workPreference: 'hybrid' as const,
        paperSize: 'LETTER' as const,
      };
      await saveProfilePreferences(owner, input, database);
      expect(await getProfilePreferences(owner, database)).toEqual({
        ...input,
        cvName: '',
        cvContact: '',
      });
      // The CV header is kept when a save leaves it out, and saved when sent.
      await saveProfilePreferences(
        owner,
        { ...input, cvName: 'Priya Shah', cvContact: 'priya@example.test' },
        database,
      );
      await saveProfilePreferences(owner, input, database);
      expect(await getProfilePreferences(owner, database)).toMatchObject({
        cvName: 'Priya Shah',
        cvContact: 'priya@example.test',
      });
      expect((await getProfilePreferences(other, database)).paperSize).toBe(
        'A4',
      );
      await expect(
        saveProfilePreferences(
          owner,
          { ...input, paperSize: 'INVALID' } as never,
          database,
        ),
      ).rejects.toThrow();
    });
    it('lists the master CV and other uploaded document kinds only for their owner', async () => {
      const storage: PrivateStorage = {
        put: async () => {},
        get: async () => null,
        delete: async () => {},
      };
      for (const kind of [
        'cv_upload',
        'portfolio',
        'supporting_document',
      ] as const)
        await createUserFile(
          owner,
          {
            kind,
            originalName: `${kind}.pdf`,
            contents: new TextEncoder().encode('%PDF-1.7\nSample file'),
          },
          { database, storage },
        );
      expect(
        (await listDocuments(owner, database)).uploads
          .map((file) => file.kind)
          .sort(),
      ).toEqual(['cv_upload', 'portfolio', 'supporting_document']);
      expect((await listDocuments(other, database)).uploads).toEqual([]);
    });
    it('refuses preference changes after account deletion begins', async () => {
      await database
        .update(users)
        .set({ deletionRequestedAt: new Date() })
        .where(eq(users.id, other));
      await expect(
        saveProfilePreferences(
          other,
          {
            targetRoles: ['Designer'],
            preferredLocation: '',
            workPreference: 'any',
            paperSize: 'A4',
          },
          database,
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' });
      expect(
        (await getProfilePreferences(other, database)).targetRoles,
      ).toEqual([]);
    });
  },
);
