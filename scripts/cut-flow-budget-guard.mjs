import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
const target = process.env.CUT_FLOW_BUDGET_FILE;
if (!target) throw new Error('CUT_FLOW_BUDGET_FILE is required.');
const original = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!url.startsWith('https://openrouter.ai/api/v1/chat/completions'))
    return original(input, init);
  if (!init?.body || typeof init.body !== 'string')
    throw new Error('Budget guard requires a readable request.');
  const body = JSON.parse(init.body);
  const allowed = ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna'];
  if (!allowed.includes(body.model) || body.tools?.length)
    throw new Error('Budget guard rejected model or tools.');
  body.max_tokens = Math.min(body.max_tokens ?? 6000, 6000);
  // Conservative highest published tier; one UTF-8 byte per input token.
  const reserve =
    Buffer.byteLength(JSON.stringify(body.messages ?? [])) * 0.0000005 +
    body.max_tokens * 0.0000025 +
    0.002;
  let lock;
  try {
    lock = openSync(target + '.lock', 'wx');
  } catch {
    throw new Error('Budget guard busy; retry later.');
  }
  try {
    const state = JSON.parse(readFileSync(target, 'utf8'));
    if (state.reserved + reserve > 0.25)
      throw new Error('Live check spending cap reached.');
    state.reserved += reserve;
    state.requests += 1;
    writeFileSync(target, JSON.stringify(state), { mode: 0o600 });
  } finally {
    closeSync(lock);
    unlinkSync(target + '.lock');
  }
  const response = await original(input, {
    ...init,
    body: JSON.stringify(body),
  });
  const result = await response
    .clone()
    .json()
    .catch(() => ({}));
  let responseLock;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      responseLock = openSync(target + '.lock', 'wx');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (responseLock === undefined)
    throw new Error('Budget result lock unavailable.');
  const state = JSON.parse(readFileSync(target, 'utf8'));
  state.responses += 1;
  state.actualCost += Number(result.usage?.cost ?? 0);
  state.costReported += typeof result.usage?.cost === 'number' ? 1 : 0;
  writeFileSync(target, JSON.stringify(state), { mode: 0o600 });
  closeSync(responseLock);
  unlinkSync(target + '.lock');
  return response;
};
