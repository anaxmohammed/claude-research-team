/**
 * Vector database service using ChromaDB
 * Provides semantic search capabilities for research findings
 */

import { ChromaClient, type Collection } from 'chromadb';
import type { ResearchFinding } from '../types.js';

export interface VectorSearchResult {
  findingId: string;
  similarity: number;
  field: 'query' | 'summary' | 'points' | 'content';
  text: string;
  metadata: Record<string, unknown>;
}

export interface SemanticSearchOptions {
  projectPath?: string;
  domain?: string;
  limit?: number;
  minSimilarity?: number;
}

export interface SimilarQueryResult {
  exists: boolean;
  findingId?: string;
  existingQuery?: string;
  similarity?: number;
}

// Chroma metadata type
type ChromaMetadata = Record<string, string | number | boolean>;

// ChromaDB server configuration
const CHROMA_HOST = process.env.CHROMA_HOST || 'localhost';
const CHROMA_PORT = parseInt(process.env.CHROMA_PORT || '8000', 10);

export class VectorService {
  private client: ChromaClient | null = null;
  private collection: Collection | null = null;
  private initialized = false;
  private collectionName = 'research_findings';

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Connect to ChromaDB server (running via systemd service)
      this.client = new ChromaClient({
        host: CHROMA_HOST,
        port: CHROMA_PORT,
      });

      // Verify connection with heartbeat
      await this.client.heartbeat();

      // Get or create collection with cosine distance metric
      this.collection = await this.client.getOrCreateCollection({
        name: this.collectionName,
        metadata: {
          description: 'Research findings with semantic embeddings',
          'hnsw:space': 'cosine', // Use cosine distance (0 = identical, 2 = opposite)
        },
      });

