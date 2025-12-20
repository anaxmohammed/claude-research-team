<p align="center">
  <img src="assets/logo.png" alt="Claude Research Team" width="200">
</p>

<h1 align="center">Claude Research Team</h1>

<p align="center">
  <strong>Autonomous research agents for Claude Code — passively research and inject helpful context</strong>
</p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="License: AGPL v3"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6" alt="Bun"></a>
  <a href="https://docs.anthropic.com/claude-code"><img src="https://img.shields.io/badge/powered%20by-Claude%20Agent%20SDK-orange" alt="Claude Agent SDK"></a>
</p>

<p align="center">
  <a href="#what-is-this">What is This?</a> •
  <a href="#search-engines--tools">Tools</a> •
  <a href="#installation">Installation</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

## What is This?

Claude Research Team is a **Claude Code plugin** that runs background research while you work. When you ask questions or encounter errors, it automatically:

1. **Detects research opportunities** from your prompts and tool outputs
2. **Searches the web** using multiple search APIs (Serper, Brave, Tavily)
3. **Synthesizes findings** with AI (Claude or Gemini)
4. **Injects context** back into your Claude conversation at the right moment
5. **Learns and improves** by tracking source quality and research effectiveness

**No manual intervention required** — research happens in the background and gets injected automatically.

### Standalone Design

