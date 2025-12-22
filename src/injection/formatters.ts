/**
 * Injection Formatters
 *
 * Format knowledge candidates for injection into Claude's context.
 * Implements high-impact, low-token injection formats from the vision document.
 *
 * Design Principles:
 * - High impact: Every token must earn its place
 * - Actionable: Information should help Claude immediately
 * - Non-disruptive: Feels like a natural continuation
 * - Progressive: More detail available on demand
 * - Transparent: Clear source attribution
 */

import type { KnowledgeCandidate } from '../adapters/claude-mem-adapter.js';
import type { ResearchTask, PivotSuggestion } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

// ============================================================================
// Types
// ============================================================================

export type InjectionType = 'memory-only' | 'research-only' | 'combined' | 'warning' | 'none';

export interface FormattedInjection {
  type: InjectionType;
  content: string;
  tokensEstimate: number;
  sources: {
    memory?: { id: number; title: string };
    research?: { id: string; query: string };
  };
}

export interface FormatOptions {
  maxTokens?: number;
  includeFiles?: boolean;
  includeFollowup?: boolean;
}

// ============================================================================
// Token Budget Defaults (from config)
// ============================================================================

const DEFAULT_BUDGETS = {
  memoryOnly: DEFAULT_CONFIG.claudeMem.memoryOnlyTokens,      // 80
  researchOnly: DEFAULT_CONFIG.claudeMem.researchOnlyTokens,  // 100
  combined: DEFAULT_CONFIG.claudeMem.combinedTokens,           // 150
  warning: DEFAULT_CONFIG.claudeMem.warningTokens,             // 120
};

// ============================================================================
// Memory-Only Formatter (~80 tokens)
// ============================================================================

/**
 * Format a memory-only injection
 * Used when user's past work is highly relevant
 *
 * Example output:
 * ```
 * Continue your work. Relevant context:
 *
 * [Memory] You handled similar JWT auth in project-x (Dec 15):
 * Used httpOnly cookies for refresh tokens, 15min access token expiry.
 * Files: src/auth/tokens.ts, src/middleware/auth.ts
 * ```
 */
export function formatMemoryInjection(
  candidate: KnowledgeCandidate,
  options: FormatOptions = {}
): FormattedInjection {
  const maxTokens = options.maxTokens ?? DEFAULT_BUDGETS.memoryOnly;
  const maxChars = maxTokens * 4; // ~4 chars per token

  const parts: string[] = [];

  parts.push('Continue your work. Relevant context:');
  parts.push('');

  // Format observation with date
  const date = formatRelativeDate(candidate.createdAt);
  const projectName = candidate.project.split('/').pop() || candidate.project;

  parts.push(`[Memory] You handled similar ${candidate.content.type} in ${projectName} (${date}):`);

  // Add summary (truncate if needed)
  let summary = candidate.content.summary;
  const remainingChars = maxChars - parts.join('\n').length - 50; // Leave room for files
  if (summary.length > remainingChars) {
    summary = summary.slice(0, remainingChars - 3) + '...';
  }
  parts.push(summary);

  // Add files if available and there's room
  if (options.includeFiles !== false && (candidate.filesModified?.length || candidate.filesRead?.length)) {
    const files = [...(candidate.filesModified || []), ...(candidate.filesRead || [])];
    const uniqueFiles = [...new Set(files)].slice(0, 3);
    if (uniqueFiles.length > 0) {
      parts.push(`Files: ${uniqueFiles.join(', ')}`);
    }
  }

  const content = parts.join('\n');
  const tokensEstimate = Math.ceil(content.length / 4);

  return {
    type: 'memory-only',
    content,
    tokensEstimate,
    sources: {
      memory: { id: candidate.content.id, title: candidate.content.title },
    },
  };
}

// ============================================================================
// Research-Only Formatter (~100 tokens)
// ============================================================================

/**
 * Format a research-only injection
 * Used when external research is available
 *
 * Example output:
 * ```
 * Continue your work. Research gathered:
 *
 * **Rate limiting in Hono**: Use hono-rate-limiter middleware.
 * Configure: windowMs (time window), max (request limit), keyGenerator (IP/user).
 * (confidence: 89%) [/research-detail abc123 for sources]
 * ```
 */
