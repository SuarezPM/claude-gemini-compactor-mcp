#!/usr/bin/env node
import 'dotenv/config';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import fs from 'fs';
import path from 'path';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB hard cap
const MAX_URL_BODY_BYTES  = 10 * 1024 * 1024; // 10MB URL response cap
const FETCH_TIMEOUT_MS    = 15_000;            // 15s fetch timeout
const OLLAMA_TIMEOUT_MS   = 30_000;            // 30s for local inference
const LOCAL_MIN_LENGTH    = 80;                // ask_smart: escalate if local output < N chars
const CWD = process.cwd();

// ── Provider Registry ────────────────────────────────────────────────────────
// v6.0: Groq (fast cloud) + OpenRouter (large-context cloud) + Ollama (local/free)
// Gemini and DeepSeek removed: no active keys, cost not justified.
const PROVIDER_REGISTRY = {
  groq: {
    baseURL:  'https://api.groq.com/openai/v1',
    envKey:   'GROQ_API_KEY',
    ctxLimit: 128_000,
    costIn:   0.0,   // free tier
    costOut:  0.0,
    models: {
      'flash-lite': 'llama-3.3-70b-versatile',
      'flash':      'llama-3.3-70b-versatile',
      'pro':        'llama-3.3-70b-versatile',
    },
    strengths: ['fast', 'free'],
  },
  openrouter: {
    baseURL:  'https://openrouter.ai/api/v1',
    envKey:   'OPENROUTER_API_KEY',
    ctxLimit: 1_000_000,
    costIn:   0.0,   // free-tier models
    costOut:  0.0,
    models: {
      'flash-lite': 'google/gemma-3-27b-it:free',
      'flash':      'google/gemma-3-27b-it:free',
      'pro':        'meta-llama/llama-4-maverick:free',
    },
    strengths: ['ingest', 'large-context', 'fallback'],
  },
  ollama: {
    // Raw API — no OpenAI compat (fixes empty-response bug with Gemma4)
    baseURL:  (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/v1\/?$/, ''),
    envKey:   null,  // local server — no key required
    ctxLimit: 128_000,
    costIn:   0.0,
    costOut:  0.0,
    models: {
      'flash-lite': 'gemma4:e4b',
      'flash':      'gemma4:e4b',
      'pro':        'gemma4:e4b',
    },
    strengths: ['local', 'offline', 'private', 'free'],
  },
};

// ── Build active OpenAI clients (cloud providers only) ───────────────────────
const clients = {};
const ACTIVE_PROVIDERS = [];

for (const [id, cfg] of Object.entries(PROVIDER_REGISTRY)) {
  if (cfg.envKey === null) {
    // Ollama: raw fetch, no OpenAI client. Always registered.
    ACTIVE_PROVIDERS.push(id);
    continue;
  }
  const apiKey = process.env[cfg.envKey];
  if (apiKey) {
    clients[id] = new OpenAI({ apiKey, baseURL: cfg.baseURL, timeout: 60_000 });
    ACTIVE_PROVIDERS.push(id);
  }
}

const cloudProviders = ACTIVE_PROVIDERS.filter(id => PROVIDER_REGISTRY[id].envKey !== null);
if (cloudProviders.length === 0) {
  process.stderr.write('[FATAL] No cloud API keys configured. Set at least one of: GROQ_API_KEY, OPENROUTER_API_KEY.\n');
  process.exit(1);
}

process.stderr.write(`[INFO] v6.0 active providers: ${ACTIVE_PROVIDERS.join(', ')}\n`);

const server = new Server(
  { name: "ai-router-mcp", version: "6.0.0" },
  { capabilities: { tools: {} } }
);

