/**
 * Logger utility
 * Structured logging with file output support
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
  data?: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let globalLogLevel: LogLevel = 'info';
let logFilePath: string | null = null;

export function setLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}

export function setLogFile(path: string): void {
  const dir = path.replace('~', homedir());
  const parentDir = join(dir, '..');
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }
  logFilePath = dir;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[globalLogLevel];
}

function formatEntry(entry: LogEntry): string {
  const parts = [
    `[${entry.timestamp}]`,
    `[${entry.level.toUpperCase().padEnd(5)}]`,
    `[${entry.context}]`,
    entry.message,
  ];

  if (entry.data !== undefined) {
    parts.push(JSON.stringify(entry.data));
  }

  return parts.join(' ');
}

function writeToFile(formatted: string): void {
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, formatted + '\n');
    } catch {
      // Silently fail file writes
    }
  }
}

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      message,
      data,
    };

    const formatted = formatEntry(entry);

    // Console output with colors
    switch (level) {
      case 'debug':
        console.debug('\x1b[90m%s\x1b[0m', formatted);
        break;
      case 'info':
        console.info('\x1b[36m%s\x1b[0m', formatted);
        break;
      case 'warn':
        console.warn('\x1b[33m%s\x1b[0m', formatted);
        break;
      case 'error':
        console.error('\x1b[31m%s\x1b[0m', formatted);
        break;
    }

    writeToFile(formatted);
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }
}

// Pre-configured loggers
export const serverLogger = new Logger('Server');
export const queueLogger = new Logger('Queue');
export const hookLogger = new Logger('Hook');
