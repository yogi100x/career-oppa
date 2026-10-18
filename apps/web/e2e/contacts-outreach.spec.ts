import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import {
  companies,
  contacts,
  getDatabase,
  outreachDrafts,
  profileFacts,
} from '@career-workspace/db';

test('role contacts and recorded outreach draft require reviewed handoff', async ({
  page,
}) => {
  const meResponse = await page.request.get('/api/v1/me');
  expect(meResponse.ok()).toBeTruthy();
  const me = (await meResponse.json()) as { data: { id: string } };
  const suffix = randomUUID().slice(0, 8);
  const roleResponse = await page.request.post('/api/v1/jobs', {
    data: {
      title: `Outreach role ${suffix}`,
      company: `Contact fixture ${suffix}`,
      text: 'We need a product engineer to build clear and accessible tools with a collaborative team. You will work across TypeScript interfaces, test new features, and improve how candidates prepare for work.',
    },
  });
  expect(roleResponse.ok()).toBeTruthy();
  const role = (await roleResponse.json()) as {
    data: { opportunity: { id: string } };
  };
  const opportunityId = role.data.opportunity.id;
  const db = getDatabase();
  const [company] = await db
    .insert(companies)
    .values({
      name: `Contact fixture ${suffix}`,
      normalizedName: `contact fixture ${suffix}`.toLowerCase(),
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({
      userId: me.data.id,
      opportunityId,
      companyId: company.id,
      providerContactId: `browser-fixture-${suffix}`,
      name: 'Casey Contact',
      title: 'Talent partner',
      email: 'casey@example.invalid',
      emailStatus: 'VALID',
      revealedAt: new Date(),
      source: 'getleads',
      sourceDate: new Date('2026-09-30T12:00:00Z'),
    })
    .returning();
  const [fact] = await db
    .insert(profileFacts)
    .values({
      userId: me.data.id,
      kind: 'skill',
      text: 'I led accessibility testing for a TypeScript product.',
      source: 'user',
      status: 'approved',
    })
    .returning();
  const [draft] = await db
    .insert(outreachDrafts)
    .values({
      userId: me.data.id,
      opportunityId,
      contactId: contact.id,
      subject: `A question about ${suffix}`,
      body: 'I led accessibility testing for a TypeScript product and would enjoy hearing more about the team.',
      factIds: [fact.id],
      promptVersion: 'recorded-browser-fixture.v1',
      model: 'recorded-browser-fixture',
    })
    .returning();

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/workspace/roles/${opportunityId}`);
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();
  await expect(
    page.getByText(
      'These are company contacts, not confirmed owners of the vacancy.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Casey Contact')).toBeVisible();
  await expect(page.getByText('casey@example.invalid')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Reveal email · 5 credits' }),
  ).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue(
    `A question about ${suffix}`,
  );
  await expect(
    page.getByRole('button', { name: 'Copy message' }),
  ).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: 'I reviewed this exact subject and message.',
    })
    .check();
  await page.getByRole('button', { name: 'Copy message' }).click();
  await expect(
    page.getByText('Copied to your clipboard. Sending is still up to you.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yes, I sent it' })).toBeVisible();
  await page.getByRole('button', { name: 'Yes, I sent it' }).click();
  await expect(
    page.getByText(
      'You marked this message as sent. Delivery was not verified.',
    ),
  ).toBeVisible();

  expect(draft.id).toBeTruthy();
});
