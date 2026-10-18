import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createRefreshedBrowserContext,
  expect,
  test,
  type APIRequestContext,
} from './fixtures';
import { eq } from 'drizzle-orm';
import { createTask } from '../../../packages/core/src/tasks/index';
import {
  answerDrafts,
  coachMessages,
  coachProposals,
  companies,
  contacts,
  files,
  fitReviews,
  getDatabase,
  jobs,
  outreachDrafts,
  practiceSessions,
  posts,
  profileFacts,
  reminders,
  resumeVersions,
  rewardSubmissions,
  socialConnections,
  tasks,
  users,
} from '@career-workspace/db';
import { getPrivateStorage } from '@career-workspace/adapters/storage';
import { hashRewardUrl } from '@career-workspace/core/rewards';
import {
  OWNED_RECORD_ROUTES,
  OWNED_RECORD_MUTATIONS,
  SELF_SCOPED_COLLECTION_ROUTES,
  SELF_ONLY_ROUTES,
  SELF_SCOPED_RECORD_ROUTES,
  USER_A_STORAGE_STATE,
  USER_B_STORAGE_STATE,
  USER_DELETION_GUARD_ROUTES,
} from './ownership.routes';

type ApiEnvelope<T> = { data?: T; error?: { code?: string; message?: string } };
type CurrentUser = { id: string };
type CollectionItem = { id?: string; opportunity?: { id?: string } };
function collectionRecordIds(
  items: CollectionItem[],
  resource:
    | 'profileFact'
    | 'project'
    | 'opportunity'
    | 'coachMessage'
    | 'coachProposal'
    | 'document'
    | 'upload'
    | 'reminder'
    | 'outreach'
    | 'post'
    | 'reward',
): string[] {
  return items
    .map((item) =>
      resource === 'opportunity' ? item.opportunity?.id : item.id,
    )
    .filter((id): id is string => Boolean(id));
}

async function currentUser(api: APIRequestContext): Promise<CurrentUser> {
  const response = await api.get('/api/v1/me');
  expect(response.status()).toBe(200);
  const body = (await response.json()) as ApiEnvelope<CurrentUser>;
  expect(body.data?.id).toBeTruthy();
  return body.data!;
}

