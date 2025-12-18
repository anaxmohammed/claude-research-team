/**
 * PostToolUse Hook
 * Injects relevant research results into Claude's context after tool execution
 *
 * This hook runs AFTER Claude uses a tool.
 * It can inject additional context via the additionalContext field,
 * which Claude will see as supplementary information.
 */

import type { PostToolUseInput, HookResult } from '../types.js';

const SERVICE_URL = process.env.CLAUDE_RESEARCH_URL || 'http://localhost:3200';

// Tools that are good injection points
const INJECTABLE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'WebFetch',
  'WebSearch',
]);

// Tools where injection might be distracting
const SKIP_INJECTION_TOOLS = new Set([
  'Write',
  'Edit',
  'TodoWrite',
  'AskUserQuestion',
]);

interface InjectionResponse {
  success: boolean;
  data: {
    injection: string | null;
  };
}

interface TriggerResult {
  shouldResearch: boolean;
  query?: string;
  depth: 'quick' | 'medium' | 'deep';
  priority: number;
}

/**
 * Main hook handler
 */
export async function postToolUse(input: PostToolUseInput): Promise<HookResult> {
  try {
    // Skip certain tools
    if (SKIP_INJECTION_TOOLS.has(input.toolName)) {
      return { continue: true, suppressOutput: false };
    }

    // Check if service is running
    const healthCheck = await fetch(`${SERVICE_URL}/api/health`, {
      signal: AbortSignal.timeout(1000),
    }).catch(() => null);

    if (!healthCheck?.ok) {
      return { continue: true, suppressOutput: false };
    }

    // Analyze tool output for new research triggers
    // This catches errors and patterns that might benefit from research
    if (input.toolOutput && input.toolOutput.length > 50) {
      const analyzeResponse = await fetch(`${SERVICE_URL}/api/analyze/tool-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolName: input.toolName,
          output: input.toolOutput.slice(0, 5000), // Limit output size
        }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => null);

      if (analyzeResponse?.ok) {
        const analysis = (await analyzeResponse.json()) as { success: boolean; data: TriggerResult };
        if (analysis.success && analysis.data?.shouldResearch && analysis.data.query) {
          // Queue background research based on tool output
          await fetch(`${SERVICE_URL}/api/research`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: analysis.data.query,
              depth: analysis.data.depth || 'quick',
              priority: analysis.data.priority || 5,
              sessionId: input.sessionId,
            }),
            signal: AbortSignal.timeout(2000),
          }).catch(() => {});
        }
      }
    }

    // Only try to inject on tools where it makes sense
    if (!INJECTABLE_TOOLS.has(input.toolName)) {
      return { continue: true, suppressOutput: false };
    }

    // Check for available injection
    const injectionResponse = await fetch(
      `${SERVICE_URL}/api/injection/${input.sessionId}`,
      { signal: AbortSignal.timeout(2000) }
    ).catch(() => null);

    if (!injectionResponse?.ok) {
      return { continue: true, suppressOutput: false };
    }

    const injectionData = (await injectionResponse.json()) as InjectionResponse;

    if (!injectionData.success || !injectionData.data.injection) {
      return { continue: true, suppressOutput: false };
    }

    // Return with additional context
    return {
      continue: true,
      suppressOutput: false,
      additionalContext: injectionData.data.injection,
    };
  } catch {
    // On any error, just continue normally
    return { continue: true, suppressOutput: false };
  }
}

// Export for Claude Code hook system
export default postToolUse;

// For direct execution/testing
if (process.argv[1]?.includes('post-tool-use')) {
  const testInput: PostToolUseInput = {
    toolName: 'Read',
    toolInput: { file_path: '/test/file.ts' },
    toolOutput: 'test content',
    sessionId: 'test-session',
    projectPath: process.cwd(),
  };

  postToolUse(testInput).then((result) => {
    console.log('Hook result:', JSON.stringify(result, null, 2));
  });
}
