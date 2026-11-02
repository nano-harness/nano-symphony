# Pull Request

[English](./pull_request_template.md)

## 描述

<!-- 简要描述本次变更的内容和目的 -->

## 变更类型

- [ ] 缺陷修复（Bug fix）
- [ ] 新功能（New feature）
- [ ] 重构（Refactor）
- [ ] 文档更新（Docs）
- [ ] 其他（Other）

## 合并前检查清单

### 代码质量
- [ ] 类型检查通过（`bun run lint`）
- [ ] 后端测试通过（`bun test tests/`）
- [ ] 前端测试通过（`cd frontend && bun run test`）
- [ ] 前端构建成功（`cd frontend && bun run build`）

### 代码审查
- [ ] 代码逻辑清晰，无冗余代码
- [ ] 未引入新的安全漏洞
- [ ] 错误处理完善
- [ ] 涉及 schema 变更时已使用 `nullishString()` 处理可选字符串字段

### 数据库 / 状态
- [ ] 涉及数据模型变更时，已更新相关 schema 及类型定义
- [ ] 工作流状态转换逻辑正确（如有修改）

### 文档
- [ ] README 或相关文档已更新（如有需要）
- [ ] CHANGELOG.md 已更新（如有需要）

### 其他
- [ ] 未提交敏感信息（密钥、Token 等）
- [ ] 提交信息清晰，符合项目规范
