<script lang="ts">
  import { onMount } from 'svelte';
  import { Tabs, Dialog } from 'bits-ui';
  import { api, time } from './api';
  let config = $state<any>(null),
    revision = $state(0),
    view = $state<any>(null),
    error = $state(''),
    notice = $state(''),
    configured = $state(false),
    tab = $state('settings');
  let secret = $state(''),
    brokerSecret = $state(''),
    workspace = $state(''),
    query = $state(''),
    results = $state<any>(null),
    details = $state<any>(null),
    pendingDelete = $state<{ id: string; workspaceId: string } | null>(null),
    dialog = $state(false),
    busy = $state(false);
  async function load() {
    try {
      const c = await api('config');
      config = c.config;
      configured = Boolean(
        config.memory.secretRef && config.memory.bindings.length,
      );
      revision = c.revision;
      workspace ||= config.memory.bindings[0]?.workspaceId ?? '';
      await refresh();
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function refresh() {
    try {
      view = await api('memory');
    } catch (e) {
      error = (e as Error).message;
    }
  }
  onMount(() => {
    void load();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  });
  async function save() {
    busy = true;
    error = '';
    notice = '';
    try {
      if (secret) {
        config.memory.secretRef = (
          await api('secrets', 'POST', {
            name: 'memstation-service',
            value: secret,
          })
        ).ref;
        secret = '';
      }
      if (brokerSecret) {
        config.memory.broker.secretRef = (
          await api('secrets', 'POST', {
            name: 'memory-broker',
            value: brokerSecret,
          })
        ).ref;
        brokerSecret = '';
      }
      const c = await api('config', 'PUT', { config, revision });
      config = c.config;
      configured = Boolean(
        config.memory.secretRef && config.memory.bindings.length,
      );
      revision = c.revision;
      notice = '已保存';
      await refresh();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function action(name: string, value: any = {}) {
    pendingDelete = null;
    error = '';
    notice = '';
    busy = true;
    try {
      const r = await api('memory/' + name, 'POST', {
        workspaceId: workspace,
        ...value,
      });
      if (name === 'search') results = r;
      else if (
        name === 'inspect' ||
        name === 'source' ||
        name === 'probe' ||
        name === 'operation'
      ) {
        details = r;
        dialog = true;
      } else notice = '已更新';
      await refresh();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  const addBinding = () =>
    config.memory.bindings.push({
      workspaceId: '',
      remoteWorkspaceId: '',
      integrationId: '',
      externalSpaceId: '',
      partitionId: '',
      audienceActorIds: [],
    });
  function generate() {
    brokerSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('');
  }
</script>

<div class="page-head">
  <div>
    <h1>记忆</h1>
    <p class="subtitle">配置记忆引擎，查看摄取进度与召回来源。</p>
  </div>
  <button class="secondary" onclick={refresh}>刷新</button>
</div>
{#if error}<div class="error-message" role="alert">{error}</div>{/if}
{#if notice}<div class="notice" role="status">{notice}</div>{/if}
{#if config}
  <Tabs.Root bind:value={tab}>
    <Tabs.List class="tabs"
      ><Tabs.Trigger value="settings">接入设置</Tabs.Trigger><Tabs.Trigger
        value="activity">处理与检索</Tabs.Trigger
      ><Tabs.Trigger value="broker">AI broker</Tabs.Trigger></Tabs.List
    >
    <Tabs.Content value="settings">
      <section class="panel stack">
        <p class="muted">保存业务凭据和会话绑定后，长期记忆会自动开启。</p>
        {#if configured}<label class="check"
            ><input
              type="checkbox"
              bind:checked={config.memory.enabled}
            />启用长期记忆</label
          >{/if}
        <div class="form-grid">
          <label
            >记忆插件<select bind:value={config.memory.provider}
              ><option value="memstation">MemStation</option></select
            ></label
          ><label
            >服务地址<input
              bind:value={config.memory.baseUrl}
              placeholder="http://127.0.0.1:8090"
            /></label
          >
        </div>
        <label
          >MemStation 业务 API Key<input
            type="password"
            bind:value={secret}
            autocomplete="new-password"
            placeholder={config.memory.secretRef
              ? '已配置，留空保留'
              : 'Agent 业务凭据，不是管理员或模型密钥'}
          /></label
        >
        <div class="form-grid">
          <label
            >检索截止时间（毫秒）<input
              type="number"
              min="100"
              max="10000"
              bind:value={config.memory.timeoutMs}
            /></label
          ><label
            >召回条数<input
              type="number"
              min="1"
              max="20"
              bind:value={config.memory.topN}
            /></label
          ><label
            >记忆正文预算（字符）<input
              type="number"
              min="100"
              max="12000"
              bind:value={config.memory.maxChars}
            /></label
          >
        </div>
        <p class="footnote">
          先在 MemStation Manager 创建 Workspace、Agent 与
          Integration。这里只配置业务凭据和明确的空间映射。
        </p>
      </section>
      <section class="panel stack">
        <div class="panel-title">
          <h2>会话绑定</h2>
          <button class="secondary tiny" onclick={addBinding}>添加绑定</button>
        </div>
        {#each config.memory.bindings as b, i}
          <div
            class="stack"
            style="border-bottom:1px solid var(--line);padding-bottom:20px"
          >
            <div class="form-grid">
              <label
                >Mimic 会话 ID<input
                  bind:value={b.workspaceId}
                  placeholder="qq:group:… 或 replay:开发回放"
                /></label
              ><label
                >MemStation Workspace ID<input
                  bind:value={b.remoteWorkspaceId}
                /></label
              ><label
                >Integration ID<input bind:value={b.integrationId} /></label
              ><label>外部空间 ID<input bind:value={b.externalSpaceId} /></label
              ><label
                >私有分区 ID（可选）<input bind:value={b.partitionId} /></label
              ><label
                >私有受众 Actor ID（逗号分隔）<input
                  value={b.audienceActorIds.join(',')}
                  oninput={(e) =>
                    (b.audienceActorIds = e.currentTarget.value
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean))}
                /></label
              >
            </div>
            <div>
              <button
                class="secondary tiny"
                onclick={() => config.memory.bindings.splice(i, 1)}
                >移除绑定</button
              >
            </div>
          </div>
        {:else}<p class="muted">
            尚无绑定。只有明确绑定的会话会摄取和检索。
          </p>{/each}
        <p class="footnote">
          私有分区必须同时设置完整受众；群聊绑定使用默认 Workspace
          受众。修改映射后，旧队列会停止投递并提示绑定已变化。
        </p>
      </section>
      <div class="actions" style="margin-top:20px">
        <button disabled={busy} onclick={save}>保存记忆设置</button><button
          class="secondary"
          onclick={load}>重新加载</button
        >
      </div>
    </Tabs.Content>
    <Tabs.Content value="activity">
      <div class="select-row">
        <select aria-label="记忆会话" bind:value={workspace}
          ><option value="">选择已绑定会话</option
          >{#each config.memory.bindings as b}<option value={b.workspaceId}
              >{b.workspaceId}</option
            >{/each}</select
        ><button
          class="secondary"
          disabled={!workspace || busy}
          onclick={() => action('probe')}>检查连接与权限</button
        ><button
          class="secondary"
          disabled={busy}
          onclick={() => action('flush')}>处理待投递消息</button
        >
      </div>
      <section class="panel stack">
        <h2>检索测试</h2>
        <label
          >查询内容<input
            bind:value={query}
            placeholder="输入要查找的信息"
          /></label
        >
        <div>
          <button
            disabled={!workspace || !query || busy}
            onclick={() => action('search', { query })}>查询记忆</button
          >
        </div>
        {#if results}<p class="muted">
            {results.status}，注入 {results.items.length} 条。查询可能产生 embedding
            / rerank 用量。
          </p>
          {#each results.items as item}<div class="row">
              <div class="grow">
                <p>{item.content}</p>
                <p class="muted">{item.id}</p>
                <div class="actions">
                  <button
                    class="secondary tiny"
                    onclick={() => action('inspect', { id: item.id })}
                    >记录详情</button
                  >{#each item.sourceIds as id}<button
                      class="secondary tiny"
                      onclick={() => action('source', { id })}>查看来源</button
                    >{/each}
                  <button
                    class="secondary tiny"
                    onclick={() => {
                      pendingDelete = { id: item.id, workspaceId: workspace };
                      dialog = true;
                    }}>删除此记忆</button
                  >
                </div>
              </div>
            </div>{:else}<p class="muted">没有可注入的结果。</p>{/each}
          <details>
            <summary>本次查询诊断</summary>
            <pre>{JSON.stringify(results.trace, null, 2)}</pre>
          </details>{/if}
      </section>
      <section class="panel table-wrap">
        <h2>摄取队列</h2>
        <table>
          <thead
            ><tr
              ><th>会话 / 消息</th><th>状态</th><th>处理水位</th><th>操作</th
              ></tr
            ></thead
          ><tbody
            >{#each view?.jobs ?? [] as row}<tr
                ><td
                  >{row.scope}<br /><span class="muted"
                    >{row.value.messageId}</span
                  ></td
                ><td
                  >{row.value.status}<br /><span class="muted"
                    >{row.value.code ?? ''}</span
                  ></td
                ><td
                  >{row.value.receipt?.indexed_sequence ?? '—'} / {row.value
                    .receipt?.accepted_sequence ?? '—'}<br /><span class="muted"
                    >{row.value.receipt?.stage ?? ''}</span
                  ></td
                ><td
                  >{#if ['dead_letter', 'retry'].includes(row.value.status)}<button
                      class="secondary tiny"
                      onclick={() => action('retry', { key: row.key })}
                      >重试</button
                    >{/if}</td
                ></tr
              >{:else}<tr><td colspan="4" class="empty">暂无摄取任务。</td></tr
              >{/each}</tbody
          >
        </table>
      </section>
      <section class="panel">
        <h2>最近召回</h2>
        {#each view?.recalls ?? [] as row}<details>
            <summary>{row.scope}　{row.value.status}　{time(row.at)}</summary>
            <p class="muted">
              耗时 {row.value.latencyMs}ms，注入 {row.value.items.length} 条。usedRefs
              尚未核验，不计作采用成功。
            </p>
            <div class="actions">
              {#each row.value.items as item}<button
                  class="secondary tiny"
                  onclick={() =>
                    action('inspect', { id: item.id, workspaceId: row.scope })}
                  >当前内容</button
                >{/each}
            </div>
            <pre>{JSON.stringify(row.value, null, 2)}</pre>
          </details>{:else}<p class="muted">
            暂无查询记录。命中率和回答效果需要积累样本后再评估。
          </p>{/each}
      </section>
      <section class="panel stack">
        <h2>数据操作</h2>
        <p class="muted">
          删除和导出作用于当前会话绑定的分区。候选批准、发布和后台 DLQ 重放在
          MemStation Manager 中管理。
        </p>
        <div class="actions">
          <button
            class="secondary"
            disabled={!workspace || busy}
            onclick={() =>
              action('operation', {
                action: 'export',
                value: {},
                key: crypto.randomUUID(),
              })}>创建分区导出</button
          >
        </div>
        <label>操作 ID<input id="memory-operation-id" /></label>
        <div>
          <button
            class="secondary"
            disabled={!workspace || busy}
            onclick={() =>
              action('operation', {
                action: 'operation',
                value: {
                  id: (
                    document.getElementById(
                      'memory-operation-id',
                    ) as HTMLInputElement
                  ).value,
                },
                key: crypto.randomUUID(),
              })}>查询删除或导出进度</button
          >
        </div>
      </section>
    </Tabs.Content>
    <Tabs.Content value="broker"
      ><section class="panel stack">
        <h2>统一 AI 入口</h2>
        <p class="muted">
          MemStation 的摘要、分析、向量和精排复用 Mimic 的模型连接与用量账本。
        </p>
        <label class="check"
          ><input
            type="checkbox"
            bind:checked={config.memory.broker.enabled}
          />启用受限 broker</label
        ><label
          >服务凭据<input
            type="password"
            bind:value={brokerSecret}
            autocomplete="new-password"
            placeholder={config.memory.broker.secretRef
              ? '已配置，留空保留'
              : '与 MemStation 数据面凭据分开配置'}
          /></label
        >
        <div class="actions">
          <button class="secondary tiny" onclick={generate}>生成随机凭据</button
          ><button
            class="secondary tiny"
            disabled={!brokerSecret}
            onclick={() => navigator.clipboard.writeText(brokerSecret)}
            >复制待保存凭据</button
          >
        </div>
        <p class="footnote">
          将此凭据配置到 MemStation 的
          MEMORY_BROKER_CREDENTIAL，然后保存。broker 仅接受已绑定的 Workspace
          与四种 memory 角色。默认监听本机 3215 端口。
        </p>
        <div class="form-grid">
          <label
            >Embedding 实际模型版本<input
              bind:value={config.memory.broker.embeddingModel}
            /></label
          ><label
            >Embedding 指纹<input
              bind:value={config.memory.broker.embeddingFingerprint}
            /></label
          ><label
            >向量维度<input
              type="number"
              min="1"
              max="8192"
              bind:value={config.memory.broker.embeddingDimensions}
            /></label
          ><label
            >后台调用截止时间（毫秒）<input
              type="number"
              bind:value={config.memory.broker.timeoutMs}
            /></label
          >
        </div>
        <p class="muted">
          模型角色在“模型与连接”里统一分配：memory.summary、memory.analysis、memory.embedding、memory.rerank。Embedding
          支持 OpenAI 兼容服务，rerank 支持本地 Jina 兼容接口；模型变更须在
          MemStation 新建 generation 重建。
        </p>
        <div class="actions">
          <button onclick={save} disabled={busy}>保存 broker 设置</button><a
            class="text-link"
            href="/models">配置模型角色</a
          >
        </div>
      </section></Tabs.Content
    >
  </Tabs.Root>
{:else}<div class="loading">正在连接本地运行服务…</div>{/if}
<Dialog.Root bind:open={dialog}
  ><Dialog.Portal
    ><Dialog.Overlay class="dialog-overlay" /><Dialog.Content
      class="dialog-content"
      ><Dialog.Title class="dialog-title"
        >{pendingDelete ? '删除记忆' : '记忆服务详情'}</Dialog.Title
      ><Dialog.Description class="muted"
        >当前授权范围内的服务响应。</Dialog.Description
      >
      {#if pendingDelete}
        <p>
          确认删除会话 {pendingDelete.workspaceId} 中的这条记忆？来源关联和派生内容将由
          MemStation 按范围处理。
        </p>
        <code>{pendingDelete.id}</code>
        <div class="actions" style="margin:20px 0">
          <button
            class="danger"
            onclick={async () => {
              const target = pendingDelete!;
              dialog = false;
              await action('operation', {
                workspaceId: target.workspaceId,
                action: 'forget',
                value: { node_ids: [target.id] },
                key: crypto.randomUUID(),
              });
              results = null;
            }}>确认删除</button
          >
        </div>
      {:else}<pre>{JSON.stringify(details, null, 2)}</pre>{/if}
      <Dialog.Close class="secondary">关闭</Dialog.Close></Dialog.Content
    ></Dialog.Portal
  ></Dialog.Root
>
