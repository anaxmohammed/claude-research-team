<p align="center">
  <img src="assets/logo.png" alt="Claude Research Team" width="200">
</p>

<h1 align="center">Claude Research Team</h1>

<p align="center">
  <strong>Autonomous research agents for Claude Code — passively research and inject helpful context</strong>
</p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="License: AGPL v3"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen" alt="Node.js"></a>
  <a href="https://docs.anthropic.com/claude-code"><img src="https://img.shields.io/badge/powered%20by-Claude%20Agent%20SDK-orange" alt="Claude Agent SDK"></a>
</p>

---

## Overview

Claude Research Team runs background research agents that automatically detect when additional information would help during your Claude Code sessions. Powered entirely by the **Claude Agent SDK** — no external AI services required.

When you ask questions or encounter errors, the system:

1. **Detects triggers** — Analyzes your prompts and tool outputs for research opportunities
2. **Queues research** — Runs searches in the background without blocking your workflow
3. **Synthesizes with Claude** — Uses Claude Agent SDK to create intelligent summaries
4. **Injects context** — Passively adds relevant findings to Claude's context at the right moment

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        CLAUDE RESEARCH TEAM                               │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐               │
│   │  USER       │     │  TRIGGER    │     │  RESEARCH   │               │
│   │  PROMPT     │────▶│  DETECTOR   │────▶│  QUEUE      │               │
│   └─────────────┘     └─────────────┘     └──────┬──────┘               │
│                                                  │                       │
│                                                  ▼                       │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐               │
│   │  CLAUDE     │◀────│  INJECTION  │◀────│  CLAUDE SDK │               │
│   │  CONTEXT    │     │  MANAGER    │     │  SYNTHESIS  │               │
│   └─────────────┘     └─────────────┘     └─────────────┘               │
│                                                                          │
│   ═══════════════════════════════════════════════════════════════════   │
│                                                                          │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐               │
│   │  HTTP API   │     │  WEB UI     │     │  SQLITE DB  │               │
│   │  :3200      │     │  DASHBOARD  │     │  + FTS5     │               │
│   └─────────────┘     └─────────────┘     └─────────────┘               │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Features

- **🤖 100% Claude Powered** — Uses Claude Agent SDK for AI synthesis, no external AI keys needed
- **🔍 Intelligent Trigger Detection** — Recognizes questions, errors, and research-worthy patterns
- **📊 Priority Queue Management** — Research tasks are prioritized by relevance and urgency
- **💉 Passive Context Injection** — Results are injected without disrupting your workflow
- **📈 Budget Control** — Configurable limits prevent context pollution
- **🌐 Web Dashboard** — Monitor research tasks and queue status in real-time
- **🔗 Optional claude-mem Sync** — Persist research findings across sessions
- **🔌 Plugin Architecture** — Install as a Claude Code plugin

## Quick Start

### Install as Plugin (Recommended)

```bash
# Install the plugin
claude plugins install bigphoot/claude-research-team

# Or install from local path during development
claude plugins install /path/to/claude-research-team
```

The plugin will automatically:
- Start the background research service
- Register lifecycle hooks
- Make skills available

### Manual Installation

```bash
# Clone the repository
git clone https://github.com/bigphoot/claude-research-team.git
cd claude-research-team

# Install dependencies
npm install

# Build
npm run build

# Start the service
npm start
```

The service runs on port **3200** by default. Open http://localhost:3200 to view the dashboard.

## Using the Skills

Once installed, you can use the skills in Claude Code:

```
Use the research skill to look up "best practices for rate limiting in Node.js"
```

```
Use the research-status skill to check the queue
```

### Available Skills

| Skill | Description |
|-------|-------------|
| `research` | Queue background research on a topic |
| `research-status` | Check queue status and recent findings |

## CLI Commands

```bash
# Check service status
claude-research-team status

# Queue manual research
claude-research-team research "how to implement caching in Redis"

# List recent tasks
claude-research-team tasks --limit 20

# View/update configuration
claude-research-team config
claude-research-team config port 3201
```

## Configuration

Configuration is stored in `~/.claude-research-team/config.json`:

```json
{
  "port": 3200,
  "dataDir": "~/.claude-research-team",
  "logLevel": "info",
  "defaultDepth": "medium",
  "engines": ["serper", "brave", "tavily"],
  "injection": {
    "maxPerSession": 5,
    "maxTokensPerInjection": 150,
    "maxTotalTokensPerSession": 500,
    "cooldownMs": 30000
  },
  "queue": {
    "maxConcurrent": 2,
    "maxQueueSize": 20,
    "taskTimeoutMs": 120000,
    "retryAttempts": 2
  },
  "claudeMemSync": false
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_RESEARCH_PORT` | HTTP service port | 3200 |
| `CLAUDE_RESEARCH_DATA_DIR` | Data directory | ~/.claude-research-team |
| `CLAUDE_RESEARCH_LOG_LEVEL` | Log level | info |
| `SERPER_API_KEY` | Serper search API key | - |
| `BRAVE_API_KEY` | Brave search API key | - |
| `TAVILY_API_KEY` | Tavily search API key | - |
| `CLAUDE_MEM_SYNC` | Enable claude-mem sync | false |
| `CLAUDE_MEM_URL` | claude-mem API URL | http://localhost:37777 |

### Search API Keys

At least one search API key is required for web search functionality:

- **Serper** (recommended): https://serper.dev — Google search API
- **Brave**: https://brave.com/search/api — Privacy-focused search
- **Tavily**: https://tavily.com — AI-optimized search

## How It Works

### Research Pipeline

1. **Trigger Detection** — User prompts and tool outputs are analyzed for research opportunities
2. **Queue Management** — Research tasks are queued with priority and depth settings
3. **Web Search** — Multiple search engines are queried in parallel
4. **Content Scraping** — Top results are scraped using Jina Reader (free, unlimited)
5. **Claude Synthesis** — Results are synthesized using Claude Agent SDK
6. **Context Injection** — Findings are passively injected via `PostToolUse` hook

### Injection Example

When relevant research completes, it's injected like this:

```xml
<research-context query="how to implement rate limiting">
Rate limiting in Node.js can be implemented using token bucket
or sliding window algorithms. Popular libraries include rate-limiter-flexible
and express-rate-limit for Express applications.
Source: Rate Limiting Best Practices (https://example.com/rate-limiting)
</research-context>
```

## Research Depths

| Depth | Time | Searches | Scrapes | Best For |
|-------|------|----------|---------|----------|
| `quick` | ~15s | 5 | 2 | Simple facts, definitions |
| `medium` | ~30s | 10 | 4 | How-to questions, technical docs |
| `deep` | ~60s | 20 | 8 | Complex comparisons, thorough research |

## API Reference

### Status & Health

```http
GET /api/status          # Service status with queue stats
GET /api/health          # Simple health check
```

### Research Queue

```http
POST /api/research       # Queue new research
{
  "query": "how to implement caching",
  "depth": "medium",      # quick | medium | deep
  "priority": 7,          # 1-10
  "sessionId": "optional"
}

GET /api/queue/stats     # Queue statistics
GET /api/tasks           # List recent tasks
GET /api/tasks/:id       # Get specific task
GET /api/search/tasks?q= # Search tasks
```

### Trigger Analysis

```http
POST /api/analyze/prompt        # Analyze prompt for triggers
POST /api/analyze/tool-output   # Analyze tool output for triggers
```

### Injection

```http
GET /api/injection/:sessionId           # Get pending injection
GET /api/injection/:sessionId/history   # Injection history
```

## Optional claude-mem Integration

When enabled, research findings sync to claude-mem for cross-session persistence:

```bash
# Enable sync
claude-research-team config claudeMemSync true

# Set claude-mem URL (if not default)
claude-research-team config claudeMemUrl "http://localhost:37777"
```

Research tasks are stored as `discovery` observations in claude-mem.

## Development

```bash
# Development build with watch
npm run dev

# Run tests
npm test

# Lint
npm run lint

# Clean build
npm run clean && npm run build
```

### Project Structure

```
claude-research-team/
├── src/
│   ├── crew/           # Research executor (Claude SDK)
│   ├── database/       # SQLite with FTS5
│   ├── hooks/          # Claude Code lifecycle hooks
│   ├── injection/      # Context injection manager
│   ├── plugin/         # Plugin entry point
│   ├── queue/          # Task queue manager
│   ├── service/        # HTTP service & web UI
│   ├── skills/         # Claude Code skills
│   ├── sync/           # claude-mem integration
│   ├── triggers/       # Pattern detection
│   ├── utils/          # Logger, config
│   ├── types.ts        # TypeScript types
│   ├── index.ts        # Library exports
│   └── cli.ts          # CLI entry point
├── scripts/
│   └── build-hooks.js  # Hook bundler
├── plugin.json         # Plugin manifest
├── dist/               # Compiled output
└── package.json
```

## License

AGPL-3.0 — See [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please read our contributing guidelines before submitting PRs.

## Credits

- Inspired by [claude-mem](https://github.com/thedotmack/claude-mem) for its elegant approach to Claude Code enhancement
- Powered by the [Claude Agent SDK](https://docs.anthropic.com/claude-code) for AI synthesis
- Uses [Jina Reader](https://jina.ai/reader/) for free, unlimited web scraping
