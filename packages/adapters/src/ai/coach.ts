import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { streamText, tool, stepCountIs } from 'ai';
import {
  COACH_GENERATION_TIMEOUT_MS,
  COACH_OUTPUT_TOKEN_LIMIT,
  trimCoachHistory,
} from '@career-workspace/contracts';
import { z } from 'zod';
import { loadVersionedPrompt } from './index';

const statusSchema = z.enum([
  'saved',
  'reviewed',
  'preparing',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
]);
type Status = z.infer<typeof statusSchema>;
export type CoachTools = {
  profile: () => Promise<unknown>;
  roles: () => Promise<unknown>;
  role: (id: string) => Promise<unknown>;
  reminders: () => Promise<unknown>;
  proposeStatus: (
    id: string,
    status: Status,
    reason: string,
  ) => Promise<unknown>;
  discoveryMatches: (keyword?: string) => Promise<unknown>;
  saveDiscoveredJob: (id: string) => Promise<unknown>;
};
const tones: Record<string, URL> = {
  coach: new URL('./prompts/coach.v3.md', import.meta.url),
};
const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5';
const DEFAULT_FALLBACK_MODEL = 'openai/gpt-6-luna';

export async function streamCoach(options: {
  coachId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: CoachTools;
  signal?: AbortSignal;
  onFinish: (
    text: string,
    metadata: { promptVersion: string; model: string },
  ) => Promise<void>;
  onError: () => Promise<void>;
}): Promise<{ toTextStreamResponse: (init?: ResponseInit) => Response }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.startsWith('REPLACE_WITH_'))
    throw new Error('AI_NOT_CONFIGURED');
  const prompt = await loadVersionedPrompt(
    tones[options.coachId] ?? tones.coach,
  );
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const configuredFallback = process.env.OPENROUTER_FALLBACK_MODEL;
  const fallbackModel =
    configuredFallback === undefined
      ? DEFAULT_FALLBACK_MODEL
      : configuredFallback.trim();
  const openrouter = createOpenRouter({ apiKey });
  let streamedText = '';
  let settlement: Promise<void> | undefined;

  const settle = (callback: () => Promise<void>) => {
    if (settlement) return settlement;
    settlement = Promise.resolve().then(callback);
    const removeAbortListener = () => {
      if (abortListener) options.signal?.removeEventListener('abort', abortListener);
    };
    void settlement.then(removeAbortListener, removeAbortListener);
    return settlement;
  };

  const finish = async (
    text: string,
    metadata: { promptVersion: string; model: string },
  ) => {
    return settle(() => options.onFinish(text, metadata));
  };
  const fail = async () => {
    return settle(options.onError);
  };
  const interrupted = async () => {
    if (streamedText.length > 0) {
      await finish(
        streamedText.trim()
          ? streamedText
          : 'The reply was interrupted before readable text was available.',
        { promptVersion: prompt.version, model },
      );
    } else {
      await fail();
    }
  };
  const abortListener = () => {
    void interrupted().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abortListener, { once: true });
  if (options.signal?.aborted) abortListener();

  return streamText({
    model: openrouter(model, { provider: { data_collection: 'deny' } }),
    ...(fallbackModel && fallbackModel !== model
      ? { providerOptions: { openrouter: { models: [fallbackModel] } } }
      : {}),
    system: prompt.body,
    messages: trimCoachHistory(options.messages),
    maxOutputTokens: COACH_OUTPUT_TOKEN_LIMIT,
    timeout: { totalMs: COACH_GENERATION_TIMEOUT_MS },
    stopWhen: stepCountIs(5),
    abortSignal: options.signal,
    tools: {
      readProfile: tool({
        description:
          'Read your candidate’s profile facts, including their approval status.',
        inputSchema: z.object({}).strict(),
        execute: options.tools.profile,
      }),
      readRoles: tool({
        description: 'Read your candidate’s saved roles and next steps.',
        inputSchema: z.object({}).strict(),
        execute: options.tools.roles,
      }),
      readRole: tool({
        description: 'Read one role owned by your candidate.',
        inputSchema: z.object({ id: z.uuid() }).strict(),
        execute: ({ id }) => options.tools.role(id),
      }),
      readReminders: tool({
        description: 'Read your candidate’s saved follow-up reminders.',
        inputSchema: z.object({}).strict(),
        execute: options.tools.reminders,
      }),
      suggestStatus: tool({
        description:
          'Propose a status change for the candidate to explicitly confirm. This does not change the role.',
        inputSchema: z
          .object({
            id: z.uuid(),
            status: statusSchema,
            reason: z.string().trim().min(1).max(1000),
          })
          .strict(),
        execute: ({ id, status, reason }) =>
          options.tools.proposeStatus(id, status, reason),
      }),
      discoveryMatches: tool({
        description:
          'Read up to 10 of your candidate’s already-collected CV-matched jobs, optionally filtered by keyword. This does not search for or refresh jobs.',
        inputSchema: z
          .object({ keyword: z.string().trim().max(100).optional() })
          .strict(),
        execute: ({ keyword }) => options.tools.discoveryMatches(keyword),
      }),
      saveDiscoveredJob: tool({
        description:
          'Propose saving one already-collected discovered job. This only creates a confirmation proposal; the candidate must confirm using the explicit web card or Telegram button.',
        inputSchema: z.object({ id: z.uuid() }).strict(),
        execute: ({ id }) => options.tools.saveDiscoveredJob(id),
      }),
    },
    maxRetries: 0,
    onChunk: async ({ chunk }) => {
      if (chunk.type === 'text-delta') streamedText += chunk.text;
    },
    onFinish: async ({ text, response }) =>
      finish(text, {
        promptVersion: prompt.version,
        model: response.modelId || model,
      }),
    onError: async () => fail(),
    onAbort: interrupted,
  });
}
