#!/usr/bin/env node
// v7.0 — Two providers only: Ollama/Gemma4 (local, free) + Groq (cloud).
// AIRGAP protocol: Claude passes paths, Node reads disk, AI processes content.
// Local-first: Ollama always tried first. Cloud only when local insufficient.
import 'dotenv/config';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import fs from 'fs';
import path from 'path';

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_FILE_BYTES  = 50 * 1024 * 1024;   // 50MB hard cap
const MAX_URL_BYTES   = 10 * 1024 * 1024;   // 10MB URL response cap
const FETCH_TIMEOUT   = 15_000;             // 15s
const OLLAMA_TIMEOUT  = 30_000;             // 30s for local inference
const LOCAL_MIN_LEN   = 80;                 // chars; escalate if shorter
const CWD             = process.cwd();

const OLLAMA_BASE  = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/v1\/?$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma4:e4b';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

// ── Groq client (required) ────────────────────────────────────────────────────
if (!process.env.GROQ_API_KEY) {
  process.stderr.write('[FATAL] GROQ_API_KEY not set. Export it and restart.\n');
  process.exit(1);
}
const groq = new OpenAI({
  apiKey:  process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
  timeout: 60_000,
});
process.stderr.write(`[INFO] v7.0 — ollama:${OLLAMA_MODEL} + groq:${GROQ_MODEL}\n`);

// ── Security: path traversal guard ───────────────────────────────────────────
function validatePath(p) {
  if (!p) throw new Error('Path must not be empty.');
  const resolved = path.resolve(CWD, p);
  const rel = path.relative(CWD, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error(`Access denied: '${p}' is outside the working directory.`);
  return resolved;
}

// ── Security: SSRF guard ──────────────────────────────────────────────────────
function validateUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`Invalid URL: ${u}`); }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error(`Blocked scheme '${parsed.protocol}'. Only http/https allowed.`);
  const h = parsed.hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' ||
      /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(h) ||
      h.endsWith('.local') || h.endsWith('.internal'))
    throw new Error(`Blocked private/internal host: ${h}`);
  return u;
}

// ── File reader with size guard ───────────────────────────────────────────────
async function readFile(p) {
  const resolved = validatePath(p);
  const { size } = await fs.promises.stat(resolved);
  if (size > MAX_FILE_BYTES) throw new Error(`File too large: ${(size/1024/1024).toFixed(1)}MB exceeds 50MB.`);
  return fs.promises.readFile(resolved, 'utf8');
}

