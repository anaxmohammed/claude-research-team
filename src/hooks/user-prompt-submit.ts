/**
 * UserPromptSubmit Hook
 *
 * This hook runs BEFORE Claude processes the user's message.
 * It streams the user prompt to the research service for conversation analysis
 * and potential background research.
 *
 * Stdin Input: { prompt, session_id, cwd }
 * Stdout Output: { continue, suppressOutput }
 */

import {
  createHookRunner,
  createContinueResponse,
  type HookResponse,
} from './cli-handler.js';

const SERVICE_URL = process.env.CLAUDE_RESEARCH_URL || 'http://localhost:3200';

interface UserPromptSubmitHookInput {
  prompt: string;
  session_id: string;
  cwd?: string;
}

/**
 * Main hook handler
 */
async function handleUserPromptSubmit(input: UserPromptSubmitHookInput): Promise<HookResponse> {
  // Stream user prompt to research service for conversation analysis
  try {
    await fetch(`${SERVICE_URL}/api/conversation/user-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: input.session_id,
        prompt: input.prompt,
        projectPath: input.cwd,
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Service might not be running, that's okay - just continue
  }

  // Always continue - we never block user prompts
  return createContinueResponse();
}

// Entry point - run the hook with stdin/stdout protocol
createHookRunner(handleUserPromptSubmit);
