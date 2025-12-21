/**
 * Project Context Service
 *
 * Provides stateful, cached analysis of project files to:
 * 1. Avoid re-analyzing project files repeatedly
 * 2. Provide context for research decisions
 * 3. Improve injection relevance scoring
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { Logger } from '../utils/logger.js';

/**
 * Detected project type based on analysis
 */
export type ProjectType = 'library' | 'webapp' | 'cli' | 'api' | 'mobile' | 'unknown';

/**
 * Full project context with caching metadata
 */
export interface ProjectContext {
  projectPath: string;
  projectType: ProjectType;
  projectName?: string;
  description?: string;
  framework?: string;           // react, express, fastify, next, etc.
  language: 'typescript' | 'javascript' | 'mixed';
  packageJson?: {
    name: string;
    description?: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts?: Record<string, string>;
  };
  structure: {
    hasSrc: boolean;
    hasTests: boolean;
    hasDocs: boolean;
    hasConfig: boolean;
    mainDirectories: string[];
  };
  techStack: string[];          // Detected technologies (e.g., ['react', 'typescript', 'tailwind'])
  cachedAt: number;             // When this context was cached
  ttlMs: number;                // Time-to-live in milliseconds
}

/**
 * Quick context for performance-sensitive operations
 */
export interface QuickProjectContext {
  projectPath: string;
  projectName?: string;
  projectType: ProjectType;
  framework?: string;
  language: 'typescript' | 'javascript' | 'mixed';
  techStack: string[];
  cachedAt: number;
}

// Framework detection patterns
const FRAMEWORK_PATTERNS: Record<string, { deps: string[]; type: ProjectType }> = {
  'next': { deps: ['next'], type: 'webapp' },
  'react': { deps: ['react', 'react-dom'], type: 'webapp' },
  'vue': { deps: ['vue'], type: 'webapp' },
  'angular': { deps: ['@angular/core'], type: 'webapp' },
  'svelte': { deps: ['svelte'], type: 'webapp' },
  'express': { deps: ['express'], type: 'api' },
  'fastify': { deps: ['fastify'], type: 'api' },
  'hono': { deps: ['hono'], type: 'api' },
  'koa': { deps: ['koa'], type: 'api' },
  'nest': { deps: ['@nestjs/core'], type: 'api' },
  'expo': { deps: ['expo'], type: 'mobile' },
  'react-native': { deps: ['react-native'], type: 'mobile' },
  'electron': { deps: ['electron'], type: 'webapp' },
  'commander': { deps: ['commander'], type: 'cli' },
  'yargs': { deps: ['yargs'], type: 'cli' },
  'oclif': { deps: ['@oclif/core'], type: 'cli' },
};

// Tech stack detection (dependencies that indicate specific technologies)
const TECH_STACK_DEPS: Record<string, string[]> = {
  'typescript': ['typescript'],
  'tailwind': ['tailwindcss'],
  'prisma': ['prisma', '@prisma/client'],
  'drizzle': ['drizzle-orm'],
  'graphql': ['graphql', '@apollo/server', '@apollo/client'],
  'trpc': ['@trpc/server', '@trpc/client'],
  'zod': ['zod'],
  'jest': ['jest'],
  'vitest': ['vitest'],
  'playwright': ['@playwright/test', 'playwright'],
  'docker': [],  // Detected via files
  'redis': ['redis', 'ioredis'],
  'postgres': ['pg', '@prisma/client'],
  'mongodb': ['mongodb', 'mongoose'],
  'sqlite': ['better-sqlite3', 'sqlite3'],
  'bun': [],  // Detected via bun.lockb
};