export function formatResearchInjection(
  candidate: KnowledgeCandidate,
  options: FormatOptions = {}
): FormattedInjection {
  const maxTokens = options.maxTokens ?? DEFAULT_BUDGETS.researchOnly;
  const maxChars = maxTokens * 4;

  const parts: string[] = [];

  parts.push('Continue your work. Research gathered:');
  parts.push('');

  // Title as bold header
  const title = candidate.content.title.length > 50
    ? candidate.content.title.slice(0, 47) + '...'
    : candidate.content.title;
  parts.push(`**${title}**:`);

  // Add summary
  let summary = candidate.content.summary;
  const remainingChars = maxChars - parts.join('\n').length - 60; // Leave room for confidence + followup
  if (summary.length > remainingChars) {
    summary = summary.slice(0, remainingChars - 3) + '...';
  }
  parts.push(summary);

  // Add confidence and followup hint
  const confidencePercent = Math.round(candidate.relevance.confidence * 100);
  if (options.includeFollowup !== false) {
    parts.push(`(confidence: ${confidencePercent}%) [/research-detail ${candidate.content.id} for sources]`);
  } else {
    parts.push(`(confidence: ${confidencePercent}%)`);
  }

  const content = parts.join('\n');
  const tokensEstimate = Math.ceil(content.length / 4);

  return {
    type: 'research-only',
    content,
    tokensEstimate,
    sources: {
      research: { id: String(candidate.content.id), query: candidate.content.title },
    },
  };
}

// ============================================================================
// Combined Formatter (~150 tokens)
// ============================================================================

/**
 * Format a combined memory + research injection
 * Used when both past experience and fresh research are relevant
 *
 * Example output:
 * ```
 * Continue your work. Context gathered:
 *
 * [Memory] You implemented rate limiting in api-gateway (Nov 20):
 * Used sliding window algorithm, Redis for distributed state.
 *
 * [Research] Current Hono best practice: hono-rate-limiter middleware
 * supports sliding window natively, no Redis needed for single-instance.
 * (confidence: 91%) [/research-detail abc123]
 * ```
 */
export function formatCombinedInjection(
  memory: KnowledgeCandidate,
  research: KnowledgeCandidate,
  options: FormatOptions = {}
): FormattedInjection {
  const maxTokens = options.maxTokens ?? DEFAULT_BUDGETS.combined;
  const maxChars = maxTokens * 4;

  // Split budget: 40% memory, 60% research (research typically more actionable)
  const memoryChars = Math.floor(maxChars * 0.4);
  const researchChars = Math.floor(maxChars * 0.6);

  const parts: string[] = [];

  parts.push('Continue your work. Context gathered:');
  parts.push('');

  // Memory section
  const memDate = formatRelativeDate(memory.createdAt);
  const memProject = memory.project.split('/').pop() || memory.project;
  parts.push(`[Memory] You ${memory.content.type === 'bugfix' ? 'fixed' : 'implemented'} ${memory.content.title.slice(0, 30)} in ${memProject} (${memDate}):`);

  let memSummary = memory.content.summary;
  if (memSummary.length > memoryChars - 80) {
    memSummary = memSummary.slice(0, memoryChars - 83) + '...';
  }
  parts.push(memSummary);
  parts.push('');

  // Research section
  const resTitle = research.content.title.length > 40
    ? research.content.title.slice(0, 37) + '...'
    : research.content.title;
  parts.push(`[Research] Current best practice for ${resTitle}:`);

  let resSummary = research.content.summary;
  if (resSummary.length > researchChars - 100) {
    resSummary = resSummary.slice(0, researchChars - 103) + '...';
  }
  parts.push(resSummary);

  // Confidence and followup
  const confidencePercent = Math.round(research.relevance.confidence * 100);
  if (options.includeFollowup !== false) {
    parts.push(`(confidence: ${confidencePercent}%) [/research-detail ${research.content.id}]`);
  } else {
    parts.push(`(confidence: ${confidencePercent}%)`);
  }

  const content = parts.join('\n');
  const tokensEstimate = Math.ceil(content.length / 4);

  return {
    type: 'combined',
    content,
    tokensEstimate,
    sources: {
      memory: { id: memory.content.id, title: memory.content.title },
      research: { id: String(research.content.id), query: research.content.title },
    },
  };
}

// ============================================================================
// Warning/Pivot Formatter (~120 tokens)
// ============================================================================

/**
 * Format a warning/pivot injection
 * Used when research suggests reconsidering the current approach
 *
 * Example output:
 * ```
 * [!] Research suggests reconsidering approach:
 *
 * **Current**: Manual fetch with retry logic
 * **Alternative**: Use ky or got - built-in retry, timeout, hooks
 * **Why**: Less code, battle-tested edge cases, better error handling
 *
 * (high confidence) [/research-detail xyz789]
 * ```
 */
