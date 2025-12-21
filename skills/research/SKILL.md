---
name: research
description: Research a topic using autonomous web search and AI synthesis. Use when you need external information, documentation lookup, or to validate technical approaches.
---

# Research Skill

Research any topic using multi-agent web search and AI synthesis.

## When to Use

- Looking up unfamiliar APIs or libraries
- Need documentation or best practices
- Comparing technologies or approaches
- Encountering errors you don't recognize
- Validating technical decisions

## Usage

The research service must be running. Check with:
```
curl http://localhost:3200/api/health
```

### Quick Research (~10s)
For simple facts, definitions, quick lookups:
```bash
curl -X POST http://localhost:3200/api/research \
  -H "Content-Type: application/json" \
  -d '{"query": "What is HTMX?", "depth": "quick"}'
```

### Medium Research (~30s) - Default
For how-to questions, documentation lookup:
```bash
curl -X POST http://localhost:3200/api/research \
  -H "Content-Type: application/json" \
  -d '{"query": "How to implement rate limiting in FastAPI"}'
```

### Deep Research (~60s)
For comprehensive comparisons, complex topics:
```bash
curl -X POST http://localhost:3200/api/research \
  -H "Content-Type: application/json" \
  -d '{"query": "Rust vs Go for CLI tools", "depth": "deep"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| query | Yes | The research topic or question |
| depth | No | `quick`, `medium` (default), or `deep` |
| context | No | Additional context to focus the research |

## Examples

1. **API Lookup**: `{"query": "Bun SQLite named parameters syntax"}`
2. **Error Research**: `{"query": "ECONNREFUSED database connection error"}`
3. **Comparison**: `{"query": "PostgreSQL vs SQLite for local-first apps", "depth": "deep"}`
4. **With Context**: `{"query": "audio transcription APIs", "context": "comparing quality and latency for real-time use"}`

## Dashboard

View research activity and findings at: http://localhost:3200
