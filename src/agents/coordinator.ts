/**
 * Coordinator Agent
 *
 * Orchestrates specialist agents, decides research depth and direction.
 * Uses Claude Haiku for efficient decision-making (~300 tokens per iteration).
 *
 * Key responsibilities:
 * - Plan initial research approach based on directive
 * - Dispatch work to appropriate specialists
 * - Evaluate findings and decide: go deeper, pivot, or done
 * - Synthesize final results
 * - Detect when alternative approaches might be better (creative thinking)
 */

import { Logger } from '../utils/logger.js';
import { queryAI } from '../ai/provider.js';
import type { Finding, BaseSpecialistAgent } from './specialists/base.js';
import type { QuickProjectContext } from '../context/project-context.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Research directive from the watcher or manual call
 */
export interface ResearchDirective {
  query: string;
  context?: string;
  priorKnowledge?: PriorKnowledge[];
  maxIterations?: number;
  sessionId?: string;
  projectPath?: string;
  projectContext?: QuickProjectContext;  // Cached project analysis
}

/**
 * Prior knowledge from memory
 */
export interface PriorKnowledge {
  query: string;
  summary: string;
  confidence: number;
  age: number; // ms since research
}

/**
 * Coordinator's research plan
 */
export interface ResearchPlan {
  strategy: string;
  nextSteps: PlannedStep[];
  rationale: string;
}

/**
 * A planned step for specialists
 */
export interface PlannedStep {
  specialist: 'web' | 'code' | 'docs' | 'community' | 'research';
  query: string;
  priority: number;
  rationale?: string;
}

/**
 * Coordinator's evaluation of findings
 */
export interface Evaluation {
  complete: boolean;
  confidence: number;
  nextSteps: PlannedStep[];
  pivot?: PivotSuggestion;
  synthesis?: string;
  reasoning: string;
}

/**
 * Suggestion for an alternative approach
 */
export interface PivotSuggestion {
  alternative: string;
  reason: string;
  urgency: 'low' | 'medium' | 'high';
}

/**
 * Final synthesized result
 */
export interface SynthesizedResult {
  summary: string;
  keyFindings: string[];
  confidence: number;
  pivot?: PivotSuggestion;
  totalFindings: number;
  totalSources: number;
}

// ============================================================================
// Coordinator Agent
// ============================================================================

export class CoordinatorAgent {
  private logger: Logger;

  // Configuration
  private readonly COMPLETION_THRESHOLD = 0.85;
  // Reserved for future rate limiting
  // private readonly MAX_CLAUDE_CALLS = 3;

  constructor() {
    this.logger = new Logger('Coordinator');
  }

  /**
   * Plan the initial research approach
   */
  async plan(
    directive: ResearchDirective,
    priorKnowledge: PriorKnowledge[] = []
  ): Promise<ResearchPlan> {
    this.logger.info(`Planning research: "${directive.query}"`);

    const prompt = this.buildPlanPrompt(directive, priorKnowledge);

    try {
      const response = await this.callClaude(prompt);
      const plan = this.parsePlanResponse(response, directive.query);

      this.logger.debug('Research plan created', {
        steps: plan.nextSteps.length,
        strategy: plan.strategy,
      });

      return plan;
    } catch (error) {
      this.logger.error('Plan generation failed, using fallback', error);
      return this.createFallbackPlan(directive.query);
    }
  }

