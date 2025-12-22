/**
 * Injection Manager
 * Controls when and what research results get injected into Claude's context
 *
 * Supports two modes:
 * 1. Task-based injection (existing): Inject completed research tasks
 * 2. Unified knowledge injection (new): Combine memory + research from claude-mem
 */

import { randomUUID } from 'crypto';
import type {
  ResearchTask,
  InjectionRecord,
  InjectionBudget,
  Session,
} from '../types.js';
import { ResearchDatabase, getDatabase } from '../database/index.js';
import { Logger } from '../utils/logger.js';
import {
  formatMemoryInjection,
  formatResearchInjection,
  formatCombinedInjection,
  formatTaskInjection,
  type FormattedInjection,
  type InjectionType,
} from './formatters.js';

interface InjectionCandidate {
  task: ResearchTask;
  score: number;
  reason: string;
}

interface UnifiedInjectionResult {
  type: InjectionType;
  content: string;
  tokensEstimate: number;
  memoryId?: number;
  researchId?: string;
}

export class InjectionManager {
  private db: ResearchDatabase;
  private logger: Logger;
  private budget: InjectionBudget;
  private lastInjectionTime: Map<string, number> = new Map();

  constructor(budget?: Partial<InjectionBudget>) {
    this.db = getDatabase();
    this.logger = new Logger('InjectionManager');
    this.budget = {
      maxPerSession: budget?.maxPerSession ?? 5,
      maxTokensPerInjection: budget?.maxTokensPerInjection ?? 150,
      maxTotalTokensPerSession: budget?.maxTotalTokensPerSession ?? 500,
      cooldownMs: budget?.cooldownMs ?? 30000,
      showInConversation: budget?.showInConversation ?? false,
    };
  }

  /**
   * Get research result ready for injection, if any
   * Returns formatted context string or null if nothing suitable
   */
  getInjection(sessionId: string, currentContext?: string): string | null {
    // Get session info
    const session = this.db.getSession(sessionId);
    if (!session) {
      this.logger.debug('No session found', { sessionId });
      return null;
    }

    // Check budget constraints
    if (!this.canInject(session)) {
      this.logger.debug('Budget exceeded, skipping injection', {
        sessionId,
        injectionsCount: session.injectionsCount,
        injectionsTokens: session.injectionsTokens,
      });
      return null;
    }

    // Check cooldown
    if (this.isInCooldown(sessionId)) {
      this.logger.debug('In cooldown period', { sessionId });
      return null;
    }

    // Get completed tasks for this session that haven't been injected
    const injectedTaskIds = new Set(
      this.db.getSessionInjections(sessionId).map((i) => i.taskId)
    );

    const candidates = this.db
      .getRecentTasks(20)
      .filter(
        (t) =>
          t.status === 'completed' &&
          t.sessionId === sessionId &&
          t.result &&
          !injectedTaskIds.has(t.id)
      );

    if (candidates.length === 0) {
      this.logger.debug('No injection candidates', { sessionId });
      return null;
    }

    // Score and select best candidate
    const scored = candidates
      .map((task) => this.scoreCandidate(task, currentContext))
      .filter((c) => c.score > 0.5) // Minimum relevance threshold
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      this.logger.debug('No candidates above threshold', { sessionId });
      return null;
    }

    const best = scored[0];
    this.logger.info('Selected injection candidate', {
      taskId: best.task.id,
      score: best.score,
      reason: best.reason,
    });

    // Format the injection
    const formatted = this.formatInjection(best.task);

    // Record the injection
    this.recordInjection(sessionId, best.task, formatted);

