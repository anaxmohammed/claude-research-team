/**
 * Claude-Mem Sync
 * Optional integration to sync research findings to claude-mem
 *
 * When enabled, completed research tasks can be stored as observations
 * in claude-mem, making them available across sessions.
 */

import type { ResearchTask, ResearchResult } from '../types.js';
import { Logger } from '../utils/logger.js';

const DEFAULT_CLAUDE_MEM_URL = 'http://localhost:37777';

interface ClaudeMemObservation {
  type: 'discovery' | 'feature' | 'change' | 'bugfix' | 'refactor' | 'decision';
  title: string;
  content: string;
  context?: {
    file?: string;
    sessionId?: string;
  };
  tags?: string[];
}

interface ClaudeMemResponse {
  success: boolean;
  id?: string;
  error?: string;
}

export class ClaudeMemSync {
  private logger: Logger;
  private baseUrl: string;
  private enabled: boolean;

  constructor(options: { enabled?: boolean; url?: string } = {}) {
    this.logger = new Logger('ClaudeMemSync');
    this.enabled = options.enabled ?? false;
    this.baseUrl = options.url || DEFAULT_CLAUDE_MEM_URL;
  }

  /**
   * Check if claude-mem service is available
   */
  async isAvailable(): Promise<boolean> {
    if (!this.enabled) return false;

    try {
      const response = await fetch(`${this.baseUrl}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Enable sync
   */
  enable(url?: string): void {
    this.enabled = true;
    if (url) this.baseUrl = url;
    this.logger.info('Claude-mem sync enabled', { url: this.baseUrl });
  }

  /**
   * Disable sync
   */
  disable(): void {
    this.enabled = false;
    this.logger.info('Claude-mem sync disabled');
  }

  /**
   * Sync a completed research task to claude-mem
   */
  async syncResearchTask(task: ResearchTask): Promise<boolean> {
    if (!this.enabled) return false;
    if (!task.result) return false;

    try {
      const observation = this.taskToObservation(task);
      const response = await this.createObservation(observation);

      if (response.success) {
        this.logger.info('Research synced to claude-mem', {
          taskId: task.id,
          observationId: response.id,
        });
        return true;
      } else {
        this.logger.warn('Failed to sync to claude-mem', { error: response.error });
        return false;
      }
    } catch (error) {
      this.logger.error('Claude-mem sync error', error);
      return false;
    }
  }

  /**
   * Convert research task to claude-mem observation format
   */
  private taskToObservation(task: ResearchTask): ClaudeMemObservation {
    const result = task.result!;

    // Build content with proper formatting
    const contentParts: string[] = [];

    contentParts.push(`Research query: "${task.query}"`);
    contentParts.push('');
    contentParts.push('## Summary');
    contentParts.push(result.summary);

    if (result.sources.length > 0) {
      contentParts.push('');
      contentParts.push('## Sources');
      for (const source of result.sources.slice(0, 5)) {
        contentParts.push(`- [${source.title}](${source.url})`);
      }
    }

    // Generate a concise title
    const title = this.generateTitle(task.query, result);

    return {
      type: 'discovery',
      title,
      content: contentParts.join('\n'),
      context: {
        sessionId: task.sessionId,
      },
      tags: ['research', 'auto-generated', task.depth],
    };
  }

  /**
   * Generate a concise title for the observation
   */
  private generateTitle(query: string, _result: ResearchResult): string {
    // Try to extract a meaningful title from the query or summary
    const cleanQuery = query.trim().replace(/\?$/, '');

    // If query is short enough, use it
    if (cleanQuery.length <= 60) {
      return `Research: ${cleanQuery}`;
    }

    // Otherwise, truncate intelligently
    const words = cleanQuery.split(' ');
    let title = '';
    for (const word of words) {
      if ((title + ' ' + word).length > 55) break;
      title += (title ? ' ' : '') + word;
    }

    return `Research: ${title}...`;
  }

  /**
   * Create an observation in claude-mem
   */
  private async createObservation(observation: ClaudeMemObservation): Promise<ClaudeMemResponse> {
    const response = await fetch(`${this.baseUrl}/api/sessions/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(observation),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as { id: string };
    return { success: true, id: data.id };
  }

  /**
   * Search claude-mem for related research
   * Can be used to avoid duplicate research
   */
  async searchRelated(query: string, limit: number = 5): Promise<string[]> {
    if (!this.enabled) return [];

    try {
      const response = await fetch(
        `${this.baseUrl}/api/search/observations?query=${encodeURIComponent(query)}&limit=${limit}`,
        { signal: AbortSignal.timeout(3000) }
      );

      if (!response.ok) return [];

      const data = (await response.json()) as { observations: Array<{ title: string }> };
      return data.observations.map((o) => o.title);
    } catch {
      return [];
    }
  }
}

// Singleton instance
let instance: ClaudeMemSync | null = null;

export function getClaudeMemSync(): ClaudeMemSync {
  if (!instance) {
    instance = new ClaudeMemSync();
  }
  return instance;
}
