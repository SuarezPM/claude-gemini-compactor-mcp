# Changelog

All notable changes to this project will be documented in this file.

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
