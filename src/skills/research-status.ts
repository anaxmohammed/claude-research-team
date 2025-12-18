/**
 * Research Status Skill
 * Check the status of the research queue and recent findings
 */

const SERVICE_URL = process.env.CLAUDE_RESEARCH_URL || 'http://localhost:3200';

interface QueueStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

interface RecentTask {
  id: string;
  query: string;
  status: string;
  depth: string;
  createdAt: number;
  result?: {
    summary: string;
  };
}

interface StatusOutput {
  success: boolean;
  running: boolean;
  queue?: QueueStats;
  recentTasks?: Array<{
    query: string;
    status: string;
    summary?: string;
  }>;
  message: string;
}

/**
 * Main skill handler
 */
export async function researchStatus(): Promise<StatusOutput> {
  try {
    // Check service status
    const statusResponse = await fetch(`${SERVICE_URL}/api/status`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);

    if (!statusResponse?.ok) {
      return {
        success: true,
        running: false,
        message: 'Research service is not running. Start it with: claude-research-team start',
      };
    }

    const statusData = await statusResponse.json() as {
      success: boolean;
      data: { queue: QueueStats };
    };

    // Get recent tasks
    const tasksResponse = await fetch(`${SERVICE_URL}/api/tasks?limit=5`, {
      signal: AbortSignal.timeout(3000),
    });

    let recentTasks: Array<{ query: string; status: string; summary?: string }> = [];

    if (tasksResponse.ok) {
      const tasksData = await tasksResponse.json() as { success: boolean; data: RecentTask[] };
      if (tasksData.success) {
        recentTasks = tasksData.data.map(t => ({
          query: t.query,
          status: t.status,
          summary: t.result?.summary,
        }));
      }
    }

    const queue = statusData.data.queue;
    const parts: string[] = [];

    parts.push('**Research Service Status: Running**');
    parts.push('');
    parts.push('**Queue:**');
    parts.push(`- Queued: ${queue.queued}`);
    parts.push(`- Running: ${queue.running}`);
    parts.push(`- Completed: ${queue.completed}`);
    parts.push(`- Failed: ${queue.failed}`);

    if (recentTasks.length > 0) {
      parts.push('');
      parts.push('**Recent Research:**');
      for (const task of recentTasks) {
        const icon = task.status === 'completed' ? '✅' : task.status === 'running' ? '🔄' : '⏳';
        parts.push(`${icon} ${task.query}`);
        if (task.summary) {
          parts.push(`   → ${task.summary.slice(0, 100)}...`);
        }
      }
    }

    parts.push('');
    parts.push(`Dashboard: http://localhost:${process.env.CLAUDE_RESEARCH_PORT || 3200}`);

    return {
      success: true,
      running: true,
      queue,
      recentTasks,
      message: parts.join('\n'),
    };
  } catch (error) {
    return {
      success: false,
      running: false,
      message: `Error checking status: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// Export for skill system
export default researchStatus;

// Skill metadata
export const metadata = {
  name: 'research-status',
  description: 'Check the status of the research queue and see recent findings',
  parameters: {},
};
