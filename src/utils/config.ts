/**
 * Configuration Manager
 * Loads and manages configuration from file and environment
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Config } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

const CONFIG_FILENAME = 'config.json';

export class ConfigManager {
  private config: Config;
  private configPath: string;

  constructor(dataDir?: string) {
    const resolvedDataDir = (dataDir || DEFAULT_CONFIG.dataDir).replace('~', homedir());

    // Ensure data directory exists
    if (!existsSync(resolvedDataDir)) {
      mkdirSync(resolvedDataDir, { recursive: true });
    }

    this.configPath = join(resolvedDataDir, CONFIG_FILENAME);
    this.config = this.load();
  }

  /**
   * Load configuration from file
   */
  private load(): Config {
    const config = { ...DEFAULT_CONFIG };

    // Load from file if exists
    if (existsSync(this.configPath)) {
      try {
        const fileContent = readFileSync(this.configPath, 'utf-8');
        const fileConfig = JSON.parse(fileContent) as Partial<Config>;
        Object.assign(config, fileConfig);
      } catch (error) {
        console.warn('Failed to load config file, using defaults:', error);
      }
    }

    // Override with environment variables
    if (process.env.CLAUDE_RESEARCH_PORT) {
      config.port = parseInt(process.env.CLAUDE_RESEARCH_PORT, 10);
    }
    if (process.env.CLAUDE_RESEARCH_DATA_DIR) {
      config.dataDir = process.env.CLAUDE_RESEARCH_DATA_DIR;
    }
    if (process.env.CLAUDE_RESEARCH_LOG_LEVEL) {
      config.logLevel = process.env.CLAUDE_RESEARCH_LOG_LEVEL as Config['logLevel'];
    }
    if (process.env.CLAUDE_MEM_SYNC === 'true') {
      config.claudeMemSync = true;
    }
    if (process.env.CLAUDE_MEM_URL) {
      config.claudeMemUrl = process.env.CLAUDE_MEM_URL;
    }

    return config;
  }

  /**
   * Save current configuration to file
   */
  save(): void {
    try {
      const content = JSON.stringify(this.config, null, 2);
      writeFileSync(this.configPath, content, 'utf-8');
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }

  /**
   * Get the full configuration
   */
  get(): Config {
    return { ...this.config };
  }

  /**
   * Get a specific config value
   */
  getValue<K extends keyof Config>(key: K): Config[K] {
    return this.config[key];
  }

  /**
   * Set a config value
   */
  setValue<K extends keyof Config>(key: K, value: Config[K]): void {
    this.config[key] = value;
    this.save();
  }

  /**
   * Update multiple config values
   */
  update(updates: Partial<Config>): void {
    Object.assign(this.config, updates);
    this.save();
  }

  /**
   * Reset to default configuration
   */
  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.save();
  }

  /**
   * Get the data directory path (resolved)
   */
  getDataDir(): string {
    return this.config.dataDir.replace('~', homedir());
  }
}

// Singleton instance
let instance: ConfigManager | null = null;

export function getConfig(dataDir?: string): ConfigManager {
  if (!instance) {
    instance = new ConfigManager(dataDir);
  }
  return instance;
}
