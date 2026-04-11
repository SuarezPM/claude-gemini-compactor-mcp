<div align="center">

<img src="bannergit.png" alt="Claude-Gemini Compactor MCP" width="100%">

# Claude-Gemini Compactor MCP

<img src="logogit.png" alt="Compactor Logo" width="80">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-5B4FBE?logo=anthropic)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/version-7.0.0-brightgreen.svg)](https://github.com/SuarezPM/claude-gemini-compactor-mcp/releases)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

> **A perfect closed circuit. Your Anthropic token quota, untouched.**
> **v7.0: Local-First Pipeline — Gemma4/Ollama (0 cloud tokens) → Groq fallback. 8 tools. ask\_smart runs free when Ollama handles it.**

---

## The Problem with Claude + Large Files

Every time Claude reads a massive file, something dies inside your token budget.

A 10,000-line log. A 500KB API dump. A folder of weekly reports.
Claude loads it all into its context window — and you pay for every single token.
Then it forgets. And loads it again on the next message.

**This is the hidden tax on every developer using Claude Code at scale.**

---

## The Solution: A Context Bypass Bridge

The Compactor is **not** a wrapper. It is not a prompt trick. It is not a workaround.

It is a **context bypass bridge** — a lightweight MCP server written in ~280 lines of Node.js that runs natively and transparently in your OS terminal. It teaches Claude one sacred rule:

> **Never read the file. Pass the path. Let the bridge handle the rest.**

Claude passes an absolute file path as a string. That is all it knows. Our Node.js server intercepts the path, reads the raw bytes from your local disk without ever touching Claude's cognitive memory, tunnels the data into Gemma4 (local, free) or Groq (cloud, fast), and writes the analyzed result back to disk in Markdown — all in a closed circuit Claude never enters.

**The result: you spend ~500 Claude tokens where you used to spend 80,000.**

---

## How the Circuit Works

<div align="center">
<img src="example.png" alt="Compactor flow diagram" width="720">
</div>

```
╔══════════════════╗   "here's the path"    ╔════════════════════════╗
║      CLAUDE      ║ ────────────────────►  ║   COMPACTOR SERVER     ║
║                  ║                        ║   (Node.js, ~280 loc)  ║
║  context stays   ║ ◄────────────────────  ║   reads disk locally   ║
║  clean · cheap   ║   distilled answer     ╚════════════════════════╝
║  ~500 tokens ✓   ║   (~500 tokens)
╚══════════════════╝                                       │ raw bytes
                                                           │ (no Claude tokens burned)
                                                           ▼
                                             ╔═══════════════════════════╗
                                             ║  SMART ROUTER  (v7)       ║
                                             ║  local  → Gemma4/Ollama   ║
                                             ║           (0 cloud tokens) ║
                                             ║  cloud  → Groq only        ║
                                             ║  auto   → Ollama first,    ║
                                             ║           Groq if needed   ║
                                             ╚═══════════════════════════╝
                                                         │
                                                         │ analyzed result
                                                         ▼
                                             ╔═══════════════════════╗
                                             ║    LOCAL DISK         ║
                                             ║    output.md          ║
                                             ╚═══════════════════════╝
```

**The 4-step closed circuit:**

1. **Claude passes a path string.** It never sees the file contents. Not one byte.
2. **Node.js reads the disk locally.** Silent. No network. No Claude memory involved.
3. **Smart router picks the provider** — Ollama/Gemma4 first (0 cloud tokens), escalates to Groq only when local output is insufficient.
4. **The result lands on disk** (or returns to Claude) as a clean, distilled answer with token counts and provider used.

---

## Our Mission

The developer ecosystem is **desperately searching** for efficient ways to delegate tasks across models — to save tokens, reduce costs, and sharpen logical reasoning by keeping each model in its lane.

Claude reasons. The Router ingests, routes, and costs. Each model stays in its lane.

This project is proof that you don't need a complex orchestration framework to do multi-model delegation. You need **a clear AIRGAP protocol and a local-first pipeline.**

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Tool Reference](#tool-reference)
- [Provider Architecture](#provider-architecture)
- [Security](#security)
- [Token Savings](#token-savings)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Prerequisites

- **Node.js ≥ 18** — required for native `fetch()` and ESM support
- **npm ≥ 9**
- **Groq API key** (required): [console.groq.com](https://console.groq.com/) — 128K ctx, ~200ms, free tier
- **Ollama** (optional, recommended): [ollama.com](https://ollama.com/) — local inference, 0 cloud tokens
  - Pull the model: `ollama pull gemma4:e4b`
- **Claude Code** or any MCP-compatible client

---

## Installation

```bash
git clone https://github.com/SuarezPM/claude-gemini-compactor-mcp.git
cd claude-gemini-compactor-mcp
npm install
cp .env.example .env   # then add your GROQ_API_KEY
```

---

## Configuration

Register the server in your MCP client. The server **exits immediately with a clear message** if `GROQ_API_KEY` is not set — no silent failures.

Add to your `.env`:

```env
GROQ_API_KEY=your_groq_key_here          # required — cloud fallback
# OLLAMA_BASE_URL=http://localhost:11434  # optional — local inference (no /v1 suffix)
# OLLAMA_MODEL=gemma4:e4b                 # optional — default: gemma4:e4b
```

### Claude Code (CLI)

`~/.claude/claude_desktop_config.json`:

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
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/claude/claude_desktop_config.json` |

Restart Claude after saving. All **8 tools** will appear automatically.

> **Note:** Keys are loaded from `.env` by dotenv at startup. `.env` is in `.gitignore`. Never commit it.

---

## Usage

### Local-first task (0 cloud tokens if Gemma4 handles it)

```
Claude, use ask_smart with instruction "Extract all CRITICAL and ERROR entries,
group by frequency, top 10 only" on input_file "/var/log/syslog"
and save to "docs/errors.md".
```

> `ask_smart` tries Gemma4 locally first. Escalates to Groq only if local output < 80 chars.

### Force cloud processing

```
Claude, use ask_ai with task_type "cloud" and instruction "Extract the 5 most competitive price
patterns with their frequency" on input_file "data/dump.txt"
with output_format "json".
```

### Ingest a URL without Claude seeing the response body

```
Claude, use ask_url with url "https://api.example.com/data"
and instruction "Extract all product prices as a JSON array" with output_format "json".
```

### Summarize a full week of logs in one call

```
Claude, use ask_batch with input_files ["logs/mon.log", "logs/tue.log",
"logs/wed.log", "logs/thu.log", "logs/fri.log"] and instruction
"Summarize all ERROR entries by day" and save to "docs/weekly_errors.md".
```

---

## Tool Reference

### `ask_ai` — Single file or prompt

Routes to local or cloud based on `task_type`. Auto-triggered for log files >100 lines, bulk data extraction, or any task where Claude would otherwise read large raw content.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `instruction` | ✅ | string | What the AI should do |
| `input_file` | ❌ | string | File path — Claude never sees the content |
| `output_file` | ❌ | string | Path to save the result to disk |
| `output_format` | ❌ | enum | `text` · `json` (default: `text`) |
| `task_type` | ❌ | enum | `local` · `cloud` · `auto` (default: `auto`) |

### `ask_local` — Local / offline inference only

Runs exclusively on Ollama/Gemma4. Zero cloud tokens. Requires Ollama running locally.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `instruction` | ✅ | string | What the local model should do |
| `input_file` | ❌ | string | File path to process locally |
| `output_file` | ❌ | string | Path to save the result |
| `output_format` | ❌ | enum | Default: `text` |

### `ask_smart` — Local-first pipeline (preferred)

Tries Gemma4/Ollama first (0 cloud tokens). Escalates to Groq only if local output < 80 chars or Ollama is unavailable.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `instruction` | ✅ | string | What the AI should do |
| `input_file` | ❌ | string | File path — Claude never sees the content |
| `output_file` | ❌ | string | Path to save the result to disk |
| `output_format` | ❌ | enum | `text` · `json` (default: `text`) |

### `ask_url` — URL ingestion

Fetches a URL locally via Node.js. Claude never sees the raw HTML or response body.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `url` | ✅ | string | URL to fetch and process |
| `instruction` | ✅ | string | What the AI should do with the content |
| `output_file` | ❌ | string | Path to save the result |
| `output_format` | ❌ | enum | Default: `text` |

### `ask_batch` — Parallel multi-file ingestion

Reads all files simultaneously via `Promise.all()` and sends them in a single call.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `instruction` | ✅ | string | What the AI should do with all files |
| `input_files` | ✅ | string[] | Array of file paths |
| `output_file` | ❌ | string | Path to save the combined result |
| `output_format` | ❌ | enum | Default: `text` |
| `task_type` | ❌ | enum | `local` · `cloud` · `auto` (default: `auto`) |

### `ask_diff` — Diff / patch analysis

Auto-triggered when working with `.diff` or `.patch` files >100 lines, or when asked to review a git diff.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `diff_file` | ✅ | string | Path to `.diff` or `.patch` file |
| `instruction` | ✅ | string | Analysis goal (e.g., "find breaking changes") |
| `output_file` | ❌ | string | Path to save the analysis |
| `output_format` | ❌ | enum | Default: `text` |

### `ask_schema` — Schema / data model analysis

Auto-triggered on `.prisma`, `.sql`, `.graphql`, or OpenAPI/Swagger files.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `schema_file` | ✅ | string | Path to schema file |
| `instruction` | ✅ | string | Analysis goal (e.g., "find N+1 risks") |
| `output_file` | ❌ | string | Path to save the analysis |
| `output_format` | ❌ | enum | Default: `text` |

### `ask_compress` — Context compaction

Two-stage: Gemma4 (local) pre-compresses, Groq finalizes. Auto-triggered on `/compact` requests or when a file exceeds 50KB.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `input_file` | ✅ | string | File to compact |
| `instruction` | ❌ | string | Focus for the summary (default: concise summary) |
| `output_file` | ❌ | string | Path to save the compacted result |

---

## Provider Architecture

v7.0 uses exactly two providers. No registration table. No model tiers.

| Provider | Model | Cost | When used |
| --- | --- | --- | --- |
| **Ollama** (local) | `gemma4:e4b` | Free — 0 cloud tokens | `task_type: local` or first attempt in `auto` |
| **Groq** (cloud) | `llama-3.3-70b-versatile` | Free tier (rate-limited) | `task_type: cloud`, or `auto` escalation when Ollama output < 80 chars |

**`ask_smart` / `auto` pipeline:**

```
Ollama/Gemma4 → output ≥ 80 chars? → done (0 cloud tokens)
                output < 80 chars?  → escalate to Groq
                Ollama unavailable? → escalate to Groq
```

`ask_compress` always uses both: Gemma4 pre-compresses locally, Groq finalizes.

---

## Security

The server enforces four hard guarantees on every operation:

**1. Path traversal protection** — `path.relative()` validation blocks `../../etc/passwd`-style attacks before any disk read occurs.

**2. 50MB file size cap** — files exceeding 50MB are rejected before being read into memory, preventing OOM crashes on unexpectedly large inputs.

**3. SSRF guard** — `ask_url` blocks `file://`, private IPs (10.x, 172.16–31.x, 192.168.x), localhost, and `.local`/`.internal` hostnames.

**4. Fail-fast key validation** — the server exits at startup with `[FATAL] GROQ_API_KEY not set` if the required key is missing. No silent runtime failures mid-task.

---

## Token Savings

| Scenario | Without Compactor | With Compactor | Savings |
| --- | --- | --- | --- |
| 10K-line log analysis | ~80,000 Claude tokens | ~500 Claude tokens | **99.4%** |
| 500KB data dump | Context overflow | ~800 Claude tokens | ∞ |
| 5-file batch audit | 5× full file reads | ~1,200 Claude tokens | **~98%** |
| URL ingestion (50KB page) | ~40,000 Claude tokens | ~600 Claude tokens | **98.5%** |

*Claude token estimates at ~4 chars/token. Groq usage billed to your Groq account (free tier available).*

---

## Troubleshooting

**`[FATAL] GROQ_API_KEY not set`**
→ Add `GROQ_API_KEY=your_key` to your `.env` file and restart.

**`[WARN] Ollama failed or output too short, escalating to Groq`**
→ Expected behavior when Ollama is unavailable or returns an insufficient response. Groq handled the request.

**`[WARN] Ollama unavailable`**
→ Ollama is not running or not reachable at `OLLAMA_BASE_URL`. Start with `ollama serve` or verify the URL.

**`Access denied: '../../etc/passwd' is outside the working directory`**
→ Use paths relative to your project root. The path guard is working correctly.

**`File too large: 62.3MB exceeds 50MB limit`**
→ Pre-filter or split the file before passing it to the tool.

**Tool does not appear in Claude after config change**
→ Restart Claude completely. MCP servers are loaded at startup, not hot-reloaded.

**`HTTP 403 fetching: https://...` on ask_url**
→ The target server is blocking automated requests. Check if authentication is required.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit following [Conventional Commits](https://www.conventionalcommits.org/)
4. Open a Pull Request against `master`

New tools should follow the `ask_*` naming pattern and use the shared `callSmart()` and `writeOutput()` helpers. Keep `server.js` focused on the AIRGAP Protocol — no bloat.

---

## License

MIT © 2025–2026 Pablo ([SuarezPM](https://github.com/SuarezPM))
