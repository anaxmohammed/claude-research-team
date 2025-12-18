#!/usr/bin/env node

/**
 * CLI for claude-research-team
 * Manage the research service and queue
 */

import { ResearchService } from './service/server.js';
import { getConfig } from './utils/config.js';
import { getDatabase, closeDatabase } from './database/index.js';
import type { ResearchDepth } from './types.js';

const VERSION = '1.0.0';

interface Command {
  name: string;
  description: string;
  usage: string;
  handler: (args: string[]) => Promise<void>;
}

const commands: Map<string, Command> = new Map();

// ===== Commands =====

commands.set('start', {
  name: 'start',
  description: 'Start the research service',
  usage: 'claude-research-team start',
  handler: async () => {
    console.log('Starting Claude Research Team service...');

    const service = new ResearchService();

    process.on('SIGINT', async () => {
      console.log('\nStopping service...');
      await service.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await service.stop();
      process.exit(0);
    });

    await service.start();
    console.log('Service is running. Press Ctrl+C to stop.');
  },
});

commands.set('status', {
  name: 'status',
  description: 'Check service status',
  usage: 'claude-research-team status',
  handler: async () => {
    const config = getConfig();
    const port = config.getValue('port');

    try {
      const response = await fetch(`http://localhost:${port}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });

      if (!response.ok) {
        console.log('Service is not responding properly');
        process.exit(1);
      }

      const data = (await response.json()) as { success: boolean; data: Record<string, unknown> };

      if (data.success) {
        console.log('Service Status: Running');
        console.log(`  Version: ${data.data.version}`);
        console.log(`  Uptime: ${formatUptime(data.data.uptime as number)}`);
        console.log(`  Port: ${port}`);
        console.log(`  Active Sessions: ${data.data.activeSessions}`);
        console.log('Queue:');
        const queue = data.data.queue as Record<string, number>;
        console.log(`  Queued: ${queue.queued}`);
        console.log(`  Running: ${queue.running}`);
        console.log(`  Completed: ${queue.completed}`);
        console.log(`  Failed: ${queue.failed}`);
      }
    } catch {
      console.log('Service is not running');
      console.log(`Expected on port: ${port}`);
      console.log('Start with: claude-research-team start');
      process.exit(1);
    }
  },
});

commands.set('research', {
  name: 'research',
  description: 'Queue a research task',
  usage: 'claude-research-team research <query> [--depth quick|medium|deep]',
  handler: async (args) => {
    if (args.length === 0) {
      console.error('Error: Query is required');
      console.log('Usage: claude-research-team research <query>');
      process.exit(1);
    }

    // Parse arguments
    let query = '';
    let depth: ResearchDepth = 'medium';

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--depth' && args[i + 1]) {
        depth = args[i + 1] as ResearchDepth;
        i++;
      } else {
        query += (query ? ' ' : '') + args[i];
      }
    }

    const config = getConfig();
    const port = config.getValue('port');

    try {
      const response = await fetch(`http://localhost:${port}/api/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, depth, priority: 8 }),
        signal: AbortSignal.timeout(5000),
      });

      const data = (await response.json()) as { success: boolean; data: { id: string }; error?: string };

      if (data.success) {
        console.log('Research task queued successfully');
        console.log(`  Task ID: ${data.data.id}`);
        console.log(`  Query: ${query}`);
        console.log(`  Depth: ${depth}`);
      } else {
        console.error('Failed to queue research:', data.error);
        process.exit(1);
      }
    } catch (error) {
      console.error('Failed to connect to service. Is it running?');
      console.log('Start with: claude-research-team start');
      process.exit(1);
    }
  },
});

