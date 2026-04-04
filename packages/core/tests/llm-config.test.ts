import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveLLMConfig } from '../src/config/llm.js';

const ORIGINAL_ENV = { ...process.env };

function clearLLMEnv() {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.DECIGRAPH_EMBEDDINGS_URL;
  delete process.env.DECIGRAPH_EMBEDDINGS_KEY;
  delete process.env.DECIGRAPH_EMBEDDINGS_MODEL;
  delete process.env.DECIGRAPH_LLM_URL;
  delete process.env.DECIGRAPH_LLM_KEY;
  delete process.env.DECIGRAPH_LLM_MODEL;
  delete process.env.DISTILLERY_PROVIDER;
  delete process.env.DISTILLERY_MODEL;
  delete process.env.EMBEDDING_PROVIDER;
}

describe('resolveLLMConfig', () => {
  beforeEach(() => {
    clearLLMEnv();
  });

  afterEach(() => {
    Object.keys(process.env).forEach((key) => delete process.env[key]);
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it('returns both null when no keys are set', () => {
    const config = resolveLLMConfig();
    expect(config.embeddings).toBeNull();
    expect(config.distillery).toBeNull();
  });

  it('resolves OpenRouter for both embeddings and distillery', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
    const config = resolveLLMConfig();

    expect(config.embeddings).not.toBeNull();
    expect(config.embeddings!.provider).toBe('openrouter');
    expect(config.embeddings!.url).toBe('https://openrouter.ai/api/v1');
    expect(config.embeddings!.model).toBe('openai/text-embedding-3-small');

    expect(config.distillery).not.toBeNull();
    expect(config.distillery!.provider).toBe('openrouter');
    expect(config.distillery!.url).toBe('https://openrouter.ai/api/v1');
    expect(config.distillery!.model).toContain('claude-opus');
  });

  it('resolves OpenAI direct for both embeddings and distillery', () => {
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    const config = resolveLLMConfig();

    expect(config.embeddings).not.toBeNull();
    expect(config.embeddings!.provider).toBe('openai');
    expect(config.embeddings!.url).toBe('https://api.openai.com/v1');

    expect(config.distillery).not.toBeNull();
    expect(config.distillery!.provider).toBe('openai');
    expect(config.distillery!.model).toBe('gpt-4o-mini');
  });

  it('resolves Anthropic direct: null embeddings, anthropic SDK distillery', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const config = resolveLLMConfig();

    expect(config.embeddings).toBeNull();

    expect(config.distillery).not.toBeNull();
    expect(config.distillery!.provider).toBe('anthropic');
    expect(config.distillery!.url).toBe('__anthropic_sdk__');
    expect(config.distillery!.model).toContain('claude-opus');
  });

  it('DECIGRAPH_EMBEDDINGS_URL overrides OpenRouter for embeddings', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.DECIGRAPH_EMBEDDINGS_URL = 'http://localhost:11434/v1';
    process.env.DECIGRAPH_EMBEDDINGS_KEY = 'ollama';
    process.env.DECIGRAPH_EMBEDDINGS_MODEL = 'nomic-embed-text';
    const config = resolveLLMConfig();

    expect(config.embeddings!.url).toBe('http://localhost:11434/v1');
    expect(config.embeddings!.key).toBe('ollama');
    expect(config.embeddings!.model).toBe('nomic-embed-text');
    expect(config.embeddings!.provider).toBe('localhost');

    // Distillery still uses OpenRouter
    expect(config.distillery!.provider).toBe('openrouter');
  });

  it('DECIGRAPH_LLM_URL overrides OpenRouter for distillery', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.DECIGRAPH_LLM_URL = 'https://api.groq.com/openai/v1';
    process.env.DECIGRAPH_LLM_KEY = 'gsk-test';
    process.env.DECIGRAPH_LLM_MODEL = 'llama-3.3-70b-versatile';
    const config = resolveLLMConfig();

    expect(config.distillery!.url).toBe('https://api.groq.com/openai/v1');
    expect(config.distillery!.key).toBe('gsk-test');
    expect(config.distillery!.model).toBe('llama-3.3-70b-versatile');

    // Embeddings still uses OpenRouter
    expect(config.embeddings!.provider).toBe('openrouter');
  });

  it('OpenAI + Anthropic: embeddings via OpenAI, distillery via Anthropic', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-anthropic';
    const config = resolveLLMConfig();

    expect(config.embeddings!.provider).toBe('openai');
    expect(config.distillery!.provider).toBe('anthropic');
    expect(config.distillery!.url).toBe('__anthropic_sdk__');
  });

  it('DECIGRAPH_LLM_MODEL overrides default model', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.DECIGRAPH_LLM_MODEL = 'gpt-4o';
    const config = resolveLLMConfig();

    expect(config.distillery!.model).toBe('gpt-4o');
  });

  it('DECIGRAPH_EMBEDDINGS_MODEL overrides default model', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.DECIGRAPH_EMBEDDINGS_MODEL = 'text-embedding-3-large';
    const config = resolveLLMConfig();

    expect(config.embeddings!.model).toBe('text-embedding-3-large');
  });

  it('explicit URL/KEY takes highest priority even with all keys set', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or';
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    process.env.DECIGRAPH_EMBEDDINGS_URL = 'http://custom-embed:8080/v1';
    process.env.DECIGRAPH_EMBEDDINGS_KEY = 'custom-key';
    process.env.DECIGRAPH_LLM_URL = 'http://custom-llm:8080/v1';
    process.env.DECIGRAPH_LLM_KEY = 'custom-key';
    const config = resolveLLMConfig();

    expect(config.embeddings!.url).toBe('http://custom-embed:8080/v1');
    expect(config.distillery!.url).toBe('http://custom-llm:8080/v1');
  });
});
