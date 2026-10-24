# 阿昼的原生表情包 MCP v2

这是从零重建的纯工具版表情包服务。

## 设计

- `find_azhou_stickers`：按名称、标签和语境搜索。
- `send_azhou_sticker`：服务端读取原图并作为 MCP 原生图片返回。
- 不注册 UI 资源。
- 不包含 iframe、卡片、CSP 或 `openai/outputTemplate`。
- 保留 `stickers.json` 中的 101 条原始素材记录。

## MCP 地址

`https://azhou-stickers.onrender.com/mcp`

## 本地运行

```bash
npm install
npm run check
npm start
```
