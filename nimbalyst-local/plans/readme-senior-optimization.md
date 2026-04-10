---
planStatus:
  planId: plan-readme-senior-optimization
  title: README.md Senior-Level Optimization
  status: draft
  planType: improvement
  priority: high
  owner: Pablo
  stakeholders: []
  tags: [docs, open-source, ux]
  created: "2026-04-09"
  updated: "2026-04-09T00:00:00.000Z"
  progress: 0
---

# README.md — Senior-Level Optimization Plan

## Objective

Elevate the README from "functional bilingual doc" to an **open-source standard** that signals professional quality to developers browsing GitHub.

---

## Diagnosis: Current Problems

| # | Issue | Severity |
|---|-------|----------|
| 1 | No Table of Contents | Medium |
| 2 | `your-user` placeholder in clone URL (should be `SuarezPM`) | High |
| 3 | Bilingual mixing within paragraphs — hard to scan | Medium |
| 4 | No Prerequisites section (Node ≥18, npm, Google AI account) | High |
| 5 | No Troubleshooting section | Medium |
| 6 | No Security section — path guard & file size cap are features, not mentioned | High |
| 7 | No "Model Selection Guide" — user doesn't know when to use flash vs pro | Medium |
| 8 | Token savings table — "cached by Gemini" claim is misleading (no cross-call cache) | Medium |
| 9 | No Contributing / License section with full context | Low |
| 10 | No quick-start / TL;DR block for impatient devs | Medium |
| 11 | ASCII diagram undersells the architecture — no labels for token flow | Low |
| 12 | Config path note doesn't mention Claude Code vs Claude Desktop difference | High |

---

## Proposed Improvements

### P0 — Fix Bugs (break confidence in docs)

- [ ] Replace `your-user` with `SuarezPM` in clone URL
- [ ] Fix "cached by Gemini" claim → replace with accurate "0 Claude tokens" phrasing
- [ ] Clarify config path: Claude Code uses `~/.claude/claude_desktop_config.json`

### P1 — Structure & Navigation

- [ ] Add **Table of Contents** (anchor links, 6–8 entries)
- [ ] Add **Prerequisites** section before Installation
- [ ] Add **Quick Start** (3-command TL;DR) at the top, after the tagline
- [ ] Separate bilingual content: EN block → ES block per section (not interleaved)

### P2 — Content Depth (what makes it "senior")

- [ ] Add **Security** section documenting:
  - Path traversal guard (`path.relative()` check)
  - 50MB file size cap
  - Fail-fast API key validation
- [ ] Add **Model Selection Guide** table:
  - `flash-lite`: speed, free tier, bulk ingestion
  - `flash`: balance, structured tasks
  - `pro`: deep reasoning, complex extraction
- [ ] Add **Environment Variables** reference table

### P3 — Polish

- [ ] Upgrade ASCII diagram with token cost labels on each arrow
- [ ] Add a **Troubleshooting** section (top 3 errors + fix)
- [ ] Add **Contributing** section (fork → branch → PR)
- [ ] Update MIT line: `MIT © 2025–2026 Pablo (SuarezPM)`

---

## Proposed Structure (Final)

```
# Claude-Gemini Compactor MCP
[badges]
[tagline EN/ES]
[Quick Start — 3 commands]

## Table of Contents
## The Problem
## The Solution: Airgap Protocol
## Prerequisites
## Installation
## Configuration
## Usage
  - ask_gemini
  - ask_gemini_url
  - ask_gemini_batch
## Tool Reference
## Model Selection Guide
## Security
## Token Savings
## Troubleshooting
## Contributing
## License
```

---

## Out of Scope

- API documentation changes (server.js untouched)
- Adding new badges (npm publish not configured)
- Wiki pages

---

## Steps

- [ ] **Step 1**: Review plan with Pablo — confirm scope
- [ ] **Step 2**: Implement all P0 fixes
- [ ] **Step 3**: Implement P1 structural changes
- [ ] **Step 4**: Implement P2 content depth
- [ ] **Step 5**: Implement P3 polish
- [ ] **Step 6**: Final review + commit
