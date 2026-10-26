<script lang="ts">
  import { onMount } from 'svelte';
  import { api, time, statusLabel } from '#lib/api.ts';
  import Icon from '#lib/Icon.svelte';
  import BrandIcon from '#lib/BrandIcon.svelte';
  let data = $state<any>(null),
    error = $state('');
  async function refresh() {
    try {
      data = await api('overview');
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }
  onMount(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });
  async function pause() {
    try {
      const c = await api('config');
      c.config.paused = !c.config.paused;
      await api('config', 'PUT', c);
      await refresh();
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const shortcuts = [
    ['/models', 'model', '模型与连接', 'API 凭据、角色分配与预算'],
    ['/soul', 'heart', 'Soul', '性格、兴趣和回复风格'],
    ['/plugins/protocol-qq', 'chat', 'QQ 机器人', '账号连接与接收范围'],
    [
      '/plugins/safety-decisions',
      'shield',
      '安全设置',
      '输入输出检查与拦截策略',
    ],
  ];
</script>

<div class="page-head">
  <div>
    <h1>概览</h1>
    <p class="subtitle">会话与机器人的运行情况。</p>
  </div>
  <div class="actions">
    <button class="secondary" onclick={pause}
      >{data?.status === 'paused' ? '恢复发言' : '暂停发言'}</button
    >
    <a class="button" href="/conversations"
      >本地回放 <Icon name="arrow" size={15} /></a
    >
  </div>
</div>
{#if error}<div class="error-message" role="alert">
    无法连接运行服务：{error}
    <button class="secondary tiny" onclick={refresh}>重试</button>
  </div>{/if}

<div class="cards">
  <div class="card">
    <div class="label">运行状态</div>
    <div class="value status-value">
      {data?.status === 'paused' ? '已暂停' : data ? '运行中' : '连接中'}
    </div>
    <div class="hint">
      <span class="dot"></span>{data?.mode === 'live'
        ? '实时发送模式'
        : '观察模式 · 不发送到 QQ'}
    </div>
  </div>
  <div class="card">
    <div class="label">已观察会话</div>
    <div class="value">{data?.workspaces ?? '—'}</div>
    <div class="hint">群聊与私聊</div>
  </div>
  <div class="card">
    <div class="label">模型调用</div>
    <div class="value">{data?.usage.calls ?? '—'}</div>
    <div class="hint">最近 1,000 次调用窗口</div>
  </div>
  <div class="card">
    <div class="label">Token 用量</div>
    <div class="value">
      {data
        ? ((data.usage.inputTokens + data.usage.outputTokens) / 1000).toFixed(
            1,
          ) + 'k'
        : '—'}
    </div>
    <div class="hint">{data?.usage.unknown ?? 0} 次用量待确认</div>
  </div>
</div>

<div class="columns overview-columns">
  <section class="panel recent-panel">
    <div class="panel-title">
      <h2>最近的参与</h2>
      <a class="text-link" href="/logs"
        >运行记录 <Icon name="arrow" size={14} /></a
      >
    </div>
    {#if data?.runs.length}
      {#each data.runs as run}<div class="row">
          <span class="run-avatar"><BrandIcon size={34} /></span>
          <div class="grow">
            <div class="title">{run.workspaceId.replace('replay:', '')}</div>
            <p class="muted">{run.draft || run.reason || '正在理解上下文'}</p>
          </div>
          <div class="run-meta">
            <span class:warn={run.status === 'failed'} class="badge"
              >{statusLabel[run.status] ?? run.status}</span
            >
            <div class="muted">{time(run.at)}</div>
          </div>
        </div>{/each}
    {:else}
      <div class="empty recent-empty">
        <span class="empty-icon"><Icon name="chat" size={28} /></span>
        <h3>暂无参与记录</h3>
        <p>连接模型后，可以通过本地回放测试回复。</p>
        <a class="text-link" href="/models"
          >配置模型 <Icon name="arrow" size={14} /></a
        >
      </div>
    {/if}
  </section>
  <section class="panel setup-panel">
    <h2>快速配置</h2>
    {#each shortcuts as [href, icon, title, description]}
      <a class="shortcut" {href}>
        <span class="shortcut-icon"><Icon name={icon} size={19} /></span>
        <span class="shortcut-copy"
          ><strong>{title}</strong><small>{description}</small></span
        >
        <Icon name="arrow" size={15} />
      </a>
    {/each}
    <div class="memory-note">
      <div class="panel-title">
        <h3>长期记忆</h3>
        <span class="badge neutral"
          >{data?.memory === 'disabled'
            ? '未启用'
            : (data?.memory ?? '连接中')}</span
        >
      </div>
      <p class="muted">
        {data?.memory === 'disabled'
          ? '当前通过近期对话理解上下文。'
          : '已配置记忆插件，处理状态见记忆页面。'}
      </p>
      <a class="text-link" href="/memory"
        >查看记忆状态 <Icon name="arrow" size={14} /></a
      >
    </div>
  </section>
</div>
