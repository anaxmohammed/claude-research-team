/**
 * Memory Integration Layer
 * Integrates research results with claude-mem's database for persistent learning
 *
 * Architecture:
 * - Adds research-specific tables to claude-mem's SQLite database
 * - Creates observations automatically for context injection
 * - Tracks topics and knowledge for gap detection
 * - Enables semantic search of past research via Chroma
 */

import Database from 'better-sqlite3';
import { Logger } from '../utils/logger.js';
import type { ResearchResult, ResearchDepth } from '../types.js';
import path from 'path';
import os from 'os';

const CLAUDE_MEM_DB = path.join(os.homedir(), '.claude-mem', 'claude-mem.db');

interface ResearchRecord {
  id: number;
  query: string;
  depth: ResearchDepth;
  context?: string;
  summary: string;
  fullContent: string;
  confidence: number;
  tokensUsed: number;
  sourcesCount: number;
  createdAt: string;
  createdAtEpoch: number;
  observationId?: number;
}

// SourceRecord type available for future use
// interface SourceRecord {
//   id: number;
//   researchId: number;
//   url: string;
//   title: string;
//   snippet: string;
//   relevance: number;
//   scraped: boolean;
//   scrapedContent?: string;
// }

interface TopicRecord {
  id: number;
  name: string;
  description?: string;
  researchCount: number;
  lastResearchedEpoch: number;
  relatedTopics: string; // JSON array
  knowledgeLevel: 'unknown' | 'basic' | 'intermediate' | 'deep';
}

export class MemoryIntegration {
  private db: Database.Database | null = null;
  private logger: Logger;
  private initialized: boolean = false;

  constructor() {
    this.logger = new Logger('MemoryIntegration');
  }

  /**
   * Initialize the database connection and ensure tables exist
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.db = new Database(CLAUDE_MEM_DB);
      this.db.pragma('journal_mode = WAL');

      await this.createTables();
      await this.ensureResearchSession();
      this.initialized = true;
      this.logger.info('Memory integration initialized', { db: CLAUDE_MEM_DB });
    } catch (error) {
      this.logger.error('Failed to initialize memory integration', error);
      throw error;
    }
  }

  /**
   * Ensure a session exists for the research service
   */
  private async ensureResearchSession(): Promise<void> {
    if (!this.db) return;

    const existing = this.db.prepare(
      'SELECT id FROM sdk_sessions WHERE sdk_session_id = ?'
    ).get('research-service');

    if (!existing) {
      const now = new Date();
      this.db.prepare(`
        INSERT INTO sdk_sessions (
          claude_session_id, sdk_session_id, project, user_prompt,
          started_at, started_at_epoch, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'research-service-claude',
        'research-service',
        'claude-research-team',
        'Research service memory integration',
        now.toISOString(),
        now.getTime(), // claude-mem uses milliseconds
        'active'
      );
      this.logger.debug('Created research service session');
    }
  }

  /**
   * Create research-specific tables in claude-mem database
   */
  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

    // Research tasks table - stores full research results
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        depth TEXT NOT NULL CHECK(depth IN ('quick', 'medium', 'deep')),
        context TEXT,
        summary TEXT NOT NULL,
        full_content TEXT NOT NULL,
        confidence REAL NOT NULL,
        tokens_used INTEGER NOT NULL,
        sources_count INTEGER NOT NULL,
        project TEXT,
        sdk_session_id TEXT,
        observation_id INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE SET NULL
      )
    `);

    // Research sources table - individual sources with metadata
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        research_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        snippet TEXT,
        relevance REAL NOT NULL,
        scraped INTEGER NOT NULL DEFAULT 0,
        scraped_content TEXT,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(research_id) REFERENCES research_tasks(id) ON DELETE CASCADE
      )
    `);

    // Knowledge topics table - tracks what we know about
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        research_count INTEGER NOT NULL DEFAULT 0,
        last_researched_epoch INTEGER,
        related_topics TEXT DEFAULT '[]',
        knowledge_level TEXT NOT NULL DEFAULT 'unknown'
          CHECK(knowledge_level IN ('unknown', 'basic', 'intermediate', 'deep')),
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER NOT NULL
      )
    `);

