#!/usr/bin/env node
import 'dotenv/config';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'fs';
import path from 'path';

// P0: Fail-fast — don't silently fail at runtime
if (!process.env.GEMINI_API_KEY) {
  process.stderr.write('[FATAL] GEMINI_API_KEY is not set. Create a .env file from .env.example.\n');
  process.exit(1);
}

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB hard cap
const MAX_URL_BODY_BYTES  = 10 * 1024 * 1024; // 10MB URL response cap
const FETCH_TIMEOUT_MS    = 15_000;            // 15s fetch timeout
const CWD = process.cwd();                     // cache cwd once at startup

const MODEL_MAP = {
  'flash-lite': 'gemini-2.5-flash-lite',
  'flash':      'gemini-2.0-flash',
  'pro':        'gemini-1.5-pro',
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const server = new Server(
  { name: "gemini-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// P0: Secure path validation — fixes startsWith() bypass bug
function validatePath(filePath) {
  const resolved = path.resolve(CWD, filePath);
  const relative = path.relative(CWD, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Access denied: '${filePath}' is outside the working directory.`);
  }
  return resolved;
}

// P0: SSRF guard — blocks file://, private IPs, and internal hosts
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

// P0: Async read with 50MB size guard — prevents OOM on huge files
async function readFileGuarded(filePath) {
  const resolved = validatePath(filePath);
  const stat = await fs.promises.stat(resolved);
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 50MB limit.`);
  }
  return fs.promises.readFile(resolved, 'utf8');
}

// P1: Central Gemini caller — model selection + token usage + JSON mode
async function callGemini(prompt, modelKey = 'flash-lite', outputFormat = 'text') {
  const modelName = MODEL_MAP[modelKey] ?? MODEL_MAP['flash-lite'];
  const model = genAI.getGenerativeModel({ model: modelName });

  const finalPrompt = outputFormat === 'json'
    ? `${prompt}\n\nCRITICAL: Respond ONLY with valid JSON. No markdown, no explanation, no code blocks.`
    : prompt;

  const result = await model.generateContent(finalPrompt);
  const text = result.response.text();
  const usage = result.response.usageMetadata;
  return { text, usage };
}

// Shared: write output_file and return success message
async function writeOutput(text, outputFile, usage, context) {
  const tokenInfo = usage?.totalTokenCount ? ` [Tokens used: ${usage.totalTokenCount}]` : '';
  if (outputFile) {
    const outPath = validatePath(outputFile);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, text, 'utf8');
    return { content: [{ type: "text", text: `SUCCESS: ${context} Result saved to ${outputFile}.${tokenInfo}` }] };
  }
  return { content: [{ type: "text", text: text + tokenInfo }] };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ask_gemini",
      description: "AIRGAP INGESTION TOOL. Delegates reading of large files to Gemini 2.x. Claude NEVER reads the file content — only passes the PATH. Node.js reads the disk locally, Gemini processes in its 2M-token context.",
      inputSchema: {
        type: "object",
        properties: {
          instruction:   { type: "string", description: "What Gemini should do (e.g. 'Extract all ERROR entries')." },
          input_file:    { type: "string", description: "OPTIONAL. File path to read (e.g. logs/app.log). Pass the PATH, never the content." },
          output_file:   { type: "string", description: "OPTIONAL. Path to save the result (e.g. docs/analysis.md)." },
          model:         { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Model tier. Default: flash-lite (fastest, cheapest)." },
          output_format: { type: "string", enum: ["text", "json"], description: "OPTIONAL. Force structured JSON output. Default: text." },
        },
        required: ["instruction"]
      }
    },
    {
      name: "ask_gemini_url",
      description: "AIRGAP URL INGESTION. Fetches a URL locally (Node.js) and delegates processing to Gemini. Claude never sees the raw HTML or response body.",
      inputSchema: {
        type: "object",
        properties: {
          url:           { type: "string", description: "URL to fetch and process (e.g. https://example.com/data)." },
          instruction:   { type: "string", description: "What Gemini should do with the fetched content." },
          output_file:   { type: "string", description: "OPTIONAL. Path to save the result." },
          model:         { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Default: flash-lite." },
          output_format: { type: "string", enum: ["text", "json"], description: "OPTIONAL. Default: text." },
        },
        required: ["url", "instruction"]
      }
    },
    {
      name: "ask_gemini_batch",
      description: "AIRGAP BATCH INGESTION. Processes an array of files with the same instruction in a single Gemini call. Ideal for summarizing weekly logs, multi-module audits, etc.",
      inputSchema: {
        type: "object",
        properties: {
          instruction:   { type: "string", description: "What Gemini should do with all files." },
          input_files:   { type: "array", items: { type: "string" }, description: "Array of file paths to process together." },
          output_file:   { type: "string", description: "OPTIONAL. Path to save the combined result." },
          model:         { type: "string", enum: ["flash-lite", "flash", "pro"], description: "OPTIONAL. Default: flash-lite." },
          output_format: { type: "string", enum: ["text", "json"], description: "OPTIONAL. Default: text." },
        },
        required: ["instruction", "input_files"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // --- Tool: ask_gemini ---
    if (name === "ask_gemini") {
      const { instruction, input_file, output_file, model = 'flash-lite', output_format = 'text' } = args;
      let prompt = instruction;

      if (input_file) {
        const content = await readFileGuarded(input_file);
        prompt = `${instruction}\n\n--- FILE: ${input_file} ---\n${content}`;
      }

      const { text, usage } = await callGemini(prompt, model, output_format);
      return writeOutput(text, output_file, usage, `Gemini processed '${input_file ?? 'instruction'}'.`);
    }

    // --- Tool: ask_gemini_url ---
    if (name === "ask_gemini_url") {
      const { url, instruction, output_file, model = 'flash-lite', output_format = 'text' } = args;

      validateUrl(url);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching: ${url}`);

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_URL_BODY_BYTES) {
        throw new Error(`URL response too large: ${(parseInt(contentLength)/1024/1024).toFixed(1)}MB exceeds 10MB limit.`);
      }
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_URL_BODY_BYTES) {
        throw new Error(`URL response body exceeds 10MB limit.`);
      }

      const prompt = `${instruction}\n\n--- URL: ${url} ---\n${body}`;
      const { text, usage } = await callGemini(prompt, model, output_format);
      return writeOutput(text, output_file, usage, `Gemini processed URL '${url}'.`);
    }

    // --- Tool: ask_gemini_batch ---
    if (name === "ask_gemini_batch") {
      const { instruction, input_files, output_file, model = 'flash-lite', output_format = 'text' } = args;

      // Read all files in parallel
      const sections = await Promise.all(
        input_files.map(async (f) => {
          const content = await readFileGuarded(f);
          return `--- FILE: ${f} ---\n${content}`;
        })
      );

      const prompt = `${instruction}\n\n${sections.join('\n\n')}`;
      const { text, usage } = await callGemini(prompt, model, output_format);
      return writeOutput(text, output_file, usage, `Gemini processed ${input_files.length} files.`);
    }

    throw new Error(`Tool not found: ${name}`);

  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }] };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