Claude Research Team operates independently with its own SQLite database for research findings, source quality tracking, and learning. It optionally integrates with [claude-mem](https://github.com/thedotmack/claude-mem) for cross-session memory, but works perfectly standalone.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        CLAUDE RESEARCH TEAM                               │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   STREAMING CONVERSATION ANALYSIS                                        │
│   ───────────────────────────────                                        │
│                                                                          │
│   ┌─────────────┐     ┌─────────────────┐     ┌─────────────┐           │
│   │  USER       │────▶│  CONVERSATION   │────▶│  RESEARCH   │           │
│   │  PROMPT     │     │  WATCHER        │     │  DETECTOR   │           │
│   └─────────────┘     └─────────────────┘     └──────┬──────┘           │
│         │                     │                       │                  │
│         │                     ▼                       ▼                  │
│         │            ┌─────────────────┐     ┌─────────────┐            │
│         │            │  SESSION STATE  │     │  RESEARCH   │            │
│         │            │  (topics, errs) │     │  QUEUE      │            │
│         │            └─────────────────┘     └──────┬──────┘            │
│         │                                           │                    │
│   ┌─────────────┐                                   ▼                    │
│   │  TOOL USE   │     ┌─────────────────┐   ┌─────────────┐             │
│   │  (streamed) │────▶│  POST-TOOL-USE  │◀──│  AI SYNTH   │             │
│   └─────────────┘     │  HOOK           │   │  (Claude/   │             │
│                       └────────┬────────┘   │   Gemini)   │             │
│                                │            └─────────────┘             │
│                                ▼                    │                    │
│   ┌─────────────┐     ┌─────────────────┐   ┌─────────────────────┐     │
│   │  CLAUDE     │◀────│  INJECTION      │   │  RESEARCH DB        │     │
│   │  CONTEXT    │     │  MANAGER        │   │  ~/.claude-research │     │
│   └─────────────┘     └─────────────────┘   └─────────────────────┘     │
│                                                                          │
│   ═══════════════════════════════════════════════════════════════════   │
│                                                                          │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐               │
│   │  HTTP API   │     │  DASHBOARD  │     │  SETTINGS   │               │
│   │  :3200      │     │  + SEARCH   │     │  PANEL      │               │
│   └─────────────┘     └─────────────┘     └─────────────┘               │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Features

### Core Capabilities
- **Multi-AI Provider** — Choose between Claude (via Agent SDK) or Gemini Flash for synthesis
- **Intelligent Trigger Detection** — Recognizes questions, errors, and research-worthy patterns
- **Priority Queue Management** — Research tasks are prioritized by relevance and urgency
- **Passive Context Injection** — Results are injected without disrupting your workflow
- **Web Dashboard** — Monitor research, run manual searches, and configure settings at http://localhost:3200
- **Plugin Architecture** — Install as a Claude Code plugin with hooks and skills

### Advanced Features
- **Multi-Agent Research** — Specialized agents (web-search, code-expert, docs-expert) work in parallel
- **Source Quality Tracking** — Learns which domains are reliable for specific topics
- **Progressive Disclosure** — 3-tier injection system (summary → key points → full content)
- **Rate Limiting** — Prevents runaway API costs with configurable limits
- **Bun Runtime** — Fast startup, native SQLite, no native module compilation

---

## Search Engines & Tools

### Built-in (Always Available)

| Tool | Purpose | Cost |
|------|---------|------|
| **Claude Agent SDK** | AI synthesis (default) | Uses your Claude account |
| **Gemini Flash** | AI synthesis (alternative) | Free with API key |
| **Jina Reader** | Web page scraping | Free, unlimited |
| **SQLite + FTS5** | Local storage with full-text search | Free, built-in |

### Search APIs (Configure at least one)

| Provider | What It Does | Free Tier | Sign Up |
|----------|--------------|-----------|---------|
| **Serper** ⭐ | Google search results (recommended) | 2,500 queries/month | [serper.dev](https://serper.dev) |
| **Brave** | Privacy-focused web search | 2,000 queries/month | [brave.com/search/api](https://brave.com/search/api) |
| **Tavily** | AI-optimized search results | 1,000 queries/month | [tavily.com](https://tavily.com) |

**You need at least one search API key** — without it, the research crew can't search the web.

---

## Prerequisites

### Required

- **[Bun](https://bun.sh)** — Fast JavaScript runtime with native SQLite
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- **Search API Key** — At least one of Serper, Brave, or Tavily

### Optional

- **Gemini API Key** — For free AI synthesis alternative to Claude
  - Get a free key at [Google AI Studio](https://aistudio.google.com/apikey)
- **[claude-mem](https://github.com/thedotmack/claude-mem)** — For cross-session memory persistence

---

## Installation

### Option 1: Install as Claude Code Plugin (Recommended)

```bash
# Install from GitHub
claude plugins install bigph00t/claude-research-team

# Or install from local path during development
claude plugins install /path/to/claude-research-team
```

The plugin automatically:
- Starts the background research service on port 3200
- Registers lifecycle hooks (SessionStart, SessionEnd, UserPromptSubmit, PostToolUse)
- Makes skills available (`research`, `research-status`, `research-detail`)

### Option 2: Manual Installation

```bash
# Clone the repository
git clone https://github.com/bigph00t/claude-research-team.git
cd claude-research-team

# Install dependencies with Bun
bun install

# Build TypeScript and hooks
bun run build

# Set your search API key(s)
export SERPER_API_KEY="your-key-here"
# Optional: Gemini for free AI synthesis
export GEMINI_API_KEY="your-key-here"

# Start the service
bun run start
```

The service runs on port **3200**. Open http://localhost:3200 to view the dashboard.

### Verify Installation

```bash
# Check if service is running
curl http://localhost:3200/api/health

# Should return:
# {"status":"ok","timestamp":...}
```

---

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SERPER_API_KEY` | Serper.dev API key | At least one search key |
| `BRAVE_API_KEY` | Brave Search API key | At least one search key |
| `TAVILY_API_KEY` | Tavily API key | At least one search key |
| `GEMINI_API_KEY` | Google Gemini API key | No (enables Gemini option) |
| `CLAUDE_RESEARCH_PORT` | HTTP service port | No (default: 3200) |
| `CLAUDE_RESEARCH_DATA_DIR` | Data directory | No (default: ~/.claude-research-team) |

### Dashboard Settings

Access the settings panel at **http://localhost:3200** to configure:

- **AI Provider** — Choose between Claude or Gemini for synthesis
- **Claude Model** — Select haiku (fast), sonnet (balanced), or opus (capable)
- **Gemini Model** — Select from available Gemini models (when API key detected)
- **Autonomous Research** — Enable/disable background research
- **Confidence Threshold** — Minimum confidence to trigger research (0.5-1.0)
- **Rate Limits** — Max researches per hour, session cooldown

### Config File

Configuration is stored in `~/.claude-research-team/config.json`:

```json
{
  "port": 3200,
  "dataDir": "~/.claude-research-team",
  "logLevel": "info",
  "defaultDepth": "medium",
  "engines": ["serper", "brave", "tavily"],
  "research": {
    "autonomousEnabled": true,
    "confidenceThreshold": 0.85,
    "sessionCooldownMs": 60000,
    "maxResearchPerHour": 20
  },
  "aiProvider": {
    "provider": "claude",
    "claudeModel": "sonnet",
    "geminiModel": "gemini-2.0-flash-exp"
  }
}
```

---

## How It Works

### 1. Trigger Detection

When you send a prompt, the research service analyzes it for research opportunities:

```typescript
// Patterns that trigger research:
- Questions: "how do I...", "what is...", "why does..."
- Errors: "error:", "failed:", stack traces
- Technical queries: library names, API references
- Comparisons: "X vs Y", "best way to..."
```

If confidence ≥ 0.85, research is queued in the background (subject to rate limits).

### 2. Research Execution

The research executor:

1. **Checks memory** — Finds related past research to avoid redundancy
2. **Searches** — Queries configured search APIs in parallel
3. **Scrapes** — Extracts content from top results using Jina Reader
4. **Synthesizes** — Uses Claude or Gemini to create intelligent summary
5. **Stores** — Saves to local SQLite database with FTS5 indexing

### 3. Context Injection

After each tool use, the `PostToolUse` hook:

1. Checks if relevant research has completed
2. Formats findings as XML context block
3. Returns via `additionalContext` field
4. Claude sees the research and can use it

```xml
<research-context query="how to implement rate limiting">
Rate limiting in Node.js can be implemented using token bucket
or sliding window algorithms. Popular libraries include
rate-limiter-flexible and express-rate-limit.

**Sources:**
- [Rate Limiting Best Practices](https://example.com/rate-limiting)
- [Express Rate Limit Documentation](https://example.com/express-rate-limit)

_More detail available: use /research-detail abc123_
</research-context>
```

---

## Research Depths

| Depth | Iterations | Max Searches | Best For |
|-------|------------|--------------|----------|
| `quick` | 1 | 5 | Simple facts, definitions (default for background) |
| `medium` | 1 | 10 | How-to questions, technical docs |
| `deep` | 2 | 20 | Complex comparisons, thorough research |

### Rate Limiting

To prevent runaway API costs, the system enforces:
- **Global limit**: Maximum 20 background researches per hour
- **Session cooldown**: 1 minute between researches per session
- **Confidence threshold**: 0.85 (only high-confidence triggers execute)

Manual research via dashboard or skills bypasses these limits.

---

## Using the Skills

Once installed, you can manually trigger research:

```
Use the research skill to look up "best practices for rate limiting in Node.js"
```

### Available Skills

| Skill | Description |
|-------|-------------|
| `research` | Execute research on a topic (supports quick/medium/deep depth) |
| `research-status` | Check queue status and recent findings |
| `research-detail` | Get more detail from a previous finding |

---

## Web Dashboard

Access the dashboard at **http://localhost:3200** to:

- **Search manually** — Run research queries directly
- **View findings** — Browse all research results with sources
- **Monitor injections** — See what context was injected into sessions
- **Configure settings** — Adjust AI provider, rate limits, and more
- **Track queue** — See pending and running research tasks

---

## API Reference

### Health & Status

```http
GET /api/health          # Health check
GET /api/status          # Service status with queue stats
```

### Research

```http
POST /api/research       # Queue new research
{
  "query": "how to implement caching",
  "depth": "medium",      # quick | medium | deep
  "sessionId": "optional"
}

GET /api/findings        # List recent findings
GET /api/queue/stats     # Queue statistics
```

### Settings

```http
GET /api/settings        # Get current settings
POST /api/settings       # Update settings
{
  "aiProvider": "gemini",
  "claudeModel": "sonnet",
  "geminiModel": "gemini-2.0-flash-exp",
  "autonomousEnabled": true,
  "confidenceThreshold": 0.85
}
```

---

## Troubleshooting

### "Service not running"

```bash
# Start the service
bun run start

# Check if port 3200 is in use
lsof -i :3200
```

### "No search results"

Ensure you have at least one search API key set:

```bash
export SERPER_API_KEY="your-key-here"
```

### "Research not triggering"

Check the dashboard settings:
- Is "Autonomous Research" enabled?
- Is the confidence threshold too high?
- Are you hitting the rate limit?

### "Hooks not firing"

Verify the plugin is installed:

```bash
claude plugins list
```

Rebuild if needed:

```bash
bun run clean && bun run build
```

---

## Development

```bash
# Development build with watch
bun run dev

# Run tests
bun test

# Lint
bun run lint

# Clean build
bun run clean && bun run build
```

---

## Project Structure

```
claude-research-team/
├── assets/               # Logo images
├── src/
│   ├── agents/           # Agent architecture
│   │   ├── coordinator.ts        # Research planning & synthesis
│   │   └── conversation-watcher.ts   # Proactive trigger detection
│   ├── ai/               # AI provider abstraction
│   │   └── provider.ts           # Claude/Gemini unified interface
│   ├── crew/             # Research execution
│   │   ├── autonomous-crew.ts    # Self-directing research
│   │   └── research-executor.ts  # Single research execution
│   ├── database/         # SQLite with FTS5
│   │   ├── index.ts              # Main database operations
│   │   └── sqlite-adapter.ts     # Bun/Node.js SQLite compatibility
│   ├── hooks/            # Claude Code lifecycle hooks
│   ├── memory/           # Optional claude-mem integration
│   ├── service/          # HTTP service & dashboard
│   ├── skills/           # Claude Code skills
│   ├── utils/            # Logger, config utilities
│   └── types.ts          # TypeScript types
├── plugin.json           # Claude Code plugin manifest
├── package.json
└── tsconfig.json
```

---

## License

**AGPL-3.0** — See [LICENSE](LICENSE) for details.

---

## Related Projects

- **[claude-mem](https://github.com/thedotmack/claude-mem)** — Persistent memory for Claude Code (optional integration)
- **[Claude Agent SDK](https://docs.anthropic.com/claude-code)** — Powers the AI synthesis

---

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `bun test` and `bun run lint`
5. Submit a pull request
