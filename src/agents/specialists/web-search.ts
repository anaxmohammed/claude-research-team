/**
 * Web Search Specialist Agent
 *
 * Expert at general web search using multiple search engines.
 * Tools: Serper, Brave, Tavily, DuckDuckGo
 */

import {
  BaseSpecialistAgent,
  fetchWithTimeout,
  safeParseJson,
  type SearchResult,
} from './base.js';

export class WebSearchAgent extends BaseSpecialistAgent {
  readonly name = 'WebSearch';
  readonly domain = 'web';
  readonly description = 'General web search using Serper, Brave, Tavily, and DuckDuckGo search engines';

  constructor() {
    super();
    this.initializeTools();
  }

  private initializeTools(): void {
    // Serper (Google Search)
    this.registerTool({
      name: 'serper',
      description: 'Google Search via Serper API - most comprehensive web results',
      requiresApiKey: 'SERPER_API_KEY',
      search: this.searchSerper.bind(this),
    });

    // Brave Search
    this.registerTool({
      name: 'brave',
      description: 'Brave Search - privacy-focused web search',
      requiresApiKey: 'BRAVE_API_KEY',
      search: this.searchBrave.bind(this),
    });

    // Tavily
    this.registerTool({
      name: 'tavily',
      description: 'Tavily - AI-optimized search engine',
      requiresApiKey: 'TAVILY_API_KEY',
      search: this.searchTavily.bind(this),
    });

    // DuckDuckGo (free, no API key required)
    this.registerTool({
      name: 'duckduckgo',
      description: 'DuckDuckGo - privacy-focused search (free, no API key)',
      search: this.searchDuckDuckGo.bind(this),
    });
  }

  /**
   * Search using Serper (Google)
   */
  private async searchSerper(query: string, maxResults: number): Promise<SearchResult[]> {
    const response = await fetchWithTimeout(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: query, num: maxResults }),
      },
      10000
    );

    if (!response.ok) {
      throw new Error(`Serper API error: ${response.status}`);
    }

    interface SerperResponse {
      organic?: Array<{
        title: string;
        link: string;
        snippet: string;
        position?: number;
      }>;
      answerBox?: {
        title?: string;
        answer?: string;
        snippet?: string;
      };
      knowledgeGraph?: {
        title?: string;
        description?: string;
      };
    }

    const data = await safeParseJson<SerperResponse>(response);
    if (!data) return [];

    const results: SearchResult[] = [];

    // Add answer box if present
    if (data.answerBox?.answer || data.answerBox?.snippet) {
      results.push({
        title: data.answerBox.title || 'Direct Answer',
        url: 'https://google.com',
        snippet: data.answerBox.answer || data.answerBox.snippet || '',
        source: 'serper:answer_box',
        relevance: 1.0,
      });
    }

    // Add organic results
    if (data.organic) {
      for (const item of data.organic) {
        results.push({
          title: item.title,
          url: item.link,
          snippet: item.snippet,
          source: 'serper',
          relevance: item.position ? 1 - (item.position * 0.05) : 0.8,
        });
      }
    }

    return results.slice(0, maxResults);
  }

  /**
   * Search using Brave
   */
  private async searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));

    const response = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          'X-Subscription-Token': process.env.BRAVE_API_KEY!,
          'Accept': 'application/json',
        },
      },
      10000
    );

    if (!response.ok) {
      throw new Error(`Brave API error: ${response.status}`);
    }

    interface BraveResponse {
      web?: {
        results?: Array<{
          title: string;
          url: string;
          description: string;
          age?: string;
        }>;
      };
      query?: {
        spellcheck_off?: boolean;
        altered_query?: string;
      };
    }

    const data = await safeParseJson<BraveResponse>(response);
    if (!data?.web?.results) return [];

    return data.web.results.map((item, i) => ({
      title: item.title,
      url: item.url,
      snippet: item.description,
      source: 'brave',
      relevance: 1 - (i * 0.05),
      metadata: item.age ? { age: item.age } : undefined,
    }));
  }

  /**
   * Search using Tavily
   */
  private async searchTavily(query: string, maxResults: number): Promise<SearchResult[]> {
    const response = await fetchWithTimeout(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          max_results: maxResults,
          search_depth: 'basic',
          include_answer: true,
        }),
      },
      10000
    );

    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status}`);
    }

    interface TavilyResponse {
      answer?: string;
      results?: Array<{
        title: string;
        url: string;
        content: string;
        score: number;
      }>;
    }

    const data = await safeParseJson<TavilyResponse>(response);
    if (!data) return [];

    const results: SearchResult[] = [];

    // Add direct answer if available
    if (data.answer) {
      results.push({
        title: 'AI-Generated Answer',
        url: 'https://tavily.com',
        snippet: data.answer,
        source: 'tavily:answer',
        relevance: 1.0,
      });
    }

    // Add search results
    if (data.results) {
      for (const item of data.results) {
        results.push({
          title: item.title,
          url: item.url,
          snippet: item.content,
          source: 'tavily',
          relevance: item.score || 0.8,
        });
      }
    }

    return results.slice(0, maxResults);
  }

  /**
   * Search using DuckDuckGo (free, no API key)
   * Uses the HTML search page and parses results
   */
  private async searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
    // DuckDuckGo HTML search - we'll use their lite version for easier parsing
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);

    const response = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ResearchBot/1.0)',
          'Accept': 'text/html',
        },
      },
      10000
    );

    if (!response.ok) {
      throw new Error(`DuckDuckGo error: ${response.status}`);
    }

    const html = await response.text();
    const results: SearchResult[] = [];

    // Parse results from HTML - DuckDuckGo lite has a simpler structure
    // Results are in <a class="result__a"> tags with snippets in <a class="result__snippet">
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]*)<\/a>/gi;

    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const [, url, title, snippet] = match;
      if (url && title && !url.includes('duckduckgo.com')) {
        results.push({
          title: this.decodeHtmlEntities(title.trim()),
          url: url,
          snippet: this.decodeHtmlEntities(snippet.trim()),
          source: 'duckduckgo',
          relevance: 1 - (results.length * 0.05),
        });
      }
    }

    // Fallback: try alternate regex pattern if first didn't match
    if (results.length === 0) {
      const altRegex = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
      while ((match = altRegex.exec(html)) !== null && results.length < maxResults) {
        const [, url, title] = match;
        if (url && title && url.startsWith('http') && !url.includes('duckduckgo.com')) {
          results.push({
            title: this.decodeHtmlEntities(title.trim()),
            url: url,
            snippet: '',
            source: 'duckduckgo',
            relevance: 1 - (results.length * 0.05),
          });
        }
      }
    }

    return results;
  }

  /**
   * Decode HTML entities
   */
  private decodeHtmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }
}