  /**
   * Evaluate current findings and decide next steps
   */
  async evaluate(
    directive: ResearchDirective,
    findings: Finding[]
  ): Promise<Evaluation> {
    this.logger.info(`Evaluating ${findings.length} findings`);

    // Quick check: if we have solid findings, we might be done
    if (findings.length > 0) {
      const avgRelevance = this.calculateAverageRelevance(findings);
      if (avgRelevance > this.COMPLETION_THRESHOLD && findings.length >= 2) {
        this.logger.debug('High confidence early exit');
        return {
          complete: true,
          confidence: avgRelevance,
          nextSteps: [],
          reasoning: 'High confidence findings from multiple specialists',
        };
      }
    }

    const prompt = this.buildEvaluationPrompt(directive, findings);

    try {
      const response = await this.callClaude(prompt);
      const evaluation = this.parseEvaluationResponse(response);

      this.logger.debug('Evaluation complete', {
        complete: evaluation.complete,
        confidence: evaluation.confidence,
        nextSteps: evaluation.nextSteps.length,
        hasPivot: !!evaluation.pivot,
      });

      return evaluation;
    } catch (error) {
      this.logger.error('Evaluation failed, assuming done', error);
      return {
        complete: true,
        confidence: this.calculateAverageRelevance(findings),
        nextSteps: [],
        reasoning: 'Evaluation failed, returning collected findings',
      };
    }
  }

  /**
   * Synthesize final results from all findings
   */
  async synthesize(
    directive: ResearchDirective,
    findings: Finding[],
    pivot?: PivotSuggestion
  ): Promise<SynthesizedResult> {
    this.logger.info(`Synthesizing ${findings.length} findings`);

    if (findings.length === 0) {
      return this.createEmptySynthesis(directive.query);
    }

    const prompt = this.buildSynthesisPrompt(directive, findings, pivot);

    try {
      const response = await this.callClaude(prompt);
      const result = this.parseSynthesisResponse(response, findings, pivot);

      this.logger.debug('Synthesis complete', {
        confidence: result.confidence,
        findings: result.keyFindings.length,
        hasPivot: !!result.pivot,
      });

      return result;
    } catch (error) {
      this.logger.error('Synthesis failed, creating fallback', error);
      return this.createFallbackSynthesis(directive.query, findings, pivot);
    }
  }

  /**
   * Quick decision: which specialists should handle this query?
   *
   * Agent routing:
   * - DocsExpert: Library/framework questions, "how to use X"
   * - CodeExpert: Implementation examples, "show me code that does X"
   * - CommunityExpert: Opinions, comparisons, "what do people think of X"
   * - ResearchExpert: Concepts, definitions, "what is X"
   * - WebSearch: General fallback, current events, broad searches
   */
  selectSpecialists(
    query: string,
    availableSpecialists: Map<string, BaseSpecialistAgent>
  ): string[] {
    const queryLower = query.toLowerCase();
    const selected: string[] = [];

    // DocsExpert: Library/package documentation queries
    if (
      queryLower.match(/\b(documentation|docs|library|package|npm|pip|crates|cargo)\b/) ||
      queryLower.match(/\b(how to use|how do i|using|middleware|routing|configuration)\b/) ||
      queryLower.match(/\b(react|vue|angular|svelte|next|hono|express|fastify|django|flask)\b/)
    ) {
      if (availableSpecialists.has('docs')) selected.push('docs');
    }

    // CodeExpert: Code implementation queries
    if (
      queryLower.match(/\b(code|function|class|implement|example|snippet)\b/) ||
      queryLower.match(/\b(github|stackoverflow|bug|error|exception|debug)\b/) ||
      queryLower.match(/\b(show me|how to implement|code for)\b/)
    ) {
      if (availableSpecialists.has('code')) selected.push('code');
    }

    // CommunityExpert: Opinion/discussion queries
    if (
      queryLower.match(/\b(vs|versus|opinion|think|better|worth|should i|recommend)\b/) ||
      queryLower.match(/\b(hackernews|reddit|twitter|discussion|comparison)\b/) ||
      queryLower.match(/\b(experience|review|pros and cons|alternative)\b/)
    ) {
      if (availableSpecialists.has('community')) selected.push('community');
    }

    // ResearchExpert: Concept/definition queries
    if (
      queryLower.match(/\b(what is|explain|concept|theory|definition|history)\b/) ||
      queryLower.match(/\b(wikipedia|arxiv|paper|academic|research)\b/) ||
      queryLower.match(/\b(algorithm|protocol|standard|specification)\b/)
    ) {
      if (availableSpecialists.has('research')) selected.push('research');
    }

    // WebSearch: Fallback for general queries
    if (selected.length === 0 || queryLower.match(/\b(search|find|latest|news|current|recent)\b/)) {
      if (availableSpecialists.has('web')) selected.push('web');
    }

    // If still nothing, use docs + web as sensible defaults
    if (selected.length === 0) {
      if (availableSpecialists.has('docs')) selected.push('docs');
      if (availableSpecialists.has('web')) selected.push('web');
    }

    // Limit to 3 specialists max for efficiency
    return selected.slice(0, 3);
  }

