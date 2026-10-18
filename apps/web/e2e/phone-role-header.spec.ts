import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { expect, test } from './fixtures';
import { fitReviews, getDatabase, resumeVersions } from '@career-workspace/db';
import { jobs } from '../../../packages/db/src/roles-schema';

const shots = 'output/browser-test-fixes';

test('phone role header and CV tools fit at 390px and 320px', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const unique = randomUUID().slice(0, 8);
  const database = getDatabase();
  const userId = (
    (await (await page.request.get('/api/v1/me')).json()) as {
      data: { id: string };
    }
  ).data.id;
  const created = await page.request.post('/api/v1/jobs', {
    data: {
      title: 'Graduate data analyst',
      company: 'Header Studio',
      text: `Header fixture ${unique}. Analyse data, build dashboards and present findings to product teams. Work with engineers and designers across the full graduate programme.`,
    },
  });
  expect(created.ok()).toBeTruthy();
  const role = (
    (await created.json()) as {
      data: { opportunity: { id: string }; job: { id: string } };
    }
  ).data;
  const [review] = await database
    .insert(fitReviews)
    .values({
      userId,
      opportunityId: role.opportunity.id,
      verdict: 'Header fixture',
      strengths: [],
      gaps: [],
      unknowns: [],
      promptVersion: 'e2e-header-fixture.v1',
      model: 'test-fixture',
    })
    .returning();
  await database.insert(resumeVersions).values({
    userId,
    opportunityId: role.opportunity.id,
    content: {
      name: 'Header Student',
      contact: 'header@example.test',
      sections: [{ title: 'Experience', bullets: [] }],
    },
    version: 1,
    promptVersion: 'e2e-header-fixture.v1',
    model: 'recorded-fixture',
  });

  try {
    await mkdir(shots, { recursive: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/workspace/roles/${role.opportunity.id}`);
      const chat = page.getByRole('button', { name: 'Talk to Oppa' });
      const badge = page
        .locator('span[class*="badge"]')
        .filter({ hasText: 'Reviewed' });
      await expect(chat).toBeVisible();
      await expect(badge).toBeVisible();
      expect(await badge.evaluate((el) => (el as HTMLElement).innerText)).toBe(
        'Reviewed',
      );
      await page.screenshot({ path: `${shots}/role-header-${width}.png` });
      for (const box of [await chat.boundingBox(), await badge.boundingBox()])
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect((await chat.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading).toHaveText('Graduate data analyst');
      expect(
        await heading.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
      ).toBe(true);
      const badgeBox = (await badge.boundingBox())!;
      expect(badgeBox.height).toBeLessThan(30);
      expect((await heading.boundingBox())!.height).toBeLessThan(60);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);

      await page.goto(`/workspace/roles/${role.opportunity.id}/resume`);
      const draft = page.getByRole('button', {
        name: 'Review before creating another draft',
      });
      await expect(draft).toBeVisible({ timeout: 30_000 });
      const draftBox = (await draft.boundingBox())!;
      expect(draftBox.width).toBeGreaterThan(draftBox.height * 2);
      expect(draftBox.x + draftBox.width).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await draft.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/cv-tools-${width}.png` });
    }

    await page.goto('/workspace/coach');
    await expect(
      page.getByPlaceholder('Ask Oppa anything about your search'),
    ).toBeVisible();
  } finally {
    await database
      .delete(resumeVersions)
      .where(eq(resumeVersions.opportunityId, role.opportunity.id));
    await database.delete(fitReviews).where(eq(fitReviews.id, review.id));
    await database.delete(jobs).where(eq(jobs.id, role.job.id));
  }
});
