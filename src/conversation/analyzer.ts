/**
 * Conversation Analyzer
 *
 * Maintains conversation state per session and intelligently detects
 * research opportunities by analyzing the flow of tool uses and user prompts.
 *
 * This is the "streaming conversation watcher" that observes all tool data
 * and decides when research would be helpful.
 */

import { Logger } from '../utils/logger.js';
import type { ResearchDepth } from '../types.js';

export interface ConversationEntry {
  type: 'user_prompt' | 'tool_use';
  timestamp: number;
  content: {
    prompt?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolOutput?: string;
  };
}

export interface ConversationState {
  sessionId: string;
  projectPath?: string;
  entries: ConversationEntry[];
  topics: Set<string>;
  errors: string[];
  questions: string[];
  lastResearchTime: number;
  researchCount: number;
}

export interface ResearchOpportunity {
  shouldResearch: boolean;
  query?: string;
  depth: ResearchDepth;
  priority: number;
  confidence: number;
  reason: string;
  topics: string[];
}

interface InjectionCandidate {
  taskId: string;
  query: string;
  summary: string;
  relevance: number;
}

export class ConversationAnalyzer {
  private sessions: Map<string, ConversationState> = new Map();
  private logger: Logger;
  private pendingInjections: Map<string, InjectionCandidate[]> = new Map();

  // Configuration
  private maxEntriesPerSession = 100;
  private researchCooldownMs = 30000; // 30 seconds between research
  private minConfidenceToResearch = 0.6;

  constructor() {
    this.logger = new Logger('ConversationAnalyzer');
  }

  /**
   * Get or create conversation state for a session
   */
  private getSession(sessionId: string, projectPath?: string): ConversationState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        projectPath,
        entries: [],
        topics: new Set(),
        errors: [],
        questions: [],
        lastResearchTime: 0,
        researchCount: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * Process a user prompt and analyze for research opportunities
   */
  processUserPrompt(
    sessionId: string,
    prompt: string,
    projectPath?: string
  ): ResearchOpportunity {
    const state = this.getSession(sessionId, projectPath);

    // Add to conversation history
    state.entries.push({
      type: 'user_prompt',
      timestamp: Date.now(),
      content: { prompt },
    });

    // Trim old entries
    if (state.entries.length > this.maxEntriesPerSession) {
      state.entries = state.entries.slice(-this.maxEntriesPerSession);
    }

    // Extract and track topics
    const topics = this.extractTopics(prompt);
    topics.forEach((t) => state.topics.add(t));

    // Check for questions
    if (this.isQuestion(prompt)) {
      state.questions.push(prompt);
    }

    // Analyze for research opportunity
    return this.analyzeForResearch(state, 'user_prompt', prompt);
  }

  /**
   * Process a tool use and analyze for research opportunities
   */
  processToolUse(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOutput: string,
    projectPath?: string
  ): { opportunity: ResearchOpportunity; injection: string | null } {
    const state = this.getSession(sessionId, projectPath);

    // Add to conversation history
    state.entries.push({
      type: 'tool_use',
      timestamp: Date.now(),
      content: { toolName, toolInput, toolOutput },
    });

    // Trim old entries
    if (state.entries.length > this.maxEntriesPerSession) {
      state.entries = state.entries.slice(-this.maxEntriesPerSession);
    }

    // Extract errors from tool output
    const errors = this.extractErrors(toolOutput);
    errors.forEach((e) => state.errors.push(e));

    // Extract topics from tool context
    const topics = this.extractTopicsFromTool(toolName, toolInput, toolOutput);
    topics.forEach((t) => state.topics.add(t));

    // Check for pending injections
    const injection = this.getPendingInjection(sessionId, state);

    // Analyze for research opportunity
    const opportunity = this.analyzeForResearch(state, 'tool_output', toolOutput);

    return { opportunity, injection };
  }

