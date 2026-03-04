# 并发 401 下的 Token 刷新竞态：一个被低估的 Bug

**TL;DR：** 当多个请求同时遇到 401 时，朴素实现会触发多次 token 刷新，导致 race condition。用一个 `isRefreshing` 标志 + 订阅者队列可以彻底解决——但大多数实现里存在一个隐藏的 Promise 泄漏问题。

> 本文假设你熟悉 `async/await`、HTTP 拦截器（axios/fetch）和 JWT 认证基础。

---

## 问题：并发 401 不止一个

实现过 token 刷新的人，第一版代码大概长这样：

```typescript
// ❌ 朴素实现
axios.interceptors.response.use(null, async (error) => {
  if (error.response?.status === 401) {
    const newToken = await refreshToken();
    error.config.headers.Authorization = `Bearer ${newToken}`;
    return axios(error.config);
  }
  return Promise.reject(error);
});
```

单个请求失效时，这完全够用。但在真实应用里，你的页面同时发出 5 个请求是常态——Dashboard 加载时并行请求用户信息、通知数量、最新数据……

当 token 在这 5 个请求飞行途中过期：

```
Request A → 401 → refreshToken() ─┐
Request B → 401 → refreshToken()  │← 同时触发 5 次刷新
Request C → 401 → refreshToken()  │
Request D → 401 → refreshToken() ─┘
Request E → 401 → refreshToken()
```

每次刷新都会使上一次发出的 `refresh_token` 失效（轮换机制）。结果是：第一个刷新成功，其余四个用过期的 `refresh_token` 刷新——全部失败，用户被踢回登录页。

---

## 心理模型：收银台排队

把并发请求想象成超市收银台：

- **朴素实现**：每个顾客（请求）都跑去叫店长（刷新 token）。店长同时被 5 个人拉着，什么都做不了。
- **正确实现**：第一个顾客去叫店长，其他人在收银台前排队等候。店长回来后，所有人一起结账（用新 token 重试）。

实现这个逻辑只需要两个变量：

```typescript
let isRefreshing = false;          // 店长是否在处理中
let subscribers: Subscriber[] = []; // 排队等待的顾客
```

---

## 实现：带队列的刷新机制

完整实现分四个部分：

### 1. 订阅者类型

```typescript
// newToken 为字符串时表示刷新成功，为 null 时表示刷新失败
type Subscriber = (newToken: string | null) => void;

let isRefreshing = false;
let subscribers: Subscriber[] = [];
```

注意 `string | null` 的设计——这是避免 Promise 泄漏的关键，后面详述。

### 2. 队列管理

```typescript
function addSubscriber(callback: Subscriber) {
  subscribers.push(callback);
}

function notifySubscribers(newToken: string | null) {
  subscribers.forEach((cb) => cb(newToken));
  subscribers = [];
}
```

### 3. 核心调度逻辑

```typescript
export async function handleUnauthorized<T>(
  doRefresh: () => Promise<string | null>,
  doRetry: (newToken: string) => Promise<T>,
  onFailure: () => void,
): Promise<T> {
  // 已有刷新进行中 → 排队等待
  if (isRefreshing) {
    return new Promise<T>((resolve, reject) => {
      addSubscriber((newToken) => {
        if (newToken) {
          doRetry(newToken).then(resolve).catch(reject);
        } else {
          reject(new Error('Token refresh failed'));
        }
      });
    });
  }

  // 发起刷新
  isRefreshing = true;
  const newToken = await doRefresh();

  if (newToken) {
    notifySubscribers(newToken); // 通知队列重试
    isRefreshing = false;
    return doRetry(newToken);
  }

  // 刷新失败：通知队列（传 null），然后执行失败处理
  notifySubscribers(null);
  isRefreshing = false;
  onFailure();
  return Promise.reject(new Error('Token refresh failed'));
}
```

### 4. 接入 Axios 拦截器

