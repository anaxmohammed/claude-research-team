/**
 * SessionEnd Hook
 *
 * This hook runs at the end of a Claude Code session.
 * It notifies the research service to clean up session state.
 *
 * Stdin Input: { session_id, cwd }
 * Stdout Output: { continue, suppressOutput }
 */

import {
  createHookRunner,
  createContinueResponse,
  type HookResponse,
} from './cli-handler.js';

const SERVICE_URL = process.env.CLAUDE_RESEARCH_URL || 'http://localhost:3200';

interface SessionEndHookInput {
  session_id: string;
  cwd?: string;
}

/**
 * Main hook handler
 */
async function handleSessionEnd(input: SessionEndHookInput): Promise<HookResponse> {
  // Notify research service of session end
  try {
    await fetch(`${SERVICE_URL}/api/sessions/${input.session_id}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endedAt: Date.now(),
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Service might not be running, that's okay
  }

  return createContinueResponse();
}

// Entry point - run the hook with stdin/stdout protocol
createHookRunner(handleSessionEnd);
