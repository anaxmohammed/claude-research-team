/**
 * SessionEnd Hook
 * Notifies the research service that a session has ended
 * Can trigger sync to claude-mem if enabled
 */

import type { HookResult } from '../types.js';

const SERVICE_URL = process.env.CLAUDE_RESEARCH_URL || 'http://localhost:3200';

interface SessionEndInput {
  sessionId: string;
  projectPath?: string;
}

/**
 * Main hook handler
 */
export async function sessionEnd(input: SessionEndInput): Promise<HookResult> {
  try {
    // Notify research service (could trigger cleanup or sync)
    await fetch(`${SERVICE_URL}/api/sessions/${input.sessionId}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
export default sessionEnd;
