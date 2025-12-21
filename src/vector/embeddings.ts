/**
 * Document preparation utilities for vector embeddings
 */

import type { ResearchFinding, ProjectContext } from '../types.js';

export interface EmbeddingDocument {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

/**
 * Prepare a research finding for embedding
 * Returns multiple documents for different fields
 */
export function prepareFindingDocuments(finding: ResearchFinding): EmbeddingDocument[] {
  const docs: EmbeddingDocument[] = [];

  const baseMetadata = {
    finding_id: finding.id,
    doc_type: 'finding',
    domain: finding.domain || 'general',
    project_path: finding.projectPath || '',
    confidence: finding.confidence,
    depth: finding.depth,
    created_at: finding.createdAt,
  };

  // Query document
  docs.push({
    id: `${finding.id}_query`,
    text: finding.query,
    metadata: { ...baseMetadata, field_type: 'query' },
  });

  // Summary document
  if (finding.summary) {
    docs.push({
      id: `${finding.id}_summary`,
      text: finding.summary,
      metadata: { ...baseMetadata, field_type: 'summary' },
    });
  }

  // Key points document
  if (finding.keyPoints && finding.keyPoints.length > 0) {
    docs.push({
      id: `${finding.id}_points`,
      text: finding.keyPoints.join('\n- '),
      metadata: { ...baseMetadata, field_type: 'points' },
    });
  }

  // Full content (chunked if large)
  if (finding.fullContent) {
    const chunks = chunkText(finding.fullContent, 1000);
    chunks.forEach((chunk, i) => {
      docs.push({
        id: `${finding.id}_content_${i}`,
        text: chunk,
        metadata: { ...baseMetadata, field_type: 'content', chunk_index: i },
      });
    });
  }

  return docs;
}

/**
 * Prepare project context for embedding
 */
export function prepareProjectDocument(project: ProjectContext): EmbeddingDocument {
  const text = [
    `Project: ${project.name}`,
    `Summary: ${project.summary}`,
    `Tech Stack: ${project.stack.join(', ')}`,
    `Patterns: ${project.patterns.join(', ')}`,
    `Key Dependencies: ${project.dependencies.slice(0, 10).join(', ')}`,
  ].join('\n');

  return {
    id: `project_${hashPath(project.projectPath)}`,
    text,
    metadata: {
      doc_type: 'project',
      project_path: project.projectPath,
      project_name: project.name,
      tech_stack: project.stack,
      indexed_at: project.indexedAt,
    },
  };
}

/**
 * Chunk text into smaller pieces for embedding
 * Tries to split on sentence boundaries
 */
export function chunkText(text: string, maxChunkSize: number): string[] {
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

/**
 * Simple hash for project paths to use as IDs
 */
function hashPath(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    const char = path.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Calculate text similarity using word overlap (fallback for when vectors unavailable)
 * Returns 0-1 similarity score
 */
export function jaccardSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}
