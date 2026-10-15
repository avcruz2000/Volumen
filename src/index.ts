#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, VERSION } from "./server.js";
import { buildSnapshot } from "./core/snapshot.js";

const args = process.argv.slice(2);
const useHttp = args.includes("--http") || process.env.MCP_TRANSPORT === "http";

if (!useHttp) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`Volumen MCP v${VERSION} listo (stdio)`);
} else {
  const port = Number(process.env.PORT ?? 8787);
  const http = createHttpServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (url.pathname === "/mcp") {
        // Modo sin estado: un servidor + transporte por petición.
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        let body: unknown;
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      if (url.pathname === "/api/snapshot") {
        const snap = await buildSnapshot();
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" });
        return void res.end(JSON.stringify(snap));
      }
      if (url.pathname === "/" || url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify({ name: "volumen", version: VERSION, mcp: "/mcp", snapshot: "/api/snapshot" }));
      }
      res.writeHead(404).end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  http.listen(port, () => console.error(`Volumen MCP v${VERSION} escuchando en http://localhost:${port}/mcp`));
}
