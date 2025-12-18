/**
 * Core types for claude-research-team
 * Autonomous research agents for Claude Code
 */

// ============================================================================
// Research Types
// ============================================================================

export type ResearchDepth = 'quick' | 'medium' | 'deep';

export type ResearchStatus =
  | 'queued'      // Waiting to be processed
  | 'running'     // Currently being researched
  | 'completed'   // Successfully completed
  | 'failed'      // Research failed
  | 'injected';   // Results were injected into context

export type TriggerSource =
  | 'user_prompt'   // Detected from user message
  | 'tool_output'   // Detected from tool result
  | 'manual'        // Manually queued via API
  | 'scheduled';    // Scheduled background research

export interface ResearchTask {
  id: string;
  query: string;
  context?: string;
  depth: ResearchDepth;
  status: ResearchStatus;
  trigger: TriggerSource;
  sessionId?: string;
  priority: number;        // 1-10, higher = more urgent
  createdAt: number;       // Unix timestamp
  startedAt?: number;
  completedAt?: number;
  result?: ResearchResult;
  error?: string;
}

export interface ResearchResult {
  summary: string;         // Concise summary for injection
  fullContent: string;     // Full research content
  sources: ResearchSource[];
  tokensUsed: number;      // Approximate tokens in summary
  confidence: number;      // 0-1 confidence score
}

export interface ResearchSource {
  title: string;
  url: string;
  snippet?: string;
  relevance: number;       // 0-1 relevance score
}

// ============================================================================
// Injection Types
// ============================================================================

export interface InjectionRecord {
  id: string;
  taskId: string;          // Reference to research task
  sessionId: string;
  injectedAt: number;
  content: string;         // What was injected
  tokensUsed: number;
  accepted: boolean;       // Was it useful? (feedback)
}

export interface InjectionBudget {
  maxPerSession: number;   // Max injections per session
  maxTokensPerInjection: number;
  maxTotalTokensPerSession: number;
  cooldownMs: number;      // Min time between injections
}

// ============================================================================
// Queue Types
// ============================================================================

export interface QueueStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  totalProcessed: number;
}

export interface QueueConfig {
  maxConcurrent: number;   // Max simultaneous research tasks
  maxQueueSize: number;    // Max pending tasks
  taskTimeoutMs: number;   // Timeout for individual tasks
  retryAttempts: number;   // Retries on failure
}

// ============================================================================
// Session Types
// ============================================================================

export interface Session {
  id: string;
  startedAt: number;
  lastActivityAt: number;
  projectPath?: string;
  injectionsCount: number;
  injectionsTokens: number;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface Config {
  // Service
  port: number;
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  // Research
  defaultDepth: ResearchDepth;
  engines: string[];       // Which search engines to use

  // Injection
  injection: InjectionBudget;

  // Queue
  queue: QueueConfig;

  // Integration
  claudeMemSync: boolean;  // Sync findings to claude-mem
  claudeMemUrl?: string;   // URL if sync enabled
}

export const DEFAULT_CONFIG: Config = {
  port: 3200,
  dataDir: '~/.claude-research-team',
  logLevel: 'info',

  defaultDepth: 'medium',
  engines: ['serper', 'brave', 'tavily'],

  injection: {
    maxPerSession: 5,
    maxTokensPerInjection: 150,
    maxTotalTokensPerSession: 500,
    cooldownMs: 30000,      // 30 seconds between injections
  },

  queue: {
    maxConcurrent: 2,
    maxQueueSize: 20,
    taskTimeoutMs: 120000,  // 2 minutes
    retryAttempts: 2,
  },

  claudeMemSync: false,
};

// ============================================================================
// API Types
// ============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ServiceStatus {
  running: boolean;
  uptime: number;
  version: string;
  queue: QueueStats;
  activeSessions: number;
  config: Partial<Config>;
}

// ============================================================================
// Hook Types
// ============================================================================

export interface HookContext {
  sessionId: string;
  projectPath?: string;
  hookType: 'UserPromptSubmit' | 'PostToolUse' | 'SessionStart' | 'SessionEnd';
}

export interface UserPromptSubmitInput {
  prompt: string;
  sessionId: string;
  projectPath?: string;
}

export interface PostToolUseInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: string;
  sessionId: string;
  projectPath?: string;
}

export interface HookResult {
  continue: boolean;
  suppressOutput?: boolean;
  additionalContext?: string;
}