  // ============================================================================
  // Private: AI Interaction
  // ============================================================================

  /**
   * Call AI using the configured provider (Claude or Gemini)
   */
  private async callClaude(prompt: string): Promise<string> {
    const result = await queryAI(prompt, {
      maxTokens: 1024,
      temperature: 0.3, // Lower temperature for more focused decisions
    });

    this.logger.debug(`AI response from ${result.provider}`, {
      model: result.model,
      tokensUsed: result.tokensUsed,
    });

    return result.content;
  }

  // ============================================================================
  // Private: Prompt Building
  // ============================================================================

  private buildPlanPrompt(
    directive: ResearchDirective,
    priorKnowledge: PriorKnowledge[]
  ): string {
    const parts: string[] = [];

    // Add current date context for time-aware research
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    parts.push('You are a research coordinator planning how to investigate a query.');
    parts.push('');
    parts.push(`**Current Date: ${dateStr}**`);
    parts.push('');
    parts.push('**CRITICAL: NEVER add years (2024, 2025, etc) to search queries.**');
    parts.push('BAD: "react native best practices 2024"');
    parts.push('GOOD: "react native best practices"');
    parts.push('Search engines handle recency automatically. Adding years pollutes results.');
    parts.push('');
    parts.push(`## Research Query`);
    parts.push(`"${directive.query}"`);

    if (directive.context) {
      parts.push('');
      parts.push(`## Additional Context`);
      parts.push(directive.context);
    }

    if (priorKnowledge.length > 0) {
      parts.push('');
      parts.push(`## Prior Knowledge (from previous research)`);
      for (const pk of priorKnowledge.slice(0, 3)) {
        const ageHours = Math.round(pk.age / 3600000);
        parts.push(`- "${pk.query}" (${ageHours}h ago, ${Math.round(pk.confidence * 100)}% conf): ${pk.summary.slice(0, 150)}...`);
      }
      parts.push('');
      parts.push('Build on this prior knowledge. Focus on NEW information not already covered.');
    }

    // Add project context if available
    if (directive.projectContext) {
      const ctx = directive.projectContext;
      parts.push('');
      parts.push(`## Project Context`);
      parts.push(`This research is for a **${ctx.projectType}** project${ctx.projectName ? ` named "${ctx.projectName}"` : ''}.`);
      if (ctx.framework) {
        parts.push(`- **Framework**: ${ctx.framework}`);
      }
      parts.push(`- **Language**: ${ctx.language}`);
      if (ctx.techStack.length > 0) {
        parts.push(`- **Tech Stack**: ${ctx.techStack.join(', ')}`);
      }
      parts.push('');
      parts.push('Prioritize information relevant to this tech stack. Consider project-specific best practices.');
    }

    parts.push('');
    parts.push(`## Available Specialists`);
    parts.push('- **docs**: Library documentation (Context7, npm, PyPI, crates.io, MDN) - "How do I use X?"');
    parts.push('- **code**: Code examples (GitHub, StackOverflow) - "Show me code that does X"');
    parts.push('- **community**: Discussions (HackerNews, Reddit, Twitter) - "What do people think of X?"');
    parts.push('- **research**: Academic/reference (Wikipedia, ArXiv) - "What is X?"');
    parts.push('- **web**: General search (Serper, Brave, Tavily) - Fallback for broad queries');

    parts.push('');
    parts.push(`## Your Task`);
    parts.push('Create a research plan. Decide which specialists should search and with what queries.');
    parts.push('');
    parts.push('**Creative Thinking Mandate:**');
    parts.push('Consider whether the query itself might be approaching the problem suboptimally.');
    parts.push('If a completely different approach might be better, note it in your strategy.');

    parts.push('');
    parts.push('Respond in this exact format:');
    parts.push('STRATEGY: <brief strategy description>');
    parts.push('RATIONALE: <why this approach>');
    parts.push('STEPS:');
    parts.push('- specialist:web query:"search query" priority:1');
    parts.push('- specialist:code query:"search query" priority:2');

    return parts.join('\n');
  }