// ── Ollama: raw /api/generate (fixes empty-response bug in compat layer) ─────
async function callOllama(prompt) {
  const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    signal:  AbortSignal.timeout(OLLAMA_TIMEOUT),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${await r.text()}`);
  return (await r.json()).response ?? '';
}

// ── Groq: OpenAI-compatible cloud call ───────────────────────────────────────
async function callGroq(prompt, jsonMode = false) {
  const p = jsonMode
    ? `${prompt}\n\nCRITICAL: Respond ONLY with valid JSON. No markdown, no explanation.`
    : prompt;
  const c = await groq.chat.completions.create({
    model:    GROQ_MODEL,
    messages: [{ role: 'user', content: p }],
  });
  const usage = c.usage ?? {};
  return {
    text:     c.choices[0].message.content ?? '',
    inTok:    usage.prompt_tokens     ?? 0,
    outTok:   usage.completion_tokens ?? 0,
    provider: 'groq',
  };
}

// ── Smart pipeline: Ollama first, escalate to Groq if needed ─────────────────
async function callSmart(prompt, jsonMode = false) {
  try {
    const text = await callOllama(prompt);
    if (text && text.length >= LOCAL_MIN_LEN)
      return { text, inTok: 0, outTok: 0, provider: 'ollama' };
    process.stderr.write(`[INFO] Local result short (${text?.length ?? 0} chars), escalating to Groq.\n`);
  } catch (e) {
    process.stderr.write(`[WARN] Ollama unavailable: ${e.message}. Escalating to Groq.\n`);
  }
  return callGroq(prompt, jsonMode);
}

// ── Output: write to file or return inline ────────────────────────────────────
async function writeOutput(text, outputFile, meta, ctx) {
  const info = ` [${meta.provider}][in:${meta.inTok} out:${meta.outTok}]`;
  if (outputFile) {
    const resolved = validatePath(outputFile);
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, text, 'utf8');
    return { content: [{ type: 'text', text: `SUCCESS: ${ctx} Saved to ${outputFile}.${info}` }] };
  }
  return { content: [{ type: 'text', text: text + info }] };
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'ai-router-mcp', version: '7.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool Definitions ──────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ask_ai",
      description: "AIRGAP: Claude passes file PATH, Node reads disk, AI processes content. General AI tasks: summarize, extract, analyze. Uses smart pipeline (Ollama free → Groq cloud). task_type='local' forces Ollama only.",
      inputSchema: {
        type: "object",
        properties: {
          instruction:   { type: "string", description: "What the AI should do." },
          input_file:    { type: "string", description: "OPTIONAL. File path to read." },
          output_file:   { type: "string", description: "OPTIONAL. Path to save result." },
          output_format: { type: "string", enum: ["text", "json"], description: "OPTIONAL. Default: text." },
          task_type:     { type: "string", enum: ["auto", "local", "cloud"], description: "OPTIONAL. 'local'=Ollama only, 'cloud'=Groq only, 'auto'=smart pipeline. Default: auto." },
        },
        required: ["instruction"],
      },
    },
    {
      name: "ask_local",
      description: "LOCAL-ONLY via Ollama/Gemma4. 0 cloud tokens. Use for sensitive data or offline processing. No cloud fallback.",
      inputSchema: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "What the local AI should do." },
          input_file:  { type: "string", description: "OPTIONAL. File path to read." },
          output_file: { type: "string", description: "OPTIONAL. Save result to this path." },
        },
        required: ["instruction"],
      },
    },
    {
      name: "ask_smart",
      description: "LOCAL-FIRST PIPELINE. Tries Gemma4 (free) first. If sufficient, returns with 0 cloud tokens. Auto-escalates to Groq only when needed. Best for cost efficiency.",
      inputSchema: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "What the AI should do." },
          input_file:  { type: "string", description: "OPTIONAL. File path to read." },
          output_file: { type: "string", description: "OPTIONAL. Save result to this path." },
        },
        required: ["instruction"],
      },
    },
    {
      name: "ask_url",
      description: "AIRGAP URL INGESTION. Fetches URL locally, sends content to AI. Claude never sees raw HTML. Use for docs, API refs, JSON endpoints.",
      inputSchema: {
        type: "object",
        properties: {
          url:           { type: "string", description: "URL to fetch." },
          instruction:   { type: "string", description: "What the AI should do with the content." },
          output_file:   { type: "string", description: "OPTIONAL. Save result to this path." },
          output_format: { type: "string", enum: ["text", "json"], description: "OPTIONAL. Default: text." },
        },
        required: ["url", "instruction"],
      },
    },
    {
      name: "ask_batch",
      description: "AIRGAP BATCH: process multiple files with one instruction. All reads are local. Claude never sees content. Max 20 files.",
      inputSchema: {
        type: "object",
        properties: {
          instruction:   { type: "string", description: "What the AI should do with all files." },
          input_files:   { type: "array", items: { type: "string" }, description: "Array of file paths." },
          output_file:   { type: "string", description: "OPTIONAL. Save combined result." },
          output_format: { type: "string", enum: ["text", "json"], description: "OPTIONAL. Default: text." },
        },
        required: ["instruction", "input_files"],
      },
    },
    {
      name: "ask_diff",
      description: "AIRGAP DIFF ANALYSIS. Reads diff/patch file via Node.js, sends to Groq. Returns per-file risk assessment. Pass 'stdin' to run 'git diff HEAD' automatically.",
      inputSchema: {
        type: "object",
        properties: {
          diff_file:   { type: "string", description: "Path to .diff/.patch file, or 'stdin' for git diff HEAD." },
          instruction: { type: "string", description: "OPTIONAL. Default: summarize changes, assess risk, flag breaking changes." },
          output_file: { type: "string", description: "OPTIONAL. Save report to this path." },
        },
        required: ["diff_file"],
      },
    },
    {
      name: "ask_schema",
      description: "AIRGAP SCHEMA EXTRACTION. Reads .prisma/.sql/.graphql/OpenAPI files via Node.js. Returns normalized JSON structure. Raw file never enters Claude's context.",
      inputSchema: {
        type: "object",
        properties: {
          input_file:  { type: "string", description: "Path to schema file (.prisma, .sql, .graphql, .yaml, .json)." },
          instruction: { type: "string", description: "OPTIONAL. Default: extract all models/tables with fields, types, relations as JSON." },
          output_file: { type: "string", description: "OPTIONAL. Save extracted schema." },
        },
        required: ["input_file"],
      },
    },
    {
      name: "ask_compress",
      description: "TWO-STAGE COMPACTION. Stage 1: Gemma4 local pre-compression (free). Stage 2: Groq finalizes. Use when /compact needed or large history/log file >50KB. Minimizes cloud tokens.",
      inputSchema: {
        type: "object",
        properties: {
          input_file:  { type: "string", description: "Large text file to compact (conversation history, logs, etc.)." },
          focus:       { type: "string", description: "OPTIONAL. Extra focus (e.g. 'preserve all file paths and errors')." },
          output_file: { type: "string", description: "OPTIONAL. Save compact summary." },
        },
        required: ["input_file"],
      },
    },
  ],
}));

// ── Tool Handlers ─────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ── ask_ai ────────────────────────────────────────────────────────────────
    if (name === 'ask_ai') {
      const { instruction, input_file, output_file, output_format = 'text', task_type = 'auto' } = args;
      let prompt = instruction;
      if (input_file) {
        const content = await readFile(input_file);
        prompt = `${instruction}\n\n--- FILE: ${input_file} ---\n${content}`;
      }
      const jsonMode = output_format === 'json';
      let meta;
      if      (task_type === 'local') meta = { text: await callOllama(prompt), inTok: 0, outTok: 0, provider: 'ollama' };
      else if (task_type === 'cloud') meta = await callGroq(prompt, jsonMode);
      else                            meta = await callSmart(prompt, jsonMode);
      return writeOutput(meta.text, output_file, meta, `Processed '${input_file ?? 'prompt'}'.`);
    }

    // ── ask_local ─────────────────────────────────────────────────────────────
    if (name === 'ask_local') {
      const { instruction, input_file, output_file } = args;
      let prompt = instruction;
      if (input_file) {
        const content = await readFile(input_file);
        prompt = `${instruction}\n\n--- FILE: ${input_file} ---\n${content}`;
      }
      const text = await callOllama(prompt);
      return writeOutput(text, output_file, { inTok: 0, outTok: 0, provider: 'ollama' }, `Local processed '${input_file ?? 'prompt'}'.`);
    }

    // ── ask_smart ─────────────────────────────────────────────────────────────
    if (name === 'ask_smart') {
      const { instruction, input_file, output_file } = args;
      let prompt = instruction;
      if (input_file) {
        const content = await readFile(input_file);
        prompt = `${instruction}\n\n--- FILE: ${input_file} ---\n${content}`;
      }
      const meta = await callSmart(prompt);
      return writeOutput(meta.text, output_file, meta, `Smart processed '${input_file ?? 'prompt'}'.`);
    }

    // ── ask_url ───────────────────────────────────────────────────────────────
    if (name === 'ask_url') {
      const { url, instruction, output_file, output_format = 'text' } = args;
      validateUrl(url);
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      let body;
      try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
        const cl = resp.headers.get('content-length');
        if (cl && parseInt(cl) > MAX_URL_BYTES) throw new Error(`Response too large: ${(parseInt(cl)/1024/1024).toFixed(1)}MB`);
        body = await resp.text();
      } finally { clearTimeout(tid); }
      if (Buffer.byteLength(body) > MAX_URL_BYTES) throw new Error('Response body exceeds 10MB.');
      const meta = await callGroq(`${instruction}\n\n--- URL: ${url} ---\n${body}`, output_format === 'json');
      return writeOutput(meta.text, output_file, meta, `Processed URL '${url}'.`);
    }

    // ── ask_batch ─────────────────────────────────────────────────────────────
    if (name === 'ask_batch') {
      const { instruction, input_files, output_file, output_format = 'text' } = args;
      if (input_files.length > 20) throw new Error('Batch limit: max 20 files.');
      const results = await Promise.allSettled(
        input_files.map(async (f) => `--- FILE: ${f} ---\n${await readFile(f)}`)
      );
      const failedIdx = results.reduce((a, r, i) => (r.status === 'rejected' ? a.concat(i) : a), []);
      if (failedIdx.length) {
        const msg = failedIdx.map((i) => `${input_files[i]}: ${results[i].reason.message}`).join('; ');
        process.stderr.write(`[WARN] ask_batch: ${failedIdx.length} file(s) skipped: ${msg}\n`);
      }
      const sections = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      if (!sections.length) throw new Error('All files failed to read.');
      const meta = await callGroq(`${instruction}\n\n${sections.join('\n\n')}`, output_format === 'json');
      return writeOutput(meta.text, output_file, meta, `Processed ${sections.length}/${input_files.length} files.`);
    }

    // ── ask_diff ──────────────────────────────────────────────────────────────
    if (name === 'ask_diff') {
      const { diff_file, instruction, output_file } = args;
      let diffContent;
      if (diff_file === 'stdin') {
        const { execFile } = await import('child_process');
        diffContent = await new Promise((res, rej) =>
          execFile('git', ['diff', 'HEAD'], { encoding: 'utf8', cwd: CWD }, (e, out) => e ? rej(e) : res(out))
        );
      } else {
        diffContent = await readFile(diff_file);
      }
      const inst = instruction ?? 'Summarize all changes. Per file: what changed, risk level (low/medium/high), and any breaking changes or security issues.';
      const meta = await callGroq(`${inst}\n\n--- DIFF ---\n${diffContent}`);
      return writeOutput(meta.text, output_file, meta, 'Diff analysis complete.');
    }

    // ── ask_schema ────────────────────────────────────────────────────────────
    if (name === 'ask_schema') {
      const { input_file, instruction, output_file } = args;
      const content = await readFile(input_file);
      const inst = instruction ?? 'Extract all models/tables with fields, types, constraints, and relations. Return ONLY valid JSON.';
      const meta = await callGroq(`${inst}\n\n--- SCHEMA: ${input_file} ---\n${content}`, true);
      return writeOutput(meta.text, output_file, meta, `Schema extracted from '${input_file}'.`);
    }

    // ── ask_compress ──────────────────────────────────────────────────────────
    if (name === 'ask_compress') {
      const { input_file, focus, output_file } = args;
      const content   = await readFile(input_file);
      const focusTip  = focus ? `\nFocus especially on: ${focus}` : '';

      // Stage 1: Gemma4 local pre-compression (0 cloud tokens)
      let compressed = content;
      try {
        const c = await callOllama(
          `Compress to a dense summary. Preserve key facts, decisions, file paths, errors, tool results. Output ONLY the summary.${focusTip}\n\n${content}`
        );
        if (c && c.length > 50 && c.length < content.length) {
          process.stderr.write(`[INFO] ask_compress: ${content.length} → ${c.length} chars (Gemma4)\n`);
          compressed = c;
        }
      } catch (e) {
        process.stderr.write(`[WARN] ask_compress: local stage skipped (${e.message})\n`);
      }

      // Stage 2: Groq finalization
      const meta = await callGroq(
        `Summarize concisely. Preserve all decisions, file paths, errors, tool results, and facts needed to continue work.${focusTip}\n\n--- CONTENT ---\n${compressed}`
      );
      return writeOutput(meta.text, output_file, meta, `Compacted '${input_file}'.`);
    }

    throw new Error(`Unknown tool: ${name}`);

  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
