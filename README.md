# TIL — Today I Learned

个人代码片段与技术备忘仓库。

## 目录

### `/react`

| 文件 | 说明 |
|------|------|
| [use-stable-handler.ts](react/use-stable-handler.ts) | 稳定事件订阅 Hook，解决 handler 频繁变化导致反复 subscribe/unsubscribe 的问题 |

### `/typescript`

| 文件 | 说明 |
|------|------|
| [token-refresh-queue.ts](typescript/token-refresh-queue.ts) | 并发 Token 刷新队列，解决多个请求同时 401 时的竞态条件 |

### `/posts`

| 文章 | 说明 |
|------|------|
| [并发 401 下的 Token 刷新竞态](posts/token-refresh-queue.md) | Deep dive：isRefreshing + 订阅者队列模式，以及隐藏的 Promise 泄漏 bug |
