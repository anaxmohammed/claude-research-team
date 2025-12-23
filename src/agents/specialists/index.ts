/**
 * Specialist Agents Index
 *
 * Re-exports all specialist agents for easy importing.
 *
 * Agent Structure:
 * - WebSearch: General internet search (Serper, Brave, Tavily, DuckDuckGo)
 * - CodeExpert: Code examples and implementations (GitHub, StackOverflow)
 * - DocsExpert: Library documentation (Context7, npm, PyPI, crates.io, MDN, Dev.to)
 * - CommunityExpert: Discussions and opinions (HackerNews, Reddit, Twitter)
 * - ResearchExpert: Academic and reference (Wikipedia, ArXiv)
 */

export * from './base.js';
export * from './web-search.js';
export * from './code-expert.js';
export * from './docs-expert.js';
export * from './community-expert.js';
export * from './research-expert.js';
export * from './meta-evaluator.js';
export * from './source-assessor.js';

import { WebSearchAgent } from './web-search.js';
import { CodeExpertAgent } from './code-expert.js';
import { DocsExpertAgent } from './docs-expert.js';
import { CommunityExpertAgent } from './community-expert.js';
import { ResearchExpertAgent } from './research-expert.js';
import type { BaseSpecialistAgent } from './base.js';

// Also export evaluation agents (these don't extend BaseSpecialistAgent)
export { MetaEvaluatorAgent, getMetaEvaluator } from './meta-evaluator.js';
export { SourceAssessorAgent, getSourceAssessor } from './source-assessor.js';

/**
 * Get all specialist agent instances
 */
export function createAllSpecialists(): Map<string, BaseSpecialistAgent> {
  const map = new Map<string, BaseSpecialistAgent>();
  map.set('web', new WebSearchAgent());
  map.set('code', new CodeExpertAgent());
  map.set('docs', new DocsExpertAgent());
  map.set('community', new CommunityExpertAgent());
  map.set('research', new ResearchExpertAgent());
  return map;
}

/**
 * Get operational specialists (those with at least one tool available)
 */
export function getOperationalSpecialists(): Map<string, BaseSpecialistAgent> {
  const all = createAllSpecialists();
  const operational = new Map<string, BaseSpecialistAgent>();

  for (const [key, specialist] of all) {
    if (specialist.isOperational()) {
      operational.set(key, specialist);
    }
  }

  return operational;
}