test('owned IDs stay private and self routes use only the signed-in user', async ({
  browser,
  page,
}, testInfo) => {
  // This exercises many distinct routes; a cold development server compiles
  // each handler before the ownership assertions can finish.
  test.setTimeout(90_000);
  const testDatabaseUrl = process.env.DATABASE_TEST_URL;
  if (!testDatabaseUrl) {
    throw new Error(
      'Set DATABASE_TEST_URL to the isolated career_workspace_test database.',
    );
  }
  const databaseName = new URL(testDatabaseUrl).pathname.slice(1);
  if (databaseName !== 'career_workspace_test') {
    throw new Error(
      'Ownership fixtures require the career_workspace_test database.',
    );
  }
  process.env.DATABASE_URL = testDatabaseUrl;

  const statePathA = resolve('apps/web', USER_A_STORAGE_STATE);
  const statePathB = resolve('apps/web', USER_B_STORAGE_STATE);
  const [stateA, stateB] = await Promise.all([
    readFile(statePathA, 'utf8'),
    readFile(statePathB, 'utf8'),
  ]);
  expect(stateA).toBeTruthy();
  expect(stateB).toBeTruthy();

  const baseURL = testInfo.project.use.baseURL as string;
  const userBContext = await createRefreshedBrowserContext(
    browser,
    statePathB,
    baseURL,
  );
  const apiA = page.request;
  const apiB = userBContext.page.request;
  let fileId: string | undefined;
  let taskId: string | undefined;
  let fileKey: string | undefined;
  let cvFileId: string | undefined;
  let cvFileKey: string | undefined;
  let cvTaskId: string | undefined;
  let profileFactId: string | undefined;
  let projectId: string | undefined;
  let opportunityId: string | undefined;
  let resumeId: string | undefined;
  let answerId: string | undefined;
  let jobId: string | undefined;
  let capturedJobId: string | undefined;
  let capturedOpportunityId: string | undefined;
  let contactId: string | undefined;
  let contactsSearchTaskId: string | undefined;
  let outreachId: string | undefined;
  let reminderId: string | undefined;
  let practiceId: string | undefined;
  let postId: string | undefined;
  let projectFactId: string | undefined;
  let socialConnectionId: string | undefined;
  let rewardId: string | undefined;
  let rewardBId: string | undefined;
  let userBId: string | undefined;
  let originalBDeletion: Date | null | undefined;

  try {
    const userA = await currentUser(apiA);
    const bBefore = await currentUser(apiB);
    userBId = bBefore.id;
    const [bOriginal] = await getDatabase()
      .select({
        deletion: users.deletionRequestedAt,
      })
      .from(users)
      .where(eq(users.id, bBefore.id));
    originalBDeletion = bOriginal?.deletion ?? null;
    const userB = await currentUser(apiB);
    expect(userB.id).not.toBe(userA.id);

    await getDatabase()
      .update(users)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(users.id, userB.id));
    for (const route of USER_DELETION_GUARD_ROUTES) {
      const response = await apiB.fetch(route.path, {
        method: route.method,
        data: route.method === 'GET' ? undefined : {},
      });
      expect(
        response.status(),
        `${route.method} ${route.path} deletion pending`,
      ).toBe(403);
      expect(
        (await response.json()).error.code,
        `${route.method} ${route.path} deletion pending`,
      ).toBe('ACCOUNT_DELETION_PENDING');
    }
    expect((await apiB.get('/api/v1/account/deletion')).status()).toBe(200);
    const deletionRetry = await apiB.post('/api/v1/account/deletion', {
      data: { confirmation: 'DELETE' },
    });
    expect(deletionRetry.status()).toBe(400);
    expect((await deletionRetry.json()).error.code).toBe('INVALID_INPUT');
    await getDatabase()
      .update(users)
      .set({ deletionRequestedAt: originalBDeletion ?? null })
      .where(eq(users.id, userB.id));

    const factResponse = await apiA.post('/api/v1/profile/facts', {
      data: {
        kind: 'skill',
        text: 'Built a private project with TypeScript.',
      },
    });
    expect(factResponse.status()).toBe(200);
    const factBody = (await factResponse.json()) as ApiEnvelope<{ id: string }>;
    profileFactId = factBody.data?.id;
    expect(profileFactId).toBeTruthy();

    const projectResponse = await apiA.post('/api/v1/projects', {
      data: {
        title: 'Ownership project fixture',
        summary: 'A private project used by the ownership check.',
        links: [],
        claims: [],
      },
    });
    expect(projectResponse.status()).toBe(201);
    const project = (await projectResponse.json()) as ApiEnvelope<{
      id: string;
      claims: Array<{ id: string }>;
    }>;
    projectId = project.data?.id;
    expect(projectId).toBeTruthy();

    const [projectFact] = await getDatabase()
      .insert(profileFacts)
      .values({
        userId: userA.id,
        projectId: projectId!,
        source: 'project',
        kind: 'achievement',
        text: 'Improved a private project workflow.',
        status: 'approved',
      })
      .returning();
    projectFactId = projectFact.id;

    const approveFact = await apiA.patch(
      `/api/v1/profile/facts/${profileFactId}`,
      { data: { status: 'approved' } },
    );
    expect(approveFact.status()).toBe(200);

    const jobText =
      'The engineer will build and maintain reliable web software, work with product teams, ' +
      'write clear tests, review code, and improve the performance and accessibility of ' +
      'customer-facing applications. Candidates should communicate well and be comfortable ' +
      'working across a modern TypeScript stack.';
    const opportunityResponse = await apiA.post('/api/v1/jobs', {
      data: {
        title: 'Ownership fixture engineer',
        company: 'Private fixture company',
        text: jobText,
      },
    });
    expect(opportunityResponse.status()).toBe(200);
    const opportunity = (await opportunityResponse.json()) as ApiEnvelope<{
      opportunity: { id: string };
      job: { id: string };
    }>;
    opportunityId = opportunity.data?.opportunity.id;
    jobId = opportunity.data?.job.id;
    expect(opportunityId).toBeTruthy();

    // The fixture row avoids a live AI call while exercising real GET auth and ownership.
    await getDatabase()
      .insert(fitReviews)
      .values({
        userId: userA.id,
        opportunityId: opportunityId!,
        verdict: 'Recorded ownership fixture review.',
        strengths: [
          {
            text: 'Has the approved TypeScript project fact.',
            fact_ids: [profileFactId!],
          },
        ],
        gaps: ['No other evidence was added.'],
        unknowns: [],
        promptVersion: 'ownership-fixture.v1',
        model: 'recorded-test-response',
      });

    const [resume] = await getDatabase()
      .insert(resumeVersions)
      .values({
        userId: userA.id,
        opportunityId: opportunityId!,
        content: {
          name: 'Fixture candidate',
          contact: '',
          sections: [
            {
              title: 'Evidence',
              bullets: [
                {
                  text: 'Has the approved TypeScript project fact.',
                  fact_ids: [profileFactId!],
                },
              ],
            },
          ],
        },
        version: 1,
        promptVersion: 'ownership-fixture.v1',
        model: 'recorded-test-response',
      })
      .returning();
    resumeId = resume.id;
    const [answer] = await getDatabase()
      .insert(answerDrafts)
      .values({
        userId: userA.id,
        opportunityId: opportunityId!,
        question: 'What relevant experience do you bring?',
        answer: 'Has the approved TypeScript project fact.',
        factIds: [profileFactId!],
        promptVersion: 'ownership-fixture.v1',
        model: 'recorded-test-response',
      })
      .returning();
    answerId = answer.id;
    const [coachMessage] = await getDatabase()
      .insert(coachMessages)
      .values({
        userId: userA.id,
        role: 'user',
        content: 'Private coaching note for this role.',
        opportunityId: opportunityId!,
        requestKey: `ownership-coach-${randomUUID()}`,
        status: 'completed',
      })
      .returning();
    const [coachProposal] = await getDatabase()
      .insert(coachProposals)
      .values({
        userId: userA.id,
        opportunityId: opportunityId!,
        kind: 'change_status',
        data: {
          from: 'saved',
          to: 'reviewed',
          reason: 'Recorded ownership test.',
        },
      })
      .returning();
    const suffix = randomUUID();
    const [company] = await getDatabase()
      .insert(companies)
      .values({
        name: `Ownership fixture ${suffix}`,
        normalizedName: `ownership fixture ${suffix}`.toLowerCase(),
      })
      .returning();
    const [contact] = await getDatabase()
      .insert(contacts)
      .values({
        userId: userA.id,
        opportunityId: opportunityId!,
        companyId: company.id,
        providerContactId: `ownership-contact-${suffix}`,
        name: 'Casey Contact',
        title: 'Recruiting lead',
        email: `casey-${suffix}@example.com`,
        emailStatus: 'VALID',
        revealedAt: new Date(),
        source: 'getleads',
      })
      .returning();
    contactId = contact.id;
    const [searchTask] = await getDatabase()
      .insert(tasks)
      .values({
        userId: userA.id,
        kind: 'contacts_search',
        status: 'succeeded',
        input: { opportunityId: opportunityId! },
        idempotencyKey: `task:${userA.id}:ownership-search-${suffix}`,
      })
      .returning();
    contactsSearchTaskId = searchTask.id;
    const [outreach] = await getDatabase()
      .insert(outreachDrafts)
      .values({
        userId: userA.id,
        opportunityId: opportunityId!,
        contactId: contact.id,
        subject: 'Role introduction',
        body: 'A private draft for the saved role.',
        factIds: [profileFactId!],
        promptVersion: 'ownership-fixture.v1',
        model: 'recorded-test-response',
      })
      .returning();
    outreachId = outreach.id;
    const [reminder] = await getDatabase()
      .insert(reminders)
      .values({
        userId: userA.id,
        opportunityId: opportunityId!,
        contactId: contact.id,
        outreachId: outreach.id,
        title: 'Follow up about this role',
        dueAt: new Date('2026-12-01T12:00:00Z'),
      })
      .returning();
    reminderId = reminder.id;

    const [practice] = await getDatabase()
      .insert(practiceSessions)
      .values({
        userId: userA.id,
        opportunityId: opportunityId!,
        questions: [
          { question: 'What did you build?', focus: 'Scope' },
          { question: 'How did you measure it?', focus: 'Impact' },
          { question: 'What would you improve?', focus: 'Reflection' },
        ],
        questionPromptVersion: 'ownership-fixture.v1',
        model: 'recorded-test-response',
      })
      .returning();
    practiceId = practice.id;
    const [post] = await getDatabase()
      .insert(posts)
      .values({
        userId: userA.id,
        projectId: projectId!,
        content: 'A recorded draft about a completed workflow improvement.',
        factIds: [projectFactId!],
        destination: 'copy',
        promptVersion: 'ownership-fixture.v1',
        model: 'recorded-test-response',
      })
      .returning();
    postId = post.id;
    const [socialConnection] = await getDatabase()
      .insert(socialConnections)
      .values({
        userId: userA.id,
        providerProfileId: `ownership-profile-${suffix}`,
        platform: 'linkedin',
        status: 'pending',
      })
      .returning();
    socialConnectionId = socialConnection.id;
    const rewardUrl = `https://example.com/ownership/${suffix}`;
    const [reward] = await getDatabase()
      .insert(rewardSubmissions)
      .values({
        userId: userA.id,
        url: rewardUrl,
        urlHash: hashRewardUrl(rewardUrl),
        disclosureConfirmed: true,
      })
      .returning();
    rewardId = reward.id;

    // These routes have no user selector. Supplying one cannot switch identity.
    const queriedMe = await apiB.get(
      `/api/v1/me?userId=${encodeURIComponent(userA.id)}`,
    );
    expect(
      ((await queriedMe.json()) as ApiEnvelope<CurrentUser>).data?.id,
    ).toBe(userB.id);
    const credits = await apiB.get('/api/v1/credits');
    const creditsWithSelector = await apiB.get(
      `/api/v1/credits?userId=${encodeURIComponent(userA.id)}`,
    );
    expect(credits.status()).toBe(200);
    expect(creditsWithSelector.status()).toBe(200);
    expect(await creditsWithSelector.json()).toEqual(await credits.json());

    const upload = await apiA.post('/api/v1/files', {
      multipart: {
        file: {
          name: 'ownership-fixture.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.7\nprivate ownership fixture'),
        },
      },
    });
    expect(upload.status()).toBe(201);
    const uploaded = (await upload.json()) as ApiEnvelope<{ id: string }>;
    fileId = uploaded.data?.id;
    expect(fileId).toBeTruthy();

    const [fileRecord] = await getDatabase()
      .select({ r2Key: files.r2Key })
      .from(files)
      .where(eq(files.id, fileId!));
    fileKey = fileRecord?.r2Key;

    const task = await createTask(userA.id, 'ownership_e2e', randomUUID(), {});
    taskId = task.id;

    const cvUpload = await apiA.post('/api/v1/profile/cv', {
      multipart: {
        file: {
          name: 'profile-cv-owner-proof.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.7\nProfile CV ownership fixture.'),
        },
      },
    });
    expect(cvUpload.status(), 'profile CV owner creates a file and task').toBe(
      201,
    );
    const cvCreated = (await cvUpload.json()) as ApiEnvelope<{
      file: { id: string };
      task: { id: string };
    }>;
    cvFileId = cvCreated.data?.file.id;
    cvTaskId = cvCreated.data?.task.id;
    expect(cvFileId).toBeTruthy();
    expect(cvTaskId).toBeTruthy();
    const [cvRecord] = await getDatabase()
      .select({ r2Key: files.r2Key, userId: files.userId })
      .from(files)
      .where(eq(files.id, cvFileId!));
    cvFileKey = cvRecord?.r2Key;
    expect(cvRecord?.userId).toBe(userA.id);
    expect((await apiA.get(`/api/v1/files/${cvFileId}`)).status()).toBe(200);
    const otherCvFile = await apiB.get(`/api/v1/files/${cvFileId}`);
    expect(otherCvFile.status()).toBe(404);
    expect((await otherCvFile.json()).error.code).toBe('NOT_FOUND');
    const otherCvTask = await apiB.get(`/api/v1/tasks/${cvTaskId}`);
    expect(otherCvTask.status()).toBe(404);
    expect((await otherCvTask.json()).error.code).toBe('NOT_FOUND');

    const capturedJob = await apiA.post('/api/v1/jobs/capture', {
      data: {
        title: 'Captured ownership fixture',
        company: 'Capture owner fixture',
        url: `https://jobs.example.test/${randomUUID()}`,
        text: 'The engineer builds accessible TypeScript applications with clear tests, collaborates with product designers, reviews code, and improves the speed and reliability of customer workflows. Candidates explain decisions clearly and support dependable releases.',
      },
    });
    expect(capturedJob.status(), 'job capture owner creates a role').toBe(200);
    const captured = (await capturedJob.json()) as ApiEnvelope<{
      job: { id: string };
      opportunity: { id: string };
    }>;
    capturedJobId = captured.data?.job.id;
    capturedOpportunityId = captured.data?.opportunity.id;
    expect(capturedJobId).toBeTruthy();
    expect(capturedOpportunityId).toBeTruthy();
    const capturedOwner = await apiA.get(
      `/api/v1/opportunities/${capturedOpportunityId}`,
    );
    expect(capturedOwner.status()).toBe(200);
    const capturedOther = await apiB.get(
      `/api/v1/opportunities/${capturedOpportunityId}`,
    );
    expect(capturedOther.status()).toBe(404);
    expect((await capturedOther.json()).error.code).toBe('NOT_FOUND');

    const ids: Record<
      (typeof OWNED_RECORD_ROUTES)[number]['resource'],
      string
    > = {
      file: fileId!,
      task: taskId,
      opportunity: opportunityId!,
      resume: resumeId!,
      answer: answerId!,
      outreach: outreachId!,
      practice: practiceId!,
      post: postId!,
    };
    // Inventory order is intentional: file download is the first owned-ID route.
    for (const route of OWNED_RECORD_ROUTES) {
      const path = route.url(ids[route.resource]);
      const ownerResponse = await apiA.get(path);
      expect(ownerResponse.status(), `${route.name} owner access`).toBe(200);
      const otherResponse = await apiB.get(path);
      expect(otherResponse.status(), `${route.name} cross-user access`).toBe(
        404,
      );
      expect((await otherResponse.json()).error.code).toBe('NOT_FOUND');
    }

    const mutationIds = {
      opportunity: opportunityId!,
      contact: contactId!,
      resume: resumeId!,
      answer: answerId!,
      profileFact: profileFactId!,
      project: projectId!,
      coachProposal: coachProposal.id,
      outreach: outreachId!,
      practice: practiceId!,
      post: postId!,
    };
    for (const route of OWNED_RECORD_MUTATIONS) {
      const path = route.url(mutationIds[route.resource]);
      const data =
        typeof route.data === 'function'
          ? route.data(mutationIds[route.resource])
          : route.data;
      const response = await apiB.fetch(path, {
        method: route.method,
        data,
        headers:
          'key' in route ? { 'idempotency-key': randomUUID() } : undefined,
      });
      expect(response.status(), `${route.name} cross-user write`).toBe(404);
      expect((await response.json()).error.code).toBe('NOT_FOUND');
    }

    const ownerReveal = await apiA.post(`/api/v1/contacts/${contactId}/reveal`);
    expect(
      ownerReveal.status(),
      'contact owner can view an already-revealed email',
    ).toBe(200);
    const ownerSearch = await apiA.post(
      `/api/v1/opportunities/${opportunityId}/contacts/search`,
      {
        headers: { 'idempotency-key': `ownership-search-${suffix}` },
        data: {},
      },
    );
    expect(
      ownerSearch.status(),
      'owner receives the already-completed contacts search task',
    ).toBe(200);

    const factPatchByB = await apiB.patch(
      `/api/v1/profile/facts/${profileFactId}`,
      { data: { status: 'rejected' } },
    );
    expect(factPatchByB.status()).toBe(404);
    const projectPatchByB = await apiB.patch(`/api/v1/projects/${projectId}`, {
      data: { title: 'Cross-user edit attempt' },
    });
    expect(projectPatchByB.status()).toBe(404);

    const ownedCollectionIds: Record<
      (typeof SELF_SCOPED_COLLECTION_ROUTES)[number]['resource'],
      string
    > = {
      profileFact: profileFactId!,
      project: projectId!,
      coachMessage: coachMessage.id,
      coachProposal: coachProposal.id,
      document: resumeId!,
      upload: cvFileId!,
      reminder: reminderId!,
      opportunity: opportunityId!,
      post: postId!,
      reward: rewardId!,
    };
    for (const route of SELF_SCOPED_COLLECTION_ROUTES) {
      const routePath = route.path.replace('{opportunityId}', opportunityId!);
      const ownerResponse = await apiA.get(routePath);
      const otherResponse = await apiB.get(
        `${routePath}?userId=${encodeURIComponent(userA.id)}`,
      );
      expect(ownerResponse.status(), `${route.name} owner list`).toBe(200);
      expect(otherResponse.status(), `${route.name} other-user list`).toBe(200);
      const ownerBody = (await ownerResponse.json()) as ApiEnvelope<unknown>;
      const otherBody = (await otherResponse.json()) as ApiEnvelope<unknown>;
      const ownerData =
        route.collectionKey === 'data'
          ? ownerBody.data
          : (ownerBody.data as Record<string, unknown> | undefined)?.[
              route.collectionKey
            ];
      const otherData =
        route.collectionKey === 'data'
          ? otherBody.data
          : (otherBody.data as Record<string, unknown> | undefined)?.[
              route.collectionKey
            ];
      expect(Array.isArray(ownerData), `${route.name} owner result`).toBe(true);
      expect(Array.isArray(otherData), `${route.name} other-user result`).toBe(
        true,
      );
      expect(
        collectionRecordIds(ownerData as CollectionItem[], route.resource),
        `${route.name} owner includes ${ownedCollectionIds[route.resource]}; received ${collectionRecordIds(ownerData as CollectionItem[], route.resource).join(', ')}`,
      ).toContain(ownedCollectionIds[route.resource]);
      expect(
        collectionRecordIds(otherData as CollectionItem[], route.resource),
        `${route.name} other-user list excludes ${ownedCollectionIds[route.resource]}`,
      ).not.toContain(ownedCollectionIds[route.resource]);
    }

    const ownerOutcome = await apiA.post(
      `/api/v1/contacts/${contactId}/outcome`,
      { data: { outcome: 'reply', confirmed: true } },
    );
    expect(ownerOutcome.status(), 'contact owner can record an outcome').toBe(200);

    expect(SELF_ONLY_ROUTES.map((route) => route.path)).toEqual([
      '/api/v1/me',
      '/api/v1/credits',
      '/api/v1/profile/facts',
      '/api/v1/rewards',
    ]);
    const retiredMeUpdate = await apiB.patch('/api/v1/me', {
      data: { ageConfirmed: true },
    });
    expect(retiredMeUpdate.status()).toBe(405);
    for (const route of SELF_SCOPED_RECORD_ROUTES) {
      const ownerResponse = await apiA.get(route.path);
      const otherResponse = await apiB.get(
        `${route.path}?userId=${encodeURIComponent(userA.id)}`,
      );
      expect(ownerResponse.status(), `${route.name} owner access`).toBe(200);
      expect(otherResponse.status(), `${route.name} other-user access`).toBe(
        200,
      );
      expect((await ownerResponse.json()).data?.id).toBe(socialConnectionId);
      expect((await otherResponse.json()).data?.id).not.toBe(
        socialConnectionId,
      );
    }
    const otherDelete = await apiB.delete('/api/v1/social-connections');
    expect(otherDelete.status()).toBe(404);
    const ownerConnectionAfterOtherDelete = await apiA.get(
      '/api/v1/social-connections',
    );
    expect((await ownerConnectionAfterOtherDelete.json()).data?.id).toBe(
      socialConnectionId,
    );

    const otherReward = await apiB.post('/api/v1/rewards', {
      data: {
        url: `https://example.com/ownership-other/${randomUUID()}`,
        disclosureConfirmed: true,
      },
    });
    expect(otherReward.status()).toBe(200);
    const otherRewardBody = (await otherReward.json()) as ApiEnvelope<{
      id: string;
      userId: string;
    }>;
    rewardBId = otherRewardBody.data?.id;
    expect(otherRewardBody.data?.userId).toBe(userB.id);
  } finally {
    if (userBId)
      await getDatabase()
        .update(users)
        .set({
          deletionRequestedAt: originalBDeletion ?? null,
        })
        .where(eq(users.id, userBId));
    if (opportunityId) {
      await getDatabase()
        .delete(resumeVersions)
        .where(eq(resumeVersions.opportunityId, opportunityId));
      await getDatabase()
        .delete(answerDrafts)
        .where(eq(answerDrafts.opportunityId, opportunityId));
      await getDatabase()
        .delete(fitReviews)
        .where(eq(fitReviews.opportunityId, opportunityId));
    }
    const database = getDatabase();
    if (practiceId)
      await database
        .delete(practiceSessions)
        .where(eq(practiceSessions.id, practiceId));
    if (postId) await database.delete(posts).where(eq(posts.id, postId));
    if (rewardId)
      await database
        .delete(rewardSubmissions)
        .where(eq(rewardSubmissions.id, rewardId));
    if (rewardBId)
      await database
        .delete(rewardSubmissions)
        .where(eq(rewardSubmissions.id, rewardBId));
    if (socialConnectionId)
      await database
        .delete(socialConnections)
        .where(eq(socialConnections.id, socialConnectionId));
    if (projectFactId)
      await database
        .delete(profileFacts)
        .where(eq(profileFacts.id, projectFactId));
    if (fileId) await database.delete(files).where(eq(files.id, fileId));
    if (cvTaskId) await database.delete(tasks).where(eq(tasks.id, cvTaskId));
    if (cvFileId) await database.delete(files).where(eq(files.id, cvFileId));
    if (taskId) await database.delete(tasks).where(eq(tasks.id, taskId));
    if (contactsSearchTaskId)
      await database.delete(tasks).where(eq(tasks.id, contactsSearchTaskId));
    if (fileKey)
      await getPrivateStorage()
        .delete(fileKey)
        .catch(() => undefined);
    if (cvFileKey)
      await getPrivateStorage()
        .delete(cvFileKey)
        .catch(() => undefined);
    if (jobId) await database.delete(jobs).where(eq(jobs.id, jobId));
    if (capturedJobId)
      await database.delete(jobs).where(eq(jobs.id, capturedJobId));
    await userBContext.close();
  }
});