  /**
   * Main analysis logic - determines if research would be helpful
   */
  private analyzeForResearch(
    state: ConversationState,
    source: 'user_prompt' | 'tool_output',
    content: string
  ): ResearchOpportunity {
    const baseResult: ResearchOpportunity = {
      shouldResearch: false,
      depth: 'quick',
      priority: 5,
      confidence: 0,
      reason: '',
      topics: Array.from(state.topics).slice(-5),
    };

    // Check cooldown
    const timeSinceLastResearch = Date.now() - state.lastResearchTime;
    if (timeSinceLastResearch < this.researchCooldownMs) {
      baseResult.reason = 'Research cooldown active';
      return baseResult;
    }

    // Analyze based on source
    if (source === 'user_prompt') {
      return this.analyzeUserPrompt(state, content, baseResult);
    } else {
      return this.analyzeToolOutput(state, content, baseResult);
    }
  }

  /**
   * Analyze user prompt for research opportunities
   */
  private analyzeUserPrompt(
    _state: ConversationState,
    prompt: string,
    result: ResearchOpportunity
  ): ResearchOpportunity {
    const lowerPrompt = prompt.toLowerCase();

    // Direct question patterns (high confidence)
    const questionPatterns = [
      { pattern: /what\s+(?:is|are)\s+(.+?)(?:\?|$)/i, depth: 'quick' as const, weight: 0.75 },
      { pattern: /how\s+(?:do|does|can|should)\s+(?:i|we|you)\s+(.+?)(?:\?|$)/i, depth: 'medium' as const, weight: 0.85 },
      { pattern: /why\s+(?:is|does|do|should)\s+(.+?)(?:\?|$)/i, depth: 'medium' as const, weight: 0.7 },
      { pattern: /(?:best|recommended)\s+(?:way|approach|practice)\s+(?:to|for)\s+(.+)/i, depth: 'medium' as const, weight: 0.9 },
      { pattern: /(.+?)\s+(?:vs|versus|or|compared to)\s+(.+)/i, depth: 'deep' as const, weight: 0.85 },
    ];

    for (const { pattern, depth, weight } of questionPatterns) {
      const match = prompt.match(pattern);
      if (match) {
        const query = match[1] || prompt;
        return {
          ...result,
          shouldResearch: weight >= this.minConfidenceToResearch,
          query: this.cleanQuery(query),
          depth,
          priority: Math.round(weight * 10),
          confidence: weight,
          reason: `Question pattern detected: ${pattern.source.slice(0, 30)}...`,
        };
      }
    }

    // Check for technology/library mentions that might need research
    const techPatterns = [
      /using\s+(\w+(?:\s+\w+)?)\s+(?:library|framework|package|tool)/i,
      /implement(?:ing)?\s+(.+?)\s+(?:with|using|in)/i,
      /configure\s+(.+)/i,
      /set\s?up\s+(.+)/i,
    ];

    for (const pattern of techPatterns) {
      const match = prompt.match(pattern);
      if (match) {
        return {
          ...result,
          shouldResearch: true,
          query: `${match[1]} documentation tutorial`,
          depth: 'quick',
          priority: 6,
          confidence: 0.65,
          reason: 'Technology setup/implementation detected',
        };
      }
    }

    // Check for error mentions
    if (lowerPrompt.includes('error') || lowerPrompt.includes('failed') || lowerPrompt.includes('not working')) {
      const errorContext = this.extractErrorContext(prompt);
      if (errorContext) {
        return {
          ...result,
          shouldResearch: true,
          query: `fix ${errorContext}`,
          depth: 'medium',
          priority: 7,
          confidence: 0.75,
          reason: 'Error mentioned in prompt',
        };
      }
    }

    // If it contains a question mark but didn't match patterns
    if (prompt.includes('?')) {
      return {
        ...result,
        shouldResearch: true,
        query: this.cleanQuery(prompt.replace(/\?/g, '')),
        depth: 'quick',
        priority: 5,
        confidence: 0.55,
        reason: 'Generic question detected',
      };
    }

    result.reason = 'No research opportunity detected in prompt';
    return result;
  }

