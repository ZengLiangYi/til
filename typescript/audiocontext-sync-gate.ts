/**
 * audiocontext-sync-gate.ts
 *
 * 用 AudioContext.suspend()/resume() 作为流式音视频的同步门控。
 *
 * 适用场景：帧通过 SSE / WebSocket 逐帧推送，需要严格音画同步。
 * 核心思路：帧到达驱动时钟，而非时钟驱动帧渲染。
 *
 * 用法示例见底部。
 */

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

interface SyncGatePlayerOptions {
  /** 总帧数（从流的 info 事件获取） */
  totalFrames: number;
  /** 帧率（fps） */
  fps: number;
  /** 原始音频数据 */
  audioBytes: ArrayBuffer;
  /** 绘制帧的回调 */
  onDraw: (bitmap: ImageBitmap) => void;
  /** 播放结束回调 */
  onEnd: () => void;
}

// ─────────────────────────────────────────────
// StreamingSyncGatePlayer
// ─────────────────────────────────────────────

/**
 * 流式音视频同步播放器（帧驱动时钟）
 *
 * 使用方式：
 * 1. `new StreamingSyncGatePlayer(options)` 创建实例
 * 2. 每收到一帧调用 `onFrameReady(index, bitmap)`
 * 3. 流结束后调用 `notifyStreamEnd()`
 * 4. 调用 `stop()` 中止播放
 */
export class StreamingSyncGatePlayer {
  private frames: (ImageBitmap | null)[];
  private fps: number;
  private totalFrames: number;
  private onDraw: (bitmap: ImageBitmap) => void;
  private onEnd: () => void;

  private audioCtx: AudioContext | null = null;
  private audioReady = false;
  private audioRunning = false;
  private startTime = 0;

  private lastDrawnFrame = -1;
  private isPlaying = false;
  private streamEnded = false;
  private rafId: number | null = null;

  constructor(options: SyncGatePlayerOptions) {
    this.totalFrames = options.totalFrames;
    this.fps = options.fps;
    this.onDraw = options.onDraw;
    this.onEnd = options.onEnd;
    this.frames = new Array(options.totalFrames).fill(null);

    // 并行初始化音频（不阻塞帧渲染启动）
    this.initAudio(options.audioBytes).catch(console.error);
  }

  // ── 公开 API ──────────────────────────────

  /**
   * 每当一帧解码完成时调用。
   * 可以乱序调用，播放器内部保证顺序渲染。
   */
  onFrameReady(index: number, bitmap: ImageBitmap): void {
    this.frames[index] = bitmap;

    // 首帧到达：启动播放
    if (index === 0 && !this.isPlaying) {
      this.isPlaying = true;
      this.tryAdvance();
      return;
    }

    // 下一顺序帧到达：唤醒调度器
    if (this.isPlaying && index === this.lastDrawnFrame + 1) {
      this.tryAdvance();
    }
  }

  /** 通知流已完成推送 */
  notifyStreamEnd(): void {
    this.streamEnded = true;
    if (this.isPlaying) {
      this.tryAdvance();
    }
  }

  /** 停止播放并释放资源 */
  stop(): void {
    this.isPlaying = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    // 释放 ImageBitmap GPU 资源
    for (const bitmap of this.frames) {
      bitmap?.close();
    }
  }

  // ── 内部实现 ──────────────────────────────

  private async initAudio(audioBytes: ArrayBuffer): Promise<void> {
    const AudioCtx =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    const ctx = new AudioCtx();

    // 创建后立即 suspend——由帧驱动何时 resume
    await ctx.suspend();

    const buffer = await ctx.decodeAudioData(audioBytes);

    this.audioCtx = ctx;

    // start(0) 在 suspended 状态下合法，不会实际输出声音
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);

    this.startTime = ctx.currentTime;
    this.audioRunning = false;
    this.audioReady = true;

