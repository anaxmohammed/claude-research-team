/**
 * Project Indexer
 *
 * Scans and indexes a project's codebase to provide context for research decisions.
 * Creates a summary understanding of what the project is, its stack, and key patterns.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { ProjectContext, ProjectFile } from '../types.js';
import { Logger } from '../utils/logger.js';
import { getAIProvider } from '../ai/provider.js';

const logger = new Logger('ProjectIndexer');

// Files to look for when indexing a project
const CONFIG_FILES = [
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'build.gradle',
  'pom.xml',
];

const README_FILES = ['README.md', 'README.txt', 'README', 'readme.md'];

const TYPE_FILES = [
  'src/types.ts',
  'types/index.ts',
  'src/types/index.ts',
  'lib/types.ts',
];

export class ProjectIndexer {
  private cache: Map<string, ProjectContext> = new Map();
  private indexingInProgress: Set<string> = new Set();

  /**
   * Get or create project context for a path
   */
  async getProjectContext(projectPath: string): Promise<ProjectContext | null> {
    // Normalize path
    const normalizedPath = path.resolve(projectPath);

    // Check cache first
    const cached = this.cache.get(normalizedPath);
    if (cached && Date.now() - cached.indexedAt < 3600000) { // 1 hour cache
      return cached;
    }

    // Check if already indexing
    if (this.indexingInProgress.has(normalizedPath)) {
      logger.debug('Indexing already in progress', { projectPath: normalizedPath });
      return cached || null;
    }

    // Index the project
    try {
      this.indexingInProgress.add(normalizedPath);
      const context = await this.indexProject(normalizedPath);
      this.cache.set(normalizedPath, context);
      return context;
    } catch (error) {
      logger.error('Failed to index project', { projectPath: normalizedPath, error });
      return null;
    } finally {
      this.indexingInProgress.delete(normalizedPath);
    }
  }

  /**
   * Index a project and create context
   */
  private async indexProject(projectPath: string): Promise<ProjectContext> {
    logger.info('Indexing project', { projectPath });

    // Gather files
    const configFile = await this.findConfigFile(projectPath);
    const readmeFile = await this.findReadmeFile(projectPath);
    const typeFiles = await this.findTypeFiles(projectPath);
    const sourceFiles = await this.findKeySourceFiles(projectPath);

    // Read file contents
    const files: { path: string; content: string; type: ProjectFile['type'] }[] = [];

    if (configFile) {
      const content = await this.readFileSafe(path.join(projectPath, configFile));
      if (content) files.push({ path: configFile, content, type: 'config' });
    }

    if (readmeFile) {
      const content = await this.readFileSafe(path.join(projectPath, readmeFile));
      if (content) files.push({ path: readmeFile, content: content.slice(0, 3000), type: 'readme' });
    }

    for (const typeFile of typeFiles.slice(0, 2)) {
      const content = await this.readFileSafe(path.join(projectPath, typeFile));
      if (content) files.push({ path: typeFile, content: content.slice(0, 2000), type: 'types' });
    }

    for (const sourceFile of sourceFiles.slice(0, 3)) {
      const content = await this.readFileSafe(path.join(projectPath, sourceFile));
      if (content) files.push({ path: sourceFile, content: content.slice(0, 1500), type: 'source' });
    }

    // Extract basic info from config
    const basicInfo = await this.extractBasicInfo(projectPath, configFile);

    // Generate AI summary
    const aiSummary = await this.generateAISummary(projectPath, files, basicInfo);

    // Build context
    const context: ProjectContext = {
      id: randomUUID(),
      projectPath,
      name: basicInfo.name || path.basename(projectPath),
      summary: aiSummary.summary,
      stack: aiSummary.stack,
      keyFiles: files.map((f) => ({
        path: f.path,
        type: f.type,
        importance: f.type === 'config' ? 1 : f.type === 'readme' ? 0.9 : 0.7,
      })),
      patterns: aiSummary.patterns,
      dependencies: basicInfo.dependencies,
      indexedAt: Date.now(),
      lastUpdatedAt: Date.now(),
      tokenCount: this.estimateTokens(aiSummary.summary),
    };

    logger.info('Project indexed', {
      projectPath,
      name: context.name,
      stack: context.stack,
      fileCount: context.keyFiles.length,
    });

    return context;
  }

  /**
   * Find the main config file for the project
   */
  private async findConfigFile(projectPath: string): Promise<string | null> {
    for (const file of CONFIG_FILES) {
      const filePath = path.join(projectPath, file);
      try {
        await fs.access(filePath);
        return file;
      } catch {
        // File doesn't exist, continue
      }
    }
    return null;
  }

  /**
   * Find README file
   */
  private async findReadmeFile(projectPath: string): Promise<string | null> {
    for (const file of README_FILES) {
      const filePath = path.join(projectPath, file);
      try {
        await fs.access(filePath);
        return file;
      } catch {
        // File doesn't exist, continue
      }
    }
    return null;
  }

  /**
   * Find type definition files
   */
  private async findTypeFiles(projectPath: string): Promise<string[]> {
    const found: string[] = [];
    for (const file of TYPE_FILES) {
      const filePath = path.join(projectPath, file);
      try {
        await fs.access(filePath);
        found.push(file);
      } catch {
        // File doesn't exist, continue
      }
    }
    return found;
  }

  /**
   * Find key source files (entry points, main files)
   */
  private async findKeySourceFiles(projectPath: string): Promise<string[]> {
    const candidates = [
      'src/index.ts',
      'src/main.ts',
      'src/app.ts',
      'src/server.ts',
      'src/lib.rs',
      'main.py',
      'app.py',
      'main.go',
      'index.js',
      'index.ts',
    ];

    const found: string[] = [];
    for (const file of candidates) {
      const filePath = path.join(projectPath, file);
      try {
        await fs.access(filePath);
        found.push(file);
      } catch {
        // File doesn't exist, continue
      }
    }
    return found;
  }

  /**
   * Safely read a file
   */
  private async readFileSafe(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Extract basic info from config file
   */
  private async extractBasicInfo(
    projectPath: string,
    configFile: string | null
  ): Promise<{ name: string; dependencies: string[] }> {
    if (!configFile) {
      return { name: path.basename(projectPath), dependencies: [] };
    }

    const content = await this.readFileSafe(path.join(projectPath, configFile));
    if (!content) {
      return { name: path.basename(projectPath), dependencies: [] };
    }

    try {
      if (configFile === 'package.json') {
        const pkg = JSON.parse(content);
        const deps = [
          ...Object.keys(pkg.dependencies || {}),
          ...Object.keys(pkg.devDependencies || {}),
        ].slice(0, 20); // Limit to top 20
        return { name: pkg.name || path.basename(projectPath), dependencies: deps };
      }
      // Add other config parsers as needed
    } catch {
      // Parse error, return defaults
    }

    return { name: path.basename(projectPath), dependencies: [] };
  }

  /**
   * Generate AI summary of the project
   */
  private async generateAISummary(
    projectPath: string,
    files: { path: string; content: string; type: string }[],
    basicInfo: { name: string; dependencies: string[] }
  ): Promise<{ summary: string; stack: string[]; patterns: string[] }> {
    const ai = getAIProvider();

    // Build prompt with file contents
    const fileContext = files
      .map((f) => `--- ${f.path} (${f.type}) ---\n${f.content}`)
      .join('\n\n');

    const prompt = `Analyze this project and provide a concise understanding for a research assistant.

Project: ${basicInfo.name}
Path: ${projectPath}
Dependencies: ${basicInfo.dependencies.slice(0, 10).join(', ')}

Key Files:
${fileContext}

Provide a JSON response with:
1. "summary": A 2-3 sentence summary of what this project is and does
2. "stack": Array of technologies/frameworks (e.g., ["typescript", "react", "node", "express"])
3. "patterns": Array of notable patterns/conventions (e.g., ["MVC architecture", "functional components", "dependency injection"])

Respond ONLY with valid JSON, no markdown.`;

    try {
      const response = await ai.analyze(prompt);

      // Parse JSON response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          summary: parsed.summary || `${basicInfo.name} project`,
          stack: parsed.stack || [],
          patterns: parsed.patterns || [],
        };
      }
    } catch (error) {
      logger.warn('AI summary generation failed, using fallback', { error });
    }

    // Fallback: infer from dependencies
    const stack: string[] = [];
    const deps = basicInfo.dependencies.join(' ').toLowerCase();

    if (deps.includes('typescript') || files.some(f => f.path.endsWith('.ts'))) stack.push('typescript');
    if (deps.includes('react')) stack.push('react');
    if (deps.includes('vue')) stack.push('vue');
    if (deps.includes('express')) stack.push('express');
    if (deps.includes('fastify')) stack.push('fastify');
    if (deps.includes('next')) stack.push('nextjs');

    return {
      summary: `${basicInfo.name} - a ${stack.join('/')} project`,
      stack,
      patterns: [],
    };
  }

  /**
   * Estimate token count
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Clear cache for a project
   */
  clearCache(projectPath?: string): void {
    if (projectPath) {
      this.cache.delete(path.resolve(projectPath));
    } else {
      this.cache.clear();
    }
  }

  /**
   * Get a compact context string for AI prompts
   */
  getContextString(context: ProjectContext): string {
    return `Project: ${context.name}
Stack: ${context.stack.join(', ')}
Summary: ${context.summary}
Key patterns: ${context.patterns.join(', ') || 'none identified'}`;
  }
}

// Singleton instance
let indexerInstance: ProjectIndexer | null = null;

export function getProjectIndexer(): ProjectIndexer {
  if (!indexerInstance) {
    indexerInstance = new ProjectIndexer();
  }
  return indexerInstance;
}