  private buildEvaluationPrompt(directive: ResearchDirective, findings: Finding[]): string {
    const parts: string[] = [];

    parts.push('You are evaluating research progress and deciding next steps.');
    parts.push('');
    parts.push(`## Original Query`);
    parts.push(`"${directive.query}"`);

    parts.push('');
    parts.push(`## Findings So Far`);
    for (const finding of findings) {
      parts.push(`### From ${finding.specialist} (${finding.results.length} results)`);
      for (const result of finding.results.slice(0, 3)) {
        parts.push(`- **${result.title}**: ${result.snippet?.slice(0, 150)}...`);
      }
      parts.push('');
    }

    parts.push(`## Your Task`);
    parts.push('Evaluate: Do we have enough to answer confidently? Should we dig deeper? Pivot?');
    parts.push('');
    parts.push('**Creative Thinking Mandate:**');
    parts.push('Look for signs that the current approach has fundamental problems.');
    parts.push('If findings suggest a DIFFERENT solution would be better, flag it as a pivot.');
    parts.push('Don\'t just answer the question asked - consider what SHOULD have been asked.');

    parts.push('');
    parts.push('Respond in this exact format:');
    parts.push('COMPLETE: true/false');
    parts.push('CONFIDENCE: 0.0-1.0');
    parts.push('REASONING: <why>');
    parts.push('NEXT_STEPS: (if not complete)');
    parts.push('- specialist:web query:"query" priority:1');
    parts.push('PIVOT: (optional, if alternative approach detected)');
    parts.push('alternative: <description>');
    parts.push('reason: <why this might be better>');
    parts.push('urgency: low/medium/high');

    return parts.join('\n');
  }

  private buildSynthesisPrompt(
    directive: ResearchDirective,
    findings: Finding[],
    pivot?: PivotSuggestion
  ): string {
    const parts: string[] = [];

    // Add current date context
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    parts.push('Synthesize research findings into a concise, actionable summary.');
    parts.push('');
    parts.push(`**Current Date: ${dateStr}**`);
    parts.push('Prioritize recent information and note if any findings may be outdated.');
    parts.push('');
    parts.push(`## Original Query`);
    parts.push(`"${directive.query}"`);

    parts.push('');
    parts.push(`## All Findings`);
    for (const finding of findings) {
      parts.push(`### ${finding.specialist} Results`);
      for (const result of finding.results.slice(0, 5)) {
        parts.push(`- **${result.title}**`);
        parts.push(`  ${result.snippet?.slice(0, 200)}`);
        parts.push(`  URL: ${result.url}`);
      }

      // Include scraped content if available
      for (const scraped of finding.scraped.slice(0, 2)) {
        parts.push(`#### Detailed: ${scraped.title || scraped.url}`);
        parts.push(scraped.content.slice(0, 1000));
      }
      parts.push('');
    }

    if (pivot) {
      parts.push(`## Alternative Approach Detected`);
      parts.push(`Alternative: ${pivot.alternative}`);
      parts.push(`Reason: ${pivot.reason}`);
      parts.push(`Urgency: ${pivot.urgency}`);
      parts.push('');
      parts.push('Include this in your synthesis if it represents a better solution.');
    }

    parts.push(`## Your Task`);
    parts.push('Create a synthesis that:');
    parts.push('1. Directly answers the query with key insights');
    parts.push('2. Lists 5-8 key findings as bullet points');
    parts.push('3. Notes any caveats or alternative approaches');

    parts.push('');
    parts.push('Respond in this exact format:');
    parts.push('SUMMARY: <4-6 sentence summary answering the query>');
    parts.push('KEY_FINDINGS:');
    parts.push('- <finding 1>');
    parts.push('- <finding 2>');
    parts.push('CONFIDENCE: 0.0-1.0');

    return parts.join('\n');
  }

