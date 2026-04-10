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
const CWD = process.cwd();

// ── Provider Registry ────────────────────────────────────────────────────────
// Each entry: baseURL, envKey (null = no key needed), ctxLimit, costIn/Out per M tokens
const PROVIDER_REGISTRY = {
  gemini: {
    baseURL:  'https://generativelanguage.googleapis.com/v1beta/openai/',
    envKey:   'GEMINI_API_KEY',
    ctxLimit: 1_000_000,
    costIn:   0.075,  // $ per M tokens
    costOut:  0.30,
    models: {
      'flash-lite': 'gemini-2.0-flash-lite',
      'flash':      'gemini-2.0-flash',
      'pro':        'gemini-1.5-pro',
    },
    strengths: ['ingest', 'large-context'],
  },
  deepseek: {
    baseURL:  'https://api.deepseek.com/v1',
    envKey:   'DEEPSEEK_API_KEY',
    ctxLimit: 64_000,
    costIn:   0.27,
    costOut:  1.10,
    models: {
      'flash-lite': 'deepseek-chat',
      'flash':      'deepseek-chat',
      'pro':        'deepseek-reasoner',
    },
    strengths: ['cheap', 'reason'],
  },
  groq: {
    baseURL:  'https://api.groq.com/openai/v1',
    envKey:   'GROQ_API_KEY',
    ctxLimit: 128_000,
    costIn:   0.0,
    costOut:  0.0,
    models: {
      'flash-lite': 'llama-3.3-70b-versatile',
      'flash':      'llama-3.3-70b-versatile',
      'pro':        'llama-3.3-70b-versatile',
    },
    strengths: ['fast'],
  },
  openrouter: {
    baseURL:  'https://openrouter.ai/api/v1',
    envKey:   'OPENROUTER_API_KEY',
    ctxLimit: 1_000_000,
    costIn:   0.0,
    costOut:  0.0,
    models: {
      'flash-lite': 'google/gemini-2.0-flash-exp:free',
      'flash':      'google/gemini-2.0-flash-exp:free',
      'pro':        'meta-llama/llama-4-maverick:free',
    },
    strengths: ['fallback', 'web'],
  },
  ollama: {
    baseURL:  process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
    envKey:   null,  // local server — no key required
    ctxLimit: 128_000,
    costIn:   0.0,
    costOut:  0.0,
    models: {
      'flash-lite': 'llama3.2',
      'flash':      'llama3.3',
      'pro':        'llama3.3',
    },
    strengths: ['local', 'offline', 'private'],
  },
};

// ── Build active clients from present env keys ───────────────────────────────
const clients = {};
const ACTIVE_PROVIDERS = [];

for (const [id, cfg] of Object.entries(PROVIDER_REGISTRY)) {
  if (cfg.envKey === null) {
    // Local provider (Ollama) — always attempt, no API key needed
    clients[id] = new OpenAI({ apiKey: 'ollama', baseURL: cfg.baseURL });
    ACTIVE_PROVIDERS.push(id);
    continue;
  }
  const apiKey = process.env[cfg.envKey];
  if (apiKey) {
    clients[id] = new OpenAI({ apiKey, baseURL: cfg.baseURL });
    ACTIVE_PROVIDERS.push(id);
  }
}

// Must have at least one cloud provider (Ollama alone isn't sufficient at startup)
const cloudProviders = ACTIVE_PROVIDERS.filter(id => PROVIDER_REGISTRY[id].envKey !== null);
if (cloudProviders.length === 0) {
  process.stderr.write('[FATAL] No API keys configured. Set at least one of: GEMINI_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY.\n');
  process.exit(1);
}

process.stderr.write(`[INFO] Active providers: ${ACTIVE_PROVIDERS.join(', ')}\n`);

