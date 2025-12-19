/**
 * SessionStart Hook
 *
 * This hook runs at the start of a Claude Code session.
 * It registers the session with the research service.
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

interface SessionStartHookInput {
  session_id: string;
  cwd?: string;
}

/**
 * Main hook handler
 */
async function handleSessionStart(input: SessionStartHookInput): Promise<HookResponse> {
  // Register session with research service
  try {
    await fetch(`${SERVICE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: input.session_id,
        projectPath: input.cwd,
        startedAt: Date.now(),
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Service might not be running, that's okay
  }

  return createContinueResponse();
}

// Entry point - run the hook with stdin/stdout protocol
createHookRunner(handleSessionStart);
