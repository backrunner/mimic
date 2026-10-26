import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
test('dashboard navigation, soul save, replay, plugin pages and mobile layout', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '概览', exact: true }),
  ).toBeVisible();
  await mkdir('.artifacts', { recursive: true });
  await page.screenshot({
    path: '.artifacts/dashboard-desktop.png',
    fullPage: true,
  });
  await page.goto('/soul');
  await page.getByLabel('名字', { exact: true }).fill('小弥测试');
  await page.getByRole('button', { name: '应用 Soul' }).click();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('名字', { exact: true })).toHaveValue(
    '小弥测试',
  );
  await page.goto('/conversations');
  await page
    .getByLabel('消息', { exact: true })
    .fill('事务提交后还是 busy，下一步看什么？');
  await page.getByRole('button', { name: '加入对话' }).click();
  await expect(
    page
      .locator('.chat-message')
      .filter({ hasText: '事务提交后还是 busy，下一步看什么？' })
      .first(),
  ).toBeVisible();
  await page.screenshot({
    path: '.artifacts/dashboard-conversations.png',
    fullPage: true,
  });
  for (const route of [
    'models',
    'usage',
    'logs',
    'tasks',
    'system',
    'memory',
    'plugins',
    'plugins/protocol-qq',
    'plugins/tool-web-deepseek',
    'plugins/tool-node',
    'plugins/tool-stickers',
    'plugins/safety-decisions',
    'plugins/model-typesafe',
  ]) {
    await page.goto('/' + route);
    await expect(page.locator('h1')).toBeVisible();
    await expect(
      page.getByText('正在连接本地运行服务…', { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: '.artifacts/dashboard-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '打开导航' }).click();
  const navigation = page.getByRole('dialog', { name: '导航菜单' });
  await expect(navigation).toBeVisible();
  await page.screenshot({ path: '.artifacts/dashboard-mobile-menu.png' });
  await page.keyboard.press('Escape');
  await expect(navigation).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开导航' })).toBeFocused();
  await page.getByRole('button', { name: '打开导航' }).click();
  await navigation.getByRole('link', { name: '插件', exact: true }).click();
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(navigation).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: '插件', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test('local dashboard rejects cross-origin mutations and internal API requires token', async ({
  request,
}) => {
  const bad = await request.post('/api/replay', {
    headers: { origin: 'https://attacker.example' },
    data: { text: 'x' },
  });
  expect(bad.status()).toBe(403);
  const internal = await request.get('http://127.0.0.1:43212/api/config');
  expect(internal.status()).toBe(401);
});
test('model credentials and scheduled behavior can be managed through dialogs', async ({
  page,
}) => {
  await page.goto('/models');
  await page.getByRole('button', { name: '＋ 添加连接' }).click();
  const dialog = page.getByRole('dialog');
  await page.screenshot({ path: '.artifacts/dashboard-model-dialog.png' });
  await dialog.getByLabel('名称', { exact: true }).fill('测试连接');
  await dialog
    .getByLabel('API Key', { exact: false })
    .fill('fixture-only-not-a-real-key');
  await dialog.getByRole('button', { name: '保存连接' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '测试连接' })).toBeVisible();
  const config = await page.evaluate(
    async () => await (await fetch('/api/config')).json(),
  );
  expect(JSON.stringify(config)).not.toContain('fixture-only-not-a-real-key');
  expect(
    config.config.connections.some(
      (c: any) => c.name === '测试连接' && c.secretRef.startsWith('secret:'),
    ),
  ).toBe(true);
  await page.goto('/tasks');
  await page.getByRole('button', { name: '＋ 创建任务' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('午间候选');
  await page.getByRole('button', { name: '预览未来时间' }).click();
  await expect(page.locator('dialog pre, [role=dialog] pre')).toBeVisible();
  await page.getByRole('button', { name: '保存任务' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('cell', { name: '午间候选 已暂停', exact: true }),
  ).toBeVisible();
});

test('memory bindings and broker configuration persist without exposing credentials', async ({
  page,
}) => {
  await page.goto('/memory');
  await page.getByRole('button', { name: '添加绑定', exact: true }).click();
  await page
    .getByLabel('Mimic 会话 ID', { exact: true })
    .fill('replay:记忆测试');
  await page
    .getByLabel('MemStation Workspace ID', { exact: true })
    .fill('remote-memory-test');
  await page
    .getByLabel('Integration ID', { exact: true })
    .fill('integration-test');
  await page.getByLabel('外部空间 ID', { exact: true }).fill('room-test');
  await page
    .getByLabel('MemStation 业务 API Key', { exact: true })
    .fill('fixture-memory-not-a-real-key');
  await page.getByRole('button', { name: '保存记忆设置', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存');
  await page.reload();
  await expect(page.getByLabel('Mimic 会话 ID', { exact: true })).toHaveValue(
    'replay:记忆测试',
  );
  const config = await page.evaluate(
    async () => await (await fetch('/api/config')).json(),
  );
  expect(JSON.stringify(config)).not.toContain('fixture-memory-not-a-real-key');
  expect(config.config.memory.secretRef).toMatch(/^secret:/);
  expect(config.config.memory.enabled).toBe(true);
  await expect(page.getByLabel('启用长期记忆', { exact: true })).toBeChecked();
  await page.screenshot({
    path: '.artifacts/memory-settings-desktop.png',
    fullPage: true,
  });
  await page.getByRole('tab', { name: 'AI broker', exact: true }).click();
  await page
    .getByLabel('Embedding 实际模型版本', { exact: true })
    .fill('fixture-embedding-v1');
  await page
    .getByLabel('Embedding 指纹', { exact: true })
    .fill('fixture-embedding-v1:3');
  await page.getByLabel('向量维度', { exact: true }).fill('3');
  await page
    .getByRole('button', { name: '保存 broker 设置', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText('已保存');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: '处理与检索', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: '.artifacts/memory-activity-mobile.png',
    fullPage: true,
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('tab', { name: '接入设置', exact: true }).click();
  await page.getByLabel('启用长期记忆', { exact: true }).uncheck();
  await page.getByRole('button', { name: '保存记忆设置', exact: true }).click();
  await page.reload();
  await expect(
    page.getByLabel('启用长期记忆', { exact: true }),
  ).not.toBeChecked();
});
