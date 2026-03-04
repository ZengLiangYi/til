# React 事件订阅的稳定引用问题：从 useEffect 到 useEffectEvent

**TL;DR：** 在 React 里订阅 WebSocket / EventEmitter 时，把 handler 直接放进 effect 依赖会导致反复 subscribe/unsubscribe。用 `useRef` 代理最新 handler 可以解决——但渲染阶段直接赋值 ref 在 Strict Mode 下有副作用风险。本文拆解这个模式的三个演进版本，以及 React 19 的终极解法。

> 本文假设你理解 React `useEffect` 的依赖数组机制和闭包基础。

---

## 问题：handler 是新的，订阅也是新的

写 WebSocket 消息监听的第一版，大多数人会这样写：

```tsx
// ❌ 版本 1：handler 变化 = 重新订阅
function ChatPanel({ conversationId }: { conversationId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    socket.on('message:new', (msg) => {
      setMessages((prev) => [...prev, msg]);
    });
    return () => socket.off('message:new', /* 哪个函数？ */);
  }, [conversationId]);
}
```

第一个问题显而易见：`socket.off` 需要传入与 `socket.on` **完全相同的函数引用**，但内联箭头函数每次渲染都是新对象，`off` 根本移除不掉正确的监听器，导致监听器堆积。

修复方式是把 handler 提出来，加入依赖数组：

```tsx
// ❌ 版本 2：监听器能正确移除了，但每次渲染都重订阅
useEffect(() => {
  const handler = (msg: Message) => {
    setMessages((prev) => [...prev, msg]);
  };
  socket.on('message:new', handler);
  return () => socket.off('message:new', handler);
}, [conversationId, setMessages]); // handler 是函数，引用每次都变
```

更典型的场景是 handler 来自 props：

```tsx
// ❌ 每次父组件重渲染，onMessage 是新函数 → 重新订阅
function useSocketEvent(event: string, onMessage: (msg: Message) => void) {
  useEffect(() => {
    socket.on(event, onMessage);
    return () => socket.off(event, onMessage);
  }, [event, onMessage]); // onMessage 每次都是新引用
}
```

父组件只要重渲染（比如 state 更新），`onMessage` 就是新函数，effect 就重跑，WebSocket 就重新订阅一次。在高频更新的组件里，这意味着每秒可能订阅/取消订阅数十次。

---

## 心理模型：代理人

解法的核心思路是引入一个**稳定的代理人**。

想象有个翻译：客户（WebSocket）只认识这个翻译（stableHandler），不管雇主（handler）换了几茬，客户永远对着同一个翻译说话。翻译内部维护一个指针，永远转发给最新的雇主。

```
WebSocket → stableHandler（稳定，不变）→ handlerRef.current（总是最新的 handler）
```

用代码表示：

```typescript
const handlerRef = useRef(handler);
// handlerRef.current 永远是最新 handler

const stableHandler = (payload: T) => handlerRef.current(payload);
// stableHandler 是稳定函数引用，只在组件挂载时创建一次

socket.on('message:new', stableHandler); // 只订阅一次
```

---

## 三个版本的演进

### 版本 1：渲染阶段赋值（常见但有隐患）

```typescript
export function useStableHandler<T>(
  event: string,
  handler: (payload: T) => void,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler; // ← 直接在渲染阶段赋值

  useEffect(() => {
    const stableHandler = (payload: T) => handlerRef.current(payload);
    socket.on(event, stableHandler);
    return () => socket.off(event, stableHandler);
  }, [event]);
}
```

这个版本能运行，也是网上最常见的写法。但 `handlerRef.current = handler` 写在渲染函数体里，是渲染阶段的副作用。

React Strict Mode 在开发环境下会**故意执行两次渲染函数体**（不含 effects），目的是暴露副作用。在并发模式（Concurrent Mode）下，React 可以中断、暂停、重播渲染——如果渲染阶段有副作用，可能在预期之外的时机被多次执行。

对于 ref 赋值，实践中通常没有问题（ref 赋值是幂等的），但这是 React 文档明确标注为"不推荐"的模式。

### 版本 2：独立 effect 同步（正确且 Strict Mode 安全）

```typescript
export function useStableHandler<T>(
  subscribe: (handler: (payload: T) => void) => () => void,
  handler: (payload: T) => void,
): void {
  const handlerRef = useRef(handler);

  // Effect 1：同步最新 handler 到 ref（Strict Mode 安全）
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  // Effect 2：订阅，只在 subscribe 变化时重跑
  useEffect(() => {
    const stableHandler = (payload: T) => handlerRef.current(payload);
    const unsubscribe = subscribe(stableHandler);
    return unsubscribe;
  }, [subscribe]);
}
```

两个 effect 分工明确：

