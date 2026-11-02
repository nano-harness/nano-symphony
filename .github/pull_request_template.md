# Pull Request

[中文](./pull_request_template.zh-CN.md)

## Description

<!-- Briefly describe what this change does and why -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Docs
- [ ] Other

## Pre-merge Checklist

### Code Quality
- [ ] Type check passes (`bun run lint`)
- [ ] Backend tests pass (`bun test tests/`)
- [ ] Frontend tests pass (`cd frontend && bun run test`)
- [ ] Frontend build succeeds (`cd frontend && bun run build`)

### Code Review
- [ ] Code logic is clear, with no redundant code
- [ ] No new security vulnerabilities introduced
- [ ] Error handling is complete
- [ ] `nullishString()` is used for optional string fields when the schema changes

### Database / State
- [ ] Related schema and type definitions updated when the data model changes
- [ ] Workflow state transition logic is correct (if modified)

### Documentation
- [ ] README or related docs updated (if needed)
- [ ] CHANGELOG.md updated (if needed)

### Other
- [ ] No sensitive information committed (keys, tokens, etc.)
- [ ] Commit messages are clear and follow project conventions