```typescript
axios.interceptors.response.use(null, (error) => {
  const { response, config } = error;

  // 只处理 401，跳过登录和刷新接口本身
  if (response?.status !== 401) return Promise.reject(error);
  if (config?.url?.includes('/auth/login')) return Promise.reject(error);
  if (config?.url?.includes('/auth/refresh')) {
    clearStorage();
    window.location.href = '/login';
    return Promise.reject(error);
  }

  return handleUnauthorized(
    () => fetchNewToken(),
    (newToken) => {
      config.headers.Authorization = `Bearer ${newToken}`;
      return axios(config);
    },
    () => {
      clearStorage();
      window.location.href = '/login';
    },
  );
});
```

现在同样的并发场景：

```
Request A → 401 → isRefreshing=false → 发起刷新 → isRefreshing=true
Request B → 401 → isRefreshing=true  → 加入队列
Request C → 401 → isRefreshing=true  → 加入队列
Request D → 401 → isRefreshing=true  → 加入队列

刷新成功 → notifySubscribers(newToken) → B、C、D 用新 token 重试 ✅
```

---

## 隐藏的 Bug：Promise 泄漏

这是大多数网上教程里存在的问题，包括一些知名库的早期版本。

当刷新失败时，朴素实现通常这样写：

```typescript
// ❌ 有 Bug 的版本
isRefreshing = false;
subscribers = []; // ← 直接清空！
onFailure();
```

问题在于：`subscribers` 数组里存的是 Promise 的 `resolve`/`reject` 回调。直接清空等于把这些 Promise 永远挂起——它们既不 resolve 也不 reject，**永远 pending**。

JavaScript 引擎不会回收仍在等待的 Promise（因为理论上它们还能被 resolve）。在 SPA 里，这意味着用户每次遇到刷新失败，都会积累一批无法被 GC 的 Promise 和闭包。

修复方式：通知订阅者失败，让它们主动 reject：

```typescript
// ✅ 正确版本
notifySubscribers(null); // 传 null → 订阅者收到后调用 reject()
isRefreshing = false;
onFailure();
```

这就是为什么 `Subscriber` 的类型是 `(newToken: string | null) => void` 而不是 `(newToken: string) => void`。

---

## 需要注意的边界情况

### 并发刷新之间的时序

`isRefreshing` 是模块级变量，在整个应用生命周期内共享。如果两个页面同时初始化（如 iframe 或多标签页共享 localStorage），队列不会跨页面同步——这是该模式的设计边界。多标签页场景需要用 `BroadcastChannel` 或 `SharedWorker`。

### 刷新接口本身的 401

必须跳过对刷新接口的重试，否则会死循环：

```
refreshToken() → 401 → handleUnauthorized() → refreshToken() → ...
```

代码里的这一判断不能省：

```typescript
if (config?.url?.includes('/auth/refresh')) {
  clearStorage();
  window.location.href = '/login';
  return Promise.reject(error);
}
```

### 状态重置时机

`isRefreshing = false` 必须在 `notifySubscribers()` **之后**设置，不能之前。否则队列通知过程中如果又进来新的 401，会再次触发刷新。

---

## 取舍与局限

| 优点 | 缺点 |
|------|------|
| 无额外依赖，纯逻辑 | 模块级状态，无法跨 iframe/标签页 |
| O(1) 判断，O(n) 通知，性能无影响 | 刷新超时无内建处理（需自行包装） |
| 与具体 HTTP 客户端解耦 | 队列顺序不保证（取决于 Promise 执行顺序） |

如果你的应用有严格的刷新超时需求，可以在 `doRefresh` 里用 `Promise.race` 包一层 timeout：

```typescript
const doRefresh = () => Promise.race([
  fetchNewToken(),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
]);
```

---

## 完整代码

→ [typescript/token-refresh-queue.ts](../typescript/token-refresh-queue.ts)

---

## 延伸阅读

- [RFC 6750 — Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750)：理解 401 响应的标准语义
- [axios-auth-refresh](https://github.com/Flyrell/axios-auth-refresh)：成熟的 Axios 刷新插件，思路相同但功能更完整
- [MDN: Using microtasks in JavaScript with queueMicrotask()](https://developer.mozilla.org/en-US/docs/Web/API/HTML_DOM_API/Microtask_guide)：理解 Promise 回调的调度顺序
- [BroadcastChannel API](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)：多标签页 token 同步的基础工具
