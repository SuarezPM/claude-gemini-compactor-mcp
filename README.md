# Claude-Gemini "Compactor" MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-5B4FBE?logo=anthropic)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/version-2.0.0-brightgreen.svg)](https://github.com/SuarezPM/claude-gemini-compactor-mcp/releases)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> An MCP server that protects Claude's context window by delegating large file reads to Gemini — invisibly, locally, zero Claude tokens burned.

> Un servidor MCP que protege la ventana de contexto de Claude delegando la lectura de archivos masivos a Gemini — de forma invisible, local, sin quemar tokens de Claude.

---

## Quick Start

```bash
git clone https://github.com/SuarezPM/claude-gemini-compactor-mcp.git
cd claude-gemini-compactor-mcp
npm install && cp .env.example .env  # add your GEMINI_API_KEY
```

Then register in your [MCP config](#configuration) and restart Claude Code.

---

## Table of Contents

- [The Problem](#the-problem)
- [The Solution: Airgap Protocol](#the-solution-airgap-protocol)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Tool Reference](#tool-reference)
- [Model Selection Guide](#model-selection-guide)
- [Security](#security)
- [Token Savings](#token-savings)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## The Problem

Reading large files directly in Claude Code is expensive and destructive:

- A 10,000-line log file consumes **50–80% of Claude's context window** in one read.
- Once the context fills, Claude loses memory of earlier instructions.
- Costs spiral as Claude re-reads files on every message to "remember" them.
- The agent becomes slow, confused, and expensive — all from a single `cat syslog.log`.

> 🇪🇸 Leer archivos grandes directamente en Claude Code es caro y destructivo: un log de 10,000 líneas puede consumir el 50–80% de la ventana de contexto. Una vez lleno, Claude pierde la memoria de instrucciones anteriores y los costos escalan con cada re-lectura.

---

## The Solution: Airgap Protocol

The Compactor is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server with one mission: **keep Claude's context window clean**. It acts as an invisible middleman — Claude passes a file path, Node.js reads the disk locally, and Gemini processes the raw text in its own 2M-token context. Claude only receives the final distilled answer.

```
┌──────────────────┐   path string only   ┌─────────────────────┐
│      CLAUDE      │ ────────────────────► │    MCP SERVER       │
│                  │                       │    (Node.js)        │
│  context stays   │ ◄────────────────────  │    reads disk       │
│     clean ✓      │   distilled answer    └──────────┬──────────┘
└──────────────────┘     (~500 tokens)                │ raw text
                                                       │ (no Claude tokens burned)
                                                       ▼
                                             ┌───────────────────┐
                                             │   GEMINI 2.x      │
                                             │   (2M context)    │
                                             │   flash-lite /    │
                                             │   flash / pro     │
                                             └───────────────────┘
```

**How it works:**
1. **Claude never reads the file.** It only passes the absolute path as a string parameter.
2. **Node.js reads the disk locally** — silently, without touching Claude's context.
3. **Gemini receives the raw text** and processes it in its 2M-token context.
4. **Claude receives only the result** — a concise answer that costs a fraction of the tokens.

> 🇪🇸 **Cómo funciona:** Claude solo pasa la ruta del archivo. Node.js lee el disco localmente. Gemini procesa el texto crudo en su propio contexto de 2M tokens. Claude recibe solo el resultado destilado — una fracción del costo.

---

## Prerequisites

- **Node.js ≥ 18** — required for native `fetch()` and ESM support
- **npm ≥ 9** — for package management
- **Google AI Studio account** — [get a free API key](https://aistudio.google.com/)
- **Claude Code** or any MCP-compatible client

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/SuarezPM/claude-gemini-compactor-mcp.git
cd claude-gemini-compactor-mcp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and add your key:

```env
GEMINI_API_KEY=your_google_ai_studio_key_here
```

Get a free key at [Google AI Studio](https://aistudio.google.com/). The free tier is sufficient for most use cases.

---

## Configuration

Register the server in your MCP client config. The server fails fast with a clear error if `GEMINI_API_KEY` is missing.

### Claude Code (CLI)

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gemini-compactor": {
      "command": "node",
      "args": ["/absolute/path/to/claude-gemini-compactor-mcp/server.js"]
    }
  }
}
```

### Claude Desktop (App)

| Platform | Config file path |
|----------|-----------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/claude/claude_desktop_config.json` |

Restart Claude after saving. The three tools will appear in your available tools list.

> **Note:** The `GEMINI_API_KEY` is loaded from `.env` by dotenv at startup. Do **not** commit `.env` to git — it is already in `.gitignore`.

---

## Usage

### Single file analysis · Análisis de archivo

```
Claude, use ask_gemini with instruction "Extract all CRITICAL and ERROR entries,
group by frequency" on input_file "/var/log/syslog" and save to "docs/errors.md".
```

```
Claude, usa ask_gemini con instruction "Extrae los 5 patrones de precio más competitivos
con su frecuencia" sobre input_file "/home/pablo/dump_etsy.txt".
```

### URL ingestion · Ingestión de URLs

```
Claude, use ask_gemini_url with url "https://api.example.com/data"
and instruction "Extract all product prices as JSON" with output_format "json".
```

### Batch processing · Procesamiento en lote

```
Claude, use ask_gemini_batch with input_files ["logs/mon.log", "logs/tue.log", "logs/wed.log"]
and instruction "Summarize all ERROR entries by day" and save to "docs/weekly_errors.md".
```

### Structured JSON output

```
Claude, use ask_gemini with instruction "Return a JSON array of {file, error_code, count}
for all errors" on input_file "logs/app.log" with output_format "json".
```

---

## Tool Reference

### `ask_gemini`

General-purpose file ingestion. Reads one file locally, processes it with Gemini.

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `instruction` | ✅ | string | What Gemini should do with the content |
| `input_file` | ❌ | string | File path to read (Claude never sees the content) |
| `output_file` | ❌ | string | Path to save the result |
| `model` | ❌ | enum | `flash-lite` (default) · `flash` · `pro` |
| `output_format` | ❌ | enum | `text` (default) · `json` |

### `ask_gemini_url`

Fetches a URL locally via Node.js and delegates processing to Gemini. Claude never sees the raw response body.

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `url` | ✅ | string | URL to fetch and process |
| `instruction` | ✅ | string | What Gemini should do with the fetched content |
| `output_file` | ❌ | string | Path to save the result |
| `model` | ❌ | enum | `flash-lite` (default) · `flash` · `pro` |
| `output_format` | ❌ | enum | `text` (default) · `json` |

### `ask_gemini_batch`

Reads multiple files in parallel via `Promise.all()` and processes them in a single Gemini call. Ideal for multi-file audits, weekly log summaries, or cross-module analysis.

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `instruction` | ✅ | string | What Gemini should do with all files |
| `input_files` | ✅ | string[] | Array of file paths to process together |
| `output_file` | ❌ | string | Path to save the combined result |
| `model` | ❌ | enum | `flash-lite` (default) · `flash` · `pro` |
| `output_format` | ❌ | enum | `text` (default) · `json` |

---

## Model Selection Guide

All three tools accept an optional `model` parameter. Choose based on your task:

| Model key | Gemini model | Best for | Speed | Cost |
|-----------|-------------|----------|-------|------|
| `flash-lite` | `gemini-2.5-flash-lite` | Bulk log parsing, large data extraction, high-volume batch jobs | ⚡⚡⚡ | Free tier |
| `flash` | `gemini-2.0-flash` | Structured extraction, code analysis, multi-file summarization | ⚡⚡ | Low |
| `pro` | `gemini-1.5-pro` | Complex reasoning, nuanced analysis, long-form report generation | ⚡ | Standard |

**Default is `flash-lite`** — it handles the vast majority of use cases and runs on Google's free tier.

---

## Security

The server enforces three security guarantees:

### 1. Path traversal protection

All file paths are validated using `path.relative()` before any disk access. A path like `../../etc/passwd` is rejected with `Access denied`.

```js
// The fix — startsWith(cwd) is bypassable with /home/pablo-evil/
const relative = path.relative(process.cwd(), resolved);
if (relative.startsWith('..') || path.isAbsolute(relative)) {
  throw new Error(`Access denied: '${filePath}' is outside the working directory.`);
}
```

### 2. File size cap (50MB)

Files exceeding 50MB are rejected before being read into memory, preventing OOM crashes.

### 3. Fail-fast API key validation

The server exits immediately at startup with a clear error message if `GEMINI_API_KEY` is not set — no silent runtime failures.

---

## Token Savings

| Scenario | Without Compactor | With Compactor |
|----------|-------------------|----------------|
| 10K-line log analysis | ~80,000 Claude tokens | ~500 Claude tokens |
| 500KB data dump | Context overflow | ~800 Claude tokens |
| 5-file batch audit | 5× full file reads | ~1,200 Claude tokens |
| URL ingestion (50KB page) | ~40,000 Claude tokens | ~600 Claude tokens |

*Claude token estimates based on ~4 chars/token average. Gemini tokens are billed to your Google AI account separately.*

---

## Troubleshooting

**`[FATAL] GEMINI_API_KEY is not set`**
→ You forgot to create `.env` or the key is blank. Run `cp .env.example .env` and add your key.

**`Access denied: '../../etc/passwd' is outside the working directory`**
→ The path traversal guard blocked an unsafe path. Use paths relative to your project root.

**`File too large: 62.3MB exceeds 50MB limit`**
→ Split the file or pre-filter it before passing to the tool. The 50MB cap is a hard safety limit.

**Tool does not appear in Claude after config change**
→ Restart Claude completely (not just the chat). MCP servers are loaded at startup.

**`HTTP 403 fetching: https://...` on ask_gemini_url**
→ The target server blocks automated requests. Try adding a different URL or check if auth is required.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes following [Conventional Commits](https://www.conventionalcommits.org/)
4. Open a Pull Request against `master`

Please keep `server.js` focused on the Airgap Protocol. New tools should follow the `ask_gemini_*` naming pattern and use the shared `callGemini()` and `writeOutput()` helpers.

---

## License

MIT © 2025–2026 Pablo ([SuarezPM](https://github.com/SuarezPM))
