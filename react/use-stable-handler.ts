import { useCallback, useEffect, useRef } from 'react';

/**
 * useStableHandler
 *
 * 解决事件订阅场景中，handler 频繁变化导致反复 subscribe/unsubscribe 的问题。
 *
 * 核心思路：
 * - 用 ref 持有最新的 handler，在独立 effect 中同步（不在渲染阶段直接赋值）
 * - stableHandler 是稳定引用，始终代理到最新的 handlerRef.current
 * - 订阅/取消订阅只在 subscribe 函数变化时重新执行
 *
 * 适用场景：WebSocket 事件、EventEmitter、原生 addEventListener 等
 *
 * ⚠️  subscribe 必须是稳定引用：在调用处用 useCallback 包裹，否则每次渲染都会重新订阅
 *
 * @param subscribe  订阅函数，接收 stableHandler，返回取消订阅函数（必须稳定，用 useCallback）
 * @param handler    事件处理函数（可以是每次渲染新建的函数，不影响订阅稳定性）
 *
 * @example
 * // Socket.IO — subscribe 用 useCallback 稳定
 * const subscribe = useCallback((handler) => {
 *   socket.on('message:new', handler);
 *   return () => socket.off('message:new', handler);
 * }, [socket]);
 *
 * useStableHandler(subscribe, (msg) => setMessages((prev) => [...prev, msg]));
 *
 * @example
 * // 原生 DOM 事件
 * const subscribe = useCallback((handler) => {
 *   window.addEventListener('resize', handler);
 *   return () => window.removeEventListener('resize', handler);
 * }, []);
 *
 * useStableHandler(subscribe, () => setWidth(window.innerWidth));
 */
export function useStableHandler<T>(
  subscribe: (handler: (payload: T) => void) => () => void,
  handler: (payload: T) => void,
): void {
  const handlerRef = useRef(handler);

  // 在 effect 中更新 ref，避免渲染阶段的副作用（Strict Mode 安全）
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const stableHandler = (payload: T) => handlerRef.current(payload);
    const unsubscribe = subscribe(stableHandler);
    return unsubscribe;
  }, [subscribe]);
}

// ------------------------------------------------------------
// React 19+ 替代方案：useEffectEvent（更简洁，无需手动管理 ref）
// ------------------------------------------------------------
// import { useEffectEvent } from 'react';
//
// export function useStableHandler<T>(
//   subscribe: (handler: (payload: T) => void) => () => void,
//   handler: (payload: T) => void,
// ): void {
//   const stableHandler = useEffectEvent(handler);
//   useEffect(() => subscribe(stableHandler), [subscribe]);
// }
