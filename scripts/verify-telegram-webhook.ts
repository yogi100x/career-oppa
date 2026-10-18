/** Local-only walkthrough. Requires the dev server on 3197 and guarded SDK test transport. */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const {
  createDatabase,
  users,
  tasks,
  opportunities,
  reminders,
  rateLimits,
  coachMessages,
} = requireWeb('@career-workspace/db');
const { createTelegramLinkCode, getTelegramLink } = requireWeb(
  '@career-workspace/core/telegram-links',
);
const { balance } = requireWeb('@career-workspace/core/credits');
const { eq, and } = requireWeb('drizzle-orm');
process.loadEnvFile('apps/web/.env.local');
const target = 'http://localhost:3197';
let stage = 'configuration';
const messages: Array<{
  text: string;
  reply_markup?: {
    inline_keyboard: Array<
      Array<{ text: string; callback_data?: string; url?: string }>
    >;
  };
}> = [];
let messageId = 1;
const typingActions: Array<Record<string, unknown>> = [];
const server = createServer(async (request, response) => {
  if (!request.url?.startsWith('/bot123456:local-test-token/')) {
    response.writeHead(403).end();
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const method = request.url.split('/').at(-1);
  response.setHeader('content-type', 'application/json');
  if (method === 'getMe')
    response.end(
      JSON.stringify({
        ok: true,
        result: {
          id: 123456,
          is_bot: true,
          first_name: 'Local test',
          username: 'CareerOppaBot',
        },
      }),
    );
  else if (method === 'sendMessage') {
    messages.push({ ...body, text: body.text.replace(/\\(.)/gs, '$1') });
    response.end(
      JSON.stringify({
        ok: true,
        result: {
          ...body,
          message_id: messageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(body.chat_id), type: 'private' },
          from: { id: 123456, is_bot: true, first_name: 'Local test' },
        },
      }),
    );
  } else if (method === 'answerCallbackQuery')
    response.end(JSON.stringify({ ok: true, result: true }));
  else if (method === 'sendChatAction') {
    typingActions.push(body);
    response.end(JSON.stringify({ ok: true, result: true }));
  } else
    response.end(
      JSON.stringify({
        ok: false,
        description: 'Unsupported local test method',
      }),
    );
});
function assert(value: unknown) {
  if (!value) throw new Error('check_failed');
}
async function main() {
  const dbUrl = new URL(process.env.DATABASE_URL!);
  assert(
    dbUrl.pathname === '/career_workspace_test' &&
      ['localhost', '127.0.0.1'].includes(dbUrl.hostname),
  );
  assert(process.env.TELEGRAM_TEST_API_URL === 'http://127.0.0.1:3195');
  assert(process.env.OPENROUTER_API_KEY === '');
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET!;
  assert(secret);
  assert(process.env.CRON_SECRET);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(3195, '127.0.0.1', done);
  });
  const { database, pool } = createDatabase(dbUrl.toString());
  const [user] = await database
    .insert(users)
    .values({ clerkId: `telegram-walkthrough-${randomUUID()}` })
    .returning();
  const identity = Date.now();
  let updateId = Date.now();
  async function post(payload: unknown, valid = true) {
    return fetch(`${target}/api/webhooks/telegram`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': valid ? secret : 'wrong',
      },
      body: JSON.stringify(payload),
    });
  }
  const message = (text: string) => ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      chat: { id: identity, type: 'private' },
      from: { id: identity, is_bot: false, first_name: 'Test' },
      text,
    },
  });
  async function waitForReply(previous: number) {
    const end = Date.now() + 45_000;
    while (messages.length <= previous && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 150));
    assert(messages.length > previous);
    return messages.at(-1)!;
  }
  async function send(text: string) {
    const previous = messages.length;
    const response = await post(message(text));
    assert(response.status === 200);
    return waitForReply(previous);
  }
  async function press(data: string, id = ++updateId) {
    const previous = messages.length;
    const payload = {
      update_id: id,
      callback_query: {
        id: `local-${id}`,
        from: { id: identity },
        data,
        message: { message_id: 1, chat: { id: identity, type: 'private' } },
      },
    };
    const response = await post(payload);
    assert(response.status === 200);
    return { reply: await waitForReply(previous), payload };
  }
  try {
    stage = 'secret-and-private-chat';
    assert((await post(message('/credits'), false)).status === 401);
    const group = message('/credits');
    group.message.chat.type = 'group';
    assert((await post(group)).status === 200);
    assert(messages.length === 0);
    console.log('PASS secret and private-chat guards');
    stage = 'unlinked';
    assert(/connect/i.test((await send('/credits')).text));
    for (let attempt = 1; attempt < 5; attempt++) await send('/start invalid');
    const replyCount = messages.length;
    assert((await post(message('/credits'))).status === 200);
    assert((await post(message('/start invalid'))).status === 200);
    assert(messages.length === replyCount);
    console.log('PASS unlinked account five-reply cap');
    stage = 'connect';
    const link = await createTelegramLinkCode(user.id, { database });
    const code = new URL(link.url).searchParams.get('start');
    const connected = await send(`/start ${code}`);
    assert(
      /reminders are on/i.test(connected.text) && /\/stop/.test(connected.text),
    );
    assert(await getTelegramLink(user.id, database));
    console.log('PASS one-time connection and stop instructions');
    stage = 'help';
    const help = await send('/help');
    assert(/job search/i.test(help.text) && /\/roles/.test(help.text));
    assert(
      help.reply_markup?.inline_keyboard
        .flat()
        .some((item) => item.url === `${target}/workspace`),
    );
    console.log('PASS help claims and workspace URL');
    stage = 'short-coach-question-ai-disabled';
    const questionPayload = message('Can you help?');
    const repliesBeforeQuestion = messages.length;
    assert((await post(questionPayload)).status === 200);
    const coachReply = await waitForReply(repliesBeforeQuestion);
    assert(/not connected to AI yet/i.test(coachReply.text));
    assert(
      !typingActions.some(
        (action) =>
          String(action.chat_id) === String(identity) &&
          action.action === 'typing',
      ),
    );
    const coachRows = await database
      .select()
      .from(coachMessages)
      .where(eq(coachMessages.userId, user.id));
    assert(coachRows.length === 0);
    const coachAllowance = await database
      .select()
      .from(rateLimits)
      .where(
        and(
          eq(rateLimits.userId, user.id),
          eq(rateLimits.actionKey, 'coach_chat'),
        ),
      );
    assert(coachAllowance.length === 0);
    const messagesAfterQuestion = messages.length;
    assert((await post(questionPayload)).status === 200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert(messages.length === messagesAfterQuestion);
    console.log(
      'PASS short coach question stays AI-disabled without typing or allowance, and retry replies once',
    );
    stage = 'long-question-and-ambiguous-choice';
    const longQuestion =
      'How can I explain my experience when changing careers and connect my recent projects to the roles I want, while staying honest about skills I am still learning?';
    assert(/not connected to AI yet/i.test((await send(longQuestion)).text));
    const ambiguous =
      'I have worked across several teams and recently completed a project with people from different backgrounds. I am thinking about my experience and the next step in my career.';
    const choice = await send(ambiguous);
    const choices = choice.reply_markup?.inline_keyboard.flat() ?? [];
    const questionChoice = choices.find(
      (item) => item.text === 'It is a question',
    );
    const jobChoice = choices.find(
      (item) => item.text === 'Review this job (1 credit)',
    );
    assert(questionChoice?.callback_data && jobChoice?.callback_data);
    assert(Buffer.byteLength(questionChoice!.callback_data!) < 64);
    assert(Buffer.byteLength(jobChoice!.callback_data!) < 64);
    assert(
      /not connected to AI yet/i.test(
        (await press(questionChoice!.callback_data!)).reply.text,
      ),
    );
    assert(
      /costs 1 credit/i.test(
        (await press(jobChoice!.callback_data!)).reply.text,
      ),
    );
    console.log('PASS long question and both ambiguous-message choices');
    stage = 'credits';
    const before = await balance(user.id, { database });
    assert(/credits available/i.test((await send('/credits')).text));
    stage = 'cost-confirmation';
    const confirmation = await send(
      'Software engineer vacancy. Build reliable web services using TypeScript and PostgreSQL. Work with designers, review code and maintain automated checks.',
    );
    assert(/1 credit/i.test(confirmation.text));
    const button = confirmation.reply_markup?.inline_keyboard
      .flat()
      .find((item) => item.callback_data?.includes('review:'));
    assert(button?.callback_data);
    stage = 'ai-disabled-confirmation';
    const { reply, payload } = await press(button!.callback_data!);
    assert(/not configured/i.test(reply.text));
    assert(
      (await balance(user.id, { database })).available === before.available,
    );
    assert((await post(payload)).status === 200);
    const rows = await database
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, user.id),
          eq(tasks.idempotencyKey, `telegram:${payload.update_id}`),
        ),
      );
    assert(rows.length === 1);
    console.log(
      'PASS cost confirmation, disabled AI without charge, duplicate update',
    );
    stage = 'roles-and-prepare';
    const roles = await send('/roles');
    assert(
      roles.reply_markup?.inline_keyboard
        .flat()
        .some((item) => /Software engineer vacancy/.test(item.text)),
    );
    const prepare = await send('/prepare');
    const prepareButton = prepare.reply_markup?.inline_keyboard
      .flat()
      .find((item) => item.callback_data?.includes('prepare:'));
    assert(prepareButton?.callback_data);
    const prepared = await press(prepareButton!.callback_data!);
    assert(
      prepared.reply.reply_markup?.inline_keyboard
        .flat()
        .some((item) => item.url?.startsWith(target)),
    );
    console.log('PASS saved roles and web preparation link');
    stage = 'scheduled-reminder';
    const [role] = await database
      .select()
      .from(opportunities)
      .where(eq(opportunities.userId, user.id));
    await database.insert(reminders).values({
      userId: user.id,
      opportunityId: role.id,
      title: 'Local walkthrough follow-up',
      dueAt: new Date(0),
    });
    await database.insert(reminders).values({
      userId: user.id,
      opportunityId: role.id,
      title: 'Second local follow-up',
      dueAt: new Date(0),
    });
    const reminderCount = messages.length;
    const runSchedule = () =>
      fetch(`${target}/api/cron/telegram`, {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
    assert((await runSchedule()).status === 200);
    assert(
      messages.length === reminderCount + 1 &&
        /follow-up reminder/i.test(messages.at(-1)!.text),
    );
    const firstReminderText = messages.at(-1)!.text;
    assert((await runSchedule()).status === 200);
    assert(messages.length === reminderCount + 1);
    console.log('PASS one reminder per day and repeat-delivery guard');
    stage = 'disconnect';
    assert(/disconnected/i.test((await send('/stop')).text));
    assert(!(await getTelegramLink(user.id, database)));
    console.log('PASS disconnect');
    const nextLink = await createTelegramLinkCode(user.id, { database });
    await send(`/start ${new URL(nextLink.url).searchParams.get('start')}`);
    const afterRelink = messages.length;
    await runSchedule();
    assert(messages.length === afterRelink);
    await database
      .update(tasks)
      .set({ updatedAt: new Date(0) })
      .where(
        and(
          eq(tasks.userId, user.id),
          eq(tasks.kind, 'telegram_reminder'),
          eq(tasks.status, 'succeeded'),
        ),
      );
    await database
      .update(rateLimits)
      .set({ windowStart: new Date(0) })
      .where(eq(rateLimits.userId, user.id));
    await runSchedule();
    assert(messages.length === afterRelink + 1);
    assert(messages.at(-1)!.text !== firstReminderText);
    await database
      .update(tasks)
      .set({ updatedAt: new Date(0) })
      .where(
        and(
          eq(tasks.userId, user.id),
          eq(tasks.kind, 'telegram_reminder'),
          eq(tasks.status, 'succeeded'),
        ),
      );
    await database
      .update(rateLimits)
      .set({ windowStart: new Date(0) })
      .where(eq(rateLimits.userId, user.id));
    await runSchedule();
    assert(messages.length === afterRelink + 1);
    console.log('PASS relink retains sent history and daily cap');
  } finally {
    await database
      .delete(rateLimits)
      .where(eq(rateLimits.externalSubject, `telegram:${identity}`));
    await database.delete(users).where(eq(users.id, user.id));
    await pool.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
main().catch(() => {
  console.error(`FAIL ${stage}`);
  server.close();
  process.exitCode = 1;
});
