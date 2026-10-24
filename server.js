import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const STICKERS = JSON.parse(readFileSync(join(ROOT, "stickers.json"), "utf8"));
const STICKER_BY_ID = new Map(STICKERS.map((sticker) => [sticker.id, sticker]));
const IMAGE_CACHE = new Map();
const IMAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const IMAGE_CACHE_MAX_ITEMS = 25;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://azhou-stickers.onrender.com").replace(/\/$/, "");

const searchResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  labels: z.array(z.string())
});

const stickerOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  imageUrl: z.string().url(),
  markdown: z.string()
});

function tokenize(query) {
  return query
    .toLowerCase()
    .split(/[\s，,。！？!？、；;：:]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function searchStickers(query) {
  const terms = tokenize(query);
  const scored = STICKERS.map((sticker, index) => {
    const name = String(sticker.name || "").toLowerCase();
    const labels = (sticker.labels || []).map((label) => String(label).toLowerCase());
    let score = 0;

    for (const term of terms) {
      if (name === term) score += 8;
      else if (name.includes(term)) score += 5;
      for (const label of labels) {
        if (label === term) score += 4;
        else if (label.includes(term) || term.includes(label)) score += 2;
      }
    }

    return { sticker, score, index };
  });

  return scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8)
    .map(({ sticker }) => ({
      id: sticker.id,
      name: sticker.name,
      labels: sticker.labels || []
    }));
}

function pruneImageCache() {
  const now = Date.now();
  for (const [id, entry] of IMAGE_CACHE) {
    if (now - entry.cachedAt > IMAGE_CACHE_TTL_MS) IMAGE_CACHE.delete(id);
  }
  while (IMAGE_CACHE.size > IMAGE_CACHE_MAX_ITEMS) {
    IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value);
  }
}

async function loadNativeImage(sticker) {
  pruneImageCache();
  const cached = IMAGE_CACHE.get(sticker.id);
  if (cached) return cached.content;

  const response = await fetch(sticker.imageUrl, {
    headers: { "user-agent": "Azhou-Stickers/2.0" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Image request failed with HTTP ${response.status}`);

  const mimeType = (response.headers.get("content-type") || "image/jpeg")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unexpected content type: ${mimeType}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error("Image response was empty");
  if (buffer.length > 5 * 1024 * 1024) throw new Error("Image exceeds 5 MiB");

  const content = {
    type: "image",
    data: buffer.toString("base64"),
    mimeType
  };
  IMAGE_CACHE.set(sticker.id, { cachedAt: Date.now(), content });
  pruneImageCache();
  return content;
}

function createStickerServer() {
  const server = new McpServer(
    { name: "azhou-native-stickers", version: "2.2.0" },
    {
      instructions:
        "Use find_azhou_stickers to search Qiufann's original sticker collection. Then call send_azhou_sticker with one returned id. After the send call, copy structuredContent.markdown exactly into the assistant's visible reply so the sticker appears outside the collapsed integration result. Never invent a sticker id or replace it with a generated image."
    }
  );

  server.registerTool(
    "find_azhou_stickers",
    {
      title: "查找阿昼的表情包",
      description:
        "按情绪、含义、名称或标签搜索秋凡的原创表情包库。先搜索，再从结果中选最符合当前语境的一张。",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(60).describe("要表达的情绪、动作或语境")
      }),
      outputSchema: z.object({ results: z.array(searchResultSchema) })
    },
    async ({ query }) => {
      const results = searchStickers(query);
      return {
        content: [{
          type: "text",
          text: results.length
            ? `找到 ${results.length} 张与“${query}”匹配的表情包。请从结果中选一张，并调用 send_azhou_sticker。`
            : `没有找到与“${query}”匹配的表情包。可以换一个更短的情绪词再试。`
        }],
        structuredContent: { results }
      };
    }
  );

  server.registerTool(
    "send_azhou_sticker",
    {
      title: "发送阿昼的表情包",
      description:
        "把 find_azhou_stickers 返回的某个表情包作为 MCP 原生图片直接发送到聊天中。不会打开 UI 卡片。",
      inputSchema: z.object({
        id: z.string().regex(/^\d{3}$/).describe("搜索结果中的三位表情包编号")
      })
    },
    async ({ id }) => {
      const sticker = STICKER_BY_ID.get(id);
      if (!sticker) {
        return {
          isError: true,
          content: [{ type: "text", text: `没有编号为 ${id} 的表情包，请重新搜索。` }]
        };
      }

      try {
        const image = await loadNativeImage(sticker);
        const publicImageUrl = `${PUBLIC_BASE_URL}/sticker/${sticker.id}`;
        const markdown = `![${sticker.id}｜${sticker.name}](${publicImageUrl})`;
        return {
          content: [
            image,
            {
              type: "text",
              text: `${sticker.id}｜${sticker.name}\n请把下面这行原样放进最终回复：\n${markdown}`
            }
          ],
          structuredContent: {
            id: sticker.id,
            name: sticker.name,
            imageUrl: publicImageUrl,
            markdown
          }
        };
      } catch (error) {
        console.error(`Failed to load sticker ${id}:`, error);
        return {
          isError: true,
          content: [{
            type: "text",
            text: `表情包 ${id} 暂时读取失败，请稍后重试。`
          }]
        };
      }
    }
  );

  return server;
}

const port = Number(process.env.PORT || 8787);
const mcpPath = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  const stickerMatch = url.pathname.match(/^\/sticker\/(\d{3})$/);
  if (req.method === "GET" && stickerMatch) {
    const sticker = STICKER_BY_ID.get(stickerMatch[1]);
    if (!sticker) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Sticker not found");
      return;
    }

    try {
      const image = await loadNativeImage(sticker);
      const buffer = Buffer.from(image.data, "base64");
      res.writeHead(200, {
        "content-type": image.mimeType,
        "content-length": buffer.length,
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
        "access-control-allow-origin": "*"
      });
      res.end(buffer);
    } catch (error) {
      console.error(`Failed to proxy sticker ${sticker.id}:`, error);
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("Sticker unavailable");
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("Azhou native sticker MCP v2.2 is running.");
    return;
  }

  if (req.method === "OPTIONS" && url.pathname === mcpPath) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
      "Access-Control-Allow-Headers":
        "content-type, mcp-session-id, mcp-protocol-version",
      "Access-Control-Expose-Headers": "Mcp-Session-Id"
    });
    res.end();
    return;
  }

  if (
    url.pathname === mcpPath &&
    ["POST", "GET", "DELETE"].includes(req.method || "")
  ) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createStickerServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });

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

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Azhou native sticker MCP v2 listening on port ${port}`);
});