    // Research-topic junction table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_topics (
        research_id INTEGER NOT NULL,
        topic_id INTEGER NOT NULL,
        relevance REAL NOT NULL DEFAULT 1.0,
        PRIMARY KEY(research_id, topic_id),
        FOREIGN KEY(research_id) REFERENCES research_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(topic_id) REFERENCES knowledge_topics(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for fast lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_research_tasks_query ON research_tasks(query);
      CREATE INDEX IF NOT EXISTS idx_research_tasks_created ON research_tasks(created_at_epoch DESC);
      CREATE INDEX IF NOT EXISTS idx_research_tasks_project ON research_tasks(project);
      CREATE INDEX IF NOT EXISTS idx_research_sources_research ON research_sources(research_id);
      CREATE INDEX IF NOT EXISTS idx_research_sources_url ON research_sources(url);
      CREATE INDEX IF NOT EXISTS idx_knowledge_topics_name ON knowledge_topics(name);
      CREATE INDEX IF NOT EXISTS idx_knowledge_topics_level ON knowledge_topics(knowledge_level);
    `);

    // Create FTS5 virtual table for full-text search on research
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS research_fts USING fts5(
        query,
        summary,
        full_content,
        content='research_tasks',
        content_rowid='id'
      )
    `);

    // Create triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS research_tasks_ai AFTER INSERT ON research_tasks BEGIN
        INSERT INTO research_fts(rowid, query, summary, full_content)
        VALUES (new.id, new.query, new.summary, new.full_content);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS research_tasks_ad AFTER DELETE ON research_tasks BEGIN
        INSERT INTO research_fts(research_fts, rowid, query, summary, full_content)
        VALUES('delete', old.id, old.query, old.summary, old.full_content);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS research_tasks_au AFTER UPDATE ON research_tasks BEGIN
        INSERT INTO research_fts(research_fts, rowid, query, summary, full_content)
        VALUES('delete', old.id, old.query, old.summary, old.full_content);
        INSERT INTO research_fts(rowid, query, summary, full_content)
        VALUES (new.id, new.query, new.summary, new.full_content);
      END
    `);

    this.logger.debug('Research tables created/verified');
  }

  /**
   * Store a research result and create an observation for context injection
   */
  async storeResearch(
    query: string,
    depth: ResearchDepth,
    result: ResearchResult,
    context?: string,
    sessionId?: string,
    project?: string
  ): Promise<number> {
    if (!this.db) await this.initialize();

    const now = new Date();
    const createdAt = now.toISOString();
    const createdAtEpoch = now.getTime(); // claude-mem uses milliseconds, not seconds

    // Start transaction
    const transaction = this.db!.transaction(() => {
      // 1. Insert research task
      const insertResearch = this.db!.prepare(`
        INSERT INTO research_tasks (
          query, depth, context, summary, full_content, confidence,
          tokens_used, sources_count, project, sdk_session_id,
          created_at, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const researchInfo = insertResearch.run(
        query,
        depth,
        context || null,
        result.summary,
        result.fullContent,
        result.confidence,
        result.tokensUsed,
        result.sources.length,
        project || 'default',
        sessionId || null,
        createdAt,
        createdAtEpoch
      );

      const researchId = researchInfo.lastInsertRowid as number;

      // 2. Insert sources
      const insertSource = this.db!.prepare(`
        INSERT INTO research_sources (
          research_id, url, title, snippet, relevance, scraped, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const source of result.sources) {
        insertSource.run(
          researchId,
          source.url,
          source.title,
          source.snippet,
          source.relevance,
          0, // Not storing scraped content in sources table
          createdAtEpoch
        );
      }

      // 3. Create observation for context injection
      const observationId = this.createResearchObservation(
        query,
        result,
        sessionId,
        project,
        createdAt,
        createdAtEpoch
      );

      // 4. Update research task with observation ID
      if (observationId) {
        this.db!.prepare('UPDATE research_tasks SET observation_id = ? WHERE id = ?')
          .run(observationId, researchId);
      }

      // 5. Extract and update topics
      this.extractAndUpdateTopics(query, result, researchId, createdAtEpoch);

      return researchId;
    });

    const researchId = transaction();
    this.logger.info(`Stored research #${researchId}`, { query, sources: result.sources.length });

    return researchId;
  }

  /**
   * Create an observation record for context injection into future conversations
   */
  private createResearchObservation(
    query: string,
    result: ResearchResult,
    sessionId?: string,
    project?: string,
    createdAt?: string,
    createdAtEpoch?: number
  ): number | null {
    if (!this.db) return null;

    const now = new Date();
    const at = createdAt || now.toISOString();
    const epoch = createdAtEpoch || now.getTime(); // claude-mem uses milliseconds

    // Build facts from sources as JSON array
    const facts = result.sources.slice(0, 5).map(s =>
      `Source: ${s.title} (${s.url}) - relevance: ${(s.relevance * 100).toFixed(0)}%`
    );

    // Use proper concept types that claude-mem recognizes for context injection
    // Research observations primarily teach "how-it-works" and document findings ("problem-solution")
    const concepts = ['how-it-works', 'problem-solution'];

    try {
      const insertObs = this.db.prepare(`
        INSERT INTO observations (
          sdk_session_id, project, type, title, subtitle,
          text, facts, narrative, concepts,
          prompt_number, created_at, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const info = insertObs.run(
        sessionId || 'research-service',
        project || 'claude-research-team',
        'discovery', // Using existing observation type
        `Research: ${query.slice(0, 60)}${query.length > 60 ? '...' : ''}`,
        `${result.sources.length} sources, ${(result.confidence * 100).toFixed(0)}% confidence`,
        result.summary,
        JSON.stringify(facts), // claude-mem expects JSON array
        result.fullContent,
        JSON.stringify(concepts), // claude-mem expects JSON array of concept types
        0,
        at,
        epoch
      );

      return info.lastInsertRowid as number;
    } catch (error) {
      this.logger.warn('Failed to create observation', error);
      return null;
    }
  }

  /**
   * Extract topics from research and update knowledge graph
   */
  private extractAndUpdateTopics(
    query: string,
    result: ResearchResult,
    researchId: number,
    epoch: number
  ): void {
    if (!this.db) return;

    // Simple topic extraction from query (can be enhanced with NLP)
    const topics = this.extractTopicsFromText(query + ' ' + result.summary);

    for (const topicName of topics) {
      // Upsert topic
      this.db.prepare(`
        INSERT INTO knowledge_topics (name, research_count, last_researched_epoch, created_at_epoch, updated_at_epoch)
        VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          research_count = research_count + 1,
          last_researched_epoch = ?,
          updated_at_epoch = ?,
          knowledge_level = CASE
            WHEN research_count >= 10 THEN 'deep'
            WHEN research_count >= 5 THEN 'intermediate'
            WHEN research_count >= 2 THEN 'basic'
            ELSE 'unknown'
          END
      `).run(topicName, epoch, epoch, epoch, epoch, epoch);

      // Get topic ID
      const topic = this.db.prepare('SELECT id FROM knowledge_topics WHERE name = ?').get(topicName) as { id: number } | undefined;

      if (topic) {
        // Link research to topic
        this.db.prepare(`
          INSERT OR IGNORE INTO research_topics (research_id, topic_id, relevance)
          VALUES (?, ?, 1.0)
        `).run(researchId, topic.id);
      }
    }
  }

  /**
   * Simple topic extraction (keywords from query)
   */
  private extractTopicsFromText(text: string): string[] {
    // Remove common words and extract meaningful terms
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
      'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
      'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
      'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here',
      'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
      'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
      'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
      'because', 'until', 'while', 'what', 'which', 'who', 'this', 'that',
      'these', 'those', 'it', 'its', 'i', 'me', 'my', 'myself', 'we', 'our',
      'ours', 'ourselves', 'you', 'your', 'yours', 'yourself', 'yourselves',
      'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'they',
      'them', 'their', 'theirs', 'themselves', 'best', 'using', 'use', 'about'
    ]);

    const words = text.toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    // Return unique topics (up to 5)
    return [...new Set(words)].slice(0, 5);
  }

  /**
   * Search past research by query
   */
  async searchResearch(
    searchQuery: string,
    limit: number = 10
  ): Promise<ResearchRecord[]> {
    if (!this.db) await this.initialize();

    const results = this.db!.prepare(`
      SELECT r.*, rf.rank
      FROM research_tasks r
      JOIN research_fts rf ON r.id = rf.rowid
      WHERE research_fts MATCH ?
      ORDER BY rf.rank
      LIMIT ?
    `).all(searchQuery, limit) as (ResearchRecord & { rank: number })[];

    return results;
  }

  /**
   * Find related past research for a query
   */
  async findRelatedResearch(query: string, limit: number = 5): Promise<ResearchRecord[]> {
    if (!this.db) await this.initialize();

    // Extract topics from query
    const topics = this.extractTopicsFromText(query);

    if (topics.length === 0) return [];

    // Find research with matching topics
    const placeholders = topics.map(() => '?').join(',');
    const results = this.db!.prepare(`
      SELECT DISTINCT r.*
      FROM research_tasks r
      JOIN research_topics rt ON r.id = rt.research_id
      JOIN knowledge_topics kt ON rt.topic_id = kt.id
      WHERE kt.name IN (${placeholders})
      ORDER BY r.created_at_epoch DESC
      LIMIT ?
    `).all(...topics, limit) as ResearchRecord[];

    return results;
  }

  /**
   * Get knowledge gaps - topics we know little about
   */
  async getKnowledgeGaps(limit: number = 10): Promise<TopicRecord[]> {
    if (!this.db) await this.initialize();

    const gaps = this.db!.prepare(`
      SELECT * FROM knowledge_topics
      WHERE knowledge_level IN ('unknown', 'basic')
      ORDER BY research_count ASC, last_researched_epoch ASC
      LIMIT ?
    `).all(limit) as TopicRecord[];

    return gaps;
  }

  /**
   * Get topic knowledge summary
   */
  async getTopicKnowledge(): Promise<{
    total: number;
    byLevel: Record<string, number>;
    recentTopics: TopicRecord[];
  }> {
    if (!this.db) await this.initialize();

    const total = (this.db!.prepare('SELECT COUNT(*) as count FROM knowledge_topics').get() as { count: number }).count;

    const byLevelRows = this.db!.prepare(`
      SELECT knowledge_level, COUNT(*) as count
      FROM knowledge_topics
      GROUP BY knowledge_level
    `).all() as { knowledge_level: string; count: number }[];

    const byLevel: Record<string, number> = {};
    for (const row of byLevelRows) {
      byLevel[row.knowledge_level] = row.count;
    }

    const recentTopics = this.db!.prepare(`
      SELECT * FROM knowledge_topics
      ORDER BY last_researched_epoch DESC
      LIMIT 10
    `).all() as TopicRecord[];

    return { total, byLevel, recentTopics };
  }

  /**
   * Check if we've already researched something similar
   */
  async hasExistingResearch(query: string): Promise<{
    exists: boolean;
    related: ResearchRecord[];
    suggestion?: string;
  }> {
    if (!this.db) await this.initialize();

    // Check for exact or very similar queries
    const exact = this.db!.prepare(`
      SELECT * FROM research_tasks
      WHERE query = ? OR query LIKE ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(query, `%${query}%`) as ResearchRecord | undefined;

    if (exact) {
      return {
        exists: true,
        related: [exact],
        suggestion: `Already researched "${exact.query}" on ${exact.createdAt}. Use findRelatedResearch() to get details.`
      };
    }

    // Check for related research
    const related = await this.findRelatedResearch(query, 3);

    if (related.length > 0) {
      return {
        exists: false,
        related,
        suggestion: `Found ${related.length} related research tasks. Consider reviewing before new research.`
      };
    }

    return { exists: false, related: [] };
  }

  /**
   * Get research statistics
   */
  async getStats(): Promise<{
    totalResearch: number;
    totalSources: number;
    totalTopics: number;
    avgConfidence: number;
    byDepth: Record<string, number>;
  }> {
    if (!this.db) await this.initialize();

    const totalResearch = (this.db!.prepare('SELECT COUNT(*) as count FROM research_tasks').get() as { count: number }).count;
    const totalSources = (this.db!.prepare('SELECT COUNT(*) as count FROM research_sources').get() as { count: number }).count;
    const totalTopics = (this.db!.prepare('SELECT COUNT(*) as count FROM knowledge_topics').get() as { count: number }).count;
    const avgConfidence = (this.db!.prepare('SELECT AVG(confidence) as avg FROM research_tasks').get() as { avg: number | null }).avg || 0;

    const byDepthRows = this.db!.prepare(`
      SELECT depth, COUNT(*) as count
      FROM research_tasks
      GROUP BY depth
    `).all() as { depth: string; count: number }[];

    const byDepth: Record<string, number> = {};
    for (const row of byDepthRows) {
      byDepth[row.depth] = row.count;
    }

    return { totalResearch, totalSources, totalTopics, avgConfidence, byDepth };
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

// Singleton instance
let memoryInstance: MemoryIntegration | null = null;

export function getMemoryIntegration(): MemoryIntegration {
  if (!memoryInstance) {
    memoryInstance = new MemoryIntegration();
  }
  return memoryInstance;
}
