/**
 * Session Tracker
 *
 * Tracks session goals, current tasks, and recent actions.
 * Maintains understanding of what Claude is actually working on.
 */

import { randomUUID } from 'crypto';
import type {
  SessionContext,
  SessionAction,
} from '../types.js';
import { Logger } from '../utils/logger.js';
import { getProjectIndexer } from './project-indexer.js';
import { getAIProvider } from '../ai/provider.js';

const logger = new Logger('SessionTracker');

const MAX_RECENT_ACTIONS = 20;
const GOAL_ANALYSIS_COOLDOWN = 30000; // 30 seconds between goal analyses

export class SessionTracker {
  private sessions: Map<string, SessionContext> = new Map();
  private lastGoalAnalysis: Map<string, number> = new Map();

  /**
   * Get or create session context
   */
  async getSessionContext(
    sessionId: string,
    projectPath?: string
  ): Promise<SessionContext> {
    let context = this.sessions.get(sessionId);

    if (!context) {
      context = {
        sessionId,
        recentActions: [],
        knowledgeGaps: [],
        lastAnalyzedAt: 0,
      };
      this.sessions.set(sessionId, context);
    }

    // Load project context if available and not loaded
    if (projectPath && !context.projectContext) {
      const indexer = getProjectIndexer();
      const projectContext = await indexer.getProjectContext(projectPath);
      if (projectContext) {
        context.projectContext = projectContext;
      }
    }

    return context;
  }

  /**
   * Record an action (tool call, error, etc.)
   */
  recordAction(
    sessionId: string,
    action: Omit<SessionAction, 'timestamp'>
  ): void {
    const context = this.sessions.get(sessionId);
    if (!context) return;

    context.recentActions.push({
      ...action,
      timestamp: Date.now(),
    });

    // Keep only recent actions
    if (context.recentActions.length > MAX_RECENT_ACTIONS) {
      context.recentActions = context.recentActions.slice(-MAX_RECENT_ACTIONS);
    }
  }

  /**
   * Record a user request to update goal understanding
   */
  async recordUserRequest(
    sessionId: string,
    prompt: string,
    projectPath?: string
  ): Promise<void> {
    const context = await this.getSessionContext(sessionId, projectPath);

    // Record as action
    this.recordAction(sessionId, {
      type: 'user_request',
      description: prompt.slice(0, 500),
    });

    // Check if we should re-analyze goals
    const lastAnalysis = this.lastGoalAnalysis.get(sessionId) || 0;
    if (Date.now() - lastAnalysis < GOAL_ANALYSIS_COOLDOWN) {
      return;
    }

    // Analyze if this is a new goal/task
    await this.analyzeGoal(sessionId, prompt, context);
  }

  /**
   * Record a tool use to understand what Claude is doing
   */
  recordToolUse(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOutput: string,
    isError: boolean = false
  ): void {
    const inputSummary = this.summarizeToolInput(toolName, toolInput);
    const outputSummary = isError
      ? toolOutput.slice(0, 300)
      : toolOutput.slice(0, 200);

    this.recordAction(sessionId, {
      type: isError ? 'error' : 'tool_call',
      description: `${toolName}: ${inputSummary}`,
      toolName,
      errorMessage: isError ? outputSummary : undefined,
    });

    // Track errors as potential knowledge gaps
    if (isError) {
      const context = this.sessions.get(sessionId);
      if (context) {
        context.knowledgeGaps.push(`Error with ${toolName}: ${outputSummary}`);
        // Keep only recent gaps
        if (context.knowledgeGaps.length > 5) {
          context.knowledgeGaps = context.knowledgeGaps.slice(-5);
        }
      }
    }
  }

