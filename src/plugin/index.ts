/**
 * Claude Research Team Plugin Entry Point
 * Initializes the research service when the plugin loads
 */

import { ResearchService } from '../service/server.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('Plugin');

let service: ResearchService | null = null;

/**
 * Called when the plugin is loaded
 */
export async function activate(): Promise<void> {
  logger.info('Activating claude-research-team plugin');

  try {
    service = new ResearchService();
    await service.start();
    logger.info('Research service started successfully');
  } catch (error) {
    logger.error('Failed to start research service', error);
    throw error;
  }
}

/**
 * Called when the plugin is unloaded
 */
export async function deactivate(): Promise<void> {
  logger.info('Deactivating claude-research-team plugin');

  if (service) {
    await service.stop();
    service = null;
  }
}

/**
 * Get the running service instance
 */
export function getService(): ResearchService | null {
  return service;
}

export { ResearchService };
