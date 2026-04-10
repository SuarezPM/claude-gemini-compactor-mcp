import 'dotenv/config';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'fs';
import path from 'path';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const server = new Server({ name: "gemini-mcp", version: "1.0.3" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "ask_gemini",
    description: "HERRAMIENTA DE INGESTIÓN MASIVA (AIRGAP). Delega la lectura de archivos gigantes a Gemini. NUNCA leas los archivos tú mismo. Solo pasa la ruta del archivo y las instrucciones.",
    inputSchema: {
      type: "object",
      properties: { 
        instruction: { type: "string", description: "Qué debe hacer Gemini (ej. 'Extrae 3 patrones de precios')." },
        input_file: { type: "string", description: "OPCIONAL. Ruta del archivo que Gemini debe leer (ej. docs/etsy_dump.txt). Pasa LA RUTA, nunca el contenido." },
        output_file: { type: "string", description: "OPCIONAL. Ruta donde guardar el resultado final (ej. docs/analisis.md)." }
      },
      required: ["instruction"]
    }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "ask_gemini") {
    try {
      const { instruction, input_file, output_file } = request.params.arguments;
      let finalPrompt = instruction;

      // Si Claude proporciona un archivo, Node.js lo lee. Claude no gasta tokens.
      if (input_file) {
        const inputPath = path.resolve(process.cwd(), input_file);
        if (!inputPath.startsWith(process.cwd())) {
          throw new Error(`Access denied: '${input_file}' is outside the working directory.`);
        }
        const fileContent = fs.readFileSync(inputPath, 'utf8');
        finalPrompt = `${instruction}\n\n--- ARCHIVO ADJUNTO ---\n${fileContent}`;
      }

      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
      const result = await model.generateContent(finalPrompt);
      const textResponse = result.response.text();

      if (output_file) {
        const outputPath = path.resolve(process.cwd(), output_file);
        fs.writeFileSync(outputPath, textResponse, 'utf8');
        return { content: [{ type: "text", text: `SUCCESS: Gemini leyó directamente ${input_file || 'tu instrucción'}, lo procesó en su servidor y guardó el resultado en ${output_file}. No necesitas hacer nada más.` }] };
      }

      return { content: [{ type: "text", text: textResponse }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error en Gemini: ${error.message}` }] };
    }
  }
  throw new Error("Herramienta no encontrada");
});

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);