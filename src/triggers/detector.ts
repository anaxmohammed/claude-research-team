/**
 * Trigger Detector
 * Analyzes user prompts and tool outputs to detect research opportunities
 */

import type { ResearchDepth } from '../types.js';
import { Logger } from '../utils/logger.js';

export interface DetectedTrigger {
  shouldResearch: boolean;
  query?: string;
  depth: ResearchDepth;
  priority: number;
  confidence: number;
  reason: string;
}

interface PatternRule {
  pattern: RegExp;
  weight: number;
  depth: ResearchDepth;
  extractQuery?: (match: RegExpMatchArray, input: string) => string;
}

export class TriggerDetector {
  private logger: Logger;

  // Patterns that suggest research would be helpful
  private questionPatterns: PatternRule[] = [
    // Direct questions about technologies
    {
      pattern: /what\s+(?:is|are)\s+(.+?)(?:\?|$)/i,
      weight: 0.7,
      depth: 'quick',
      extractQuery: (match) => match[1],
    },
    {
      pattern: /how\s+(?:do|does|can|should)\s+(?:i|we|you)\s+(.+?)(?:\?|$)/i,
      weight: 0.8,
      depth: 'medium',
      extractQuery: (match) => match[1],
    },
    {
      pattern: /(?:what(?:'s| is) the )?best\s+(?:way|approach|practice|method)\s+(?:to|for)\s+(.+?)(?:\?|$)/i,
      weight: 0.9,
      depth: 'medium',
      extractQuery: (match) => `best practices ${match[1]}`,
    },
    // Comparison questions
    {
      pattern: /(.+?)\s+(?:vs|versus|or|compared to)\s+(.+?)(?:\?|$)/i,
      weight: 0.85,
      depth: 'deep',
      extractQuery: (match) => `${match[1]} vs ${match[2]}`,
    },
    // Error/debugging patterns
    {
      pattern: /(?:getting|seeing|have|having|got)\s+(?:an?\s+)?error[:\s]+(.+)/i,
      weight: 0.75,
      depth: 'medium',
      extractQuery: (match) => `fix error ${match[1]}`,
    },
    // Implementation questions
    {
      pattern: /how\s+(?:to\s+)?implement\s+(.+?)(?:\?|$)/i,
      weight: 0.85,
      depth: 'medium',
      extractQuery: (match) => `implement ${match[1]}`,
    },
    // Documentation/tutorial requests
    {
      pattern: /(?:show|find|get)\s+(?:me\s+)?(?:the\s+)?(?:docs?|documentation|tutorial|guide)\s+(?:for|on|about)\s+(.+)/i,
      weight: 0.9,
      depth: 'medium',
      extractQuery: (match) => `${match[1]} documentation`,
    },
    // "Why" questions
    {
      pattern: /why\s+(?:is|does|do|should|would)\s+(.+?)(?:\?|$)/i,
      weight: 0.7,
      depth: 'medium',
      extractQuery: (match) => `why ${match[1]}`,
    },
    // Latest/current information
    {
      pattern: /(?:what(?:'s| is) the\s+)?(?:latest|newest|current|recent)\s+(.+)/i,
      weight: 0.95,
      depth: 'quick',
      extractQuery: (match) => `latest ${match[1]} 2024`,
    },
  ];

  // Patterns that suggest user already has information
  private negativePatterns: RegExp[] = [
    /^(?:ok|okay|yes|no|thanks|thank you|got it|understood)/i,
    /^(?:please\s+)?(?:do|make|create|write|build|implement|add|remove|delete|update|fix)\s/i,
    /^(?:here(?:'s| is)|look at|check|see|read)\s/i,
    /^commit|^push|^pull|^merge|^deploy/i,
  ];

  // Tool outputs that might trigger research
  private toolTriggers: Map<string, (output: string) => DetectedTrigger | null> = new Map([
    ['Read', this.analyzeReadOutput.bind(this)],
    ['Grep', this.analyzeGrepOutput.bind(this)],
    ['Glob', this.analyzeGlobOutput.bind(this)],
    ['Bash', this.analyzeBashOutput.bind(this)],
  ]);

  constructor() {
    this.logger = new Logger('TriggerDetector');
  }

  /**
   * Analyze a user prompt for research triggers
   */
  analyzePrompt(prompt: string): DetectedTrigger {
    const trimmed = prompt.trim();

    // Check negative patterns first
    for (const pattern of this.negativePatterns) {
      if (pattern.test(trimmed)) {
        return {
          shouldResearch: false,
          depth: 'quick',
          priority: 0,
          confidence: 0,
          reason: 'Matches negative pattern (not a question)',
        };
      }
    }

    // Check if it's too short
    if (trimmed.length < 10) {
      return {
        shouldResearch: false,
        depth: 'quick',
        priority: 0,
        confidence: 0,
        reason: 'Prompt too short',
      };
    }

    // Check question patterns
    let bestMatch: DetectedTrigger | null = null;

    for (const rule of this.questionPatterns) {
      const match = trimmed.match(rule.pattern);
      if (match) {
        const query = rule.extractQuery
          ? rule.extractQuery(match, trimmed)
          : trimmed;

        const trigger: DetectedTrigger = {
          shouldResearch: true,
          query: this.cleanQuery(query),
          depth: rule.depth,
          priority: Math.round(rule.weight * 10),
          confidence: rule.weight,
          reason: `Matches pattern: ${rule.pattern.source.slice(0, 30)}...`,
        };

        if (!bestMatch || trigger.confidence > bestMatch.confidence) {
          bestMatch = trigger;
        }
      }
    }

    if (bestMatch) {
      this.logger.debug('Detected research trigger', bestMatch);
      return bestMatch;
    }

    // Check for question marks (generic questions)
    if (trimmed.includes('?')) {
      return {
        shouldResearch: true,
        query: this.cleanQuery(trimmed.replace(/\?/g, '')),
        depth: 'quick',
        priority: 5,
        confidence: 0.5,
        reason: 'Contains question mark',
      };
    }

    return {
      shouldResearch: false,
      depth: 'quick',
      priority: 0,
      confidence: 0,
      reason: 'No research triggers detected',
    };
  }

  /**
   * Analyze tool output for research triggers
   */
  analyzeToolOutput(toolName: string, output: string): DetectedTrigger | null {
    const analyzer = this.toolTriggers.get(toolName);
    if (analyzer) {
      return analyzer(output);
    }
    return null;
  }

  /**
   * Analyze Read tool output
   */
  private analyzeReadOutput(output: string): DetectedTrigger | null {
    // Look for TODOs or FIXMEs that might need research
    const todoMatch = output.match(/(?:TODO|FIXME|HACK|XXX)[:\s]+(.+)/i);
    if (todoMatch) {
      return {
        shouldResearch: true,
        query: `how to ${todoMatch[1].trim()}`,
        depth: 'quick',
        priority: 4,
        confidence: 0.4,
        reason: 'Found TODO/FIXME comment',
      };
    }

    // Look for deprecated warnings
    if (output.includes('@deprecated') || output.includes('DEPRECATED')) {
      const depMatch = output.match(/@deprecated[:\s]+(.+)|DEPRECATED[:\s]+(.+)/i);
      if (depMatch) {
        return {
          shouldResearch: true,
          query: `alternative to ${(depMatch[1] || depMatch[2]).trim()}`,
          depth: 'quick',
          priority: 5,
          confidence: 0.5,
          reason: 'Found deprecation notice',
        };
      }
    }

    return null;
  }

  /**
   * Analyze Grep tool output
   */
  private analyzeGrepOutput(output: string): DetectedTrigger | null {
    // If grep returns no results for what seems like a common pattern
    if (output.includes('No matches found') || output.trim() === '') {
      return null; // No automatic research for empty grep
    }
    return null;
  }

  /**
   * Analyze Glob tool output
   */
  private analyzeGlobOutput(_output: string): DetectedTrigger | null {
    // Glob results typically don't need research
    return null;
  }

  /**
   * Analyze Bash tool output for errors
   */
  private analyzeBashOutput(output: string): DetectedTrigger | null {
    const errorPatterns = [
      // npm/node errors
      {
        pattern: /npm ERR! code (.+)/,
        extract: (m: RegExpMatchArray) => `npm error ${m[1]}`,
      },
      {
        pattern: /Error: Cannot find module ['"](.+)['"]/,
        extract: (m: RegExpMatchArray) => `cannot find module ${m[1]}`,
      },
      // Python errors
      {
        pattern: /ModuleNotFoundError: No module named ['"](.+)['"]/,
        extract: (m: RegExpMatchArray) => `python install ${m[1]}`,
      },
      {
        pattern: /ImportError: (.+)/,
        extract: (m: RegExpMatchArray) => `python import error ${m[1]}`,
      },
      // Generic errors
      {
        pattern: /error: (.{10,80})/i,
        extract: (m: RegExpMatchArray) => `fix error ${m[1]}`,
      },
      // Permission errors
      {
        pattern: /permission denied/i,
        extract: () => 'fix permission denied error',
      },
      // Connection errors
      {
        pattern: /ECONNREFUSED|connection refused/i,
        extract: () => 'connection refused error troubleshooting',
      },
    ];

    for (const { pattern, extract } of errorPatterns) {
      const match = output.match(pattern);
      if (match) {
        return {
          shouldResearch: true,
          query: extract(match),
          depth: 'medium',
          priority: 6,
          confidence: 0.6,
          reason: `Detected error pattern: ${pattern.source.slice(0, 30)}`,
        };
      }
    }

    return null;
  }

  /**
   * Clean up an extracted query
   */
  private cleanQuery(query: string): string {
    return query
      .trim()
      .replace(/['"]/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 200); // Limit length
  }

  /**
   * Check if a topic has been researched recently
   * (Helps avoid duplicate research)
   */
  isRecentlyResearched(_query: string, _recentQueries: string[]): boolean {
    // Implementation would check against recent research tasks
    // For now, return false to allow all research
    return false;
  }
}