commands.set('tasks', {
  name: 'tasks',
  description: 'List recent research tasks',
  usage: 'claude-research-team tasks [--limit N]',
  handler: async (args) => {
    let limit = 10;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--limit' && args[i + 1]) {
        limit = parseInt(args[i + 1], 10);
        i++;
      }
    }

    const config = getConfig();
    const port = config.getValue('port');

    try {
      const response = await fetch(`http://localhost:${port}/api/tasks?limit=${limit}`, {
        signal: AbortSignal.timeout(5000),
      });

      const data = (await response.json()) as { success: boolean; data: Array<Record<string, unknown>> };

      if (data.success) {
        if (data.data.length === 0) {
          console.log('No tasks found');
          return;
        }

        console.log('Recent Research Tasks:\n');
        for (const task of data.data) {
          const status = formatStatus(task.status as string);
          const date = new Date(task.createdAt as number).toLocaleString();
          console.log(`${status} ${task.query}`);
          console.log(`   ID: ${task.id} | Depth: ${task.depth} | ${date}`);
          console.log('');
        }
      }
    } catch {
      console.error('Failed to connect to service. Is it running?');
      process.exit(1);
    }
  },
});

commands.set('config', {
  name: 'config',
  description: 'View or update configuration',
  usage: 'claude-research-team config [key] [value]',
  handler: async (args) => {
    const config = getConfig();

    if (args.length === 0) {
      // Show all config
      console.log('Configuration:');
      console.log(JSON.stringify(config.get(), null, 2));
    } else if (args.length === 1) {
      // Show specific key
      const key = args[0] as keyof ReturnType<typeof config.get>;
      console.log(`${key}: ${JSON.stringify(config.getValue(key), null, 2)}`);
    } else {
      // Set value
      const [key, ...valueParts] = args;
      const value = valueParts.join(' ');

      try {
        const parsed = JSON.parse(value);
        config.setValue(key as keyof ReturnType<typeof config.get>, parsed);
        console.log(`Set ${key} = ${value}`);
      } catch {
        // Try as string
        config.setValue(key as keyof ReturnType<typeof config.get>, value as never);
        console.log(`Set ${key} = ${value}`);
      }
    }
  },
});

commands.set('cleanup', {
  name: 'cleanup',
  description: 'Clean up old data',
  usage: 'claude-research-team cleanup [--days N]',
  handler: async (args) => {
    let days = 30;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--days' && args[i + 1]) {
        days = parseInt(args[i + 1], 10);
        i++;
      }
    }

    const db = getDatabase();
    const result = db.cleanup(days);

    console.log('Cleanup completed:');
    console.log(`  Deleted ${result.deletedTasks} old tasks`);
    console.log(`  Deleted ${result.deletedSessions} old sessions`);

    db.vacuum();
    console.log('  Database vacuumed');

    closeDatabase();
  },
});

commands.set('help', {
  name: 'help',
  description: 'Show help information',
  usage: 'claude-research-team help [command]',
  handler: async (args) => {
    if (args.length > 0) {
      const cmd = commands.get(args[0]);
      if (cmd) {
        console.log(`\n${cmd.name} - ${cmd.description}`);
        console.log(`\nUsage: ${cmd.usage}\n`);
        return;
      }
      console.log(`Unknown command: ${args[0]}`);
    }

    console.log(`
Claude Research Team v${VERSION}
Autonomous research agents for Claude Code

Usage: claude-research-team <command> [options]

Commands:
`);

    for (const [name, cmd] of commands) {
      console.log(`  ${name.padEnd(12)} ${cmd.description}`);
    }

    console.log(`
Examples:
  claude-research-team start              Start the service
  claude-research-team status             Check service status
  claude-research-team research "query"   Queue a research task
  claude-research-team tasks --limit 20   List recent tasks

For more information: https://github.com/bigphoot/claude-research-team
`);
  },
});

// ===== Helpers =====

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatStatus(status: string): string {
  const icons: Record<string, string> = {
    queued: '⏳',
    running: '🔄',
    completed: '✅',
    failed: '❌',
    injected: '💉',
  };
  return icons[status] || '❓';
}

// ===== Main =====

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await commands.get('help')!.handler([]);
    return;
  }

  const commandName = args[0];
  const commandArgs = args.slice(1);

  const command = commands.get(commandName);
  if (!command) {
    console.error(`Unknown command: ${commandName}`);
    console.log('Run "claude-research-team help" for usage');
    process.exit(1);
  }

  await command.handler(commandArgs);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
