import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const stickers = JSON.parse(readFileSync(join(ROOT, "stickers.json"), "utf8"));
const LEGACY_RESOURCE_URIS = [
  "ui://stickers/widget.html",
  "ui://stickers/widget-v2.html",
  "ui://stickers/widget-v3.html"
];
const LEGACY_RESOURCE_META = {
  ui: { prefersBorder: false },
  "openai/widgetPrefersBorder": false
};
const legacyWidgetHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:transparent;color:#6d8492;font:13px/1.5 system-ui,sans-serif}body{padding:8px 12px}</style></head>
<body>旧版表情卡片已停用；新表情包会直接显示在聊天中。
<script>
(() => {
  let rpcId = 0;
  const pending = new Map();
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, { resolve, reject });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0" || typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(message.error);
    else waiter.resolve(message.result);
  }, { passive: true });
  request("ui/initialize", {
    appInfo: { name: "azhou-stickers-legacy", version: "1.2.0" },
    appCapabilities: {},
    protocolVersion: "2026-01-26"
  }).then(() => {
    window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
  }).catch(() => {});
})();
</script></body></html>`;

async function fetchStickerImage(imageUrl) {
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Image request failed with ${response.status}`);
  const mimeType = (response.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!mimeType.startsWith("image/")) throw new Error(`Unexpected image type: ${mimeType}`);
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");
  return { type: "image", data, mimeType };
}

function makeServer() {
  const server = new McpServer({ name: "azhou-stickers", version: "1.2.0" });

  for (const [index, uri] of LEGACY_RESOURCE_URIS.entries()) {
    registerAppResource(server, `legacy-sticker-widget-${index + 1}`, uri, {
      description: "Compatibility view for older sticker messages.",
      _meta: LEGACY_RESOURCE_META
    }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: legacyWidgetHtml, _meta: LEGACY_RESOURCE_META }]
    }));
  }

  const stickerSchema = z.object({
    id: z.string(),
    name: z.string(),
    labels: z.array(z.string()),
    imageUrl: z.string().url()
  });
  const outputSchema = z.object({ stickers: z.array(stickerSchema) });

  server.registerTool("sticker_search", {
    title: "Search personal stickers",
    description: "Search the user's existing sticker collection by meaning, mood, name, or labels. Use this when a sticker would naturally fit the conversation. Returns original image URLs, not generated images.",
    inputSchema: z.object({ query: z.string().min(1).describe("Meaning, emotion, or situation to match") }),
    outputSchema
  }, async ({ query }) => {
    const terms = query.toLowerCase().split(/[\\s，,。！？!？、]+/).filter(Boolean);
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

  server.registerTool("sticker_pick", {
    title: "Show an original sticker",
    description: "Return one original sticker from the user's collection as a native image. Use the id returned by sticker_search.",
    inputSchema: z.object({ id: z.string().min(1).describe("Sticker id from sticker_search") }),
    outputSchema
  }, async ({ id }) => {
    const s = stickers.find(item => item.id === id);
    if (!s) return { content: [{ type: "text", text: "Sticker id not found. Search the collection again." }], structuredContent: { stickers: [] } };
    const item = { id: s.id, name: s.name, labels: s.labels || [], imageUrl: s.imageUrl };
    let imageContent;
    try { imageContent = await fetchStickerImage(s.imageUrl); }
    catch (error) { console.error(`Failed to fetch sticker ${s.id}:`, error); }
    return {
      content: [
        { type: "text", text: `Showing the original sticker “${s.name}”.` },
        ...(imageContent ? [imageContent] : [])
      ],
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
    res.on("close", () => { void transport.close().catch(() => {}); void server.close().catch(() => {}); });
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
