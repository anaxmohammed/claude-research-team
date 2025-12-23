/**
 * Community Expert Specialist Agent
 *
 * Expert at finding community discussions, opinions, and real-world experiences.
 * Tools: HackerNews, Reddit, Twitter (via web search)
 */

import {
  BaseSpecialistAgent,
  fetchWithTimeout,
  safeParseJson,
  type SearchResult,
} from './base.js';

export class CommunityExpertAgent extends BaseSpecialistAgent {
  readonly name = 'CommunityExpert';
  readonly domain = 'community';
  readonly description = 'Community discussions using HackerNews, Reddit, and Twitter/X';

  constructor() {
    super();
    this.initializeTools();
  }

  private initializeTools(): void {
    // HackerNews (Algolia API - free)
    this.registerTool({
      name: 'hackernews',
      description: 'HackerNews - tech community discussions and launches',
      search: this.searchHackerNews.bind(this),
    });

    // Reddit (via old.reddit.com JSON API - free)
    this.registerTool({
      name: 'reddit',
      description: 'Reddit - community discussions and Q&A across subreddits',
      search: this.searchReddit.bind(this),
    });

    // Twitter/X via web search (no API needed)
    this.registerTool({
      name: 'twitter',
      description: 'Twitter/X - real-time discussions and announcements',
      requiresApiKey: 'SERPER_API_KEY',
      search: this.searchTwitter.bind(this),
    });

    // Twitter via Brave (alternative)
    this.registerTool({
      name: 'twitter_brave',
      description: 'Twitter/X via Brave Search',
      requiresApiKey: 'BRAVE_API_KEY',
      search: this.searchTwitterBrave.bind(this),
    });
  }

  /**
   * Search HackerNews (via Algolia API)
   */
  private async searchHackerNews(query: string, maxResults: number): Promise<SearchResult[]> {
    // Search stories
    const url = new URL('https://hn.algolia.com/api/v1/search');
    url.searchParams.set('query', query);
    url.searchParams.set('tags', 'story');
    url.searchParams.set('hitsPerPage', String(maxResults));

    const response = await fetchWithTimeout(url.toString(), {}, 10000);

    if (!response.ok) return [];

    interface HNResponse {
      hits?: Array<{
        title: string;
        url?: string;
        objectID: string;
        author: string;
        points: number;
        num_comments: number;
        created_at: string;
        story_text?: string;
      }>;
    }

    const data = await safeParseJson<HNResponse>(response);
    if (!data?.hits) return [];

    return data.hits.map((item, i) => ({
      title: item.title,
      url: item.url || `https://news.ycombinator.com/item?id=${item.objectID}`,
      snippet: item.story_text?.slice(0, 200) ||
               `${item.points} points, ${item.num_comments} comments by ${item.author}`,
      source: 'hackernews',
      relevance: 1 - (i * 0.05),
      metadata: {
        hnId: item.objectID,
        points: item.points,
        comments: item.num_comments,
        author: item.author,
        discussionUrl: `https://news.ycombinator.com/item?id=${item.objectID}`,
      },
    }));
  }

  /**
   * Search Reddit (via old.reddit.com JSON API)
   */
  private async searchReddit(query: string, maxResults: number): Promise<SearchResult[]> {
    // Use Reddit's search JSON endpoint
    const url = new URL('https://old.reddit.com/search.json');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(Math.min(maxResults, 25)));
    url.searchParams.set('sort', 'relevance');
    url.searchParams.set('t', 'all'); // All time

    const response = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ResearchBot/1.0)',
          'Accept': 'application/json',
        },
      },
      10000
    );

    if (!response.ok) return [];

    interface RedditResponse {
      data?: {
        children?: Array<{
          data: {
            title: string;
            permalink: string;
            selftext?: string;
            subreddit: string;
            score: number;
            num_comments: number;
            author: string;
            created_utc: number;
            url?: string;
          };
        }>;
      };
    }

    const data = await safeParseJson<RedditResponse>(response);
    if (!data?.data?.children) return [];

    return data.data.children.map((item, i) => {
      const post = item.data;
      const snippet = post.selftext
        ? post.selftext.slice(0, 200).replace(/\n/g, ' ')
        : `r/${post.subreddit} • ${post.score} points • ${post.num_comments} comments`;

      return {
        title: post.title,
        url: `https://reddit.com${post.permalink}`,
        snippet,
        source: 'reddit',
        relevance: 1 - (i * 0.05),
        metadata: {
          subreddit: post.subreddit,
          score: post.score,
          comments: post.num_comments,
          author: post.author,
        },
      };
    });
  }

  /**
   * Search Twitter/X via Serper (site-restricted Google search)
   */
  private async searchTwitter(query: string, maxResults: number): Promise<SearchResult[]> {
    const response = await fetchWithTimeout(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: `site:twitter.com OR site:x.com ${query}`,
          num: maxResults,
        }),
      },
      10000
    );

    if (!response.ok) return [];

    interface SerperResponse {
      organic?: Array<{
        title: string;
        link: string;
        snippet: string;
        date?: string;
      }>;
    }

    const data = await safeParseJson<SerperResponse>(response);
    if (!data?.organic) return [];

    return data.organic.map((item, i) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
      source: 'twitter',
      relevance: 1 - (i * 0.05),
      metadata: {
        date: item.date,
      },
    }));
  }

  /**
   * Search Twitter/X via Brave Search (alternative when Serper unavailable)
   */
  private async searchTwitterBrave(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', `site:twitter.com OR site:x.com ${query}`);
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

    if (!response.ok) return [];

    interface BraveResponse {
      web?: {
        results?: Array<{
          title: string;
          url: string;
          description: string;
          age?: string;
        }>;
      };
    }

    const data = await safeParseJson<BraveResponse>(response);
    if (!data?.web?.results) return [];

    return data.web.results.map((item, i) => ({
      title: item.title,
      url: item.url,
      snippet: item.description,
      source: 'twitter:brave',
      relevance: 1 - (i * 0.05),
      metadata: item.age ? { age: item.age } : undefined,
    }));
  }
}
