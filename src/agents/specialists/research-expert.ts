/**
 * Research Expert Specialist Agent
 *
 * Expert at finding academic, encyclopedic, and reference information.
 * Tools: Wikipedia, ArXiv
 */

import {
  BaseSpecialistAgent,
  fetchWithTimeout,
  safeParseJson,
  type SearchResult,
} from './base.js';

export class ResearchExpertAgent extends BaseSpecialistAgent {
  readonly name = 'ResearchExpert';
  readonly domain = 'research';
  readonly description = 'Academic and reference search using Wikipedia and ArXiv';

  constructor() {
    super();
    this.initializeTools();
  }

  private initializeTools(): void {
    // Wikipedia
    this.registerTool({
      name: 'wikipedia',
      description: 'Wikipedia - encyclopedic knowledge and concepts',
      search: this.searchWikipedia.bind(this),
    });

    // ArXiv
    this.registerTool({
      name: 'arxiv',
      description: 'ArXiv - academic papers in CS, Math, Physics, ML',
      search: this.searchArxiv.bind(this),
    });
  }

  /**
   * Search Wikipedia
   */
  private async searchWikipedia(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('https://en.wikipedia.org/w/api.php');
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srlimit', String(maxResults));
    url.searchParams.set('format', 'json');
    url.searchParams.set('origin', '*');

    const response = await fetchWithTimeout(url.toString(), {}, 10000);

    if (!response.ok) return [];

    interface WikipediaResponse {
      query?: {
        search?: Array<{
          title: string;
          pageid: number;
          snippet: string;
          wordcount: number;
        }>;
      };
    }

    const data = await safeParseJson<WikipediaResponse>(response);
    if (!data?.query?.search) return [];

    return data.query.search.map((item, i) => ({
      title: item.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: item.snippet.replace(/<[^>]*>/g, ''), // Strip HTML
      source: 'wikipedia',
      relevance: 1 - (i * 0.05),
      metadata: {
        pageId: item.pageid,
        wordCount: item.wordcount,
      },
    }));
  }

  /**
   * Search ArXiv
   */
  private async searchArxiv(query: string, maxResults: number): Promise<SearchResult[]> {
    // ArXiv API returns Atom XML - we'll parse the essentials
    const url = new URL('http://export.arxiv.org/api/query');
    url.searchParams.set('search_query', `all:${query}`);
    url.searchParams.set('start', '0');
    url.searchParams.set('max_results', String(maxResults));
    url.searchParams.set('sortBy', 'relevance');

    const response = await fetchWithTimeout(url.toString(), {}, 15000);

    if (!response.ok) return [];

    const text = await response.text();
    return this.parseArxivXml(text);
  }

  /**
   * Parse ArXiv Atom XML response
   */
  private parseArxivXml(xml: string): SearchResult[] {
    const results: SearchResult[] = [];

    // Simple regex-based parsing for ArXiv entries
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    const titleRegex = /<title>([\s\S]*?)<\/title>/;
    const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
    const idRegex = /<id>([\s\S]*?)<\/id>/;
    const publishedRegex = /<published>([\s\S]*?)<\/published>/;

    let match;
    let position = 0;

    while ((match = entryRegex.exec(xml)) !== null) {
      const entry = match[1];

      const titleMatch = entry.match(titleRegex);
      const summaryMatch = entry.match(summaryRegex);
      const idMatch = entry.match(idRegex);
      const publishedMatch = entry.match(publishedRegex);

      if (titleMatch && idMatch) {
        // Extract authors
        const authors: string[] = [];
        let authorMatch;
        const authorRegexLocal = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g;
        while ((authorMatch = authorRegexLocal.exec(entry)) !== null) {
          authors.push(authorMatch[1].trim());
          if (authors.length >= 3) break;
        }

        // Extract categories
        const categories: string[] = [];
        let catMatch;
        const catRegexLocal = /<category[^>]*term="([^"]+)"/g;
        while ((catMatch = catRegexLocal.exec(entry)) !== null) {
          categories.push(catMatch[1]);
        }

        const title = titleMatch[1].replace(/\s+/g, ' ').trim();
        const summary = summaryMatch
          ? summaryMatch[1].replace(/\s+/g, ' ').trim().slice(0, 400)
          : '';
        const arxivId = idMatch[1].trim();
        const url = arxivId.startsWith('http') ? arxivId : `https://arxiv.org/abs/${arxivId.split('/').pop()}`;
        const published = publishedMatch ? publishedMatch[1].trim().split('T')[0] : undefined;

        results.push({
          title,
          url,
          snippet: summary || `By ${authors.slice(0, 3).join(', ')}`,
          source: 'arxiv',
          relevance: 1 - (position * 0.05),
          metadata: {
            arxivId,
            authors,
            published,
            categories: categories.slice(0, 3),
          },
        });

        position++;
      }
    }

    return results;
  }
}
