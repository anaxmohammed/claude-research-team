/**
 * ClaudeMemAdapter - Bridge between research-team and claude-mem database
 *
 * This adapter allows research-team to:
 * 1. Store research findings as claude-mem observations (type: 'discovery')
 * 2. Create linked research_tasks entries for metadata
 * 3. Query the unified knowledge base (observations + research_tasks)
 * 4. Search for relevant past knowledge using FTS5
 *
 * Design Principles:
 * - Direct SQLite access (no API middleman) for performance and reliability
 * - WAL mode for safe concurrent access
 * - Graceful fallback if claude-mem is unavailable
 * - No schema modifications - uses existing claude-mem tables
 */

import { openDatabaseSync, type SqliteDatabase } from '../database/sqlite-adapter.js';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { ResearchFinding, ClaudeMemConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

// ============================================================================
// Types for claude-mem integration
// ============================================================================

export interface ClaudeMemObservation {
  id: number;
  sdk_session_id: string;
  project: string;
  text?: string;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  title?: string;
  subtitle?: string;
  facts?: string;  // JSON array
  narrative?: string;
  concepts?: string;  // JSON array
  files_read?: string;
  files_modified?: string;
  prompt_number?: number;
  created_at: string;
  created_at_epoch: number;
  discovery_tokens?: number;
}

export interface ClaudeMemResearchTask {
  id: number;
  query: string;
  depth: 'quick' | 'medium' | 'deep';
  context?: string;
  summary: string;
  full_content: string;
  confidence: number;
  tokens_used: number;
  sources_count: number;
  project?: string;
  sdk_session_id?: string;
  observation_id?: number;
  created_at: string;
  created_at_epoch: number;
}

export interface KnowledgeResult {
  id: number;
  source: 'observation' | 'research';
  type: string;
  title: string;
  summary: string;
  details?: string;
  facts: string[];
  concepts: string[];
  project: string;
  confidence: number;
  depth?: string;
  createdAt: number;
  // For injection formatting
  filesModified?: string[];
  filesRead?: string[];
}

export interface SaveResearchResult {
  observationId: number;
  researchTaskId: number;
}

// ============================================================================
// Knowledge Candidate Types (for relevance scoring)
// ============================================================================

/**
 * A unified knowledge candidate with relevance scoring
 * Used for intelligent injection decisions (memory vs research vs combined)
 */
export interface KnowledgeCandidate {
  source: 'observation' | 'research' | 'summary';
  content: {
    id: number;
    title: string;
    summary: string;
    details?: string;
    facts?: string[];
    type?: string;
    depth?: string;
  };
  relevance: {
    textSimilarity: number;      // 0-1, semantic match to current context
    recency: number;             // 0-1, how recent (decays over time)
    projectMatch: boolean;       // Same project?
    typeMatch: number;           // 0-1, relevant observation type
    confidence: number;          // 0-1, source confidence
  };
  finalScore: number;            // Weighted combination
  project: string;
  createdAt: number;
  filesModified?: string[];
  filesRead?: string[];
}

/**
 * Weight configuration for relevance scoring
 */
export interface RelevanceWeights {
  textSimilarity: number;
  recency: number;
  projectMatch: number;
  typeMatch: number;
  confidence: number;
}

/**
 * Default weights for relevance calculation
 */
export const DEFAULT_RELEVANCE_WEIGHTS: RelevanceWeights = {
  textSimilarity: 0.35,
  recency: 0.15,
  projectMatch: 0.15,
  typeMatch: 0.15,
  confidence: 0.20,
};

/**
 * Calculate final relevance score for a knowledge candidate
 */
export function calculateRelevance(
  candidate: KnowledgeCandidate,
  weights: RelevanceWeights = DEFAULT_RELEVANCE_WEIGHTS
): number {
  const { relevance } = candidate;

  const score =
    (relevance.textSimilarity * weights.textSimilarity) +
    (relevance.recency * weights.recency) +
    ((relevance.projectMatch ? 1 : 0.5) * weights.projectMatch) +
    (relevance.typeMatch * weights.typeMatch) +
    (relevance.confidence * weights.confidence);

  return Math.min(1, Math.max(0, score));
}

/**
 * Calculate recency score (decays over time)
 * 1.0 = today, 0.5 = 7 days ago, 0.1 = 30 days ago
 */
export function calculateRecencyScore(createdAt: number, now: number = Date.now()): number {
  const ageMs = now - createdAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // Exponential decay: half-life of 7 days
  return Math.exp(-ageDays / 10);
}

/**
 * Calculate type match score based on observation type relevance to query context
 */
export function calculateTypeMatchScore(type: string, context?: string): number {
  // Base scores for each type
  const typeScores: Record<string, number> = {
    'discovery': 0.9,   // Research discoveries are highly relevant
    'bugfix': 0.8,      // Bug fixes often contain useful insights
    'decision': 0.7,    // Past decisions inform current work
    'feature': 0.6,     // Feature implementations have reusable patterns
    'refactor': 0.5,    // Refactors less immediately relevant
    'change': 0.4,      // Generic changes least specific
  };

  const baseScore = typeScores[type] || 0.5;

  // Boost if context mentions error/bug and type is bugfix
  if (context?.toLowerCase().includes('error') && type === 'bugfix') {
    return Math.min(1, baseScore + 0.2);
  }

  // Boost if context mentions decision and type is decision
  if (context?.toLowerCase().includes('decide') && type === 'decision') {
    return Math.min(1, baseScore + 0.2);
  }

  return baseScore;
}

// ============================================================================
// ClaudeMemAdapter Class
// ============================================================================

export class ClaudeMemAdapter {
  private db: SqliteDatabase | null = null;
  private readonly config: ClaudeMemConfig;
  private readonly resolvedDbPath: string;
  private fallbackMode: boolean = false;
  private initializationError: string | null = null;

  constructor(config: Partial<ClaudeMemConfig> = {}) {
    // Merge with defaults from types.ts
    this.config = { ...DEFAULT_CONFIG.claudeMem, ...config };
    // Resolve ~ in path
    this.resolvedDbPath = this.config.dbPath.replace('~', homedir());
    this.initialize();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  private initialize(): void {
    if (!this.config.enabled) {
      console.log('[ClaudeMemAdapter] Disabled by configuration');
      this.fallbackMode = true;
      return;
    }

    // Check if claude-mem database exists
    if (!existsSync(this.resolvedDbPath)) {
      this.initializationError = `claude-mem database not found at ${this.resolvedDbPath}`;
      console.warn(`[ClaudeMemAdapter] ${this.initializationError}`);
      this.fallbackMode = true;
      return;
    }

    try {
      // Open database with write access
      this.db = openDatabaseSync(this.resolvedDbPath);

      // Enable WAL mode for safe concurrent access
      this.db.pragma('journal_mode = WAL');

      // Verify schema compatibility by checking tables exist
      const tables = this.db.pragma('table_list') as Array<{ name: string }>;
      const tableNames = tables.map(t => t.name);

      if (!tableNames.includes('observations')) {
        throw new Error('observations table not found - schema incompatible');
      }
      if (!tableNames.includes('research_tasks')) {
        throw new Error('research_tasks table not found - schema incompatible');
      }

      console.log('[ClaudeMemAdapter] Successfully connected to claude-mem database');
      console.log(`[ClaudeMemAdapter] Database path: ${this.resolvedDbPath}`);
    } catch (error) {
      this.initializationError = error instanceof Error ? error.message : String(error);
      console.error(`[ClaudeMemAdapter] Failed to initialize: ${this.initializationError}`);

      if (this.config.enableFallbackMode) {
        this.fallbackMode = true;
        console.log('[ClaudeMemAdapter] Falling back to local-only mode');
      } else {
        throw error;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status Methods
  // ─────────────────────────────────────────────────────────────────────────

  isReady(): boolean {
    return this.db !== null && !this.fallbackMode;
  }

  isFallbackMode(): boolean {
    return this.fallbackMode;
  }

  getInitializationError(): string | null {
    return this.initializationError;
  }

  getStats(): { observationsCount: number; researchTasksCount: number } | null {
    if (!this.isReady()) return null;

    try {
      const obsCount = this.db!.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      const rtCount = this.db!.prepare('SELECT COUNT(*) as count FROM research_tasks').get() as { count: number };

      return {
        observationsCount: obsCount.count,
        researchTasksCount: rtCount.count,
      };
    } catch (error) {
      console.error('[ClaudeMemAdapter] Failed to get stats:', error);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Write Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Save a research finding to claude-mem as an observation + research_task
   * This is the primary write operation for integration
   */
  saveResearchAsObservation(
    finding: ResearchFinding,
    sessionId: string,
    project: string
  ): SaveResearchResult | null {
    if (!this.isReady()) {
      console.log('[ClaudeMemAdapter] Not ready, skipping save');
      return null;
    }

    const now = new Date();
    const epochMs = now.getTime();

    try {
      // 1. Create observation (type: 'discovery')
      const obsResult = this.db!.prepare(`
        INSERT INTO observations (
          sdk_session_id, project, type, title, subtitle,
          facts, narrative, text, concepts,
          created_at, created_at_epoch, discovery_tokens
        ) VALUES (?, ?, 'discovery', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        project,
        finding.query,                              // title = query
        finding.summary,                            // subtitle = summary
        JSON.stringify(finding.keyPoints || []),    // facts = key points array
        finding.fullContent || '',                  // narrative = full content
        JSON.stringify(finding.sources || []),      // text = sources as JSON
        JSON.stringify(['research', finding.domain].filter(Boolean)), // concepts include 'research' tag
        now.toISOString(),
        epochMs,
        0,  // discovery_tokens (we don't track this from research-team)
      );

      const observationId = Number(obsResult.lastInsertRowid);

      // 2. Create research_tasks entry (links to observation via FK)
      const taskResult = this.db!.prepare(`
        INSERT INTO research_tasks (
          query, depth, context, summary, full_content,
          confidence, tokens_used, sources_count,
          project, sdk_session_id, observation_id,
          created_at, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        finding.query,
        finding.depth,
        null,  // context - we don't pass this currently
        finding.summary,
        finding.fullContent || '',
        finding.confidence,
        0,  // tokens_used - we don't track exact tokens
        finding.sources?.length || 0,
        project,
        sessionId,
        observationId,
        now.toISOString(),
        epochMs,
      );

      const researchTaskId = Number(taskResult.lastInsertRowid);

      console.log(`[ClaudeMemAdapter] Saved research as observation #${observationId}, research_task #${researchTaskId}`);
      console.log(`[ClaudeMemAdapter] Query: "${finding.query.slice(0, 50)}..."`);

      return { observationId, researchTaskId };
    } catch (error) {
      console.error('[ClaudeMemAdapter] Failed to save research:', error);

      if (this.config.enableFallbackMode) {
        this.handleDbError('saveResearchAsObservation', error as Error);
      } else {
        throw error;
      }

      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Read Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Search unified knowledge base (observations + research_tasks)
   * Uses FTS5 for keyword matching
   */
  searchKnowledge(
    query: string,
    options: {
      limit?: number;
      project?: string;
      includeTypes?: string[];
      minConfidence?: number;
    } = {}
  ): KnowledgeResult[] {
    if (!this.isReady()) {
      console.log('[ClaudeMemAdapter] Not ready, returning empty results');
      return [];
    }

    const { limit = 10, project, includeTypes, minConfidence: _minConfidence = 0 } = options;

    try {
      // Escape FTS5 special characters
      const escapedQuery = '"' + query.replace(/"/g, '""') + '"';

      // Build dynamic WHERE clauses
      let whereClause = 'WHERE observations_fts MATCH ?';
      const params: unknown[] = [escapedQuery];

      if (project) {
        whereClause += ' AND o.project = ?';
        params.push(project);
      }

      if (includeTypes && includeTypes.length > 0) {
        const placeholders = includeTypes.map(() => '?').join(',');
        whereClause += ` AND o.type IN (${placeholders})`;
        params.push(...includeTypes);
      }

      params.push(limit);

      // Query observations with optional research_tasks join
      const rows = this.db!.prepare(`
        SELECT
          o.id,
          o.type,
          o.title,
          o.subtitle,
          o.narrative,
          o.facts,
          o.concepts,
          o.project,
          o.files_read,
          o.files_modified,
          o.created_at_epoch,
          rt.confidence,
          rt.depth,
          'observation' as source
        FROM observations o
        LEFT JOIN research_tasks rt ON rt.observation_id = o.id
        JOIN observations_fts fts ON fts.rowid = o.id
        ${whereClause}
        ORDER BY rank
        LIMIT ?
      `).all(...params) as Array<Record<string, unknown>>;

      return rows.map(row => this.rowToKnowledgeResult(row));
    } catch (error) {
      console.error('[ClaudeMemAdapter] Search failed:', error);
      return [];
    }
  }

  /**
   * Search specifically for research discoveries (observations with 'research' concept)
   */
  searchResearchDiscoveries(
    query: string,
    options: { limit?: number; project?: string } = {}
  ): KnowledgeResult[] {
    return this.searchKnowledge(query, {
      ...options,
      includeTypes: ['discovery'],
    });
  }

  /**
   * Get recent observations from a specific project
   */
  getRecentObservations(
    project: string,
    limit: number = 20
  ): KnowledgeResult[] {
    if (!this.isReady()) return [];

    try {
      const rows = this.db!.prepare(`
        SELECT
          o.id,
          o.type,
          o.title,
          o.subtitle,
          o.narrative,
          o.facts,
          o.concepts,
          o.project,
          o.files_read,
          o.files_modified,
          o.created_at_epoch,
          rt.confidence,
          rt.depth,
          'observation' as source
        FROM observations o
        LEFT JOIN research_tasks rt ON rt.observation_id = o.id
        WHERE o.project = ?
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `).all(project, limit) as Array<Record<string, unknown>>;

      return rows.map(row => this.rowToKnowledgeResult(row));
    } catch (error) {
      console.error('[ClaudeMemAdapter] Failed to get recent observations:', error);
      return [];
    }
  }

  /**
   * Get related research from research_tasks table
   */
  getRelatedResearch(
    query: string,
    threshold: number = 0.7,
    limit: number = 10
  ): Array<ClaudeMemResearchTask & { title: string; subtitle: string }> {
    if (!this.isReady()) return [];

    try {
      const escapedQuery = '"' + query.replace(/"/g, '""') + '"';

      const rows = this.db!.prepare(`
        SELECT rt.*, o.title, o.subtitle
        FROM research_tasks rt
        JOIN observations o ON o.id = rt.observation_id
        JOIN research_fts fts ON fts.rowid = rt.id
        WHERE research_fts MATCH ?
        AND rt.confidence >= ?
        ORDER BY rt.created_at_epoch DESC
        LIMIT ?
      `).all(escapedQuery, threshold, limit) as Array<Record<string, unknown>>;

      return rows.map(row => ({
        id: row.id as number,
        query: row.query as string,
        depth: row.depth as 'quick' | 'medium' | 'deep',
        context: row.context as string | undefined,
        summary: row.summary as string,
        full_content: row.full_content as string,
        confidence: row.confidence as number,
        tokens_used: row.tokens_used as number,
        sources_count: row.sources_count as number,
        project: row.project as string | undefined,
        sdk_session_id: row.sdk_session_id as string | undefined,
        observation_id: row.observation_id as number | undefined,
        created_at: row.created_at as string,
        created_at_epoch: row.created_at_epoch as number,
        title: row.title as string,
        subtitle: row.subtitle as string,
      }));
    } catch (error) {
      console.error('[ClaudeMemAdapter] Failed to get related research:', error);
      return [];
    }
  }

  /**
   * Check if similar research already exists in claude-mem
   * For deduplication before triggering new research
   */
  hasExistingKnowledge(
    query: string,
    options: {
      maxAgeMs?: number;
      minConfidence?: number;
      project?: string;
    } = {}
  ): { found: boolean; existingQuery?: string; confidence?: number; observationId?: number } {
    if (!this.isReady()) return { found: false };

    const { maxAgeMs = 7 * 24 * 60 * 60 * 1000, minConfidence = 0.6, project } = options;  // Default 7 days
    const cutoffTime = Date.now() - maxAgeMs;

    try {
      const escapedQuery = '"' + query.replace(/"/g, '""') + '"';

      let sql = `
        SELECT o.id, o.title, rt.confidence
        FROM observations o
        JOIN research_tasks rt ON rt.observation_id = o.id
        JOIN observations_fts fts ON fts.rowid = o.id
        WHERE observations_fts MATCH ?
        AND o.created_at_epoch > ?
        AND rt.confidence >= ?
      `;
      const params: unknown[] = [escapedQuery, cutoffTime, minConfidence];

      if (project) {
        sql += ' AND o.project = ?';
        params.push(project);
      }

      sql += ' ORDER BY rank LIMIT 1';

      const row = this.db!.prepare(sql).get(...params) as Record<string, unknown> | undefined;

      if (row) {
        return {
          found: true,
          existingQuery: row.title as string,
          confidence: row.confidence as number,
          observationId: row.id as number,
        };
      }

      return { found: false };
    } catch (error) {
      console.error('[ClaudeMemAdapter] Failed to check existing knowledge:', error);
      return { found: false };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Unified Knowledge Search (with relevance scoring)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Search unified knowledge base and return scored candidates
   * This is the primary method for injection decisions
   */
  searchUnifiedKnowledge(
    query: string,
    options: {
      limit?: number;
      project?: string;
      context?: string;
      weights?: Partial<RelevanceWeights>;
    } = {}
  ): KnowledgeCandidate[] {
    if (!this.isReady()) {
      console.log('[ClaudeMemAdapter] Not ready, returning empty candidates');
      return [];
    }

    const { limit = 10, project, context, weights } = options;
    const mergedWeights = { ...DEFAULT_RELEVANCE_WEIGHTS, ...weights };
    const now = Date.now();

    try {
      // Escape FTS5 special characters
      const escapedQuery = '"' + query.replace(/"/g, '""') + '"';

      // Build query
      let whereClause = 'WHERE observations_fts MATCH ?';
      const params: unknown[] = [escapedQuery];

      if (project) {
        whereClause += ' AND o.project = ?';
        params.push(project);
      }

      params.push(limit * 2); // Fetch extra for scoring/filtering

      const rows = this.db!.prepare(`
        SELECT
          o.id,
          o.type,
          o.title,
          o.subtitle,
          o.narrative,
          o.facts,
          o.concepts,
          o.project,
          o.files_read,
          o.files_modified,
          o.created_at_epoch,
          rt.confidence,
          rt.depth,
          CASE WHEN rt.id IS NOT NULL THEN 'research' ELSE 'observation' END as source
        FROM observations o
        LEFT JOIN research_tasks rt ON rt.observation_id = o.id
        JOIN observations_fts fts ON fts.rowid = o.id
        ${whereClause}
        ORDER BY rank
        LIMIT ?
      `).all(...params) as Array<Record<string, unknown>>;

      // Convert to KnowledgeCandidates with scoring
      const candidates: KnowledgeCandidate[] = rows.map(row => {
        const createdAt = row.created_at_epoch as number;
        const obsType = row.type as string;
        const obsProject = row.project as string;
        const confidence = (row.confidence as number) || 0.5;

        // Calculate individual relevance factors
        const recencyScore = calculateRecencyScore(createdAt, now);
        const typeMatchScore = calculateTypeMatchScore(obsType, context);
        const projectMatches = project ? obsProject === project : true;

        // Text similarity approximation (FTS rank doesn't give us this directly)
        // We'll use a base score and boost based on FTS presence
        const textSimilarity = 0.7; // Base score since FTS matched

        const candidate: KnowledgeCandidate = {
          source: row.source as 'observation' | 'research' | 'summary',
          content: {
            id: row.id as number,
            title: row.title as string || '',
            summary: row.subtitle as string || '',
            details: row.narrative as string | undefined,
            facts: this.parseJsonArray(row.facts),
            type: obsType,
            depth: row.depth as string | undefined,
          },
          relevance: {
            textSimilarity,
            recency: recencyScore,
            projectMatch: projectMatches,
            typeMatch: typeMatchScore,
            confidence,
          },
          finalScore: 0, // Will be calculated below
          project: obsProject,
          createdAt,
          filesModified: this.parseJsonArray(row.files_modified),
          filesRead: this.parseJsonArray(row.files_read),
        };

        // Calculate final score
        candidate.finalScore = calculateRelevance(candidate, mergedWeights);

        return candidate;
      });

      // Sort by final score and limit
      return candidates
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, limit);
    } catch (error) {
      console.error('[ClaudeMemAdapter] Unified search failed:', error);
      return [];
    }
  }

  /**
   * Get the best candidates for injection, separated by source type
   * Returns candidates above the minimum relevance threshold
   */
  getBestCandidatesForInjection(
    query: string,
    options: {
      project?: string;
      context?: string;
      minScore?: number;
    } = {}
  ): {
    memory: KnowledgeCandidate | null;
    research: KnowledgeCandidate | null;
    combined: KnowledgeCandidate[];
  } {
    const minScore = options.minScore ?? this.config.minRelevanceScore;

    const candidates = this.searchUnifiedKnowledge(query, {
      limit: 20,
      project: options.project,
      context: options.context,
    });

    // Filter by minimum score
    const validCandidates = candidates.filter(c => c.finalScore >= minScore);

    // Separate by source
    const memoryCandidates = validCandidates.filter(c => c.source === 'observation' && c.content.type !== 'discovery');
    const researchCandidates = validCandidates.filter(c => c.source === 'research' || c.content.type === 'discovery');

    return {
      memory: memoryCandidates[0] || null,
      research: researchCandidates[0] || null,
      combined: validCandidates.slice(0, 3), // Top 3 overall
    };
  }

  /**
   * Determine injection type based on candidate scores and thresholds
   */
  determineInjectionType(
    memory: KnowledgeCandidate | null,
    research: KnowledgeCandidate | null
  ): 'memory-only' | 'research-only' | 'combined' | 'none' {
    const memoryScore = memory?.finalScore ?? 0;
    const researchScore = research?.finalScore ?? 0;

    // Strong memory match = memory only
    if (memoryScore >= this.config.memoryOnlyThreshold && memoryScore > researchScore) {
      return 'memory-only';
    }

    // Both above combined threshold = combined
    if (memoryScore >= this.config.combinedThreshold && researchScore >= this.config.combinedThreshold) {
      return 'combined';
    }

    // Research above threshold = research only
    if (researchScore >= this.config.researchOnlyThreshold) {
      return 'research-only';
    }

    // Memory above minimum but below "only" threshold
    if (memoryScore >= this.config.minRelevanceScore) {
      return 'memory-only';
    }

    return 'none';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helper for parsing JSON arrays
  // ─────────────────────────────────────────────────────────────────────────

  private parseJsonArray(val: unknown): string[] | undefined {
    if (!val) return undefined;
    try {
      const parsed = JSON.parse(val as string);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Additional Read Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get a specific observation by ID
   */
  getObservation(id: number): KnowledgeResult | null {
    if (!this.isReady()) return null;

    try {
      const row = this.db!.prepare(`
        SELECT
          o.id,
          o.type,
          o.title,
          o.subtitle,
          o.narrative,
          o.facts,
          o.concepts,
          o.project,
          o.files_read,
          o.files_modified,
          o.created_at_epoch,
          rt.confidence,
          rt.depth,
          'observation' as source
        FROM observations o
        LEFT JOIN research_tasks rt ON rt.observation_id = o.id
        WHERE o.id = ?
      `).get(id) as Record<string, unknown> | undefined;

      if (!row) return null;

      return this.rowToKnowledgeResult(row);
    } catch (error) {
      console.error('[ClaudeMemAdapter] Failed to get observation:', error);
      return null;
    }
  }

  /**
   * Get observation counts by type
   */
  getObservationTypeCounts(): Record<string, number> {
    if (!this.isReady()) return {};

    try {
      const rows = this.db!.prepare(`
        SELECT type, COUNT(*) as count
        FROM observations
        GROUP BY type
      `).all() as Array<{ type: string; count: number }>;

      return rows.reduce((acc, row) => {
        acc[row.type] = row.count;
        return acc;
      }, {} as Record<string, number>);
    } catch (error) {
      console.error('[ClaudeMemAdapter] Failed to get type counts:', error);
      return {};
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  private rowToKnowledgeResult(row: Record<string, unknown>): KnowledgeResult {
    // Parse JSON fields safely
    const parseFacts = (val: unknown): string[] => {
      if (!val) return [];
      try {
        const parsed = JSON.parse(val as string);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    const parseConcepts = (val: unknown): string[] => {
      if (!val) return [];
      try {
        const parsed = JSON.parse(val as string);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    const parseFiles = (val: unknown): string[] | undefined => {
      if (!val) return undefined;
      try {
        const parsed = JSON.parse(val as string);
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    };

    return {
      id: row.id as number,
      source: row.source as 'observation' | 'research',
      type: row.type as string,
      title: row.title as string || '',
      summary: row.subtitle as string || '',
      details: row.narrative as string | undefined,
      facts: parseFacts(row.facts),
      concepts: parseConcepts(row.concepts),
      project: row.project as string || '',
      confidence: (row.confidence as number) || 0.5,
      depth: row.depth as string | undefined,
      createdAt: row.created_at_epoch as number,
      filesModified: parseFiles(row.files_modified),
      filesRead: parseFiles(row.files_read),
    };
  }

  private handleDbError(operation: string, error: Error): void {
    if (error.message.includes('SQLITE_BUSY')) {
      console.warn(`[ClaudeMemAdapter] Database busy during ${operation}, will retry`);
      // TODO: Implement retry with backoff
      return;
    }

    if (error.message.includes('no such table') || error.message.includes('no such column')) {
      console.error(`[ClaudeMemAdapter] Schema incompatible: ${error.message}`);
      this.fallbackMode = true;
      this.initializationError = `Schema incompatible: ${error.message}`;
      return;
    }

    // Log other errors but don't change fallback mode
    console.error(`[ClaudeMemAdapter] Error in ${operation}:`, error.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// ============================================================================
// Singleton instance
// ============================================================================

let instance: ClaudeMemAdapter | null = null;

export function getClaudeMemAdapter(config?: Partial<ClaudeMemConfig>): ClaudeMemAdapter {
  if (!instance) {
    instance = new ClaudeMemAdapter(config);
  }
  return instance;
}

export function closeClaudeMemAdapter(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
