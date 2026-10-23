import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const stickers = JSON.parse(readFileSync(join(ROOT, "stickers.json"), "utf8"));
const widgetHtml = readFileSync(join(ROOT, "public", "sticker-widget.html"), "utf8");
const RESOURCE_URI = "ui://stickers/widget.html";

function makeServer() {
  const server = new McpServer({ name: "azhou-stickers", version: "1.0.0" });

  registerAppResource(server, "sticker-widget", RESOURCE_URI, {
    description: "Displays original stickers from the user's personal sticker collection.",
    _meta: { ui: { csp: { resourceDomains: ["https://i.postimg.cc"] } } }
  }, async () => ({
    contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: widgetHtml }]
  }));

  const stickerSchema = z.object({
    id: z.string(),
    name: z.string(),
    labels: z.array(z.string()),
    imageUrl: z.string().url()
  });
  const outputSchema = { stickers: z.array(stickerSchema) };

  registerAppTool(server, "sticker_search", {
    title: "Search personal stickers",
    description: "Search the user's existing sticker collection by meaning, mood, name, or labels. Use this when a sticker would naturally fit the conversation. Returns original image URLs, not generated images.",
    inputSchema: { query: z.string().min(1).describe("Meaning, emotion, or situation to match") },
    outputSchema,
    _meta: { ui: { resourceUri: RESOURCE_URI } }
  }, async ({ query }) => {
    const terms = query.toLowerCase().split(/[\s，,。！？!？、]+/).filter(Boolean);
    const scored = stickers.map((s) => {
      const searchable = [s.name, ...(s.labels || [])].join(" ").toLowerCase();
      const score = terms.reduce((sum, term) => sum + (searchable.includes(term) ? 2 : 0), 0);
      return { sticker: { id: s.id, name: s.name, labels: s.labels || [], imageUrl: s.imageUrl }, score };
    }).sort((a, b) => b.score - a.score);
    const matches = scored.filter(x => x.score > 0).slice(0, 8).map(x => x.sticker);
    const results = matches.length ? matches : stickers.slice(0, 6).map(s => ({ id:s.id, name:s.name, labels:s.labels || [], imageUrl:s.imageUrl }));
    return {
      content: [{ type: "text", text: results.length ? `Found ${results.length} original sticker(s) matching “${query}”. Choose the most contextually appropriate one and show it using sticker_pick.` : "No stickers found." }],
      structuredContent: { stickers: results }
    };
  });

  registerAppTool(server, "sticker_pick", {
    title: "Show an original sticker",
    description: "Display one original sticker from the user's collection as a small image card. Use the id returned by sticker_search.",
    inputSchema: { id: z.string().min(1).describe("Sticker id from sticker_search") },
    outputSchema,
    _meta: { ui: { resourceUri: RESOURCE_URI } }
  }, async ({ id }) => {
    const s = stickers.find(item => item.id === id);
    if (!s) return { content: [{ type: "text", text: "Sticker id not found. Search the collection again." }], structuredContent: { stickers: [] } };
    const item = { id: s.id, name: s.name, labels: s.labels || [], imageUrl: s.imageUrl };
    return {
      content: [{ type: "text", text: `Showing the original sticker “${s.name}”.` }],
      structuredContent: { stickers: [item] }
    };
  });

  return server;
}

const port = Number(process.env.PORT || 8787);
const mcpPath = "/mcp";
const httpServer = createServer(async (req, res) => {
  if (!req.url) return res.writeHead(400).end("Missing URL");
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") {
    return res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Azhou sticker MCP is running.");
  }
  if (req.method === "OPTIONS" && url.pathname === mcpPath) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version",
      "Access-Control-Expose-Headers": "Mcp-Session-Id"
    });
    return res.end();
  }
  if (url.pathname === mcpPath && ["POST", "GET", "DELETE"].includes(req.method || "")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }
  res.writeHead(404).end("Not Found");
});
httpServer.listen(port, "0.0.0.0", () => console.log(`Azhou sticker MCP listening on port ${port}`));