  /**
   * Analyze tool output for research opportunities
   */
  private analyzeToolOutput(
    state: ConversationState,
    output: string,
    result: ResearchOpportunity
  ): ResearchOpportunity {
    // Check for errors in output
    const errorPatterns = [
      { pattern: /error:\s*(.{10,100})/i, weight: 0.8 },
      { pattern: /npm ERR!\s+(.+)/i, weight: 0.85 },
      { pattern: /ModuleNotFoundError:\s+(.+)/i, weight: 0.8 },
      { pattern: /TypeError:\s+(.+)/i, weight: 0.75 },
      { pattern: /SyntaxError:\s+(.+)/i, weight: 0.7 },
      { pattern: /ENOENT:\s+(.+)/i, weight: 0.6 },
      { pattern: /permission denied/i, weight: 0.7 },
      { pattern: /ECONNREFUSED/i, weight: 0.65 },
    ];

    for (const { pattern, weight } of errorPatterns) {
      const match = output.match(pattern);
      if (match) {
        // Only research if we haven't seen this error recently
        const errorKey = match[1]?.slice(0, 50) || pattern.source;
        if (!state.errors.includes(errorKey)) {
          state.errors.push(errorKey);
          return {
            ...result,
            shouldResearch: weight >= this.minConfidenceToResearch,
            query: `fix ${errorKey}`,
            depth: 'medium',
            priority: Math.round(weight * 10),
            confidence: weight,
            reason: `Error detected: ${pattern.source.slice(0, 30)}`,
          };
        }
      }
    }

    // Check for deprecation warnings
    if (output.includes('@deprecated') || output.includes('DEPRECATED')) {
      const depMatch = output.match(/@deprecated[:\s]+(.{10,80})/i);
      if (depMatch) {
        return {
          ...result,
          shouldResearch: true,
          query: `alternative to deprecated ${depMatch[1]}`,
          depth: 'quick',
          priority: 5,
          confidence: 0.6,
          reason: 'Deprecation warning detected',
        };
      }
    }

    // Check conversation context for patterns that suggest research might help
    const recentEntries = state.entries.slice(-5);
    const hasMultipleSearches = recentEntries.filter(
      (e) => e.content.toolName === 'Grep' || e.content.toolName === 'Glob'
    ).length >= 2;

    if (hasMultipleSearches && state.topics.size > 0) {
      // Claude seems to be searching for something - might benefit from web research
      const topic = Array.from(state.topics).pop();
      if (topic && Math.random() < 0.3) {
        // Only suggest 30% of the time to avoid being too aggressive
        return {
          ...result,
          shouldResearch: true,
          query: `${topic} best practices examples`,
          depth: 'quick',
          priority: 4,
          confidence: 0.5,
          reason: 'Multiple code searches detected - might benefit from web research',
        };
      }
    }

    result.reason = 'No research opportunity detected in tool output';
    return result;
  }

  /**
   * Queue an injection for a session
   */
  queueInjection(sessionId: string, candidate: InjectionCandidate): void {
    let candidates = this.pendingInjections.get(sessionId);
    if (!candidates) {
      candidates = [];
      this.pendingInjections.set(sessionId, candidates);
    }
    candidates.push(candidate);
    // Sort by relevance
    candidates.sort((a, b) => b.relevance - a.relevance);
    // Keep only top 3
    this.pendingInjections.set(sessionId, candidates.slice(0, 3));
  }

  /**
   * Get pending injection for a session
   */
  private getPendingInjection(sessionId: string, state: ConversationState): string | null {
    const candidates = this.pendingInjections.get(sessionId);
    if (!candidates || candidates.length === 0) {
      return null;
    }

    // Find most relevant injection based on current topics
    const currentTopics = Array.from(state.topics);
    let bestCandidate: InjectionCandidate | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const queryWords = candidate.query.toLowerCase().split(/\s+/);
      let score = candidate.relevance;

      // Boost score if query matches current topics
      for (const topic of currentTopics) {
        if (queryWords.some((w) => topic.toLowerCase().includes(w))) {
          score += 0.2;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (bestCandidate && bestScore >= 0.5) {
      // Remove the used injection
      this.pendingInjections.set(
        sessionId,
        candidates.filter((c) => c.taskId !== bestCandidate!.taskId)
      );

      // Format injection
      return this.formatInjection(bestCandidate);
    }

    return null;
  }

  /**
   * Format injection content
   */
  private formatInjection(candidate: InjectionCandidate): string {
    return `<research-context query="${candidate.query}">
${candidate.summary}
</research-context>`;
  }

  /**
   * Mark that research was performed for a session
   */
  markResearchPerformed(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.lastResearchTime = Date.now();
      state.researchCount++;
    }
  }

  /**
   * Extract topics from text
   */
  private extractTopics(text: string): string[] {
    const topics: string[] = [];

    // Technology names (frameworks, libraries, languages)
    const techPatterns = [
      /\b(react|vue|angular|svelte|next\.?js|nuxt|gatsby)\b/gi,
      /\b(node\.?js|deno|bun|express|fastify|koa)\b/gi,
      /\b(typescript|javascript|python|rust|go|java|kotlin)\b/gi,
      /\b(postgres|mysql|mongodb|redis|sqlite|prisma)\b/gi,
      /\b(docker|kubernetes|aws|gcp|azure|vercel|netlify)\b/gi,
      /\b(graphql|rest\s?api|websocket|grpc)\b/gi,
    ];

    for (const pattern of techPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        topics.push(...matches.map((m) => m.toLowerCase()));
      }
    }

    // Deduplicate
    return [...new Set(topics)];
  }