// ── P0: Secure path validation ───────────────────────────────────────────────
function validatePath(filePath) {
  if (!filePath) throw new Error('File path must not be empty.');
  const resolved = path.resolve(CWD, filePath);
  const relative = path.relative(CWD, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Access denied: '${filePath}' is outside the working directory.`);
  }
  return resolved;
}

// ── P0: SSRF guard ───────────────────────────────────────────────────────────
function validateUrl(urlString) {
  let parsed;
  try { parsed = new URL(urlString); } catch { throw new Error(`Invalid URL: ${urlString}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked URL scheme '${parsed.protocol}'. Only http/https allowed.`);
  }
  const h = parsed.hostname.toLowerCase();
  if (
    h === 'localhost' || h === '0.0.0.0' ||
    /^127\./.test(h) || /^10\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^192\.168\./.test(h) ||
    h.endsWith('.local') || h.endsWith('.internal')
  ) {
    throw new Error(`Blocked private/internal host: ${h}`);
  }
  return urlString;
}

// ── P0: Async read with 50MB size guard ──────────────────────────────────────
async function readFileGuarded(filePath) {
  const resolved = validatePath(filePath);
  const stat = await fs.promises.stat(resolved);
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 50MB limit.`);
  }
  return fs.promises.readFile(resolved, 'utf8');
}

// ── Ollama raw API caller (fixes empty-response bug in OpenAI compat layer) ──
async function callOllamaRaw(model, prompt) {
  const base = PROVIDER_REGISTRY.ollama.baseURL;
  const resp = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.response ?? '';
}

// ── Retryable error detection ─────────────────────────────────────────────────
function isRetryableError(err) {
  const msg = (err.message ?? '').toLowerCase();
  return (
    err.status === 429 ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('too many requests')
  );
}

