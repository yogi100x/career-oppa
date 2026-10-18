import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createRecordedResponseGenerator,
  generateStructured,
  loadVersionedPrompt,
  tailorCvPrompt,
} from './index';

const { generateTextMock, providerMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  providerMock: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: generateTextMock,
  Output: { object: vi.fn((options) => options) },
}));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: vi.fn(() => providerMock),
}));

const prompt = new URL('./prompts/sample.v1.md', import.meta.url);
const schema = z.object({ summary: z.string().min(1) });

describe('structured AI adapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    generateTextMock.mockReset();
    providerMock.mockReset().mockImplementation((model: string) => model);
  });

  const configure = () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', '');
  };

  it('keeps personal details out of AI-generated CV headers', async () => {
    const loaded = await loadVersionedPrompt(tailorCvPrompt);
    expect(loaded.version).toBe('tailor-cv.v6');
    expect(loaded.body).toContain('Use supportedSkills only as a prioritisation aid');
    expect(loaded.body).not.toContain('preparation.skills');
    expect(loaded.body).toContain('Return empty strings for name and contact');
    expect(loaded.body).toContain('Never infer, copy, or invent');
  });

  it('uses an explicitly injected recorded response and preserves prompt metadata', async () => {
    const generate = createRecordedResponseGenerator({
      'sample.v1': { summary: 'A test summary.' },
    });
    await expect(
      generate(prompt, schema, { text: 'example' }),
    ).resolves.toEqual({
      object: { summary: 'A test summary.' },
      promptVersion: 'sample.v1',
      model: 'recorded-test-response',
    });
  });

  it('rejects a recorded response that does not match the schema', async () => {
    const generate = createRecordedResponseGenerator({
      'sample.v1': { summary: '' },
    });
    await expect(generate(prompt, schema, {})).rejects.toThrow();
  });

  it('does not use a recorded response as the production default', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    await expect(generateStructured(prompt, schema, {})).rejects.toThrow(
      /OpenRouter is not configured/,
    );
  });

  it('uses Haiku 5.5 by default and returns its result', async () => {
    configure();
    generateTextMock.mockResolvedValue({
      output: { summary: 'Primary result' },
    });
    await expect(generateStructured(prompt, schema, {})).resolves.toEqual({
      object: { summary: 'Primary result' },
      promptVersion: 'sample.v1',
      model: 'anthropic/claude-haiku-5.5',
    });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls[0][0]).toMatchObject({ maxRetries: 0 });
  });

  it('denies provider data collection and passes a requested temperature', async () => {
    configure();
    generateTextMock.mockResolvedValue({ output: { summary: 'ok' } });
    await generateStructured(prompt, schema, {}, { temperature: 0 });
    expect(providerMock.mock.calls[0][1]).toEqual({
      provider: { data_collection: 'deny' },
    });
    expect(generateTextMock.mock.calls[0][0]).toMatchObject({ temperature: 0 });
  });

  it('falls back to Luna after a primary provider or schema failure', async () => {
    configure();
    generateTextMock
      .mockRejectedValueOnce(new Error('invalid structured output'))
      .mockResolvedValueOnce({ output: { summary: 'Fallback result' } });
    await expect(generateStructured(prompt, schema, {})).resolves.toEqual({
      object: { summary: 'Fallback result' },
      promptVersion: 'sample.v1',
      model: 'openai/gpt-6-luna',
    });
    expect(providerMock.mock.calls.map(([model]) => model)).toEqual([
      'anthropic/claude-haiku-5.5',
      'openai/gpt-6-luna',
    ]);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces fallback failure without trying a third time', async () => {
    configure();
    generateTextMock
      .mockRejectedValueOnce(new Error('primary failed'))
      .mockRejectedValueOnce(new Error('fallback failed'));
    await expect(generateStructured(prompt, schema, {})).rejects.toThrow(
      'fallback failed',
    );
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('does not call the same model twice', async () => {
    configure();
    vi.stubEnv('OPENROUTER_MODEL', 'same/model');
    vi.stubEnv('OPENROUTER_FALLBACK_MODEL', 'same/model');
    generateTextMock.mockRejectedValue(new Error('one attempt'));
    await expect(generateStructured(prompt, schema, {})).rejects.toThrow(
      'one attempt',
    );
    expect(providerMock).toHaveBeenCalledTimes(1);
  });

  it('allows an explicitly empty fallback to disable fallback', async () => {
    configure();
    vi.stubEnv('OPENROUTER_FALLBACK_MODEL', '');
    generateTextMock.mockRejectedValue(new Error('primary failed'));
    await expect(generateStructured(prompt, schema, {})).rejects.toThrow(
      'primary failed',
    );
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});