  /**
   * Extract topics from tool context
   */
  private extractTopicsFromTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOutput: string
  ): string[] {
    const topics: string[] = [];

    // File path analysis
    if (toolInput.file_path) {
      const path = String(toolInput.file_path);
      if (path.includes('.tsx') || path.includes('.jsx')) topics.push('react');
      if (path.includes('.vue')) topics.push('vue');
      if (path.includes('.py')) topics.push('python');
      if (path.includes('.rs')) topics.push('rust');
      if (path.includes('.go')) topics.push('go');
    }

    // Package.json analysis
    if (toolName === 'Read' && toolOutput.includes('"dependencies"')) {
      const depMatch = toolOutput.match(/"dependencies"\s*:\s*\{([^}]+)\}/);
      if (depMatch) {
        const deps = depMatch[1].match(/"([^"]+)"/g);
        if (deps) {
          topics.push(...deps.slice(0, 5).map((d) => d.replace(/"/g, '')));
        }
      }
    }

    return topics;
  }

  /**
   * Extract errors from text
   */
  private extractErrors(text: string): string[] {
    const errors: string[] = [];
    const errorPattern = /(?:error|Error|ERROR)[:\s]+(.{10,100})/g;
    let match;
    while ((match = errorPattern.exec(text)) !== null) {
      errors.push(match[1].trim().slice(0, 100));
    }
    return errors;
  }

  /**
   * Check if text is a question
   */
  private isQuestion(text: string): boolean {
    return (
      text.includes('?') ||
      /^(how|what|why|when|where|which|who|can|could|should|would|is|are|do|does)\s/i.test(text)
    );
  }

  /**
   * Extract error context from prompt
   */
  private extractErrorContext(prompt: string): string | null {
    const patterns = [
      /error[:\s]+["']?(.{10,80})["']?/i,
      /getting\s+(?:an?\s+)?(.+?)\s+error/i,
      /failed\s+(?:to\s+)?(.{10,50})/i,
    ];

    for (const pattern of patterns) {
      const match = prompt.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }
    return null;
  }

  /**
   * Clean up extracted query
   */
  private cleanQuery(query: string): string {
    return query
      .trim()
      .replace(/['"]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^(please|can you|could you|help me)\s+/i, '')
      .slice(0, 150);
  }

  /**
   * End a session and clean up
   */
  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.pendingInjections.delete(sessionId);
    this.logger.debug(`Session ended: ${sessionId}`);
  }

  /**
   * Get session statistics
   */
  getSessionStats(sessionId: string): {
    entries: number;
    topics: string[];
    errors: number;
    questions: number;
    researchCount: number;
  } | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;

    return {
      entries: state.entries.length,
      topics: Array.from(state.topics),
      errors: state.errors.length,
      questions: state.questions.length,
      researchCount: state.researchCount,
    };
  }
}

// Singleton instance
let analyzerInstance: ConversationAnalyzer | null = null;

export function getConversationAnalyzer(): ConversationAnalyzer {
  if (!analyzerInstance) {
    analyzerInstance = new ConversationAnalyzer();
  }
  return analyzerInstance;
}
