# 用 AudioContext.suspend()/resume() 作为流式音视频的同步门控

**TL;DR：** 在"边收帧边播放"的场景中，传统做法是缓冲 N 帧后再启动——本质上是在猜网络速度，猜错了音画就不同步。更可靠的方案：把 `AudioContext.suspend()` 当作同步门，帧没到就冻结音频时钟，帧到了再放行。这个做法成立的原因是 `suspend()` 同时冻结音频输出**和** `currentTime` 时钟，天然是一个同步原语。

> 本文假设你了解 Web Audio API 基础和 `requestAnimationFrame`。

---

## 问题：帧和音频跑在两条不同的轨道上

考虑一个流式口型同步播放器——后端通过 SSE 逐帧推送视频帧，客户端边收边解码边渲染，同时播放对应的音频。

朴素实现：音频立即开始播放，`requestAnimationFrame` 根据 `audioContext.currentTime` 计算当前应显示哪一帧：

```typescript
// ❌ 朴素实现：音频驱动帧
audioSource.start(0);
const startTime = audioContext.currentTime;

function renderLoop() {
  const elapsed = audioContext.currentTime - startTime;
  const targetFrame = Math.floor(elapsed * fps);

  if (frames[targetFrame]) {
    drawFrame(frames[targetFrame]);
  }
  // 若 frames[targetFrame] 为 null，保持上一帧
  requestAnimationFrame(renderLoop);
}
```

这在网络良好时能工作。一旦后端帧到达速度跟不上播放速度：

```
音频时钟：  0s ────────── 2s ────────── 4s ────────────
已到达帧：  ████████████░░░░░░░░░░░░░░░░░░░░░░░░ (帧停在第 60 帧)
实际显示：  [正常]        [嘴型冻结]    [嘴型冻结，音频继续]
```

嘴型冻结，但语音继续——这是用户最容易感知到的 A/V 失同步。

---

## 天真的修复：缓冲阈值

最常见的修复是在开始播放前先缓冲足够的帧：

```typescript
// ❌ 缓冲阈值方案
const BUFFER_THRESHOLD = 60; // 缓冲 60 帧再开始

onFrameDecoded(() => {
  decodedCount++;
  if (!started && decodedCount >= BUFFER_THRESHOLD) {
    started = true;
    audioSource.start(0);
    renderLoop();
  }
});
```

这把问题延后了，但没有解决：
- **阈值是拍脑袋定的**：60 帧在慢网络下可能还不够，在快网络下只是增加延迟
- **播放开始后依然会失同步**：后端如果在中途卡顿，帧再次追不上音频
- **首帧延迟增加**：用户要等 ~60 帧（约 1 秒）才看到第一个画面

根本问题是：**音频时钟在独立运行，不关心帧有没有到**。

---

## 关键洞察：suspend() 同时冻结两样东西

`AudioContext` 有一个经常被忽视的性质：

**`audioContext.suspend()` 不仅暂停音频输出，还暂停 `currentTime` 时钟本身。**

```typescript
const ctx = new AudioContext();
ctx.currentTime; // 0.0

// ... 播放一段时间后 ...
ctx.currentTime; // 2.341

await ctx.suspend();
// 此时 currentTime 冻结在 2.341，不再增加
await sleep(3000);

ctx.currentTime; // 仍然是 2.341（不是 5.341）

await ctx.resume();
// currentTime 从 2.341 继续，而非跳到 5.341
```

这意味着 **`suspend()` 可以暂停整个时间轴**，而不仅仅是静音。

这个性质让它成为一个天然的同步原语：当帧未到时冻结时间轴，帧到了再继续——音频和时钟始终只在"有帧可看"的时刻推进。

---

## 心理模型：水坝闸门

把音频时钟想象成一条河，帧是河里的船，播放器是下游的港口。

**旧方案（缓冲阈值）：** 等河里有足够多的船之后，才打开闸门。一旦闸门打开就不再关闭——如果上游来船慢了，港口会等一会儿，但时间继续流逝。

**新方案（suspend/resume 门控）：** 闸门默认关闭，只有当下一艘船（下一帧）确认在闸门口等待时，才打开放行一次，然后重新关闭等下一艘。

```
帧 N+1 已就绪？
  → 是: resume() → 时钟流动 → 绘制帧 → rAF 调度下一次检查
  → 否: suspend() → 时钟冻结 → 等待帧到达事件 → 重新触发检查
```

---

## 实现

### 1. AudioContext 创建后立即 suspend

```typescript
const AudioCtx = window.AudioContext;
const audioCtx = new AudioCtx();

// 创建后立即挂起——由帧驱动何时 resume
await audioCtx.suspend();

const buffer = await audioCtx.decodeAudioData(rawAudioBuffer);

const source = audioCtx.createBufferSource();
source.buffer = buffer;
source.connect(audioCtx.destination);
source.start(0); // start(0) 在 suspended 状态下不会实际播放
const startTime = audioCtx.currentTime;
```

注意 `start(0)` 在 suspended 状态下是合法的——它把播放位置固定在 0，但不产生声音。

