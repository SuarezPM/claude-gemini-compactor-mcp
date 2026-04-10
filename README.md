# Claude-Gemini Compactor MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-5B4FBE?logo=anthropic)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/version-2.0.0-brightgreen.svg)](https://github.com/SuarezPM/claude-gemini-compactor-mcp/releases)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

> **50 lines of Node.js. A perfect closed circuit. Your Anthropic token quota, untouched.**

> **50 líneas de Node.js. Un circuito cerrado perfecto. Tu cuota de tokens de Anthropic, intacta.**

---

## The Problem with Claude + Large Files

Every time Claude reads a massive file, something dies inside your token budget.

A 10,000-line log. A 500KB API dump. A folder of weekly reports.
Claude loads it all into its context window — and you pay for every single token.
Then it forgets. And loads it again on the next message.

**This is the hidden tax on every developer using Claude Code at scale.**

> 🇪🇸 Cada vez que Claude lee un archivo masivo, algo muere dentro de tu presupuesto de tokens. Un log de 10,000 líneas. Un dump de 500KB. Una carpeta de reportes semanales. Claude lo carga todo en su ventana de contexto — y tú pagas por cada token. Luego lo olvida. Y lo vuelve a cargar en el siguiente mensaje. **Este es el impuesto oculto que paga todo desarrollador que usa Claude Code a escala.**

---

## The Solution: A Context Bypass Bridge

The Compactor is **not** a wrapper. It is not a prompt trick. It is not a workaround.

It is a **context bypass bridge** — a lightweight MCP server written in ~50 lines of Node.js that runs natively and transparently in your OS terminal. It teaches Claude one sacred rule:

> **Never read the file. Pass the path. Let the bridge handle the rest.**

Claude passes an absolute file path as a string. That is all it knows. Our Node.js server intercepts the path, reads the raw bytes from your local disk without ever touching Claude's cognitive memory, tunnels the data directly into the Gemini Flash API, and writes the analyzed result back to disk in Markdown — all in a closed circuit Claude never enters.

**The result: you spend ~500 Claude tokens where you used to spend 80,000.**

> 🇪🇸 El Compactor es un **puente de evasión de contexto** — un servidor MCP liviano en ~50 líneas de Node.js que corre nativo y transparente en tu terminal. Le enseña a Claude una regla sagrada: **Nunca leas el archivo. Pasa la ruta. El puente se encarga del resto.** Claude pasa una ruta absoluta como string. Es todo lo que sabe. Nuestro servidor intercepta la ruta, lee los bytes crudos del disco local sin tocar jamás la memoria cognitiva de Claude, tuneliza los datos directamente hacia la API de Gemini Flash, y escribe el resultado analizado de vuelta en disco en Markdown — todo en un circuito cerrado que Claude nunca entra. **El resultado: gastas ~500 tokens de Claude donde antes gastabas 80,000.**

---

## How the Circuit Works

```
╔══════════════════╗   "here's the path"   ╔════════════════════════╗
║      CLAUDE      ║ ─────────────────────► ║    COMPACTOR SERVER    ║
║                  ║                        ║    (Node.js, ~50 loc)  ║
║  context stays   ║ ◄─────────────────────  ║    reads disk locally  ║
║  clean · cheap   ║   distilled answer     ╚═══════════╤════════════╝
║  ~500 tokens ✓   ║   (~500 tokens)                    │
╚══════════════════╝                                     │ raw bytes
                                                         │ (no Claude tokens burned)
                                                         ▼
                                             ╔═══════════════════════╗
                                             ║    GEMINI FLASH API   ║
                                             ║    2M-token context   ║
                                             ║    flash-lite · pro   ║
                                             ╚═══════════════════════╝
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
3. **Gemini processes the raw data** in its own 2M-token context. Claude's quota: untouched.
4. **The result lands on disk** (or returns to Claude) as a clean, distilled answer.

> 🇪🇸 **El circuito de 4 pasos:** Claude pasa una ruta. Node.js lee el disco localmente. Gemini procesa los datos crudos en su propio contexto de 2M tokens. El resultado llega al disco como una respuesta destilada y limpia.

---

## Our Mission

The developer ecosystem is **desperately searching** for efficient ways to delegate tasks across models — to save tokens, reduce costs, and sharpen logical reasoning by keeping each model in its lane.

Claude reasons. Gemini ingests. The Compactor connects them.

This project is proof that you don't need a complex orchestration framework to do multi-model delegation. You need **50 lines of Node.js and a clear separation of roles.**

> 🇪🇸 El ecosistema de desarrolladores está desesperado por encontrar formas eficientes de delegar tareas entre modelos — para ahorrar tokens, reducir costos, y mejorar el razonamiento manteniéndolo en su carril. Claude razona. Gemini ingiere. El Compactor los conecta. Este proyecto demuestra que no necesitas un framework de orquestación complejo para hacer delegación multi-modelo. Necesitas **50 líneas de Node.js y una separación clara de roles.**

---

## Table of Contents

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

## Prerequisites

- **Node.js ≥ 18** — required for native `fetch()` and ESM support
- **npm ≥ 9**
- **Google AI Studio account** — [get a free API key](https://aistudio.google.com/) (free tier is sufficient)
- **Claude Code** or any MCP-compatible client

---

## Installation

```bash
git clone https://github.com/SuarezPM/claude-gemini-compactor-mcp.git
cd claude-gemini-compactor-mcp
npm install
cp .env.example .env   # then add your GEMINI_API_KEY
```

---

## Configuration

Register the server in your MCP client. The server **exits immediately with a clear message** if `GEMINI_API_KEY` is missing — no silent failures.

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
|----------|-----------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/claude/claude_desktop_config.json` |

