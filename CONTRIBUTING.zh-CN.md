# 为 nano-symphony 做贡献

[English](./CONTRIBUTING.md)

感谢你有兴趣为项目做贡献！本文档介绍基础知识。

## 快速上手

1. 安装 [Bun](https://bun.sh)。
2. 克隆仓库，并在根目录和 `frontend/` 中分别运行 `bun install`。
3. 从 `share/templates/WORKFLOW.example.md` 复制 `WORKFLOW.md`，或自行创建。

## 开发工作流

```bash
bun run lint
bun test tests/unit tests/*.test.ts
bun test tests/integration --concurrency 1
bun test tests/e2e --concurrency 1
cd frontend && bun run test
```

所有测试必须在合并前通过。

## Pull request 规范

- 保持变更聚焦且最小化。
- 变更行为时同步更新测试。
- 更新相关文档（`README.md`、`docs/` 或 `AGENTS.md`）。
- 不要提交密钥、token 或个人的 `.env` 文件。
- 使用清晰的提交信息，说明变更的*原因*。

## 代码风格

- 强制启用 TypeScript strict 模式。
- 优先编写小型函数并进行显式的错误处理。
- 使用 Zod 进行请求校验。
- 避免使用 `any`；优先使用 `unknown` 并配合类型收窄。

## 报告 issue

报告 bug 时，请附上：

- 复现步骤
- 预期行为与实际行为
- `bun --version` 的输出
- 相关日志（隐去密钥等敏感信息）

## 许可证

提交贡献即表示你同意你的贡献将以 MIT License 授权发布。
