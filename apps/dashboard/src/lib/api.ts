export async function api<T = any>(
  path: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const isJson = response.headers
    .get('content-type')
    ?.includes('application/json');
  const result = isJson
    ? await response.json()
    : {
        error: `HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`,
      };
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
export const time = (n: number) =>
  new Date(n).toLocaleString('zh-CN', { hour12: false });
export const statusLabel: Record<string, string> = {
  silent: '保持安静',
  shadow: '观察草稿',
  sent: '已发送',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态未知',
  generating: '组织回复',
  deciding: '判断参与',
  observing: '观察',
  deferred: '稍等片刻',
};
