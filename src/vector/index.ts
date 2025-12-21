/**
 * Vector database module
 * Provides semantic search capabilities for research findings
 */

export { VectorService, getVectorService } from './chroma-service.js';
export type { VectorSearchResult, SemanticSearchOptions, SimilarQueryResult } from './chroma-service.js';
export { prepareFindingDocuments, prepareProjectDocument, chunkText, jaccardSimilarity } from './embeddings.js';
export type { EmbeddingDocument } from './embeddings.js';