Restart Claude after saving. The three `ask_gemini_*` tools will appear automatically.

> **Note:** `GEMINI_API_KEY` is loaded from `.env` by dotenv at startup. It is already in `.gitignore`. Never commit it.

---

## Usage

### Analyze a massive log without burning Claude tokens

```
Claude, use ask_gemini with instruction "Extract all CRITICAL and ERROR entries,
group by frequency, top 10 only" on input_file "/var/log/syslog"
and save to "docs/errors.md".
```

### Extract structured data from a data dump

```
Claude, usa ask_gemini con instruction "Extrae los 5 patrones de precio más
competitivos con su frecuencia" sobre input_file "/home/pablo/dump_etsy.txt"
con output_format "json".
```

### Ingest a URL without Claude seeing the response body

```
Claude, use ask_gemini_url with url "https://api.example.com/data"
and instruction "Extract all product prices as a JSON array" with output_format "json".
```

### Summarize a full week of logs in one call

```
Claude, use ask_gemini_batch with input_files ["logs/mon.log", "logs/tue.log",
"logs/wed.log", "logs/thu.log", "logs/fri.log"] and instruction
"Summarize all ERROR entries by day" and save to "docs/weekly_errors.md".
```

---

## Tool Reference

### `ask_gemini` — Single file or prompt

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `instruction` | ✅ | string | What Gemini should do |
| `input_file` | ❌ | string | File path — Claude never sees the content |
| `output_file` | ❌ | string | Path to save the result to disk |
| `model` | ❌ | enum | `flash-lite` · `flash` · `pro` (default: `flash-lite`) |
| `output_format` | ❌ | enum | `text` · `json` (default: `text`) |

### `ask_gemini_url` — URL ingestion

Fetches a URL locally via Node.js. Claude never sees the raw HTML or response body.

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `url` | ✅ | string | URL to fetch and process |
| `instruction` | ✅ | string | What Gemini should do with the content |
| `output_file` | ❌ | string | Path to save the result |
| `model` | ❌ | enum | Default: `flash-lite` |
| `output_format` | ❌ | enum | Default: `text` |

### `ask_gemini_batch` — Parallel multi-file ingestion

Reads all files simultaneously via `Promise.all()` and sends them in a single Gemini call.

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `instruction` | ✅ | string | What Gemini should do with all files |
| `input_files` | ✅ | string[] | Array of file paths |
| `output_file` | ❌ | string | Path to save the combined result |
| `model` | ❌ | enum | Default: `flash-lite` |
| `output_format` | ❌ | enum | Default: `text` |

---

## Model Selection Guide

| Key | Gemini model | Best for | Speed | Cost |
|-----|-------------|----------|-------|------|
| `flash-lite` | `gemini-2.5-flash-lite` | Bulk log parsing, large data extraction, high-volume batch jobs | ⚡⚡⚡ | Free tier |
| `flash` | `gemini-2.0-flash` | Structured extraction, code analysis, multi-file summarization | ⚡⚡ | Low |
| `pro` | `gemini-1.5-pro` | Complex reasoning, nuanced analysis, long-form reports | ⚡ | Standard |

**Default is `flash-lite`** — runs on Google's free tier and handles 95% of use cases.

---

## Security

The server enforces three hard guarantees on every file operation:

**1. Path traversal protection** — `path.relative()` validation blocks `../../etc/passwd`-style attacks before any disk read occurs. The naive `startsWith(cwd)` check it replaced was bypassable.

**2. 50MB file size cap** — files exceeding 50MB are rejected before being read into memory, preventing OOM crashes on unexpectedly large inputs.

**3. Fail-fast API key validation** — the server exits at startup with `[FATAL] GEMINI_API_KEY is not set` if the key is missing. No silent runtime failures mid-task.

---

## Token Savings

| Scenario | Without Compactor | With Compactor | Savings |
|----------|-------------------|----------------|---------|
| 10K-line log analysis | ~80,000 Claude tokens | ~500 Claude tokens | **99.4%** |
| 500KB data dump | Context overflow | ~800 Claude tokens | ∞ |
| 5-file batch audit | 5× full file reads | ~1,200 Claude tokens | **~98%** |
| URL ingestion (50KB page) | ~40,000 Claude tokens | ~600 Claude tokens | **98.5%** |

*Claude token estimates at ~4 chars/token. Gemini usage billed separately to your Google AI account.*

---

## Troubleshooting

**`[FATAL] GEMINI_API_KEY is not set`**
→ Run `cp .env.example .env` and add your key from [Google AI Studio](https://aistudio.google.com/).

**`Access denied: '../../etc/passwd' is outside the working directory`**
→ Use paths relative to your project root. The path guard is working correctly.

**`File too large: 62.3MB exceeds 50MB limit`**
→ Pre-filter or split the file before passing it to the tool.

**Tool does not appear in Claude after config change**
→ Restart Claude completely. MCP servers are loaded at startup, not hot-reloaded.

**`HTTP 403 fetching: https://...` on ask_gemini_url**
→ The target server is blocking automated requests. Check if authentication is required.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit following [Conventional Commits](https://www.conventionalcommits.org/)
4. Open a Pull Request against `master`

New tools should follow the `ask_gemini_*` naming pattern and use the shared `callGemini()` and `writeOutput()` helpers. Keep `server.js` focused on the Airgap Protocol — no bloat.

---

## License

MIT © 2025–2026 Pablo ([SuarezPM](https://github.com/SuarezPM))
