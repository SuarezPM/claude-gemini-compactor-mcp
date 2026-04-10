# Changelog

All notable changes to this project will be documented in this file.

---

## [6.0.0] - 2026-04-10

### Breaking Changes
- **Removed providers**: Gemini (cloud) and DeepSeek — both dropped entirely
- **Tool rename**: All `ask_gemini_*` → provider-agnostic names (see below)
- **Clean break**: No backward-compat aliases; update any tool calls

### Providers (v6.0)
| Provider | Role | Latency |
|----------|------|---------|
| Ollama/Gemma4:e4b | Local-first, free, private | ~560ms warm |
| Groq (llama-3.3-70b) | Cloud fast | ~200ms |
| OpenRouter (openrouter/free) | Cloud fallback, 1M+ ctx | variable |

### Tool Renames
| Old | New |
|-----|-----|
| `ask_gemini` | `ask_ai` |
| `ask_ollama` | `ask_local` |
| `ask_gemini_batch` | `ask_batch` |
| `ask_gemini_compact` | `ask_compress` |
| `ask_gemini_diff` | `ask_diff` |
| `ask_gemini_schema` | `ask_schema` |
| `ask_gemini_url` | `ask_url` |
| _(new)_ | `ask_smart` |

### Features
- **`ask_smart`**: Local-first pipeline — Gemma4 attempts task locally (0 cloud tokens); escalates to Groq/OpenRouter only if output < 80 chars
- **`ask_compress` upgrade**: Gemma4 pre-compresses large files locally → cloud receives lean summary (~99% token savings on large files)
- **Raw Ollama API**: Replaced OpenAI compat layer with direct `fetch()` to `/api/generate` — fixes empty-response bug (finish_reason: length)
- **Routing table**: `local` task_type = Ollama ONLY (no cloud fallback); `cheap` = Ollama → Groq → OpenRouter

### Fixes
- Gemma4 via OpenAI compat returning empty content — fixed with raw `/api/generate` endpoint

---

## [2.0.0] - 2026-04-09

### Security
- **Fixed path traversal vulnerability** — replaced `startsWith(cwd)` with `path.relative()` check to correctly block paths like `/home/pablo-evil/` that bypassed the previous guard
- **Added 50MB file size cap** — `readFileGuarded()` rejects files over 50MB before reading, preventing OOM crashes on oversized inputs
- **Fail-fast API key validation** — server exits immediately at startup with a clear error if `GEMINI_API_KEY` is missing

### Performance
- **Non-blocking async I/O** — replaced `fs.readFileSync` / `fs.writeFileSync` with `fs.promises` throughout; batch reads use `Promise.all()` for parallel execution

### Features
- **New tool: `ask_gemini_url`** — fetches a URL locally (Node.js `fetch`) and delegates processing to Gemini; Claude never sees the raw HTML body
- **New tool: `ask_gemini_batch`** — processes an array of files with a single instruction in one Gemini call; ideal for weekly log digests or multi-module audits
- **Model selection parameter** — `model` enum on all tools: `flash-lite` (default), `flash`, `pro`
- **JSON output mode** — `output_format: "json"` forces Gemini to return valid JSON; no markdown wrappers
- **Token usage reporting** — all tool responses include `[Tokens used: N]` from Gemini's `usageMetadata`

### Changed
- Server version bumped to `2.0.0`
- Centralized Gemini call logic into `callGemini()` helper
- Centralized output file write logic into `writeOutput()` helper

---

## [1.0.3] - 2026-04-09

### Added
- Initial release of the Compactor Airgap architecture
- `ask_gemini` tool: single-file ingestion via absolute path
- `dotenv/config` loader for local `.env` support
- Basic path traversal guard (patched in v2.0.0)
