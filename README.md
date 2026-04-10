# Claude-Gemini "Compactor" MCP

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)
![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-blue.svg)
![Version](https://img.shields.io/badge/version-2.0.0-brightgreen.svg)

> **EN:** A microservice that protects Claude's context window by delegating massive file reads to Gemini 2.5 Flash-Lite — invisibly, locally, zero Claude tokens burned.
>
> **ES:** Un microservicio que protege la ventana de contexto de Claude delegando la lectura masiva de archivos a Gemini 2.5 Flash-Lite — de forma invisible, local, sin quemar tokens de Claude.

---

## The Concept / El Concepto

**EN:** The Compactor is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server designed with one mission: **keep Claude's context window clean**. It acts as an invisible middleman — Claude passes a file path, Node.js reads the disk locally, and Gemini processes the raw text in its own massive 2M-token context. Claude only receives the final, distilled answer.

**ES:** El Compactor es un servidor [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) diseñado con una sola misión: **mantener limpia la ventana de contexto de Claude**. Actúa como intermediario invisible — Claude pasa una ruta de archivo, Node.js lee el disco localmente, y Gemini procesa el texto crudo en su propio contexto masivo de 2M tokens. Claude solo recibe la respuesta final y destilada.

---

## The Problem / El Problema

**EN:** Reading large files directly in Claude Code is expensive and destructive:

- A 10,000-line log file can consume **50–80% of Claude's context window** in a single read.
- Once the context is full, Claude loses short-term memory of earlier instructions.
- Costs spiral as Claude re-reads files on every message to "remember" them.
- The agent becomes slow, confused, and expensive — all from one `cat syslog.log`.

**ES:** Leer archivos grandes directamente en Claude Code es caro y destructivo:

- Un log de 10,000 líneas puede consumir el **50–80% de la ventana de contexto de Claude** en una sola lectura.
- Una vez lleno el contexto, Claude pierde la memoria a corto plazo de instrucciones anteriores.
- Los costos se disparan mientras Claude re-lee archivos en cada mensaje para "recordarlos".
- El agente se vuelve lento, confundido y caro — todo por un simple `cat syslog.log`.

---

## The Airgap Protocol / Cómo Funciona

```
┌─────────────┐     file path only     ┌──────────────────┐
│   CLAUDE    │ ──────────────────────► │   MCP SERVER     │
│  (no file   │                         │  (Node.js)       │
│   content)  │ ◄──────────────────────  │  reads disk      │
└─────────────┘   distilled answer      └────────┬─────────┘
                                                  │ raw text
                                                  ▼
                                         ┌────────────────┐
                                         │  GEMINI 2.5    │
                                         │  Flash-Lite    │
                                         │  (2M context)  │
                                         └────────────────┘
```

**EN:** This is the **Airgap Protocol**:

1. **Claude never reads the file.** It only passes the absolute file path as a string parameter.
2. **Node.js reads the disk locally** — silently, without touching Claude's context.
3. **Gemini receives the raw text** and processes it with its massive 2M-token context.
4. **Claude receives only the result** — a concise, structured answer that costs a fraction of the tokens.

**ES:** Este es el **Protocolo Airgap**:

1. **Claude nunca lee el archivo.** Solo pasa la ruta absoluta como parámetro string.
2. **Node.js lee el disco localmente** — en silencio, sin tocar el contexto de Claude.
3. **Gemini recibe el texto crudo** y lo procesa con su enorme contexto de 2M tokens.
4. **Claude solo recibe el resultado** — una respuesta concisa y estructurada que cuesta una fracción de los tokens.

---

## Installation / Instalación

### 1. Clone the repository

```bash
git clone https://github.com/your-user/claude-gemini-compactor-mcp.git
cd claude-gemini-compactor-mcp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
# Edit .env and add your Google Gemini API key
```

Get your free API key at [Google AI Studio](https://aistudio.google.com/).

### 4. Register in Claude Code

Add this block to your `claude_desktop_config.json` (usually at `~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gemini-compactor": {
      "command": "node",
      "args": ["/absolute/path/to/claude-gemini-compactor-mcp/server.js"],
      "env": {
        "GEMINI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Restart Claude Code. The `ask_gemini` tool will appear in the available tools list.

---

## Usage / Uso

### Basic prompt / Prompt básico

```
Claude, use the ask_gemini tool to extract all CRITICAL and ERROR entries
from /var/log/syslog — give me the top 10 most frequent errors with their count.
```

```
Claude, usa la herramienta ask_gemini para analizar /home/pablo/proyecto/dump_etsy.txt
y extrae los 5 patrones de precio más competitivos con su frecuencia.
```

### With output file / Con archivo de salida

```
Claude, use ask_gemini with instruction "Summarize all TODO comments by module"
on input_file "src/main.js" and save results to "docs/todo_report.md".
```

### URL ingestion / Ingestión de URLs

```
Claude, use ask_gemini_url with url "https://example.com/api/data"
and instruction "Extract all product prices as JSON".
```

### Batch processing / Procesamiento en lote

```
Claude, use ask_gemini_batch with input_files ["logs/mon.log", "logs/tue.log", "logs/wed.log"]
and instruction "Summarize all ERROR entries by day" and save to "docs/weekly_errors.md".
```

### Tool reference / Referencia de herramientas

#### `ask_gemini`

| Parameter | Required | Description |
| --- | --- | --- |
| `instruction` | ✅ | What Gemini should do |
| `input_file` | ❌ | File path to read (Claude never sees the content) |
| `output_file` | ❌ | Path to save the result |
| `model` | ❌ | `flash-lite` (default) · `flash` · `pro` |
| `output_format` | ❌ | `text` (default) · `json` |

#### `ask_gemini_url`

| Parameter | Required | Description |
| --- | --- | --- |
| `url` | ✅ | URL to fetch locally |
| `instruction` | ✅ | What Gemini should do with the content |
| `output_file` | ❌ | Path to save the result |
| `model` | ❌ | `flash-lite` (default) · `flash` · `pro` |
| `output_format` | ❌ | `text` (default) · `json` |

#### `ask_gemini_batch`

| Parameter | Required | Description |
| --- | --- | --- |
| `instruction` | ✅ | What Gemini should do with all files |
| `input_files` | ✅ | Array of file paths |
| `output_file` | ❌ | Path to save the combined result |
| `model` | ❌ | `flash-lite` (default) · `flash` · `pro` |
| `output_format` | ❌ | `text` (default) · `json` |

---

## Token Savings / Ahorro de Tokens

| Scenario | Without Compactor | With Compactor |
| --- | --- | --- |
| 10K-line log analysis | ~80K tokens | ~500 tokens |
| 500KB data dump | Context overflow | ~800 tokens |
| Repeated file reads | N × full file | 0 tokens (cached by Gemini) |

---

## License / Licencia

MIT © Pablo
