/**
 * Research Skill
 * Queue background research on a topic
 *
 * Usage: Use the "research" skill to queue research that will be
 * passively injected into context when relevant.
 */

import type { ResearchDepth } from '../types.js';

const SERVICE_URL = process.env.CLAUDE_RESEARCH_URL || 'http://localhost:3200';

interface ResearchSkillInput {
  query: string;
  depth?: ResearchDepth;
  context?: string;
  priority?: number;
}

interface ResearchSkillOutput {
  success: boolean;
  taskId?: string;
  message: string;
}

/**
 * Main skill handler
 */
export async function research(input: ResearchSkillInput): Promise<ResearchSkillOutput> {
  const { query, depth = 'medium', context, priority = 6 } = input;

  if (!query || query.trim().length === 0) {
    return {
      success: false,
      message: 'Query is required',
    };
  }

  try {
    // Check if service is running
    const healthCheck = await fetch(`${SERVICE_URL}/api/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);

    if (!healthCheck?.ok) {
      return {
        success: false,
        message: 'Research service is not running. Start it with: claude-research-team start',
      };
    }

    // Queue the research
    const response = await fetch(`${SERVICE_URL}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query.trim(),
        depth,
        context,
        priority,
        trigger: 'manual',
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        success: false,
        message: `Failed to queue research: HTTP ${response.status}`,
      };
    }

    const data = await response.json() as { success: boolean; data: { id: string } };

    if (data.success) {
      return {
        success: true,
        taskId: data.data.id,
        message: `Research queued: "${query}" (${depth} depth). Results will be passively injected when relevant.`,
      };
    } else {
      return {
        success: false,
        message: 'Failed to queue research',
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// Export for skill system
export default research;

// Skill metadata
export const metadata = {
  name: 'research',
  description: 'Queue background research on a topic for passive context injection',
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'The research query or topic',
    },
    depth: {
      type: 'string',
      enum: ['quick', 'medium', 'deep'],
      default: 'medium',
      description: 'Research depth: quick (~10s), medium (~30s), deep (~60s)',
    },
    context: {
      type: 'string',
      required: false,
      description: 'Additional context to focus the research',
    },
    priority: {
      type: 'number',
      default: 6,
      description: 'Priority 1-10 (higher = more urgent)',
    },
  },
};