  /**
   * Analyze user prompt to extract/update goals
   */
  private async analyzeGoal(
    sessionId: string,
    prompt: string,
    context: SessionContext
  ): Promise<void> {
    this.lastGoalAnalysis.set(sessionId, Date.now());

    // Use AI to understand the goal
    const ai = getAIProvider();

    const recentActionsText = context.recentActions
      .slice(-10)
      .map((a) => `- [${a.type}] ${a.description}`)
      .join('\n');

    const projectInfo = context.projectContext
      ? `Project: ${context.projectContext.name} (${context.projectContext.stack.join(', ')})\n${context.projectContext.summary}`
      : 'No project context available';

    const currentGoalText = context.currentGoal
      ? `Current goal: ${context.currentGoal.description} (${context.currentGoal.status})`
      : 'No current goal';

    const analysisPrompt = `Analyze this conversation to understand what the user wants Claude to accomplish.

${projectInfo}

${currentGoalText}

Recent actions:
${recentActionsText || 'None yet'}

Latest user message:
"${prompt.slice(0, 1000)}"

Determine:
1. Is this a NEW goal, a CONTINUATION of the current goal, or just a CLARIFICATION?
2. What is the main objective?
3. What sub-tasks might be involved?

Respond with JSON only:
{
  "isNewGoal": true/false,
  "goalDescription": "concise description of what user wants",
  "subTasks": ["task1", "task2"],
  "blockers": ["any identified blockers or challenges"]
}`;

    try {
      const response = await ai.analyze(analysisPrompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        if (parsed.isNewGoal || !context.currentGoal) {
          // Create new goal
          context.currentGoal = {
            id: randomUUID(),
            sessionId,
            description: parsed.goalDescription || prompt.slice(0, 200),
            status: 'active',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            blockers: parsed.blockers || [],
            subTasks: (parsed.subTasks || []).map((desc: string) => ({
              description: desc,
              status: 'pending' as const,
            })),
          };

          logger.info('New session goal identified', {
            sessionId,
            goal: context.currentGoal.description,
          });
        } else {
          // Update existing goal
          context.currentGoal.updatedAt = Date.now();
          if (parsed.blockers?.length) {
            context.currentGoal.blockers = parsed.blockers;
          }
        }
      }
    } catch (error) {
      logger.debug('Goal analysis failed', { error });
      // Fallback: use prompt as goal description
      if (!context.currentGoal) {
        context.currentGoal = {
          id: randomUUID(),
          sessionId,
          description: prompt.slice(0, 200),
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
    }

    context.lastAnalyzedAt = Date.now();
  }

  /**
   * Summarize tool input for logging
   */
  private summarizeToolInput(
    toolName: string,
    input: Record<string, unknown>
  ): string {
    switch (toolName) {
      case 'Read':
        return `reading ${input.file_path}`;
      case 'Write':
        return `writing ${input.file_path}`;
      case 'Edit':
        return `editing ${input.file_path}`;
      case 'Bash':
        return `running: ${String(input.command).slice(0, 100)}`;
      case 'Grep':
        return `searching for "${input.pattern}"`;
      case 'Glob':
        return `finding files: ${input.pattern}`;
      case 'WebSearch':
        return `searching web: ${input.query}`;
      case 'WebFetch':
        return `fetching ${input.url}`;
      default:
        return JSON.stringify(input).slice(0, 100);
    }
  }

  /**
   * Get a summary of current session state for research decisions
   */
  getSessionSummary(sessionId: string): string {
    const context = this.sessions.get(sessionId);
    if (!context) return 'No session context available';

    const parts: string[] = [];

    // Project context
    if (context.projectContext) {
      parts.push(`Project: ${context.projectContext.name}`);
      parts.push(`Stack: ${context.projectContext.stack.join(', ')}`);
      parts.push(`Summary: ${context.projectContext.summary}`);
    }

    // Current goal
    if (context.currentGoal) {
      parts.push(`\nCurrent Goal: ${context.currentGoal.description}`);
      if (context.currentGoal.blockers?.length) {
        parts.push(`Blockers: ${context.currentGoal.blockers.join(', ')}`);
      }
      if (context.currentGoal.subTasks?.length) {
        const activeTasks = context.currentGoal.subTasks
          .filter((t) => t.status !== 'completed')
          .map((t) => t.description);
        if (activeTasks.length) {
          parts.push(`Active tasks: ${activeTasks.join(', ')}`);
        }
      }
    }

    // Recent actions (last 5)
    const recentActions = context.recentActions.slice(-5);
    if (recentActions.length) {
      parts.push('\nRecent actions:');
      for (const action of recentActions) {
        parts.push(`- ${action.description}`);
      }
    }

    // Knowledge gaps
    if (context.knowledgeGaps.length) {
      parts.push('\nPotential knowledge gaps:');
      for (const gap of context.knowledgeGaps) {
        parts.push(`- ${gap}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Clear session context
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.lastGoalAnalysis.delete(sessionId);
  }

  /**
   * Mark current goal as completed
   */
  completeGoal(sessionId: string): void {
    const context = this.sessions.get(sessionId);
    if (context?.currentGoal) {
      context.currentGoal.status = 'completed';
      context.currentGoal.updatedAt = Date.now();
    }
  }
}

// Singleton instance
let trackerInstance: SessionTracker | null = null;

export function getSessionTracker(): SessionTracker {
  if (!trackerInstance) {
    trackerInstance = new SessionTracker();
  }
  return trackerInstance;
}
