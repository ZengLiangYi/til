/**
 * Token Refresh Queue
 *
 * 解决并发请求同时遇到 401 时，多次触发 refresh 导致竞态条件的问题。
 *
 * 核心思路：
 * - 第一个 401 触发 refresh，后续 401 的请求加入等待队列
 * - refresh 成功 → 用新 token 通知队列中所有请求重试
 * - refresh 失败 → 拒绝所有队列请求，执行登出
 *
 * 用法：在 HTTP 客户端的响应拦截器中调用 handleUnauthorized()
 *
 * @example
 * // Axios 拦截器
 * axios.interceptors.response.use(null, (error) => {
 *   if (error.response?.status === 401) {
 *     return handleUnauthorized(
 *       () => fetchNewToken(),
 *       (newToken) => {
 *         error.config.headers.Authorization = `Bearer ${newToken}`;
 *         return axios(error.config);
 *       },
 *       () => { window.location.href = '/login'; },
 *     );
 *   }
 *   return Promise.reject(error);
 * });
 */

// Subscriber 接收 newToken：成功时为字符串，失败时为 null
type Subscriber = (newToken: string | null) => void;

let isRefreshing = false;
let subscribers: Subscriber[] = [];

function addSubscriber(callback: Subscriber) {
  subscribers.push(callback);
}

function notifySubscribers(newToken: string | null) {
  subscribers.forEach((cb) => cb(newToken));
  subscribers = [];
}

/**
 * 处理 401 响应，自动排队并在 token 刷新后重试
 *
 * @param doRefresh  调用刷新接口，返回新 token（失败返回 null）
 * @param doRetry    用新 token 重试原请求，返回 Promise<T>
 * @param onFailure  刷新失败时执行（如清除存储、跳转登录页）
 */
export async function handleUnauthorized<T>(
  doRefresh: () => Promise<string | null>,
  doRetry: (newToken: string) => Promise<T>,
  onFailure: () => void,
): Promise<T> {
  // 已有刷新在进行中，排队等待结果
  if (isRefreshing) {
    return new Promise<T>((resolve, reject) => {
      addSubscriber((newToken) => {
        if (newToken) {
          doRetry(newToken).then(resolve).catch(reject);
        } else {
          // 刷新失败时正确 reject，避免 Promise 永远 pending
          reject(new Error('Token refresh failed'));
        }
      });
    });
  }

  isRefreshing = true;

  const newToken = await doRefresh();

  if (newToken) {
    notifySubscribers(newToken);
    isRefreshing = false;
    return doRetry(newToken);
  }

  // 刷新失败：通知所有等待的请求（传 null 触发 reject），再执行失败处理
  notifySubscribers(null);
  isRefreshing = false;
  onFailure();
  return Promise.reject(new Error('Token refresh failed'));
}