### 2. suspend/resume 门控函数

```typescript
let audioRunning = false;

// 不检查 audioCtx.state——resume()/suspend() 是异步的，
// state 属性的切换有延迟，检查它会导致 flag 与真实状态分裂。
// 只用本地 flag 做幂等守卫。
const ensureRunning = () => {
  if (!audioRunning) {
    audioRunning = true;
    audioCtx.resume().catch(() => {});
  }
};

const ensureSuspended = () => {
  if (audioRunning) {
    audioRunning = false;
    audioCtx.suspend().catch(() => {});
  }
};
```

**为什么不检查 `audioCtx.state`？**

`resume()` 和 `suspend()` 都是异步的，`state` 属性要等微任务队列清空后才切换。如果在同一个 rAF 周期内先调 `resume()` 再调 `ensureSuspended()`，`state` 可能还停留在 `'suspended'`（resume 尚未完成），导致 `ensureSuspended` 认为"不需要 suspend"而跳过——但 resume 已经在途中，随后完成后音频就失控地开始播放。本地 flag 的翻转是同步的，不存在这个窗口。

### 3. 核心调度器

```typescript
let lastDrawnFrame = -1;

const tryAdvance = () => {
  const nextNeeded = lastDrawnFrame + 1;

  // 结束条件
  if (streamEnded && nextNeeded >= totalFrames) {
    ensureSuspended();
    onPlayEnd();
    return;
  }

  if (frames[nextNeeded] !== null) {
    // 有帧可播 → 打开闸门
    ensureRunning();

    // 检查时钟是否已到该帧时间（后端快于实时时限速）
    const elapsed = audioCtx.currentTime - startTime;
    const frameTime = nextNeeded / fps;

    if (elapsed >= frameTime) {
      draw(frames[nextNeeded]);
      lastDrawnFrame = nextNeeded;
      requestAnimationFrame(tryAdvance); // 立即尝试下一帧
    } else {
      requestAnimationFrame(tryAdvance); // 等时钟追上
    }
  } else {
    // 帧未到 → 关闭闸门，等帧到达事件唤醒
    ensureSuspended();
    // 不调度 rAF——由 onFrameArrived 触发
  }
};

// 每次有新帧解码完成时调用
const onFrameArrived = (index: number) => {
  frames[index] = decodedBitmap;

  // 只有下一顺序帧到达才触发调度（乱序帧不触发）
  if (index === lastDrawnFrame + 1) {
    tryAdvance();
  }
};
```

### 4. 乱序帧的处理

后端可能乱序推送帧（帧 N+1 比帧 N 先到）：

```
帧到达顺序: 0, 1, 3, 2, 4, 5 ...
              ↑ 帧 2 迟到
```

`onFrameArrived(3)` 时，`lastDrawnFrame = 1`，`index !== lastDrawnFrame + 1`，不触发调度。
`onFrameArrived(2)` 时，`index === lastDrawnFrame + 1`，触发 `tryAdvance()`，绘制帧 2 后继续绘制已等待的帧 3、4、5。

这个模式保证**严格顺序播放**，无需额外排序逻辑。

---

## 边界情况

**后端快于实时**：所有帧在音频解码前到达。`tryAdvance` 看到 `frames[nextNeeded] !== null` 但 `audioReady = false`，进入 rAF 轮询等待音频就绪。音频就绪后 `elapsed >= frameTime` 判断阻止帧提前绘制。

**0 帧响应**：`streamEnded = true`，`nextNeeded >= totalFrames`（0 >= 0），立即 resolve。

**播放中断**：外部调用 stop() → `isPlaying = false` → `tryAdvance` 首行 early return → rAF 循环自然终止。

---

## 取舍

| 优点 | 缺点 |
|------|------|
| 严格音画同步，无论网络如何抖动 | 网络卡顿时音频会有可感知的停顿 |
| 首帧延迟极低（~1 帧，而非缓冲 N 帧）| 停顿期间无音频，用户可能误以为播放器崩了 |
| 不需要 AudioWorklet 或 ScriptProcessorNode | 需要处理 resume() 的异步性（见上文 flag 而非 state） |
| 与现有 close() 清理逻辑完全兼容 | Safari 较旧版本在 suspend 过渡中 close() 有内存泄漏风险 |

**何时不适用**：如果视频帧来源稳定（本地文件、已缓冲的 HLS），直接用音频时钟驱动帧渲染更简单，不需要这套门控。这个模式的价值在于**网络不稳定的流式推送**场景。

---

## 完整代码

→ [typescript/audiocontext-sync-gate.ts](../typescript/audiocontext-sync-gate.ts)

---

## 延伸阅读

- [Web Audio API: AudioContext.suspend()](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/suspend) — MDN 上关于 `currentTime` 冻结行为的说明
- [Web Audio API: AudioContext.currentTime](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/currentTime) — 为什么 currentTime 在 suspended 状态下不推进
- [requestVideoFrameCallback for video sync](https://web.dev/articles/requestvideoframecallback-rvfc) — 浏览器原生视频元素的类似思路