  // ============================================================================
  // Private: Response Parsing
  // ============================================================================

  private parsePlanResponse(response: string, originalQuery: string): ResearchPlan {
    const plan: ResearchPlan = {
      strategy: 'Multi-source research',
      nextSteps: [],
      rationale: 'Default approach',
    };

    // Extract strategy
    const strategyMatch = response.match(/STRATEGY:\s*(.+?)(?=RATIONALE:|STEPS:|$)/s);
    if (strategyMatch) {
      plan.strategy = strategyMatch[1].trim();
    }

    // Extract rationale
    const rationaleMatch = response.match(/RATIONALE:\s*(.+?)(?=STEPS:|$)/s);
    if (rationaleMatch) {
      plan.rationale = rationaleMatch[1].trim();
    }

    // Extract steps
    const stepsMatch = response.match(/STEPS:\s*([\s\S]+?)$/);
    if (stepsMatch) {
      const stepLines = stepsMatch[1].match(/specialist:(\w+)\s+query:"([^"]+)"\s+priority:(\d+)/g);
      if (stepLines) {
        for (const line of stepLines) {
          const match = line.match(/specialist:(\w+)\s+query:"([^"]+)"\s+priority:(\d+)/);
          if (match) {
            plan.nextSteps.push({
              specialist: match[1] as 'web' | 'code' | 'docs',
              query: match[2],
              priority: parseInt(match[3], 10),
            });
          }
        }
      }
    }

    // Ensure at least one step
    if (plan.nextSteps.length === 0) {
      plan.nextSteps = [
        { specialist: 'web', query: originalQuery, priority: 1 },
      ];
    }

    return plan;
  }

  private parseEvaluationResponse(response: string): Evaluation {
    const evaluation: Evaluation = {
      complete: false,
      confidence: 0.5,
      nextSteps: [],
      reasoning: 'Unable to parse evaluation',
    };

    // Extract complete
    const completeMatch = response.match(/COMPLETE:\s*(true|false)/i);
    if (completeMatch) {
      evaluation.complete = completeMatch[1].toLowerCase() === 'true';
    }

    // Extract confidence
    const confidenceMatch = response.match(/CONFIDENCE:\s*([\d.]+)/);
    if (confidenceMatch) {
      evaluation.confidence = Math.max(0, Math.min(1, parseFloat(confidenceMatch[1])));
    }

    // Extract reasoning
    const reasoningMatch = response.match(/REASONING:\s*(.+?)(?=NEXT_STEPS:|PIVOT:|$)/s);
    if (reasoningMatch) {
      evaluation.reasoning = reasoningMatch[1].trim();
    }

    // Extract next steps if not complete
    if (!evaluation.complete) {
      const stepsMatch = response.match(/NEXT_STEPS:\s*([\s\S]+?)(?=PIVOT:|$)/);
      if (stepsMatch) {
        const stepLines = stepsMatch[1].match(/specialist:(\w+)\s+query:"([^"]+)"\s+priority:(\d+)/g);
        if (stepLines) {
          for (const line of stepLines) {
            const match = line.match(/specialist:(\w+)\s+query:"([^"]+)"\s+priority:(\d+)/);
            if (match) {
              evaluation.nextSteps.push({
                specialist: match[1] as 'web' | 'code' | 'docs',
                query: match[2],
                priority: parseInt(match[3], 10),
              });
            }
          }
        }
      }
    }

    // Extract pivot if present
    const pivotMatch = response.match(/PIVOT:\s*([\s\S]+?)$/);
    if (pivotMatch) {
      const pivotText = pivotMatch[1];
      const altMatch = pivotText.match(/alternative:\s*(.+?)(?=reason:|urgency:|$)/is);
      const reasonMatch = pivotText.match(/reason:\s*(.+?)(?=urgency:|$)/is);
      const urgencyMatch = pivotText.match(/urgency:\s*(low|medium|high)/i);

      if (altMatch) {
        evaluation.pivot = {
          alternative: altMatch[1].trim(),
          reason: reasonMatch ? reasonMatch[1].trim() : 'Alternative approach detected',
          urgency: (urgencyMatch ? urgencyMatch[1].toLowerCase() : 'medium') as 'low' | 'medium' | 'high',
        };
      }
    }

    return evaluation;
  }

  private parseSynthesisResponse(
    response: string,
    findings: Finding[],
    pivot?: PivotSuggestion
  ): SynthesizedResult {
    const result: SynthesizedResult = {
      summary: '',
      keyFindings: [],
      confidence: 0.5,
      pivot,
      totalFindings: findings.length,
      totalSources: findings.reduce((sum, f) => sum + f.results.length, 0),
    };

    // Extract summary
    const summaryMatch = response.match(/SUMMARY:\s*(.+?)(?=KEY_FINDINGS:|CONFIDENCE:|$)/s);
    if (summaryMatch) {
      result.summary = summaryMatch[1].trim();
    }

    // Extract key findings
    const findingsMatch = response.match(/KEY_FINDINGS:\s*([\s\S]+?)(?=CONFIDENCE:|$)/);
    if (findingsMatch) {
      const bullets = findingsMatch[1].match(/^-\s*.+$/gm);
      if (bullets) {
        result.keyFindings = bullets.map(b => b.replace(/^-\s*/, '').trim());
      }
    }

    // Extract confidence
    const confidenceMatch = response.match(/CONFIDENCE:\s*([\d.]+)/);
    if (confidenceMatch) {
      result.confidence = Math.max(0, Math.min(1, parseFloat(confidenceMatch[1])));
    }

    return result;
  }

  // ============================================================================
  // Private: Helpers
  // ============================================================================

  private calculateAverageRelevance(findings: Finding[]): number {
    if (findings.length === 0) return 0;

    let totalRelevance = 0;
    let count = 0;

    for (const finding of findings) {
      for (const result of finding.results) {
        totalRelevance += result.relevance ?? 0.5;
        count++;
      }
    }

    return count > 0 ? totalRelevance / count : 0;
  }

  private createFallbackPlan(query: string): ResearchPlan {
    return {
      strategy: 'Broad multi-source search',
      rationale: 'Fallback plan using primary specialists',
      nextSteps: [
        { specialist: 'docs', query, priority: 1 },
        { specialist: 'code', query, priority: 2 },
        { specialist: 'web', query, priority: 3 },
      ],
    };
  }

  private createEmptySynthesis(query: string): SynthesizedResult {
    return {
      summary: `Unable to find relevant information for: "${query}"`,
      keyFindings: [],
      confidence: 0,
      totalFindings: 0,
      totalSources: 0,
    };
  }

  private createFallbackSynthesis(
    query: string,
    findings: Finding[],
    pivot?: PivotSuggestion
  ): SynthesizedResult {
    // Create a basic synthesis from findings
    const allResults = findings.flatMap(f => f.results);
    const topResults = allResults.slice(0, 5);

    const summary = topResults.length > 0
      ? `Research for "${query}" found ${allResults.length} results. Top findings: ${topResults.map(r => r.title).join(', ')}.`
      : `Limited results found for: "${query}"`;

    return {
      summary,
      keyFindings: topResults.map(r => `${r.title}: ${r.snippet?.slice(0, 100)}...`),
      confidence: this.calculateAverageRelevance(findings),
      pivot,
      totalFindings: findings.length,
      totalSources: allResults.length,
    };
  }
}