    // 音频就绪，若帧已在等待，重新触发
    if (this.isPlaying) {
      this.tryAdvance();
    }
  }

  /**
   * 核心调度器：帧驱动播放推进。
   *
   * 被两个事件触发：
   *   1. onFrameReady(index) 且 index === lastDrawnFrame + 1
   *   2. initAudio 完成后（音频就绪）
   *
   * 内部通过 rAF 持续调度，直到遇到帧缺口（suspend 等待）或播放结束。
   */
  private tryAdvance(): void {
    if (!this.isPlaying) return;

    const nextNeeded = this.lastDrawnFrame + 1;

    // ── 结束检查 ──────────────────────────
    if (this.streamEnded && nextNeeded >= this.totalFrames) {
      this.ensureSuspended();
      this.isPlaying = false;
      this.onEnd();
      return;
    }

    // ── 下一顺序帧是否已就绪？ ────────────
    if (this.frames[nextNeeded] !== null) {
      if (!this.audioReady) {
        // 音频尚未就绪，rAF 轮询等待（audioCtx 还不存在，不调 ensureRunning）
        this.rafId = requestAnimationFrame(() => this.tryAdvance());
        return;
      }

      // 有帧且音频就绪 → 打开闸门
      this.ensureRunning();

      const elapsed = this.audioCtx!.currentTime - this.startTime;
      const frameTime = nextNeeded / this.fps;

      if (elapsed >= frameTime) {
        // 时钟已到达该帧时间 → 绘制
        this.onDraw(this.frames[nextNeeded]!);
        this.lastDrawnFrame = nextNeeded;
        this.rafId = requestAnimationFrame(() => this.tryAdvance());
      } else {
        // 后端快于实时 → 等时钟追上（不跳帧）
        this.rafId = requestAnimationFrame(() => this.tryAdvance());
      }
    } else {
      // ── 帧未到 → 关闭闸门 ────────────────
      // suspend() 冻结音频输出和 currentTime，等 onFrameReady 唤醒
      this.ensureSuspended();
      // 不调度 rAF——由 onFrameReady 重新触发
    }
  }

  /**
   * 确保音频时钟运行。
   *
   * 只用本地 flag 做幂等守卫，不检查 audioCtx.state。
   * 原因：resume()/suspend() 是异步的，state 属性在微任务队列清空后才切换。
   * 同一个 rAF 周期内连续调用 resume → suspend 时，state 仍停留在旧值，
   * 会导致 flag 与真实状态分裂。本地 flag 的翻转是同步的，没有这个窗口。
   */
  private ensureRunning(): void {
    if (!this.audioRunning && this.audioCtx) {
      this.audioRunning = true;
      this.audioCtx.resume().catch(() => {});
    }
  }

  private ensureSuspended(): void {
    if (this.audioRunning && this.audioCtx) {
      this.audioRunning = false;
      this.audioCtx.suspend().catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────
// 用法示例
// ─────────────────────────────────────────────

/**
 * 典型用法：SSE 帧流 + 音频同步播放
 *
 * ```typescript
 * const canvas = document.getElementById('canvas') as HTMLCanvasElement;
 * const ctx = canvas.getContext('2d')!;
 *
 * const audioResponse = await fetch('/api/audio');
 * const audioBytes = await audioResponse.arrayBuffer();
 *
 * // 假设已从流的第一个 info 事件中获取元信息
 * const totalFrames = 120;
 * const fps = 25;
 *
 * const player = new StreamingSyncGatePlayer({
 *   totalFrames,
 *   fps,
 *   audioBytes,
 *   onDraw: (bitmap) => ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height),
 *   onEnd: () => console.log('播放完毕'),
 * });
 *
 * // 边接收帧边解码
 * const response = await fetch('/api/frames');
 * const reader = response.body!.getReader();
 *
 * while (true) {
 *   const { done, value } = await reader.read();
 *   if (done) { player.notifyStreamEnd(); break; }
 *
 *   const { index, base64 } = parseFrameEvent(value);
 *   const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
 *   const blob = new Blob([bytes], { type: 'image/jpeg' });
 *   const bitmap = await createImageBitmap(blob);
 *
 *   player.onFrameReady(index, bitmap);
 * }
 * ```
 */