| Effect | 职责 | 依赖 | 重跑频率 |
|--------|------|------|----------|
| Effect 1 | 保持 ref 最新 | `[handler]` | handler 变化时（可能很频繁） |
| Effect 2 | 管理订阅生命周期 | `[subscribe]` | subscribe 变化时（应该很少） |

关键点：Effect 1 频繁重跑没有性能问题，因为它只做一次 ref 赋值，没有 I/O。Effect 2 重跑才是代价高的（涉及 socket.on/off），而它的依赖 `subscribe` 应该是稳定的。

### 版本 3：useEffectEvent（React 19+，最简洁）

```typescript
import { useEffectEvent } from 'react';

export function useStableHandler<T>(
  subscribe: (handler: (payload: T) => void) => () => void,
  handler: (payload: T) => void,
): void {
  // useEffectEvent 返回一个稳定函数，内部始终能访问最新 handler
  const stableHandler = useEffectEvent(handler);

  useEffect(() => {
    return subscribe(stableHandler);
  }, [subscribe]); // stableHandler 不需要放进依赖
}
```

`useEffectEvent` 是 React 官方对这个模式的标准答案。它做的事和版本 2 完全一样，只是封装成了语言原语。被 `useEffectEvent` 包裹的函数：

- **稳定引用**：不会触发 effect 重跑
- **始终最新**：调用时看到的是最新的 props/state
- **不可在 effect 外调用**（React 会报错，因为语义不同）

---

## 最容易踩的坑：subscribe 必须稳定

这个 hook 把订阅稳定性的责任转移到了 `subscribe` 参数上。如果调用时传入内联函数：

```tsx
// ❌ 每次渲染 subscribe 都是新函数 → Effect 2 每次都重订阅
useStableHandler(
  (handler) => {
    socket.on('message:new', handler);
    return () => socket.off('message:new', handler);
  },
  (msg) => setMessages((prev) => [...prev, msg]),
);
```

修复：用 `useCallback` 稳定 `subscribe`：

```tsx
// ✅ subscribe 只在 socket 变化时重新创建
const subscribe = useCallback((handler: (msg: Message) => void) => {
  socket.on('message:new', handler);
  return () => socket.off('message:new', handler);
}, [socket]);

useStableHandler(subscribe, (msg) => setMessages((prev) => [...prev, msg]));
```

`handler` 参数则没有这个限制——内联函数完全可以，这正是 hook 的价值所在。

---

## 实际用例对比

### Socket.IO 消息监听

```tsx
function ChatPanel({ conversationId }: { conversationId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);

  const subscribe = useCallback((handler: (msg: Message) => void) => {
    socket.on('message:new', handler);
    return () => socket.off('message:new', handler);
  }, []); // socket 是模块级单例，依赖为空

  useStableHandler(subscribe, (msg) => {
    if (msg.conversation_id === conversationId) {
      setMessages((prev) => [...prev, msg]);
    }
  });

  // handler 每次渲染都是新函数（因为依赖 conversationId），
  // 但订阅不会重建 ✅
}
```

### 原生 resize 监听

```tsx
function useWindowWidth() {
  const [width, setWidth] = useState(window.innerWidth);

  const subscribe = useCallback((handler: () => void) => {
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  useStableHandler(subscribe, () => setWidth(window.innerWidth));

  return width;
}
```

---

## 取舍

| 优点 | 缺点 |
|------|------|
| handler 无需 useCallback，调用处更干净 | subscribe 必须稳定，调用处需要 useCallback |
| 订阅/取消订阅次数最小化 | 两个 effect 之间存在一帧的 handler 不同步窗口（极罕见） |
| 适用于任何 subscribe/unsubscribe 接口 | 版本 2 写法对团队有一定理解门槛 |

**一帧不同步窗口**是指：Effect 1（同步 handler）和 Effect 2（使用 handler）在同一个 commit 里按顺序执行，正常情况下没有问题。但如果 `subscribe` 变化的同时 `handler` 也变化，理论上可能先执行 Effect 2 再执行 Effect 1，导致新订阅在一帧内用了旧 handler。实践中这种场景几乎不会出现，且影响仅限一次事件处理。

React 19 的 `useEffectEvent` 从根本上消除了这个窗口，是该模式的最终形态。

---

## 完整代码

→ [react/use-stable-handler.ts](../react/use-stable-handler.ts)

---

## 延伸阅读

- [React Docs: Separating Events from Effects](https://react.dev/learn/separating-events-from-effects)：React 团队对这个问题的官方解释，`useEffectEvent` 的设计动机
- [React Docs: You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)：在用 useEffect 之前先读这篇
- [RFC: useEvent](https://github.com/reactjs/rfcs/pull/220)：`useEffectEvent` 的前身提案，讨论了大量边界情况
- [Dan Abramov: A Complete Guide to useEffect](https://overreacted.io/a-complete-guide-to-useeffect/)：理解 effect 依赖的最佳资料（虽然是 2019 年的，仍然有效）