const server = new Server(
  { name: "ai-router-mcp", version: "4.0.0" },
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
    if (!clients[id]) continue;
    try {
      const cfg       = PROVIDER_REGISTRY[id];
      const modelName = cfg.models[modelKey] ?? cfg.models['flash-lite'];

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
// Returns ordered provider list: best-fit first, others as fallback.
function routeProviders(taskType = 'auto') {
  const ROUTING = {
    ingest: ['gemini', 'openrouter', 'deepseek', 'groq', 'ollama'],  // large context first
    fast:   ['groq', 'deepseek', 'gemini', 'openrouter', 'ollama'],  // lowest latency first
    cheap:  ['deepseek', 'groq', 'ollama', 'gemini', 'openrouter'],  // lowest cost first
    reason: ['deepseek', 'gemini', 'openrouter', 'groq', 'ollama'],  // reasoning models first
    local:  ['ollama', 'deepseek', 'groq', 'gemini', 'openrouter'],  // offline-first
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
      name: "ask_gemini",
      description: "AIRGAP INGESTION TOOL. USE THIS for general AI tasks: summarizing files, answering questions about code, extracting data. Delegates to AI via provider fallback (Gemini → DeepSeek → Groq → OpenRouter). Claude NEVER reads file content — only passes the PATH. Node.js reads disk locally, AI processes in its context window. USE task_type to optimize routing: 'ingest' for large files, 'fast' for speed, 'cheap' for cost.",
      inputSchema: {
        type: "object",
        properties: {
          instruction:   { type: "string", description: "What the AI should do (e.g. 'Extract all ERROR entries')." },
          input_file:    { type: "string", description: "OPTIONAL. File path to read (e.g. logs/app.log). Pass the PATH, never the content." },
          output_file:   { type: "string", description: "OPTIONAL. Path to save the result (e.g. docs/analysis.md)." },
          model:         { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Model tier. Default: flash-lite (fastest, cheapest)." },
          output_format: { type: "string", enum: ["text", "json"], description: "OPTIONAL. Force structured JSON output. Default: text." },
          task_type:     { type: "string", enum: ["auto", "ingest", "fast", "cheap", "reason"], description: "OPTIONAL. Routing hint. 'ingest'=large files→Gemini first, 'fast'=speed→Groq first, 'cheap'=cost→DeepSeek first, 'reason'=logic→DeepSeek-reasoner. Default: auto." },
        },
        required: ["instruction"]
      }
    },
    {
      name: "ask_gemini_url",
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
      name: "ask_gemini_batch",
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
      name: "ask_gemini_diff",
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
      name: "ask_gemini_schema",
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
      name: "ask_gemini_compact",
      description: "CONTEXT COMPACTION TOOL. USE THIS automatically when: user types /compact, conversation references growing context, or a log/history file >50KB needs summarizing. Reads the file via Node.js, uses AI to produce a compact summary preserving key facts, decisions, file paths, and tool results. Returns the summary text.",
      inputSchema: {
        type: "object",
        properties: {
          input_file:  { type: "string", description: "Path to conversation history, log, or any large text file to compact." },
          focus:       { type: "string", description: "OPTIONAL. Extra focus instructions (e.g. 'preserve all file paths and error messages')." },
          output_file: { type: "string", description: "OPTIONAL. Save compact summary to this path." },
          model:       { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Default: flash-lite (cheapest)." },
        },
        required: ["input_file"]
      }
    },
    {
      name: "ask_ollama",
      description: "LOCAL/OFFLINE AI INFERENCE. USE THIS when: user requests offline processing, data is sensitive and must not leave the machine, or no cloud API keys are available. Routes to local Ollama server (localhost:11434). Falls back to cloud providers if Ollama is unreachable. Reads files via Node.js per AIRGAP protocol.",
      inputSchema: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "What the local AI should do." },
          input_file:  { type: "string", description: "OPTIONAL. File path to read locally." },
          output_file: { type: "string", description: "OPTIONAL. Save result to this path." },
          model:       { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Maps to llama3.2/llama3.3. Default: flash." },
        },
        required: ["instruction"]
      }
    },
  ]
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // --- Tool: ask_gemini ---
    if (name === "ask_gemini") {
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

    // --- Tool: ask_gemini_url ---
    if (name === "ask_gemini_url") {
      const { url, instruction, output_file, model = 'flash-lite', output_format = 'text' } = args;

      validateUrl(url);

      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response, body;
      try {
        response = await fetch(url, { signal: controller.signal });
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

    // --- Tool: ask_gemini_batch ---
    if (name === "ask_gemini_batch") {
      const { instruction, input_files, output_file, model = 'flash-lite', output_format = 'text', task_type = 'auto' } = args;

      const sections = await Promise.all(
        input_files.map(async (f) => {
          const content = await readFileGuarded(f);
          return `--- FILE: ${f} ---\n${content}`;
        })
      );

      const prompt = `${instruction}\n\n${sections.join('\n\n')}`;
      const order  = routeProviders(task_type);
      const meta   = await callWithFallback(prompt, model, output_format, order);
      return writeOutput(meta.text, output_file, meta, `AI processed ${input_files.length} files.`);
    }

    // --- Tool: ask_gemini_diff ---
    if (name === "ask_gemini_diff") {
      const { diff_file, instruction, output_file, model = 'flash' } = args;

      let diffContent;
      if (diff_file === 'stdin') {
        const { execSync } = await import('child_process');
        diffContent = execSync('git diff HEAD', { encoding: 'utf8', cwd: CWD });
      } else {
        diffContent = await readFileGuarded(diff_file);
      }

      const inst   = instruction ?? 'Summarize all changes. For each file: list what changed, assess risk (low/medium/high), and flag any breaking changes or security issues.';
      const prompt = `${inst}\n\n--- DIFF ---\n${diffContent}`;
      const order  = routeProviders('ingest');
      const meta   = await callWithFallback(prompt, model, 'text', order);
      return writeOutput(meta.text, output_file, meta, `Diff analysis complete.`);
    }

    // --- Tool: ask_gemini_schema ---
    if (name === "ask_gemini_schema") {
      const { input_file, instruction, output_file, model = 'flash-lite' } = args;
      const content = await readFileGuarded(input_file);
      const inst    = instruction ?? 'Extract all models/tables with their fields, types, constraints, and relations. Return ONLY valid JSON. No explanation.';
      const prompt  = `${inst}\n\n--- SCHEMA FILE: ${input_file} ---\n${content}`;
      const order   = routeProviders('ingest');
      const meta    = await callWithFallback(prompt, model, 'json', order);
      return writeOutput(meta.text, output_file, meta, `Schema extracted from '${input_file}'.`);
    }

    // --- Tool: ask_gemini_compact ---
    if (name === "ask_gemini_compact") {
      const { input_file, focus, output_file, model = 'flash-lite' } = args;
      const content  = await readFileGuarded(input_file);
      const focusTip = focus ? `\nFocus especially on: ${focus}` : '';
      const prompt   = `Summarize the following content concisely. Preserve all key decisions, file paths, error messages, tool results, and facts needed to continue work.${focusTip}\n\n--- CONTENT ---\n${content}`;
      const order    = routeProviders('cheap');
      const meta     = await callWithFallback(prompt, model, 'text', order);
      return writeOutput(meta.text, output_file, meta, `Compacted '${input_file}'.`);
    }

    // --- Tool: ask_ollama ---
    if (name === "ask_ollama") {
      const { instruction, input_file, output_file, model = 'flash' } = args;
      let prompt = instruction;
      if (input_file) {
        const content = await readFileGuarded(input_file);
        prompt = `${instruction}\n\n--- FILE: ${input_file} ---\n${content}`;
      }
      const order = routeProviders('local');
      const meta  = await callWithFallback(prompt, model, 'text', order);
      return writeOutput(meta.text, output_file, meta, `Local AI processed '${input_file ?? 'instruction'}'.`);
    }

    throw new Error(`Tool not found: ${name}`);

  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }] };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