export function formatWarningInjection(
  research: KnowledgeCandidate,
  pivot: PivotSuggestion,
  currentApproach?: string,
  options: FormatOptions = {}
): FormattedInjection {
  const maxTokens = options.maxTokens ?? DEFAULT_BUDGETS.warning;
  const maxChars = maxTokens * 4;

  const parts: string[] = [];

  // Urgency indicator
  const urgencyEmoji = pivot.urgency === 'high' ? '[!] ' : pivot.urgency === 'medium' ? '[*] ' : '[i] ';
  parts.push(`${urgencyEmoji}Research suggests reconsidering approach:`);
  parts.push('');

  // Current approach (if provided)
  if (currentApproach) {
    const truncatedCurrent = currentApproach.length > 50
      ? currentApproach.slice(0, 47) + '...'
      : currentApproach;
    parts.push(`**Current**: ${truncatedCurrent}`);
  }

  // Alternative
  const truncatedAlt = pivot.alternative.length > 100
    ? pivot.alternative.slice(0, 97) + '...'
    : pivot.alternative;
  parts.push(`**Alternative**: ${truncatedAlt}`);

  // Reason (truncate to fit budget)
  const remainingChars = maxChars - parts.join('\n').length - 60;
  let reason = pivot.reason;
  if (reason.length > remainingChars) {
    reason = reason.slice(0, remainingChars - 3) + '...';
  }
  parts.push(`**Why**: ${reason}`);
  parts.push('');

  // Confidence and followup
  const confidenceLabel = research.relevance.confidence >= 0.8 ? 'high' :
                          research.relevance.confidence >= 0.6 ? 'good' : 'moderate';
  if (options.includeFollowup !== false) {
    parts.push(`(${confidenceLabel} confidence) [/research-detail ${research.content.id}]`);
  } else {
    parts.push(`(${confidenceLabel} confidence)`);
  }

  const content = parts.join('\n');
  const tokensEstimate = Math.ceil(content.length / 4);

  return {
    type: 'warning',
    content,
    tokensEstimate,
    sources: {
      research: { id: String(research.content.id), query: research.content.title },
    },
  };
}

// ============================================================================
// Legacy Task Formatter (for backward compatibility)
// ============================================================================

/**
 * Format a ResearchTask for injection (existing format)
 * Kept for backward compatibility with current injection manager
 */
export function formatTaskInjection(
  task: ResearchTask,
  options: { maxTokens?: number } = {}
): string {
  if (!task.result) return '';

  const maxTokens = options.maxTokens ?? 150;
  const maxChars = maxTokens * 4;

  const parts: string[] = [];

  parts.push(`<research-context query="${task.query}">`);

  // Add summary (truncated if needed)
  let summary = task.result.summary;
  if (summary.length > maxChars - 100) {
    summary = summary.slice(0, maxChars - 103) + '...';
  }
  parts.push(summary);

  // Add top source if available
  if (task.result.sources.length > 0) {
    const topSource = task.result.sources[0];
    parts.push(`Source: ${topSource.title} (${topSource.url})`);
  }

  // Add pivot suggestion if present
  if (task.result.pivot) {
    parts.push('');
    const pivot = task.result.pivot;
    const urgencyEmoji = pivot.urgency === 'high' ? '[!]' :
                        pivot.urgency === 'medium' ? '[*]' : '[i]';
    parts.push(`${urgencyEmoji} **Alternative Approach Detected:**`);
    parts.push(`${pivot.alternative}`);
    parts.push(`_Reason: ${pivot.reason}_`);
  }

  // Followup hint
  const sourceCount = task.result.sources.length;
  if (sourceCount > 1 || (task.result.fullContent && task.result.fullContent.length > summary.length * 2)) {
    parts.push('');
    parts.push(`${sourceCount} sources available. Use /research-status for details.`);
  }

  parts.push('</research-context>');

  return parts.join('\n');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a timestamp as a relative date string
 * e.g., "today", "yesterday", "Dec 15", "Nov 20"
 */
function formatRelativeDate(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);

  const daysDiff = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (daysDiff === 0) return 'today';
  if (daysDiff === 1) return 'yesterday';
  if (daysDiff < 7) return `${daysDiff} days ago`;

  // Format as "Mon DD"
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Estimate token count for a string
 * ~4 characters per token on average
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
