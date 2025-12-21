/**
 * PostToolUse Hook
 *
 * This hook runs AFTER Claude uses a tool.
 * It streams ALL tool data to the research service for conversation analysis,
 * and injects relevant research results via additionalContext.
 *
 * Stdin Input: { tool_name, tool_input, tool_response, session_id, cwd }
 * Stdout Output: { continue, suppressOutput, hookSpecificOutput? }
 */

import {
  createHookRunner,
  createContinueResponse,
  createInjectionResponse,
  createVisibleInjectionResponse,
  type HookResponse,
} from './cli-handler.js';

const SERVICE_URL = process.env.CLAUDE_RESEARCH_URL || 'http://localhost:3200';

interface PostToolUseHookInput {
  tool_name: string;
  tool_input: string | Record<string, unknown>;
  tool_response: string;
  session_id: string;
  cwd?: string;
}

interface ConversationStreamResponse {
  success: boolean;
  data?: {
    injection?: string;
    injectionQuery?: string;  // The original query for visible display
    showInConversation?: boolean;  // Whether to show injection visibly
    researchQueued?: boolean;
    queuedQuery?: string;
  };
}

/**
 * Main hook handler
 */
async function handlePostToolUse(input: PostToolUseHookInput): Promise<HookResponse> {
  // Parse tool_input if it's a string
  const toolInput = typeof input.tool_input === 'string'
    ? JSON.parse(input.tool_input)
    : input.tool_input;

  // Stream tool data to research service for conversation analysis
  // This allows the service to build context and detect research opportunities
  try {
    const streamResponse = await fetch(`${SERVICE_URL}/api/conversation/tool-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: input.session_id,
        toolName: input.tool_name,
        toolInput: toolInput,
        toolOutput: typeof input.tool_response === 'string'
          ? input.tool_response.slice(0, 10000)
          : JSON.stringify(input.tool_response)?.slice(0, 10000), // Limit size
        projectPath: input.cwd,
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(5000), // 5s timeout, server responds fast now
    });

    if (streamResponse.ok) {
      const data = await streamResponse.json() as ConversationStreamResponse;

      // If the service has context to inject, return it
      if (data.success && data.data?.injection) {
        // Check if we should show the injection visibly
        if (data.data.showInConversation) {
          // Create a condensed visible message
          const visibleMessage = `\n📚 [Research injected: "${data.data.injectionQuery || 'context'}"]\n`;
          return createVisibleInjectionResponse('PostToolUse', data.data.injection, visibleMessage);
        } else {
          return createInjectionResponse('PostToolUse', data.data.injection);
        }
      }
    }
  } catch {
    // Service might not be running, that's okay - just continue
  }

  return createContinueResponse();
}

// Entry point - run the hook with stdin/stdout protocol
createHookRunner(handlePostToolUse);
