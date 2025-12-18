/**
 * SessionStart Hook
 * Registers the session with the research service
 */

import type { HookResult } from '../types.js';

const SERVICE_URL = process.env.CLAUDE_RESEARCH_URL || 'http://localhost:3200';

interface SessionStartInput {
  sessionId: string;
  projectPath?: string;
}

/**
 * Main hook handler
 */
export async function sessionStart(input: SessionStartInput): Promise<HookResult> {
  try {
    // Register session with research service
    await fetch(`${SERVICE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: input.sessionId,
        projectPath: input.projectPath,
      }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      // Service might not be running, that's okay
    });

    return { continue: true };
  } catch {
    return { continue: true };
  }
}

// Export for Claude Code hook system
export default sessionStart;
