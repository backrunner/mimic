<script lang="ts">
  import { page } from '$app/state';
  import { Dialog } from 'bits-ui';
  import Icon from '#lib/Icon.svelte';
  import BrandIcon from '#lib/BrandIcon.svelte';
  import '../lib/app.css';
  let { children } = $props();
  let open = $state(false);
  const groups = [
    {
      label: '聊天空间',
      items: [
        ['/', '概览', 'home'],
        ['/conversations', '会话', 'chat'],
        ['/soul', 'Soul', 'heart'],
        ['/memory', '记忆', 'memory'],
      ],
    },
    {
      label: '管理工具',
      items: [
        ['/models', '模型与连接', 'model'],
        ['/usage', '用量', 'chart'],
        ['/logs', '运行记录', 'logs'],
        ['/plugins', '插件', 'plugins'],
        ['/tasks', '定时任务', 'clock'],
        ['/system', '系统', 'system'],
      ],
    },
  ];
</script>

<svelte:head>
  <title>Mimic</title>
  <meta name="description" content="Mimic 本地机器人管理面板" />
  <meta name="theme-color" content="#faf8f7" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
</svelte:head>

{#snippet navigation()}
  <a
    class="brand"
    href="/"
    onclick={() => (open = false)}
    aria-label="Mimic 首页"
  >
    <BrandIcon size={52} />
    <span>mimic</span>
  </a>
  <nav class="nav" aria-label="主导航">
    {#each groups as group}
      <div class="nav-label">{group.label}</div>
      {#each group.items as [href, label, icon]}
        {@const active =
          page.url.pathname === href ||
          (href !== '/' && page.url.pathname.startsWith(href))}
        <a
          {href}
          class:active
          aria-current={active ? 'page' : undefined}
          onclick={() => (open = false)}
        >
          <Icon name={icon} size={19} /><span>{label}</span>
        </a>
      {/each}
    {/each}
  </nav>
  <div class="sidebar-footer">
    <span class="dot"></span>本地管理 · 无需登录
    <div class="version">Mimic 0.1.0 · 开发版本</div>
  </div>
{/snippet}

<div class="shell">
  <aside class="sidebar desktop-sidebar">{@render navigation()}</aside>
  <main class="main">
    <header class="topbar">
      <div class="topbar-location">
        <Dialog.Root bind:open>
          <Dialog.Trigger class="mobile-toggle" aria-label="打开导航"
            ><Icon name="menu" /></Dialog.Trigger
          >
          <Dialog.Portal>
            <Dialog.Overlay class="nav-overlay" />
            <Dialog.Content class="sidebar mobile-sidebar">
              <Dialog.Title class="sr-only">导航菜单</Dialog.Title>
              <Dialog.Description class="sr-only"
                >浏览 Mimic 的聊天空间与管理工具。</Dialog.Description
              >
              <Dialog.Close class="nav-close" aria-label="关闭导航"
                ><Icon name="close" size={18} /></Dialog.Close
              >
              {@render navigation()}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <span class="mobile-brand"><BrandIcon size={30} /></span>
        <strong>Mimic</strong><span class="subtle">
          / &nbsp; {groups
            .flatMap((g) => g.items)
            .find(([href]) => page.url.pathname === href)?.[1] ??
            '插件管理'}</span
        >
      </div>
      <span class="pill"><span class="dot"></span>仅本地访问</span>
    </header>
    <div class="content">{@render children()}</div>
  </main>
</div>