    return formatted;
  }

  /**
   * Get unified knowledge injection from claude-mem
   * Combines memory observations with research findings
   * Returns formatted context string or null if nothing suitable
   */
  getUnifiedInjection(
    sessionId: string,
    query: string,
    options: {
      project?: string;
      context?: string;
    } = {}
  ): UnifiedInjectionResult | null {
    // Get session info
    const session = this.db.getSession(sessionId);
    if (!session) {
      this.logger.debug('No session found for unified injection', { sessionId });
      return null;
    }

    // Check budget constraints
    if (!this.canInject(session)) {
      this.logger.debug('Budget exceeded for unified injection', { sessionId });
      return null;
    }

    // Check cooldown
    if (this.isInCooldown(sessionId)) {
      this.logger.debug('In cooldown for unified injection', { sessionId });
      return null;
    }

    // Get claude-mem adapter
    const claudeMemAdapter = this.db.getClaudeMemAdapter();
    if (!claudeMemAdapter.isReady()) {
      this.logger.debug('Claude-mem adapter not ready, skipping unified injection');
      return null;
    }

    // Get best candidates from unified knowledge base
    const { memory, research } = claudeMemAdapter.getBestCandidatesForInjection(query, {
      project: options.project,
      context: options.context,
    });

    // Determine injection type
    const injectionType = claudeMemAdapter.determineInjectionType(memory, research);

    if (injectionType === 'none') {
      this.logger.debug('No suitable unified knowledge found', { sessionId, query });
      return null;
    }

    // Format based on injection type
    let formatted: FormattedInjection;

    switch (injectionType) {
      case 'memory-only':
        if (!memory) return null;
        formatted = formatMemoryInjection(memory);
        break;

      case 'research-only':
        if (!research) return null;
        formatted = formatResearchInjection(research);
        break;

      case 'combined':
        if (!memory || !research) return null;
        formatted = formatCombinedInjection(memory, research);
        break;

      default:
        return null;
    }

    this.logger.info('Generated unified injection', {
      type: formatted.type,
      tokensEstimate: formatted.tokensEstimate,
      memoryId: formatted.sources.memory?.id,
      researchId: formatted.sources.research?.id,
    });

    // Record the injection
    this.recordUnifiedInjection(sessionId, formatted);

    return {
      type: formatted.type,
      content: formatted.content,
      tokensEstimate: formatted.tokensEstimate,
      memoryId: formatted.sources.memory?.id,
      researchId: formatted.sources.research?.id,
    };
  }

  /**
   * Record a unified injection (memory + research combined)
   */
  private recordUnifiedInjection(sessionId: string, injection: FormattedInjection): void {
    // Create a synthetic task ID for tracking
    const taskId = `unified-${injection.type}-${Date.now()}`;

    const record: InjectionRecord = {
      id: randomUUID(),
      taskId,
      sessionId,
      injectedAt: Date.now(),
      content: injection.content,
      tokensUsed: injection.tokensEstimate,
      accepted: true,
      injectionType: injection.type as InjectionRecord['injectionType'],
    };

    this.db.recordInjection(record);

    // Update cooldown tracker
    this.lastInjectionTime.set(sessionId, Date.now());

    this.logger.info('Unified injection recorded', {
      type: injection.type,
      sessionId,
      tokensUsed: injection.tokensEstimate,
    });
  }

  /**
   * Check if injection is allowed within budget
   */
  private canInject(session: Session): boolean {
    // Check injection count limit
    if (session.injectionsCount >= this.budget.maxPerSession) {
      return false;
    }

    // Check total tokens limit
    if (session.injectionsTokens >= this.budget.maxTotalTokensPerSession) {
      return false;
    }

    return true;
  }

  /**
   * Check if session is in cooldown period
   */
  private isInCooldown(sessionId: string): boolean {
    const lastTime = this.lastInjectionTime.get(sessionId);
    if (!lastTime) return false;

    return Date.now() - lastTime < this.budget.cooldownMs;
  }

  /**
   * Score a research task for injection relevance
   */
  private scoreCandidate(task: ResearchTask, currentContext?: string): InjectionCandidate {
    let score = 0;
    const reasons: string[] = [];

    if (!task.result) {
      return { task, score: 0, reason: 'No result' };
    }

    // Base score from research confidence
    score += task.result.confidence * 0.3;
    reasons.push(`confidence: ${task.result.confidence.toFixed(2)}`);

    // Recency bonus (more recent = better)
    const ageMs = Date.now() - (task.completedAt || task.createdAt);
    const ageMinutes = ageMs / 60000;
    if (ageMinutes < 5) {
      score += 0.3;
      reasons.push('very recent');
    } else if (ageMinutes < 15) {
      score += 0.2;
      reasons.push('recent');
    } else if (ageMinutes < 30) {
      score += 0.1;
      reasons.push('somewhat recent');
    }

    // Priority bonus
    if (task.priority >= 8) {
      score += 0.2;
      reasons.push('high priority');
    } else if (task.priority >= 6) {
      score += 0.1;
      reasons.push('medium priority');
    }

    // Source count bonus (more sources = more reliable)
    const sourceCount = task.result.sources.length;
    if (sourceCount >= 5) {
      score += 0.15;
      reasons.push(`${sourceCount} sources`);
    } else if (sourceCount >= 3) {
      score += 0.1;
    }

    // Context relevance (if current context provided)
    if (currentContext && task.result.summary) {
      const contextRelevance = this.calculateTextRelevance(
        task.result.summary,
        currentContext
      );
      score += contextRelevance * 0.25;
      if (contextRelevance > 0.5) {
        reasons.push('context relevant');
      }
    }

    return {
      task,
      score: Math.min(score, 1),
      reason: reasons.join(', '),
    };
  }

  /**
   * Calculate text relevance between two strings
   * Simple word overlap approach
   */
  private calculateTextRelevance(text1: string, text2: string): number {
    const getWords = (s: string) =>
      new Set(
        s
          .toLowerCase()
          .replace(/[^\w\s]/g, '')
          .split(/\s+/)
          .filter((w) => w.length > 3)
      );

    const words1 = getWords(text1);
    const words2 = getWords(text2);

    if (words1.size === 0 || words2.size === 0) return 0;

    const intersection = new Set([...words1].filter((w) => words2.has(w)));
    return intersection.size / Math.min(words1.size, words2.size);
  }

  /**
   * Format research result for injection
   * Uses the new formatters module for consistent formatting
   */
  private formatInjection(task: ResearchTask): string {
    return formatTaskInjection(task, { maxTokens: this.budget.maxTokensPerInjection });
  }

  /**
   * Record an injection in the database
   */
  private recordInjection(sessionId: string, task: ResearchTask, content: string): void {
    const tokensUsed = Math.ceil(content.length / 4);

    const record: InjectionRecord = {
      id: randomUUID(),
      taskId: task.id,
      sessionId,
      injectedAt: Date.now(),
      content,
      tokensUsed,
      accepted: true, // Default to accepted
    };

    this.db.recordInjection(record);

    // Update task status
    this.db.updateTaskStatus(task.id, 'injected');

    // Update cooldown tracker
    this.lastInjectionTime.set(sessionId, Date.now());

    this.logger.info('Injection recorded', {
      taskId: task.id,
      sessionId,
      tokensUsed,
    });
  }

  /**
   * Manually queue research for a topic
   */
  async requestResearch(
    sessionId: string,
    query: string,
    priority: number = 7
  ): Promise<void> {
    // Import queue manager dynamically to avoid circular dependency
    const { QueueManager } = await import('../queue/manager.js');
    const queue = new QueueManager();

    await queue.queue({
      query,
      trigger: 'manual',
      sessionId,
      priority,
      depth: 'medium',
    });
  }

  /**
   * Get injection history for a session
   */
  getHistory(sessionId: string): InjectionRecord[] {
    return this.db.getSessionInjections(sessionId);
  }

  /**
   * Update budget settings
   */
  setBudget(budget: Partial<InjectionBudget>): void {
    Object.assign(this.budget, budget);
  }
}