      this.initialized = true;
      console.log(`[VectorService] Connected to ChromaDB at ${CHROMA_HOST}:${CHROMA_PORT}, collection: ${this.collectionName}`);
    } catch (error) {
      console.error('[VectorService] Failed to connect to ChromaDB server:', error);
      console.warn('[VectorService] Ensure ChromaDB is running: systemctl --user status chromadb');
      // Don't throw - allow graceful degradation
      this.initialized = false;
    }
  }

  isReady(): boolean {
    return this.initialized && this.collection !== null;
  }

  /**
   * Add a research finding to the vector database
   * Creates multiple documents for different fields
   */
  async addFinding(finding: ResearchFinding): Promise<void> {
    if (!this.isReady()) {
      console.warn('[VectorService] Not initialized, skipping addFinding');
      return;
    }

    const documents: string[] = [];
    const ids: string[] = [];
    const metadatas: ChromaMetadata[] = [];

    const baseMetadata: ChromaMetadata = {
      finding_id: finding.id,
      domain: finding.domain || 'general',
      project_path: finding.projectPath || '',
      confidence: finding.confidence,
      depth: finding.depth,
      created_at: finding.createdAt,
    };

    // Add query
    documents.push(finding.query);
    ids.push(`${finding.id}_query`);
    metadatas.push({ ...baseMetadata, field_type: 'query' });

    // Add summary
    if (finding.summary) {
      documents.push(finding.summary);
      ids.push(`${finding.id}_summary`);
      metadatas.push({ ...baseMetadata, field_type: 'summary' });
    }

    // Add key points (joined)
    if (finding.keyPoints && finding.keyPoints.length > 0) {
      documents.push(finding.keyPoints.join('\n'));
      ids.push(`${finding.id}_points`);
      metadatas.push({ ...baseMetadata, field_type: 'points' });
    }

    // Add full content (chunked if large)
    if (finding.fullContent) {
      const chunks = this.chunkText(finding.fullContent, 1000);
      chunks.forEach((chunk, i) => {
        documents.push(chunk);
        ids.push(`${finding.id}_content_${i}`);
        metadatas.push({ ...baseMetadata, field_type: 'content', chunk_index: i });
      });
    }

    try {
      await this.collection!.add({
        documents,
        ids,
        metadatas,
      });
      console.log(`[VectorService] Added finding ${finding.id} with ${documents.length} documents`);
    } catch (error) {
      console.error(`[VectorService] Failed to add finding ${finding.id}:`, error);
    }
  }

  /**
   * Check if a semantically similar query already exists
   */
  async hasSemanticallySimilarQuery(
    query: string,
    maxAgeMs: number = 24 * 60 * 60 * 1000, // 24 hours default
    threshold: number = 0.85
  ): Promise<SimilarQueryResult> {
    if (!this.isReady()) {
      return { exists: false };
    }

    const minCreatedAt = Date.now() - maxAgeMs;

    try {
      const results = await this.collection!.query({
        queryTexts: [query],
        nResults: 5,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: {
          $and: [
            { field_type: { $eq: 'query' } },
            { created_at: { $gte: minCreatedAt } },
          ],
        } as any,
        include: ['documents', 'metadatas', 'distances'],
      });

      if (!results.distances || results.distances[0].length === 0) {
        console.log('[VectorService] No similar queries found in vector DB');
        return { exists: false };
      }

      // Chroma returns distances, not similarities
      // For cosine distance: similarity = 1 - distance (0=identical, 2=opposite)
      const distance = results.distances[0][0] ?? 1;
      const similarity = 1 - distance;
      const existingQuery = results.documents?.[0]?.[0] ?? '';

      console.log(`[VectorService] Similarity check: "${query.substring(0, 50)}..." vs "${existingQuery.substring(0, 50)}..." = ${(similarity * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(0)}%)`);

      if (similarity >= threshold) {
        const metadata = results.metadatas?.[0]?.[0] as ChromaMetadata | undefined;
        return {
          exists: true,
          findingId: metadata?.finding_id as string,
          existingQuery: results.documents?.[0]?.[0] ?? undefined,
          similarity,
        };
      }

      return { exists: false };
    } catch (error) {
      console.error('[VectorService] Error checking similar query:', error);
      return { exists: false };
    }
  }

  /**
   * Semantic search across all findings
   */
  async semanticSearch(
    query: string,
    options: SemanticSearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    if (!this.isReady()) {
      return [];
    }

    const { projectPath, domain, limit = 10, minSimilarity = 0.5 } = options;

    // Build where clause
    const whereConditions: Array<Record<string, unknown>> = [];
    if (projectPath) {
      whereConditions.push({ project_path: { $eq: projectPath } });
    }
    if (domain) {
      whereConditions.push({ domain: { $eq: domain } });
    }

    try {
      const results = await this.collection!.query({
        queryTexts: [query],
        nResults: limit * 2, // Get more than needed to filter by similarity
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: whereConditions.length > 0
          ? { $and: whereConditions } as any
          : undefined,
        include: ['documents', 'metadatas', 'distances'],
      });

      if (!results.documents || results.documents[0].length === 0) {
        return [];
      }

      const searchResults: VectorSearchResult[] = [];

      for (let i = 0; i < results.documents[0].length; i++) {
        const distance = results.distances?.[0]?.[i] ?? 1;
        const similarity = 1 - distance;

        if (similarity >= minSimilarity) {
          const metadata = results.metadatas?.[0]?.[i] as ChromaMetadata | undefined;
          searchResults.push({
            findingId: (metadata?.finding_id as string) || '',
            similarity,
            field: (metadata?.field_type as 'query' | 'summary' | 'points' | 'content') || 'query',
            text: results.documents[0][i] ?? '',
            metadata: metadata || {},
          });
        }
      }

      // Sort by similarity and limit
      return searchResults
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    } catch (error) {
      console.error('[VectorService] Error in semantic search:', error);
      return [];
    }
  }

  /**
   * Find related findings for context building
   */
  async findRelatedFindings(
    query: string,
    limit: number = 3,
    excludeFindingId?: string
  ): Promise<VectorSearchResult[]> {
    const results = await this.semanticSearch(query, { limit: limit + 1, minSimilarity: 0.6 });

    // Filter out the current finding if provided
    return results
      .filter(r => r.findingId !== excludeFindingId)
      .slice(0, limit);
  }

  /**
   * Delete all documents for a finding
   */
  async deleteFinding(findingId: string): Promise<void> {
    if (!this.isReady()) return;

    try {
      // Get all document IDs for this finding
      const results = await this.collection!.get({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: { finding_id: { $eq: findingId } } as any,
        include: [],
      });

      if (results.ids.length > 0) {
        await this.collection!.delete({ ids: results.ids });
        console.log(`[VectorService] Deleted ${results.ids.length} documents for finding ${findingId}`);
      }
    } catch (error) {
      console.error(`[VectorService] Failed to delete finding ${findingId}:`, error);
    }
  }

  /**
   * Get stats about the vector database
   */
  async getStats(): Promise<{ count: number; collectionName: string } | null> {
    if (!this.isReady()) return null;

    try {
      const count = await this.collection!.count();
      return {
        count,
        collectionName: this.collectionName,
      };
    } catch (error) {
      console.error('[VectorService] Failed to get stats:', error);
      return null;
    }
  }

  /**
   * Chunk text into smaller pieces for embedding
   */
  private chunkText(text: string, maxChunkSize: number): string[] {
    if (text.length <= maxChunkSize) {
      return [text];
    }

    const chunks: string[] = [];
    const sentences = text.split(/(?<=[.!?])\s+/);
    let currentChunk = '';

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > maxChunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += ' ' + sentence;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }
}

// Singleton instance
let vectorServiceInstance: VectorService | null = null;

export function getVectorService(): VectorService {
  if (!vectorServiceInstance) {
    vectorServiceInstance = new VectorService();
  }
  return vectorServiceInstance;
}