// ── Unified AI caller with provider fallback chain ───────────────────────────
async function callWithFallback(prompt, modelKey = 'flash-lite', outputFormat = 'text', providerOrder = ACTIVE_PROVIDERS) {
  const finalPrompt = outputFormat === 'json'
    ? `${prompt}\n\nCRITICAL: Respond ONLY with valid JSON. No markdown, no explanation, no code blocks.`
    : prompt;

  const errors = [];

  for (const id of providerOrder) {
    const cfg = PROVIDER_REGISTRY[id];
    if (!cfg) continue;

    // Ollama: use raw fetch API instead of OpenAI client
    if (id === 'ollama') {
      try {
        const modelName = cfg.models[modelKey] ?? cfg.models['flash-lite'];
        const text = await callOllamaRaw(modelName, finalPrompt);
        return { text, inTok: 0, outTok: 0, cost: 0, provider: 'ollama', model: modelName };
      } catch (err) {
        errors.push(`[ollama] ${err.message}`);
        process.stderr.write(`[WARN] Ollama unavailable: ${err.message}\n`);
        continue;
      }
    }

    // Cloud providers via OpenAI-compatible SDK
    if (!clients[id]) continue;
    try {
      const modelName  = cfg.models[modelKey] ?? cfg.models['flash-lite'];
      const completion = await clients[id].chat.completions.create({
        model:    modelName,
        messages: [{ role: 'user', content: finalPrompt }],
      });

      const text   = completion.choices[0].message.content ?? '';
      const usage  = completion.usage ?? {};
      const inTok  = usage.prompt_tokens     ?? 0;
      const outTok = usage.completion_tokens ?? 0;
      const cost   = ((inTok * cfg.costIn) + (outTok * cfg.costOut)) / 1_000_000;

      return { text, inTok, outTok, cost, provider: id, model: modelName };
    } catch (err) {
      errors.push(`[${id}] ${err.message}`);
      if (isRetryableError(err)) {
        process.stderr.write(`[WARN] Provider '${id}' quota/rate-limit. Trying next...\n`);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`All providers exhausted:\n${errors.join('\n')}`);
}

// ── Smart provider routing by task type ──────────────────────────────────────
function routeProviders(taskType = 'auto') {
  const ROUTING = {
    ingest: ['openrouter', 'groq', 'ollama'],   // large context first
    fast:   ['groq', 'openrouter', 'ollama'],    // lowest latency first
    cheap:  ['ollama', 'groq', 'openrouter'],    // free local first
    reason: ['openrouter', 'groq', 'ollama'],    // best reasoning models
    local:  ['ollama'],                          // local ONLY — no cloud fallback
    auto:   ACTIVE_PROVIDERS,
  };
  const preferred = ROUTING[taskType] ?? ACTIVE_PROVIDERS;
  return preferred.filter(id => ACTIVE_PROVIDERS.includes(id));
}

// ── Write result to file or return inline ────────────────────────────────────
async function writeOutput(text, outputFile, meta, context) {
  const { inTok = 0, outTok = 0, cost = 0, provider = '?', model = '?' } = meta ?? {};
  const costStr = cost > 0 ? ` [cost: $${cost.toFixed(6)}]` : '';
  const info    = ` [${provider}/${model}][in:${inTok} out:${outTok}${costStr}]`;

  if (outputFile) {
    const outPath = validatePath(outputFile);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, text, 'utf8');
    return { content: [{ type: "text", text: `SUCCESS: ${context} Saved to ${outputFile}.${info}` }] };
  }
  return { content: [{ type: "text", text: text + info }] };
}

// ── Tool definitions ─────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ask_ai",
      description: "AIRGAP INGESTION TOOL. USE THIS for general AI tasks: summarizing files, answering questions about code, extracting data, analyzing content. Routes to best available provider (Groq → OpenRouter → Ollama). Claude NEVER reads file content — only passes the PATH. Node.js reads disk locally, AI processes in its context window. USE task_type to optimize routing: 'ingest' for large files, 'fast' for speed, 'cheap' for cost/local.",
      inputSchema: {
        type: "object",
        properties: {
          instruction:   { type: "string", description: "What the AI should do (e.g. 'Extract all ERROR entries')." },
          input_file:    { type: "string", description: "OPTIONAL. File path to read (e.g. logs/app.log). Pass the PATH, never the content." },
          output_file:   { type: "string", description: "OPTIONAL. Path to save the result (e.g. docs/analysis.md)." },
          model:         { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Model tier. Default: flash-lite (fastest, cheapest)." },
          output_format: { type: "string", enum: ["text", "json"], description: "OPTIONAL. Force structured JSON output. Default: text." },
          task_type:     { type: "string", enum: ["auto", "ingest", "fast", "cheap", "reason"], description: "OPTIONAL. Routing hint. 'ingest'=large files→OpenRouter first, 'fast'=speed→Groq first, 'cheap'=free→Ollama first, 'reason'=logic→OpenRouter. Default: auto." },
        },
        required: ["instruction"]
      }
    },
    {
      name: "ask_local",
      description: "LOCAL-ONLY AI INFERENCE via Ollama/Gemma4. USE THIS when: data is sensitive and must not leave the machine, user requests offline processing, or maximum token savings are needed (0 cloud tokens). Does NOT fall back to cloud. If Ollama is unreachable, returns an error. Reads files via Node.js per AIRGAP protocol.",
      inputSchema: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "What the local AI should do." },
          input_file:  { type: "string", description: "OPTIONAL. File path to read locally." },
          output_file: { type: "string", description: "OPTIONAL. Save result to this path." },
          model:       { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Maps to gemma4:e4b. Default: flash-lite." },
        },
        required: ["instruction"]
      }
    },
    {
      name: "ask_smart",
      description: "LOCAL-FIRST SMART PIPELINE. USE THIS when cost efficiency is the priority. Tries Gemma4 locally first (free, ~560ms). If local output is sufficient, returns immediately with 0 cloud tokens used. If local result is too short or Ollama fails, escalates automatically to Groq/OpenRouter. Best for: medium-complexity tasks where local might be enough.",
      inputSchema: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "What the AI should do." },
          input_file:  { type: "string", description: "OPTIONAL. File path to read." },
          output_file: { type: "string", description: "OPTIONAL. Save result to this path." },
          model:       { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Default: flash-lite." },
        },
        required: ["instruction"]
      }
    },
    {
      name: "ask_url",
      description: "AIRGAP URL INGESTION. USE THIS when processing a URL's content. Fetches the URL locally (Node.js) and delegates processing to AI. Claude never sees the raw HTML or response body. Best for: reading docs pages, API references, JSON endpoints.",
      inputSchema: {
        type: "object",
        properties: {
          url:           { type: "string", description: "URL to fetch and process (e.g. https://example.com/data)." },
          instruction:   { type: "string", description: "What the AI should do with the fetched content." },
          output_file:   { type: "string", description: "OPTIONAL. Path to save the result." },
          model:         { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Default: flash-lite." },
          output_format: { type: "string", enum: ["text", "json"], description: "OPTIONAL. Default: text." },
        },
        required: ["url", "instruction"]
      }
    },
    {
      name: "ask_batch",
      description: "AIRGAP BATCH INGESTION. USE THIS when processing multiple files together with the same instruction. Ideal for: summarizing weekly logs, multi-module audits, cross-file analysis. All files read by Node.js in parallel — Claude never sees content.",
      inputSchema: {
        type: "object",
        properties: {
          instruction:   { type: "string", description: "What the AI should do with all files." },
          input_files:   { type: "array", items: { type: "string" }, description: "Array of file paths to process together." },
          output_file:   { type: "string", description: "OPTIONAL. Path to save the combined result." },
          model:         { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Default: flash-lite." },
          output_format: { type: "string", enum: ["text", "json"], description: "OPTIONAL. Default: text." },
          task_type:     { type: "string", enum: ["auto", "ingest", "fast", "cheap", "reason"], description: "OPTIONAL. Routing hint. Default: auto." },
        },
        required: ["instruction", "input_files"]
      }
    },
    {
      name: "ask_diff",
      description: "AIRGAP DIFF ANALYSIS. USE THIS automatically when: a git diff file or patch is >100 lines, user asks to review changes, or input file ends in .diff or .patch. Reads the diff via Node.js, sends to AI. Returns: files changed, risk level per file, breaking change detection. Claude NEVER loads diff content.",
      inputSchema: {
        type: "object",
        properties: {
          diff_file:   { type: "string", description: "Path to .diff or .patch file. Pass 'stdin' to capture 'git diff HEAD' automatically." },
          instruction: { type: "string", description: "OPTIONAL. Default: summarize changes, identify risks, flag breaking changes." },
          output_file: { type: "string", description: "OPTIONAL. Save report to this path." },
          model:       { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Default: flash." },
        },
        required: ["diff_file"]
      }
    },
    {
      name: "ask_schema",
      description: "AIRGAP SCHEMA EXTRACTION. USE THIS automatically when: input file ends in .prisma, .sql, .graphql, or is an OpenAPI/Swagger .yaml/.json >2KB. Reads schema via Node.js, sends to AI. Returns ONLY normalized structure: tables/models, fields, types, relations. Raw file never enters Claude's context.",
      inputSchema: {
        type: "object",
        properties: {
          input_file:  { type: "string", description: "Path to .prisma, .sql, .graphql, openapi.yaml/json schema file." },
          instruction: { type: "string", description: "OPTIONAL. Default: extract all models/tables with fields, types, and relations as JSON." },
          output_file: { type: "string", description: "OPTIONAL. Save extracted schema to this path." },
          model:       { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Default: flash-lite." },
        },
        required: ["input_file"]
      }
    },
    {
      name: "ask_compress",
      description: "TWO-STAGE CONTEXT COMPACTION. USE THIS automatically when: user types /compact, conversation references growing context, or a log/history file >50KB needs summarizing. Stage 1: Gemma4 (local, free) compresses the file. Stage 2: Groq finalizes the summary. Minimizes cloud tokens. Returns a dense summary preserving key facts, decisions, file paths, and tool results.",
      inputSchema: {
        type: "object",
        properties: {
          input_file:  { type: "string", description: "Path to conversation history, log, or any large text file to compact." },
          focus:       { type: "string", description: "OPTIONAL. Extra focus instructions (e.g. 'preserve all file paths and error messages')." },
          output_file: { type: "string", description: "OPTIONAL. Save compact summary to this path." },
          model:       { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Default: flash-lite." },
        },
        required: ["input_file"]
      }
    },
  ]
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // --- Tool: ask_ai ---
    if (name === "ask_ai") {
      const { instruction, input_file, output_file, model = 'flash-lite', output_format = 'text', task_type = 'auto' } = args;
      let prompt = instruction;
      if (input_file) {
        const content = await readFileGuarded(input_file);
        prompt = `${instruction}\n\n--- FILE: ${input_file} ---\n${content}`;
      }
      const order = routeProviders(task_type);
      const meta  = await callWithFallback(prompt, model, output_format, order);
      return writeOutput(meta.text, output_file, meta, `AI processed '${input_file ?? 'instruction'}'.`);
    }

    // --- Tool: ask_local ---
    if (name === "ask_local") {
      const { instruction, input_file, output_file, model = 'flash-lite' } = args;
      let prompt = instruction;
      if (input_file) {
        const content = await readFileGuarded(input_file);
        prompt = `${instruction}\n\n--- FILE: ${input_file} ---\n${content}`;
      }
      const cfg       = PROVIDER_REGISTRY.ollama;
      const modelName = cfg.models[model] ?? cfg.models['flash-lite'];
      const text      = await callOllamaRaw(modelName, prompt);
      const meta      = { text, inTok: 0, outTok: 0, cost: 0, provider: 'ollama', model: modelName };
      return writeOutput(meta.text, output_file, meta, `Local AI processed '${input_file ?? 'instruction'}'.`);
    }

    // --- Tool: ask_smart (local-first pipeline) ---
    if (name === "ask_smart") {
      const { instruction, input_file, output_file, model = 'flash-lite' } = args;
      let prompt = instruction;
      if (input_file) {
        const content = await readFileGuarded(input_file);
        prompt = `${instruction}\n\n--- FILE: ${input_file} ---\n${content}`;
      }

      // Stage 1: Try Gemma4 locally (0 cloud tokens)
      try {
        const cfg       = PROVIDER_REGISTRY.ollama;
        const modelName = cfg.models[model] ?? cfg.models['flash-lite'];
        const localText = await callOllamaRaw(modelName, prompt);
        if (localText && localText.length >= LOCAL_MIN_LENGTH) {
          const meta = { text: localText, inTok: 0, outTok: 0, cost: 0, provider: 'ollama', model: modelName };
          return writeOutput(meta.text, output_file, meta, `Local AI handled '${input_file ?? 'instruction'}' (0 cloud tokens).`);
        }
        process.stderr.write(`[INFO] ask_smart: local result too short (${localText?.length ?? 0} chars), escalating...\n`);
      } catch (e) {
        process.stderr.write(`[WARN] ask_smart: Ollama unavailable (${e.message}), escalating to cloud...\n`);
      }

      // Stage 2: Escalate to cloud
      const order = routeProviders('fast');
      const meta  = await callWithFallback(prompt, model, 'text', order);
      return writeOutput(meta.text, output_file, meta, `Cloud AI handled '${input_file ?? 'instruction'}' (local escalated).`);
    }

    // --- Tool: ask_url ---
    if (name === "ask_url") {
      const { url, instruction, output_file, model = 'flash-lite', output_format = 'text' } = args;
      validateUrl(url);

      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let body;
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching: ${url}`);
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > MAX_URL_BODY_BYTES) {
          throw new Error(`URL response too large: ${(parseInt(contentLength)/1024/1024).toFixed(1)}MB exceeds 10MB limit.`);
        }
        body = await response.text();
      } finally {
        clearTimeout(timeoutId);
      }
      if (Buffer.byteLength(body) > MAX_URL_BODY_BYTES) {
        throw new Error(`URL response body exceeds 10MB limit.`);
      }

      const prompt = `${instruction}\n\n--- URL: ${url} ---\n${body}`;
      const meta   = await callWithFallback(prompt, model, output_format);
      return writeOutput(meta.text, output_file, meta, `AI processed URL '${url}'.`);
    }

    // --- Tool: ask_batch ---
    if (name === "ask_batch") {
      const { instruction, input_files, output_file, model = 'flash-lite', output_format = 'text', task_type = 'auto' } = args;
      if (input_files.length > 20) throw new Error('Batch limit: max 20 files per call.');
      const results = await Promise.allSettled(
        input_files.map(async (f) => {
          const content = await readFileGuarded(f);
          return `--- FILE: ${f} ---\n${content}`;
        })
      );
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) {
        process.stderr.write(`[WARN] ask_batch: ${failed.length} file(s) skipped: ${failed.map((r, i) => `${input_files[i]}: ${r.reason.message}`).join('; ')}\n`);
      }
      const sections = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (sections.length === 0) throw new Error('All files failed to read.');
      const prompt = `${instruction}\n\n${sections.join('\n\n')}`;
      const order  = routeProviders(task_type);
      const meta   = await callWithFallback(prompt, model, output_format, order);
      return writeOutput(meta.text, output_file, meta, `AI processed ${sections.length}/${input_files.length} files.`);
    }

    // --- Tool: ask_diff ---
    if (name === "ask_diff") {
      const { diff_file, instruction, output_file, model = 'flash' } = args;
      let diffContent;
      if (diff_file === 'stdin') {
        const { execFile } = await import('child_process');
        diffContent = await new Promise((resolve, reject) => {
          execFile('git', ['diff', 'HEAD'], { encoding: 'utf8', cwd: CWD }, (err, stdout) => {
            if (err) reject(err); else resolve(stdout);
          });
        });
      } else {
        diffContent = await readFileGuarded(diff_file);
      }
      const inst   = instruction ?? 'Summarize all changes. For each file: list what changed, assess risk (low/medium/high), and flag any breaking changes or security issues.';
      const prompt = `${inst}\n\n--- DIFF ---\n${diffContent}`;
      const order  = routeProviders('ingest');
      const meta   = await callWithFallback(prompt, model, 'text', order);
      return writeOutput(meta.text, output_file, meta, `Diff analysis complete.`);
    }

    // --- Tool: ask_schema ---
    if (name === "ask_schema") {
      const { input_file, instruction, output_file, model = 'flash-lite' } = args;
      const content = await readFileGuarded(input_file);
      const inst    = instruction ?? 'Extract all models/tables with their fields, types, constraints, and relations. Return ONLY valid JSON. No explanation.';
      const prompt  = `${inst}\n\n--- SCHEMA FILE: ${input_file} ---\n${content}`;
      const order   = routeProviders('ingest');
      const meta    = await callWithFallback(prompt, model, 'json', order);
      return writeOutput(meta.text, output_file, meta, `Schema extracted from '${input_file}'.`);
    }

    // --- Tool: ask_compress (two-stage: Gemma4 local → Groq) ---
    if (name === "ask_compress") {
      const { input_file, focus, output_file, model = 'flash-lite' } = args;
      const content  = await readFileGuarded(input_file);
      const focusTip = focus ? `\nFocus especially on: ${focus}` : '';

      // Stage 1: Gemma4 local pre-compression (free)
      let compressedContent = content;
      try {
        const localModel   = PROVIDER_REGISTRY.ollama.models['flash-lite'];
        const compressPrompt = `Compress the following content to a dense summary. Preserve all key facts, decisions, file paths, error messages, and data. Output ONLY the summary, no preamble.${focusTip}\n\n${content}`;
        const compressed = await callOllamaRaw(localModel, compressPrompt);
        if (compressed && compressed.length > 50 && compressed.length < content.length) {
          process.stderr.write(`[INFO] ask_compress: Gemma4 compressed ${content.length} → ${compressed.length} chars\n`);
          compressedContent = compressed;
        }
      } catch (e) {
        process.stderr.write(`[WARN] ask_compress: local stage skipped (${e.message}), using original\n`);
      }

      // Stage 2: Cloud finalization (use 'fast' to skip Ollama if Stage 1 already failed)
      const prompt = `Summarize the following content concisely. Preserve all key decisions, file paths, error messages, tool results, and facts needed to continue work.${focusTip}\n\n--- CONTENT ---\n${compressedContent}`;
      const order  = routeProviders('fast');
      const meta   = await callWithFallback(prompt, model, 'text', order);
      return writeOutput(meta.text, output_file, meta, `Compacted '${input_file}'.`);
    }

    throw new Error(`Tool not found: ${name}`);

  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }] };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
