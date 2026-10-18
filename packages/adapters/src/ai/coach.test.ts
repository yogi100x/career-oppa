import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamCoach } from './coach';

const sdk = vi.hoisted(() => ({
  streamText: vi.fn(),
  captured: null as unknown,
}));
vi.mock('ai', () => ({
  streamText: sdk.streamText,
  tool: (definition: unknown) => definition,
  stepCountIs: (count: number) => ({ count }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  sdk.streamText.mockReset();
});
const tools = () => ({
  profile: vi.fn(async () => ({ facts: [] })),
  roles: vi.fn(async () => []),
  role: vi.fn(async () => ({ title: 'Recorded role' })),
  reminders: vi.fn(async () => []),
  proposeStatus: vi.fn(async () => ({ pending: true })),
  discoveryMatches: vi.fn(async () => ({ matches: [{ id: 'recorded-job' }] })),
  saveDiscoveredJob: vi.fn(async () => ({ pending: true })),
});

describe('coach streaming adapter with recorded output', () => {
  it('refuses missing configuration without starting a model call', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    await expect(
      streamCoach({
        coachId: 'coach',
        messages: [],
        tools: tools(),
        onFinish: vi.fn(),
        onError: vi.fn(),
      }),
    ).rejects.toThrow('AI_NOT_CONFIGURED');
    expect(sdk.streamText).not.toHaveBeenCalled();
  });
  it('applies the shared history bounds to direct adapter callers', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    sdk.streamText.mockImplementation((options) => {
      sdk.captured = options;
      return { toTextStreamResponse: () => new Response('') };
    });
    await streamCoach({
      coachId: 'coach',
      messages: Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 ? 'assistant' as const : 'user' as const,
        content: `${index}:` + 'x'.repeat(1498),
      })),
      tools: tools(),
      onFinish: vi.fn(),
      onError: vi.fn(),
    });
    const options = sdk.captured as {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      maxOutputTokens: number;
      timeout: { totalMs: number };
    };
    expect(options.messages).toHaveLength(4);
    expect(options.messages.map(({ content }) => content.slice(0, 2))).toEqual([
      '4:', '5:', '6:', '7:',
    ]);
    expect(options.messages.reduce((sum, item) => sum + item.content.length, 0)).toBe(6000);
    expect(options.maxOutputTokens).toBe(700);
    expect(options.timeout.totalMs).toBe(45_000);
  });

  it('consumes whitespace-only output on interruption and releases an empty abort', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    sdk.streamText.mockImplementation((options) => {
      sdk.captured = options;
      return { toTextStreamResponse: () => new Response('') };
    });
    const onFinish = vi.fn(async () => {});
    const onError = vi.fn(async () => {});
    await streamCoach({
      coachId: 'coach',
      messages: [],
      tools: tools(),
      onFinish,
      onError,
    });
    const callbacks = sdk.captured as {
      onChunk: (event: { chunk: { type: string; text?: string } }) => void;
      onAbort: () => Promise<void>;
    };
    callbacks.onChunk({ chunk: { type: 'text-delta', text: '  ' } });
    await callbacks.onAbort();
    expect(onFinish).toHaveBeenCalledWith(
      'The reply was interrupted before readable text was available.',
      { promptVersion: 'coach.v3', model: 'anthropic/claude-haiku-5.5' },
    );
    expect(onError).not.toHaveBeenCalled();

    const emptyError = vi.fn(async () => {});
    await streamCoach({
      coachId: 'coach',
      messages: [],
      tools: tools(),
      onFinish: vi.fn(),
      onError: emptyError,
    });
    const emptyCallbacks = sdk.captured as { onAbort: () => Promise<void> };
    await emptyCallbacks.onAbort();
    expect(emptyError).toHaveBeenCalledOnce();
  });

  it('makes the SDK abort callback wait for an in-flight save', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    let releaseSave!: () => void;
    const onFinish = vi.fn(
      () => new Promise<void>((resolve) => { releaseSave = resolve; }),
    );
    const signal = new AbortController();
    sdk.streamText.mockImplementation((options) => {
      sdk.captured = options;
      return { toTextStreamResponse: () => new Response('') };
    });
    await streamCoach({
      coachId: 'coach',
      messages: [],
      tools: tools(),
      signal: signal.signal,
      onFinish,
      onError: vi.fn(),
    });
    const callbacks = sdk.captured as {
      onChunk: (event: { chunk: { type: string; text?: string } }) => void;
      onAbort: () => Promise<void>;
    };
    callbacks.onChunk({ chunk: { type: 'text-delta', text: 'Saved partial' } });
    signal.abort();
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalledOnce());

    let abortCallbackFinished = false;
    const abortCallback = callbacks.onAbort().then(() => {
      abortCallbackFinished = true;
    });
    await Promise.resolve();
    expect(abortCallbackFinished).toBe(false);
    releaseSave();
    await abortCallback;
    expect(abortCallbackFinished).toBe(true);
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('streams a recording, uses the versioned tone and stores completion metadata', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'recorded-test-model');
    const onFinish = vi.fn();
    const readers = tools();
    sdk.streamText.mockImplementation((options) => {
      sdk.captured = options;
      return {
        toTextStreamResponse: () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('Recorded coach reply.'),
                );
                await options.onFinish({
                  text: 'Recorded coach reply.',
                  response: { modelId: 'openai/selected-fallback' },
                });
                controller.close();
              },
            }),
          ),
      };
    });
    const result = await streamCoach({
      coachId: 'coach',
      messages: [{ role: 'user', content: 'Help me choose a next step.' }],
      tools: readers,
      onFinish,
      onError: vi.fn(),
    });
    expect(await result.toTextStreamResponse().text()).toBe(
      'Recorded coach reply.',
    );
    expect(onFinish).toHaveBeenCalledWith('Recorded coach reply.', {
      promptVersion: 'coach.v3',
      model: 'openai/selected-fallback',
    });
    const options = sdk.captured as {
      system: string;
      maxOutputTokens: number;
      maxRetries: number;
      providerOptions: { openrouter: { models: string[] } };
      tools: {
        suggestStatus: {
          execute: (input: {
            id: string;
            status: 'preparing';
            reason: string;
          }) => Promise<unknown>;
        };
        discoveryMatches: {
          inputSchema: {
            safeParse: (
              input: unknown,
            ) => { success: boolean; data?: { keyword?: string } };
          };
          execute: (input: { keyword?: string }) => Promise<unknown>;
        };
        saveDiscoveredJob: {
          inputSchema: { safeParse: (input: unknown) => { success: boolean } };
          execute: (input: { id: string }) => Promise<unknown>;
        };
        readProfile: unknown;
        readRoles: unknown;
        readRole: unknown;
        readReminders: unknown;
      };
    };
    expect(options.system).toContain('proposes saving one collected job');
    expect(options.system).toContain('No matches collected yet. Open Discover on the web to refresh.');
    expect(options.system).toContain('Keep each answer focused on the next useful step.');
    expect(Object.keys(options.tools).sort()).toEqual(
      [
        'discoveryMatches',
        'readProfile',
        'readRole',
        'readRoles',
        'readReminders',
        'saveDiscoveredJob',
        'suggestStatus',
      ].sort(),
    );
    expect(options.maxOutputTokens).toBe(700);
    expect(options.maxRetries).toBe(0);
    expect(options.providerOptions.openrouter.models).toEqual([
      'openai/gpt-6-luna',
    ]);
    await options.tools.suggestStatus.execute({
      id: 'recorded-id',
      status: 'preparing',
      reason: 'Review your evidence first.',
    });
    expect(readers.proposeStatus).toHaveBeenCalledWith(
      'recorded-id',
      'preparing',
      'Review your evidence first.',
    );
    const parsedKeyword = options.tools.discoveryMatches.inputSchema.safeParse({
      keyword: '  devops ',
    });
    expect(parsedKeyword).toMatchObject({ success: true, data: { keyword: 'devops' } });
    expect(
      options.tools.discoveryMatches.inputSchema.safeParse({
        keyword: 'x'.repeat(101),
      }).success,
    ).toBe(false);
    expect(
      options.tools.discoveryMatches.inputSchema.safeParse({ extra: true })
        .success,
    ).toBe(false);
    expect(
      options.tools.saveDiscoveredJob.inputSchema.safeParse({ id: 'not-a-uuid' })
        .success,
    ).toBe(false);
    expect(
      options.tools.saveDiscoveredJob.inputSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
      }).success,
    ).toBe(true);
    await options.tools.discoveryMatches.execute({ keyword: 'devops' });
    await options.tools.saveDiscoveredJob.execute({ id: '550e8400-e29b-41d4-a716-446655440000' });
    expect(readers.discoveryMatches).toHaveBeenCalledWith('devops');
    expect(readers.saveDiscoveredJob).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000');
  });

  it('honors an environment main model and allows an empty fallback setting', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'custom/main-model');
    vi.stubEnv('OPENROUTER_FALLBACK_MODEL', '');
    sdk.streamText.mockImplementation((options) => {
      sdk.captured = options;
      return { toTextStreamResponse: () => new Response('') };
    });

    await streamCoach({
      coachId: 'coach',
      messages: [],
      tools: tools(),
      onFinish: vi.fn(),
      onError: vi.fn(),
    });

    const options = sdk.captured as {
      model: { modelId?: string };
      providerOptions?: unknown;
    };
    expect(options.model).toMatchObject({ modelId: 'custom/main-model' });
    expect(options.providerOptions).toBeUndefined();
  });

  it('uses the requested main model when response metadata has no model id', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');
    const onFinish = vi.fn();
    sdk.streamText.mockImplementation((options) => ({
      toTextStreamResponse: () => new Response(''),
      options,
    }));
    await streamCoach({
      coachId: 'coach',
      messages: [],
      tools: tools(),
      onFinish,
      onError: vi.fn(),
    });
    const options = sdk.streamText.mock.calls[0][0];
    await options.onFinish({ text: 'Reply', response: {} });
    expect(onFinish).toHaveBeenCalledWith('Reply', {
      promptVersion: 'coach.v3',
      model: 'anthropic/claude-haiku-5.5',
    });
  });
});
