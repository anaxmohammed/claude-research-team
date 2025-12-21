/**
 * AI Provider Abstraction Layer
 *
 * Provides a unified interface for calling different AI providers:
 * - Claude (via Agent SDK) - uses your Claude account
 * - Gemini (via REST API) - uses free API key
 *
 * The provider is selected based on config and automatically falls back
 * to Claude if Gemini is unavailable.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { getConfig } from '../utils/config.js';
import { Logger } from '../utils/logger.js';
import type { AIProvider, ClaudeModel, GeminiModel } from '../types.js';

const logger = new Logger('AIProvider');

// Claude model mappings for Agent SDK
const CLAUDE_MODEL_MAP: Record<ClaudeModel, string> = {
  haiku: 'claude-3-haiku-20240307',
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-20250514',
};

// Gemini API endpoint
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface AIQueryOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface AIQueryResult {
  content: string;
  provider: AIProvider;
  model: string;
  tokensUsed?: number;
}

/**
 * Query the configured AI provider
 */
export async function queryAI(
  prompt: string,
  options: AIQueryOptions = {}
): Promise<AIQueryResult> {
  const config = getConfig();
  const aiConfig = config.getValue('aiProvider');

  // Check if Gemini is configured and selected
  if (aiConfig.provider === 'gemini') {
    const geminiKey = process.env.GEMINI_API_KEY || aiConfig.geminiApiKey;
    if (geminiKey) {
      try {
        return await queryGemini(prompt, geminiKey, aiConfig.geminiModel, options);
      } catch (error) {
        logger.warn('Gemini query failed, falling back to Claude', error);
        // Fall through to Claude
      }
    } else {
      logger.warn('Gemini selected but no API key, falling back to Claude');
    }
  }

  // Default to Claude
  return await queryClaude(prompt, aiConfig.claudeModel, options);
}

/**
 * Query Claude via Agent SDK
 */
async function queryClaude(
  prompt: string,
  model: ClaudeModel,
  _options: AIQueryOptions
): Promise<AIQueryResult> {
  logger.debug(`Querying Claude (${model})`, { promptLength: prompt.length });

  const queryGenerator = query({
    prompt,
    options: {
      maxTurns: 1,
      tools: [],
      // Model selection is handled by the Agent SDK based on context
    },
  });

  let result = '';
  for await (const message of queryGenerator) {
    if (message.type === 'result' && message.subtype === 'success') {
      result = message.result;
      break;
    }
  }

  return {
    content: result,
    provider: 'claude',
    model: CLAUDE_MODEL_MAP[model],
    tokensUsed: estimateTokens(result),
  };
}

/**
 * Query Gemini via REST API
 */
async function queryGemini(
  prompt: string,
  apiKey: string,
  model: GeminiModel,
  options: AIQueryOptions
): Promise<AIQueryResult> {
  logger.debug(`Querying Gemini (${model})`, { promptLength: prompt.length });

  const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 2048,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as GeminiResponse;

  if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
    throw new Error('Invalid Gemini response structure');
  }

  const content = data.candidates[0].content.parts[0].text;
  const tokensUsed = data.usageMetadata?.totalTokenCount;

  return {
    content,
    provider: 'gemini',
    model,
    tokensUsed,
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Estimate tokens (rough approximation)
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

/**
 * Check if Gemini is available (has API key)
 */
export function isGeminiAvailable(): boolean {
  const config = getConfig();
  const aiConfig = config.getValue('aiProvider');
  return !!(process.env.GEMINI_API_KEY || aiConfig.geminiApiKey);
}

/**
 * Get current provider info
 */
export function getProviderInfo(): { provider: AIProvider; model: string; available: string[] } {
  const config = getConfig();
  const aiConfig = config.getValue('aiProvider');

  const available: string[] = ['claude'];
  if (isGeminiAvailable()) {
    available.push('gemini');
  }

  const model = aiConfig.provider === 'gemini'
    ? aiConfig.geminiModel
    : aiConfig.claudeModel;

  return {
    provider: aiConfig.provider,
    model,
    available,
  };
}

/**
 * Get AI provider interface for simple analysis tasks
 * Returns an object with an analyze method that takes a prompt
 */
export interface AIProviderInterface {
  analyze(prompt: string): Promise<string>;
}

export function getAIProvider(): AIProviderInterface {
  return {
    async analyze(prompt: string): Promise<string> {
      const result = await queryAI(prompt, {
        maxTokens: 1000,
        temperature: 0.3,  // Lower temperature for analysis tasks
      });
      return result.content;
    },
  };
}
