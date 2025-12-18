/**
 * UserPromptSubmit Hook
 * Analyzes user prompts and queues background research when appropriate
 *
 * This hook runs BEFORE Claude processes the user's message.
 * It can queue research tasks that will run in the background
 * and be ready for injection via PostToolUse.
 */

import type { UserPromptSubmitInput, HookResult } from '../types.js';

const SERVICE_URL = process.env.CLAUDE_RESEARCH_URL || 'http://localhost:3200';

interface TriggerResult {
  shouldResearch: boolean;
  query?: string;
  depth: 'quick' | 'medium' | 'deep';
  priority: number;
  confidence: number;
  reason: string;
}

/**
 * Main hook handler
 */
export async function userPromptSubmit(input: UserPromptSubmitInput): Promise<HookResult> {
  try {
    // Check if service is running
    const healthCheck = await fetch(`${SERVICE_URL}/api/health`, {
      signal: AbortSignal.timeout(1000),
    }).catch(() => null);

    if (!healthCheck?.ok) {
      // Service not running, skip silently
      return { continue: true };
    }

    // Register/update session
    await fetch(`${SERVICE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: input.sessionId,
        projectPath: input.projectPath,
      }),
    }).catch(() => {});

    // Analyze prompt for research triggers
    const analyzeResponse = await fetch(`${SERVICE_URL}/api/analyze/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: input.prompt }),
      signal: AbortSignal.timeout(2000),
    });

    if (!analyzeResponse.ok) {
      return { continue: true };
    }

    const analysis = (await analyzeResponse.json()) as { success: boolean; data: TriggerResult };

    if (!analysis.success || !analysis.data.shouldResearch) {
      return { continue: true };
    }

    // Queue background research
    // Only queue if confidence is high enough
    if (analysis.data.confidence >= 0.6) {
      await fetch(`${SERVICE_URL}/api/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: analysis.data.query,
          depth: analysis.data.depth,
          priority: analysis.data.priority,
          sessionId: input.sessionId,
        }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    }

    // Don't modify the prompt or block - just let it continue
    return { continue: true };
  } catch {
    // On any error, just continue normally
    return { continue: true };
  }
}

// Export for Claude Code hook system
export default userPromptSubmit;

// For direct execution/testing
if (process.argv[1]?.includes('user-prompt-submit')) {
  const testInput: UserPromptSubmitInput = {
    prompt: process.argv[2] || 'What is the best way to implement caching in Node.js?',
    sessionId: 'test-session',
    projectPath: process.cwd(),
  };

  userPromptSubmit(testInput).then((result) => {
    console.log('Hook result:', JSON.stringify(result, null, 2));
  });
}
