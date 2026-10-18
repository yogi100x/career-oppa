import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamText } from 'ai';

const modelState = vi.hoisted(() => ({ model: null as unknown }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => () => modelState.model,
}));

import { streamCoach } from './coach';

const readers = {
  profile: async () => ({}),
  roles: async () => [],
  role: async () => ({}),
  reminders: async () => [],
  proposeStatus: async () => ({}),
  discoveryMatches: async () => ({}),
  saveDiscoveredJob: async () => ({}),
};

function recordingModel() {
  return {
    specificationVersion: 'v2',
    provider: 'recorded',
    modelId: 'recorded-model',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('This test exercises streaming only');
    },
    doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({
            type: 'response-metadata',
            id: 'recorded-response',
            modelId: 'recorded-model',
          });
          controller.enqueue({ type: 'text-start', id: 'message' });
          controller.enqueue({
            type: 'text-delta',
            id: 'message',
            delta: 'Partial recorded answer',
          });
          abortSignal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        },
      }),
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  modelState.model = null;
});

describe('coach adapter with the installed AI SDK stream implementation', () => {
  it('fires the installed SDK onAbort callback when its total timeout expires', async () => {
    const model = recordingModel();
    const onAbort = vi.fn();
    const result = streamText({
      model: model as never,
      messages: [{ role: 'user', content: 'Help me.' }],
      maxRetries: 0,
      timeout: { totalMs: 20 },
      onAbort,
    });
    const reader = result.fullStream.getReader();
    let sawPartial = false;
    while (!sawPartial) {
      const { value, done } = await reader.read();
      if (done) break;
      sawPartial = value.type === 'text-delta';
    }
    await reader.read();
    await vi.waitFor(() => expect(onAbort).toHaveBeenCalledOnce());
  }, 3000);

  it('records partial output on abort and releases a request aborted before output', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'recorded-test-key');

    const partialModel = recordingModel();
    modelState.model = partialModel;
    const partialController = new AbortController();
    const partialFinish = vi.fn(async () => {});
    const partialError = vi.fn(async () => {});
    const partialResult = await streamCoach({
      coachId: 'coach',
      messages: [{ role: 'user', content: 'Help me.' }],
      tools: readers,
      signal: partialController.signal,
      onFinish: partialFinish,
      onError: partialError,
    });
    const partialResponse = partialResult.toTextStreamResponse();
    const partialReader = partialResponse.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('Partial recorded answer')) {
      const { value, done } = await partialReader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    partialController.abort();
    await vi.waitFor(() => expect(partialFinish).toHaveBeenCalledOnce());
    expect(body).toContain('Partial recorded answer');
    expect(partialFinish).toHaveBeenCalledWith('Partial recorded answer', {
      promptVersion: 'coach.v3',
      model: 'anthropic/claude-haiku-5.5',
    });
    expect(partialError).not.toHaveBeenCalled();

    const emptyModel = {
      ...recordingModel(),
      doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            abortSignal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          },
        }),
      }),
    };
    modelState.model = emptyModel;
    const emptyController = new AbortController();
    const emptyFinish = vi.fn(async () => {});
    const emptyError = vi.fn(async () => {});
    const emptyResult = await streamCoach({
      coachId: 'coach',
      messages: [{ role: 'user', content: 'Help me.' }],
      tools: readers,
      signal: emptyController.signal,
      onFinish: emptyFinish,
      onError: emptyError,
    });
    const emptyResponse = emptyResult.toTextStreamResponse();
    const emptyReader = emptyResponse.body!.getReader();
    emptyController.abort();
    await vi.waitFor(() => expect(emptyError).toHaveBeenCalledOnce());
    expect(emptyFinish).not.toHaveBeenCalled();
    await emptyReader.cancel();
  });
});