// Default cache TTL: 5 minutes
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class ProjectContextService {
  private cache: Map<string, ProjectContext> = new Map();
  private logger: Logger;

  constructor() {
    this.logger = new Logger('ProjectContext');
  }

  /**
   * Get full project context with caching
   */
  async analyzeProject(projectPath: string, forceFresh: boolean = false): Promise<ProjectContext> {
    // Check cache
    const cached = this.cache.get(projectPath);
    if (!forceFresh && cached && Date.now() < cached.cachedAt + cached.ttlMs) {
      this.logger.debug(`Using cached context for ${projectPath}`);
      return cached;
    }

    this.logger.debug(`Analyzing project: ${projectPath}`);

    // Start with defaults
    const context: ProjectContext = {
      projectPath,
      projectType: 'unknown',
      language: 'javascript',
      structure: {
        hasSrc: false,
        hasTests: false,
        hasDocs: false,
        hasConfig: false,
        mainDirectories: [],
      },
      techStack: [],
      cachedAt: Date.now(),
      ttlMs: DEFAULT_TTL_MS,
    };

    try {
      // Analyze package.json first (most informative)
      const packageJsonPath = join(projectPath, 'package.json');
      if (existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        context.packageJson = {
          name: packageJson.name || basename(projectPath),
          description: packageJson.description,
          dependencies: packageJson.dependencies || {},
          devDependencies: packageJson.devDependencies || {},
          scripts: packageJson.scripts,
        };
        context.projectName = packageJson.name;
        context.description = packageJson.description;

        // Detect framework and project type
        const allDeps = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
        };

        for (const [framework, { deps, type }] of Object.entries(FRAMEWORK_PATTERNS)) {
          if (deps.some(dep => allDeps[dep])) {
            context.framework = framework;
            if (context.projectType === 'unknown') {
              context.projectType = type;
            }
            break;
          }
        }

        // Detect tech stack
        for (const [tech, deps] of Object.entries(TECH_STACK_DEPS)) {
          if (deps.length > 0 && deps.some(dep => allDeps[dep])) {
            context.techStack.push(tech);
          }
        }

        // Detect TypeScript
        if (allDeps['typescript']) {
          context.language = 'typescript';
          if (!context.techStack.includes('typescript')) {
            context.techStack.push('typescript');
          }
        }
      }

      // Analyze directory structure
      context.structure = this.analyzeStructure(projectPath);

      // File-based tech detection
      if (existsSync(join(projectPath, 'Dockerfile')) || existsSync(join(projectPath, 'docker-compose.yml'))) {
        if (!context.techStack.includes('docker')) {
          context.techStack.push('docker');
        }
      }

      if (existsSync(join(projectPath, 'bun.lockb'))) {
        if (!context.techStack.includes('bun')) {
          context.techStack.push('bun');
        }
      }

      if (existsSync(join(projectPath, 'tsconfig.json'))) {
        context.language = 'typescript';
        if (!context.techStack.includes('typescript')) {
          context.techStack.push('typescript');
        }
      }

      // Infer project type from structure if still unknown
      if (context.projectType === 'unknown') {
        if (context.packageJson?.scripts?.build && context.packageJson?.scripts?.start) {
          context.projectType = 'api';
        } else if (context.structure.hasSrc) {
          context.projectType = 'library';
        }
      }

      // Cache the result
      this.cache.set(projectPath, context);
      this.logger.info(`Analyzed project: ${context.projectName || projectPath}`, {
        type: context.projectType,
        framework: context.framework,
        techStack: context.techStack.slice(0, 5),
      });

    } catch (error) {
      this.logger.warn(`Failed to analyze project: ${projectPath}`, error);
    }

    return context;
  }

  /**
   * Get quick context (package.json only) for performance-sensitive operations
   */
  async getQuickContext(projectPath: string): Promise<QuickProjectContext> {
    // Check cache first
    const cached = this.cache.get(projectPath);
    if (cached && Date.now() < cached.cachedAt + cached.ttlMs) {
      return {
        projectPath: cached.projectPath,
        projectName: cached.projectName,
        projectType: cached.projectType,
        framework: cached.framework,
        language: cached.language,
        techStack: cached.techStack,
        cachedAt: cached.cachedAt,
      };
    }

    // Quick analysis from package.json only
    const context: QuickProjectContext = {
      projectPath,
      projectType: 'unknown',
      language: 'javascript',
      techStack: [],
      cachedAt: Date.now(),
    };

    try {
      const packageJsonPath = join(projectPath, 'package.json');
      if (existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        context.projectName = packageJson.name;

        const allDeps = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
        };

        // Quick framework detection
        for (const [framework, { deps, type }] of Object.entries(FRAMEWORK_PATTERNS)) {
          if (deps.some(dep => allDeps[dep])) {
            context.framework = framework;
            context.projectType = type;
            break;
          }
        }

        // Quick tech stack (just key technologies)
        if (allDeps['typescript']) {
          context.language = 'typescript';
          context.techStack.push('typescript');
        }
        if (allDeps['react']) context.techStack.push('react');
        if (allDeps['vue']) context.techStack.push('vue');
        if (allDeps['tailwindcss']) context.techStack.push('tailwind');
      }

      // Check for TypeScript config
      if (existsSync(join(projectPath, 'tsconfig.json'))) {
        context.language = 'typescript';
        if (!context.techStack.includes('typescript')) {
          context.techStack.push('typescript');
        }
      }

    } catch (error) {
      this.logger.debug(`Quick context failed for ${projectPath}`, error);
    }

    return context;
  }

  /**
   * Analyze directory structure
   */
  private analyzeStructure(projectPath: string): ProjectContext['structure'] {
    const structure: ProjectContext['structure'] = {
      hasSrc: false,
      hasTests: false,
      hasDocs: false,
      hasConfig: false,
      mainDirectories: [],
    };

    try {
      const entries = readdirSync(projectPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const name = entry.name;

        // Skip hidden directories and node_modules
        if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build') {
          continue;
        }

        structure.mainDirectories.push(name);

        // Check for common directories
        if (name === 'src' || name === 'lib') {
          structure.hasSrc = true;
        } else if (name === 'test' || name === 'tests' || name === '__tests__') {
          structure.hasTests = true;
        } else if (name === 'docs' || name === 'documentation') {
          structure.hasDocs = true;
        } else if (name === 'config' || name === '.config') {
          structure.hasConfig = true;
        }
      }

      // Limit main directories to prevent bloat
      structure.mainDirectories = structure.mainDirectories.slice(0, 10);

    } catch (error) {
      this.logger.debug(`Failed to analyze structure: ${projectPath}`, error);
    }

    return structure;
  }

  /**
   * Check if a research query is relevant to the project's tech stack
   */
  isRelevantToProject(query: string, context: ProjectContext | QuickProjectContext): boolean {
    const queryLower = query.toLowerCase();

    // Check if query mentions any of the project's technologies
    for (const tech of context.techStack) {
      if (queryLower.includes(tech.toLowerCase())) {
        return true;
      }
    }

    // Check framework
    if (context.framework && queryLower.includes(context.framework.toLowerCase())) {
      return true;
    }

    // Check language
    if (queryLower.includes(context.language)) {
      return true;
    }

    return false;
  }

  /**
   * Get relevance score for a query against project context
   * Returns 0-1 where higher is more relevant
   */
  getRelevanceScore(query: string, context: ProjectContext | QuickProjectContext): number {
    const queryLower = query.toLowerCase();
    let score = 0;
    let matches = 0;

    // Tech stack matches (highest weight)
    for (const tech of context.techStack) {
      if (queryLower.includes(tech.toLowerCase())) {
        score += 0.2;
        matches++;
      }
    }

    // Framework match
    if (context.framework && queryLower.includes(context.framework.toLowerCase())) {
      score += 0.25;
      matches++;
    }

    // Language match
    if (queryLower.includes(context.language)) {
      score += 0.1;
      matches++;
    }

    // Cap at 1.0
    return Math.min(1.0, score);
  }

  /**
   * Invalidate cache for a project
   */
  invalidate(projectPath: string): void {
    this.cache.delete(projectPath);
    this.logger.debug(`Invalidated cache for ${projectPath}`);
  }

  /**
   * Clear all cached contexts
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.debug('Cleared all project context cache');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; projects: string[] } {
    return {
      size: this.cache.size,
      projects: Array.from(this.cache.keys()),
    };
  }
}

// Singleton instance
let instance: ProjectContextService | null = null;

export function getProjectContextService(): ProjectContextService {
  if (!instance) {
    instance = new ProjectContextService();
  }
  return instance;
}
