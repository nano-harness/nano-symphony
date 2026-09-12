# ADR 002: MCP 协议版本协商

[English](./002-mcp-protocol-version-negotiation.md)

## 状态

已接受（Accepted）

## 背景

`src/mcp/server.ts` 原先在 `initialize` 响应中硬编码
`protocolVersion: "2024-11-05"`，完全忽略客户端请求的版本。此后 MCP 协议
持续演进：`2024-11-05`（初版）→ `2025-03-26` → `2025-06-18` →
`2025-11-25`（一周年修订版，新增 Tasks 抽象与 URL 模式 elicitation）。
更晚的 `2026-07-28` 草案是一次 breaking redesign：删除 `initialize`
握手，转向无状态传输。

没有版本协商时，需要 `2025-03-26` 及以后特性的新客户端无法判断服务器
是否支持这些特性，而服务器声称的版本也未必是它真正实现的能力。

## 决策

### 1. 按 MCP 规范进行版本协商

服务器维护一个按时间排序的支持版本列表（`src/mcp/protocol.ts`）：

```
["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
```

在 `initialize` 时，服务器读取客户端请求中的 `params.protocolVersion`：

- 若请求的版本在支持列表中，服务器回显该版本。
- 否则按规范返回服务器支持的最新版本（`2025-11-25`），由客户端自行决定
  继续还是断开连接。

### 2. 通知容忍

JSON-RPC 通知（以 `notifications/` 为前缀的方法，包括
`notifications/initialized`）不携带 `id`，也不期望响应。按照 Streamable
HTTP 传输约定，服务器以 HTTP `202 Accepted` 和空响应体进行确认，而不是
返回 `-32601` "Method not found" 错误。

### 3. 暂不适配 2026-07-28 无状态化重构

`2026-07-28` 修订版完全删除了 `initialize` 握手——这对所有客户端以及本
服务器依赖的 token 作用域会话模型都是破坏性变更。我们刻意保留现有握手
架构，支持版本上限定为 `2025-11-25`。待该修订版定稿且客户端支持普及后
再做适配，届时需要单独的 ADR 和针对 agent token 的迁移方案。

## 后果

### 正面

- 新客户端（2025-03-26 及以后）可以协商到所需版本；旧的 2024-11-05
  客户端不受影响，继续可用。
- 未来新增支持版本只需修改 `src/mcp/protocol.ts` 中的一行。
- 发送 `notifications/initialized` 的标准客户端不再收到多余的协议错误。

### 负面

- 服务器声称支持 `2025-11-25`，但尚未实现其新增特性（Tasks、URL 模式
  elicitation）；需要这些特性的客户端必须通过 `capabilities` 检测缺失
  的能力。
- 2026-07-28 无状态化重构最终会迫使一次 breaking change；推迟适配积累
  了一笔已知的迁移债务。

## 相关文档

- `src/mcp/protocol.ts`
- `src/mcp/server.ts`
- `tests/unit/mcp-protocol.test.ts`
- MCP 规范 changelog（modelcontextprotocol.io）
