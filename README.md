# TIL — Today I Learned

个人代码片段与技术备忘仓库。

## 目录

### 📕 博客文章

[进入博客](https://github.com/ZengLiangYi/til/issues?q=label%3Ablog)

<!-- BLOG-LIST:START -->
1. [用 AudioContext.suspend()/resume() 作为流式音视频的同步门控](https://github.com/ZengLiangYi/til/issues/3)
2. [React 事件订阅的稳定引用问题：从 useEffect 到 useEffectEvent](https://github.com/ZengLiangYi/til/issues/2)
3. [并发 401 下的 Token 刷新竞态：一个被低估的 Bug](https://github.com/ZengLiangYi/til/issues/1)
<!-- BLOG-LIST:END -->

### `/react`

| 文件 | 说明 |
|------|------|
| [use-stable-handler.ts](react/use-stable-handler.ts) | 稳定事件订阅 Hook，解决 handler 频繁变化导致反复 subscribe/unsubscribe 的问题 |

### `/typescript`

| 文件 | 说明 |
|------|------|
| [token-refresh-queue.ts](typescript/token-refresh-queue.ts) | 并发 Token 刷新队列，解决多个请求同时 401 时的竞态条件 |
| [audiocontext-sync-gate.ts](typescript/audiocontext-sync-gate.ts) | AudioContext suspend/resume 同步门控，解决流式音视频同步问题 |
