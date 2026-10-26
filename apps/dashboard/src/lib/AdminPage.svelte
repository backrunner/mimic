<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Dialog, Tabs } from 'bits-ui';
  import Icon from './Icon.svelte';
  import MemoryAdmin from './MemoryAdmin.svelte';
  import { api, time, statusLabel } from './api';
  let { section }: { section: string } = $props();
  let config = $state<any>(null),
    revision = $state(0),
    items = $state<any[]>([]),
    auditRows = $state<any[]>([]),
    workspaces = $state<any[]>([]),
    messages = $state<any[]>([]),
    runs = $state<any[]>([]),
    system = $state<any>(null),
    error = $state(''),
    notice = $state(''),
    busy = $state(false),
    selected = $state(''),
    tab = $state('connections'),
    dialog = $state(false);
  let connection = $state({
      id: '',
      name: '',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      protocol: 'chat',
      secretRef: '',
      enabled: true,
    }),
    secret = $state('');
  let replay = $state({
    workspace: '开发回放',
    actor: '小林',
    text: '',
    mention: true,
  });
  let asset = $state({
    name: '',
    tags: '',
    alt: '',
    mime: 'image/png',
    data: '',
    source: '',
  });
  let task = $state<any>({
      id: '',
      name: '',
      workspaceId: '',
      enabled: false,
      kind: 'random',
      expression: '0 12 * * *',
      timezone: 'Asia/Shanghai',
      minMs: 3600000,
      maxMs: 10800000,
      quietStart: '22:00',
      quietEnd: '09:00',
      prompt:
        '结合当前话题，判断是否有值得分享的一条信息。没有合适内容就保持安静。',
      misfire: 'skip',
    }),
    taskRevision = $state<number | null>(null),
    future = $state<number[]>([]);
  const titles: Record<string, [string, string]> = {
    models: ['模型与连接', '管理 API 连接、模型分配与用量预算。'],
    soul: ['Soul', '设置机器人的性格、兴趣和说话方式。'],
    conversations: ['会话', '查看聊天上下文，测试机器人回复。'],
    usage: ['模型用量', '查看各模型的调用次数、Token 和耗时。'],
    logs: ['运行记录', '查看参与判断、回复草稿和异常。'],
    tasks: ['定时任务', '管理固定时间或随机间隔触发的任务。'],
    system: ['系统', '运行环境、数据备份与保留策略。'],
    memory: ['记忆', '配置记忆引擎，查看摄取进度与召回来源。'],
    qq: ['QQ 官方机器人', '接收能力与发送权限分别配置。'],
    safety: ['安全与边界', '所有安全判断复用统一的模型连接。'],
    web: ['网页搜索', '使用 DeepSeek 官方 Search / Fetch。'],
    stickers: ['表情素材', '管理机器人可以发送的图片和表情。'],
    sandbox: ['Node.js 沙箱', '隔离环境内的计算工具。'],
    plugins: ['插件', '管理协议、模型、工具与存储插件。'],
  };
  const roles = [
    ['chat', '聊天生成'],
    ['participation', '参与判断'],
    ['atmosphere', '群风格'],
    ['safety', '安全判断'],
    ['web-search', '网页搜索'],
    ['memory.summary', '记忆摘要'],
    ['memory.analysis', '记忆分析'],
    ['memory.embedding', '记忆向量'],
    ['memory.rerank', '记忆精排'],
  ];
  const pluginIcons: Record<string, string> = {
    protocol: 'chat',
    model: 'model',
    memory: 'memory',
    storage: 'system',
    tool: 'plugins',
    safety: 'shield',
    behavior: 'clock',
  };
  async function load() {
    try {
      const c = await api('config');
      config = c.config;
      revision = c.revision;
      if (
        ['models', 'soul', 'qq', 'safety', 'web', 'sandbox'].includes(section)
      )
        return;
      if (section === 'conversations' || section === 'tasks') {
        workspaces = (await api('workspaces')).items;
        if (!selected && workspaces.length) selected = workspaces[0].value.id;
        if (section === 'conversations') await loadConversation();
      }
      if (section === 'usage') items = (await api('usage?limit=200')).items;
      if (section === 'logs') {
        const [r, a] = await Promise.all([
          api('runs?limit=100'),
          api('logs?limit=100'),
        ]);
        items = r.items;
        auditRows = a.items;
      }
      if (section === 'plugins') items = (await api('plugins')).items;
      if (section === 'tasks') items = (await api('tasks')).items;
      if (section === 'stickers') items = (await api('assets')).items;
      if (section === 'system') system = await api('system');
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }
  let requestGeneration = 0;
  async function loadConversation() {
    const generation = ++requestGeneration;
    if (!selected) {
      messages = [];
      runs = [];
      return;
    }
    try {
      const [m, r] = await Promise.all([
        api(`messages?scope=${encodeURIComponent(selected)}`),
        api(`runs?scope=${encodeURIComponent(selected)}`),
      ]);
      if (generation !== requestGeneration) return;
      messages = m.items.reverse();
      runs = r.items;
    } catch (e) {
      if (generation === requestGeneration) error = (e as Error).message;
    }
  }
  $effect(() => {
    section;
    untrack(() => {
      void load();
    });
  });
  onMount(() => {
    const timer = setInterval(() => {
      if (section === 'conversations') void loadConversation();
    }, 3000);
    return () => clearInterval(timer);
  });
  async function action(work: () => Promise<unknown>, success = '已保存') {
    busy = true;
    error = '';
    notice = '';
    try {
      await work();
      notice = success;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function save() {
    await action(async () => {
      const result = await api('config', 'PUT', { config, revision });
      revision = result.revision;
      config = result.config;
    });
  }
  function newConnection() {
    connection = {
      id: crypto.randomUUID(),
      name: 'DeepSeek',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      protocol: 'chat',
      secretRef: '',
      enabled: true,
    };
    secret = '';
    dialog = true;
  }
  function providerChanged() {
    const defaults: Record<string, [string, string, string]> = {
      deepseek: ['DeepSeek', 'https://api.deepseek.com', 'chat'],
      typesafe: ['TypeSafe · Jev', 'https://api.typesafe.ai', 'systemone'],
      openai: ['OpenAI Decisions', 'https://api.openai.com', 'decisions'],
      local: ['本地模型', 'http://127.0.0.1:11434/v1', 'chat'],
    };
    const d = defaults[connection.provider]!;
    connection.name = d[0];
    connection.baseUrl = d[1];
    connection.protocol = d[2];
  }
  async function saveConnection() {
    await action(async () => {
      if (secret)
        connection.secretRef = (
          await api('secrets', 'POST', { name: connection.id, value: secret })
        ).ref;
      const index = config.connections.findIndex(
        (c: any) => c.id === connection.id,
      );
      if (index < 0)
        config.connections = [...config.connections, { ...connection }];
      else
        config.connections = config.connections.map((c: any) =>
          c.id === connection.id ? { ...connection } : c,
        );
      const result = await api('config', 'PUT', { config, revision });
      revision = result.revision;
      secret = '';
      dialog = false;
    });
  }
  function route(role: string) {
    return config.routes[role] ?? { connectionId: '', model: '' };
  }
  function setRoute(role: string, field: string, value: string) {
    config.routes = {
      ...config.routes,
      [role]: { ...route(role), [field]: value },
    };
    if (!config.routes[role].connectionId) delete config.routes[role];
  }
  async function sendReplay() {
    await action(async () => {
      const result = await api('replay', 'POST', replay);
      selected = result.message.workspaceId;
      replay.text = '';
      workspaces = (await api('workspaces')).items;
      await loadConversation();
    }, '已进入本地回放，真实模型调用仍会计量。');
  }
  async function workspaceSave(row: any) {
    await action(() =>
      api('workspaces', 'PUT', {
        id: row.value.id,
        revision: row.revision,
        name: row.value.name,
        paused: row.value.paused,
        proactive: row.value.proactive,
      }),
    );
    await load();
  }
  async function fileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (
      file.size > 1024 * 1024 ||
      !['image/png', 'image/jpeg'].includes(file.type)
    ) {
      error = '请选择 1 MB 以内的 PNG / JPEG';
      return;
    }
    asset.name = file.name;
    asset.mime = file.type;
    asset.data = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]!);
      reader.readAsDataURL(file);
    });
  }
  function editTask(row?: any) {
    task = row
      ? structuredClone(row.value.spec)
      : {
          id: crypto.randomUUID(),
          name: '随机分享候选',
          workspaceId: workspaces[0]?.value.id ?? '',
          enabled: false,
          kind: 'random',
          expression: '0 12 * * *',
          timezone: 'Asia/Shanghai',
          minMs: 3600000,
          maxMs: 10800000,
          quietStart: '22:00',
          quietEnd: '09:00',
          prompt:
            '结合当前话题，判断是否有值得分享的一条信息。没有合适内容就保持安静。',
          misfire: 'skip',
        };
    taskRevision = row?.revision ?? null;
    future = [];
    dialog = true;
  }
</script>

{#if section === 'memory'}<MemoryAdmin />{:else}
  <div class="page-head">
    <div>
      <h1>{titles[section]?.[0] ?? section}</h1>
      <p class="subtitle">{titles[section]?.[1]}</p>
    </div>
    <div class="actions">
      {#if section === 'models'}<button onclick={newConnection}
          >＋ 添加连接</button
        >{:else if section === 'tasks'}<button onclick={() => editTask()}
          >＋ 创建任务</button
        >{:else}<button class="secondary" onclick={load}>刷新</button>{/if}
    </div>
  </div>
  {#if error}<div class="error-message" role="alert">
      {error === 'daemon_unavailable'
        ? '运行服务尚未连接，请先启动 Mimic daemon。'
        : error}
    </div>{/if}{#if notice}<div class="notice" role="status">{notice}</div>{/if}
  {#if config}
    {#if section === 'models'}
      <Tabs.Root bind:value={tab}
        ><Tabs.List class="tabs"
          ><Tabs.Trigger value="connections">连接与凭据</Tabs.Trigger
          ><Tabs.Trigger value="routes">角色分配</Tabs.Trigger><Tabs.Trigger
            value="budgets">调用预算</Tabs.Trigger
          ></Tabs.List
        >
        <Tabs.Content value="connections"
          ><div class="notice">
            凭据只保存一份。聊天、决策、安全和搜索通过角色引用同一个连接；密钥不会返回浏览器。
          </div>
          {#if config.connections.length === 0}<div class="panel empty">
              <div class="symbol"><Icon name="model" size={28} /></div>
              还没有模型连接。添加 DeepSeek 或一个本地服务开始。
            </div>{/if}
          <div class="plugin-grid">
            {#each config.connections as c}<div class="panel">
                <div class="plugin-icon"><Icon name="model" size={22} /></div>
                <h2>{c.name}</h2>
                <p class="muted">{c.provider} · {c.protocol}</p>
                <p class="muted" style="overflow-wrap:anywhere">{c.baseUrl}</p>
                <p>
                  <span class="badge"
                    >{c.secretRef ? '凭据已配置' : '无凭据'}</span
                  >
                </p>
                <button
                  class="secondary tiny"
                  onclick={() => {
                    connection = { ...c };
                    secret = '';
                    dialog = true;
                  }}>编辑连接</button
                >
              </div>{/each}
          </div></Tabs.Content
        >
        <Tabs.Content value="routes"
          ><section class="panel">
            <div class="notice">
              模型名称填写供应商实际可用的 ID。网页搜索可填 <code>search</code> 作为逻辑标识。测试调用会实际请求并记录用量。
            </div>
            {#each roles as [key, label]}<div class="row">
                <div style="width:95px;font-size:13px">{label}</div>
                <div class="grow form-grid">
                  <select
                    aria-label={`${label}连接`}
                    value={route(key).connectionId}
                    onchange={(e) =>
                      setRoute(key, 'connectionId', e.currentTarget.value)}
                    ><option value="">暂未配置</option
                    >{#each config.connections as c}<option value={c.id}
                        >{c.name}</option
                      >{/each}</select
                  ><input
                    aria-label={`${label}模型`}
                    placeholder="模型 ID"
                    value={route(key).model}
                    oninput={(e) =>
                      setRoute(key, 'model', e.currentTarget.value)}
                  />
                </div>
              </div>{/each}
            <div class="actions" style="margin-top:20px">
              <button disabled={busy} onclick={save}>保存角色分配</button
              ><button
                class="secondary"
                disabled={busy}
                onclick={() =>
                  action(
                    () => api('model/probe', 'POST', { role: 'chat' }),
                    '聊天连接测试成功，用量已记录。',
                  )}>测试聊天 · 会计费</button
              ><button
                class="secondary"
                disabled={busy}
                onclick={() =>
                  action(
                    () => api('model/probe', 'POST', { role: 'participation' }),
                    '决策连接测试成功，用量已记录。',
                  )}>测试决策 · 会计费</button
              >
            </div>
          </section></Tabs.Content
        >
        <Tabs.Content value="budgets"
          ><section class="panel">
            <div class="form-grid">
              <label
                >每日调用上限<input
                  type="number"
                  min="1"
                  bind:value={config.budgets.dailyCalls}
                /></label
              ><label
                >每轮调用上限<input
                  type="number"
                  min="1"
                  max="30"
                  bind:value={config.budgets.runCalls}
                /></label
              ><label
                >每轮总时限（毫秒）<input
                  type="number"
                  bind:value={config.budgets.runTimeoutMs}
                /></label
              ><label
                >最大工具轮次<input
                  type="number"
                  min="0"
                  max="3"
                  bind:value={config.budgets.maxToolRounds}
                /></label
              >
            </div>
            <p class="footnote">
              费用未配置定价时不估算为零。失败和取消可能仍有费用，显示为待确认。
            </p>
            <button onclick={save} disabled={busy}>保存预算</button>
          </section></Tabs.Content
        ></Tabs.Root
      >
    {:else if section === 'soul'}
      <div class="columns">
        <section class="panel stack">
          <label>名字<input bind:value={config.botName} /></label><label
            >Soul Markdown<textarea
              style="min-height:350px"
              bind:value={config.soul}></textarea></label
          >
          <div class="actions">
            <button onclick={save} disabled={busy}>应用 Soul</button><button
              class="secondary"
              onclick={load}>放弃修改</button
            >
          </div>
          <p class="footnote">
            保存为本地 soul.md，同时更新配置版本并取消尚未发出的回复。
          </p>
        </section>
        <section class="panel">
          <h2>Soul 编写建议</h2>
          <p class="muted">
            喜欢什么、不了解什么、会怎么接话，比一长串性格标签更有帮助。
          </p>
          <div class="row">
            <div class="grow">
              <h3>回复习惯</h3>
              <p class="muted">别人已经说清楚时，不重复。</p>
            </div>
          </div>
          <div class="row">
            <div class="grow">
              <h3>场合与语气</h3>
              <p class="muted">同一个群也会从玩笑转入严肃讨论。</p>
            </div>
          </div>
          <div class="row">
            <div class="grow">
              <h3>知识范围</h3>
              <p class="muted">不熟悉的内容不装懂，不虚构真人经历。</p>
            </div>
          </div>
        </section>
      </div>
      <section class="panel stack" style="margin-top:24px">
        <h2>聊天节奏</h2>
        <div class="form-grid">
          <label
            >连发合并等待（毫秒）<input
              type="number"
              min="0"
              max="10000"
              bind:value={config.behavior.debounceMs}
            /></label
          ><label
            >主动参与间隔（毫秒）<input
              type="number"
              min="0"
              bind:value={config.behavior.cooldownMs}
            /></label
          ><label
            >回复最长字数<input
              type="number"
              min="20"
              max="2000"
              bind:value={config.behavior.maxChars}
            /></label
          ><label>时区<input bind:value={config.behavior.timezone} /></label
          ><label
            >安静时段开始<input
              type="time"
              bind:value={config.behavior.quietStart}
            /></label
          ><label
            >安静时段结束<input
              type="time"
              bind:value={config.behavior.quietEnd}
            /></label
          >
        </div>
        <label class="check"
          ><input
            type="checkbox"
            bind:checked={config.behavior.proactiveCalibrated}
          />已用本群回放校准主动参与</label
        >
        <p class="footnote">
          主动接话需要完整消息、原生决策概率和会话授权。普通文本模型桥接保留被动回应能力。校准开关是管理员声明，不代表系统已经测过模型效果。
        </p>
        <div class="actions">
          <button disabled={busy} onclick={save}>保存聊天节奏</button><button
            class="secondary"
            onclick={() =>
              action(async () => {
                await api('soul/reload', 'POST', {});
                await load();
              }, '已从本地 soul.md 载入。')}>重新载入 soul.md</button
          >
        </div>
      </section>
    {:else if section === 'conversations'}
      <div class="select-row">
        <select
          aria-label="选择会话"
          bind:value={selected}
          onchange={loadConversation}
          ><option value="">选择一个会话</option>{#each workspaces as w}<option
              value={w.value.id}>{w.value.name}</option
            >{/each}</select
        ><button class="secondary" onclick={load}>刷新会话</button>
      </div>
      <div class="columns">
        <section class="panel">
          <div class="panel-title">
            <h2>近期对话</h2>
            <span class="badge neutral"
              >{selected.startsWith('replay:')
                ? '本地回放'
                : '当前可见窗口'}</span
            >
          </div>
          {#if !messages.length}<div class="empty">
              <div class="symbol"><Icon name="chat" size={28} /></div>
              还没有消息。可以在右侧输入一段对话。
            </div>{/if}{#each messages as row}{#if row.value.kind !== 'deleted'}<div
                class:bot={row.value.bot}
                class="chat-message"
              >
                <div class="chat-meta">
                  <strong>{row.value.actorName}</strong><span
                    >{time(row.value.occurredAt)}</span
                  >
                </div>
                {row.value.text}{#if row.value.replyTo}<div class="muted">
                    引用：{row.value.replyTo}
                  </div>{/if}
              </div>{/if}{/each}{#each workspaces.filter((w) => w.value.id === selected) as w}<div
              class="actions"
              style="margin-top:20px"
            >
              <label class="check"
                ><input
                  type="checkbox"
                  bind:checked={w.value.paused}
                />暂停此会话</label
              ><label class="check"
                ><input
                  type="checkbox"
                  bind:checked={w.value.proactive}
                />允许主动参与</label
              ><button class="secondary tiny" onclick={() => workspaceSave(w)}
                >保存</button
              >
            </div>
            <p class="footnote">
              接收范围：{w.value
                .receive}。主动参与还需模型校准、兴趣判断和实际协议许可。
            </p>{/each}
        </section>
        <div>
          <section class="panel stack">
            <h2>本地回放</h2>
            <div class="form-grid">
              <label>会话名称<input bind:value={replay.workspace} /></label
              ><label>发言者<input bind:value={replay.actor} /></label>
            </div>
            <label
              >消息<textarea
                placeholder="给小弥发一句话…"
                bind:value={replay.text}></textarea></label
            ><label class="check"
              ><input type="checkbox" bind:checked={replay.mention} />@ 小弥</label
            ><button disabled={busy || !replay.text} onclick={sendReplay}
              >加入对话</button
            >
            <p class="footnote">
              只进入 replay 协议，不会发送到 QQ。已配置的 AI 调用会正常计量。
            </p>
          </section>
          <section class="panel">
            <h2>最近判断</h2>
            {#each runs.slice(0, 4) as r}<div class="row">
                <div class="grow">
                  <span class="badge"
                    >{statusLabel[r.value.status] ?? r.value.status}</span
                  >
                  <p class="muted" style="margin-top:7px">
                    {r.value.reason ?? '处理中'}
                  </p>
                  {#if r.value.draft}<p style="font-size:13px">
                      {r.value.draft}
                    </p>{/if}
                </div>
              </div>{:else}<p class="muted">参与判断会在这里显示。</p>{/each}
          </section>
        </div>
      </div>
    {:else if section === 'usage'}
      <div class="notice">
        展示最近 200
        次调用。原生用量、未知用量分别保留；目前没有配置价格表，费用不估算为零。
      </div>
      <section class="panel table-wrap">
        <table>
          <thead
            ><tr
              ><th>时间</th><th>角色 / 模型</th><th>输入 / 输出</th><th
                >工具单位</th
              ><th>耗时</th><th>状态</th></tr
            ></thead
          ><tbody
            >{#each items as r}<tr
                ><td>{time(r.value.at)}</td><td
                  >{r.value.role}<br /><span class="muted">{r.value.model}</span
                  ></td
                ><td
                  >{r.value.inputTokens ?? '—'} / {r.value.outputTokens ??
                    '—'}</td
                ><td>{r.value.units ?? '—'}</td><td>{r.value.durationMs} ms</td
                ><td
                  ><span class="badge neutral">{r.value.status}</span
                  >{#if r.value.error}<div class="muted">
                      {r.value.error}
                    </div>{/if}</td
                ></tr
              >{:else}<tr
                ><td colspan="6" class="empty"
                  >模型调用后会在这里记录真实用量。</td
                ></tr
              >{/each}</tbody
          >
        </table>
      </section>
    {:else if section === 'logs'}
      <section class="panel">
        <h2>执行时间线</h2>
        {#each items as row}<details>
            <summary
              ><span class="badge"
                >{statusLabel[row.value.status] ?? row.value.status}</span
              >
              &nbsp; {time(row.value.at)} · {row.value.workspaceId}</summary
            >
            <div class="timeline">
              {#each row.value.stages as s}<div>
                  {time(s.at)} &nbsp; {s.stage}
                  <span class="muted">{s.detail ?? ''}</span>
                </div>{/each}
            </div>
            <p class="muted">结束原因：{row.value.reason ?? '运行中'}</p>
            {#if row.value.draft}<div class="chat-message">
                {row.value.draft}
              </div>{/if}
            <pre>{JSON.stringify(row.value.answers ?? {}, null, 2)}</pre>
          </details>{:else}<div class="empty">
            暂无执行记录。不会将隐藏推理记录为日志。
          </div>{/each}
      </section>
      <section class="panel" style="margin-top:24px">
        <h2>系统与安全事件</h2>
        {#each auditRows as row}<details>
            <summary>{time(row.value.at)} · {row.value.event}</summary>
            <p class="muted">{row.scope}</p>
            <pre>{JSON.stringify(row.value.details, null, 2)}</pre>
          </details>{:else}<div class="empty">暂无系统事件。</div>{/each}
      </section>
    {:else if section === 'plugins'}
      <div class="plugin-grid">
        {#each items as p}<section class="panel">
            <div class="plugin-icon">
              <Icon name={pluginIcons[p.kind] ?? 'plugins'} size={22} />
            </div>
            <h2>{p.name}</h2>
            <p class="muted">{p.kind} · v{p.version}</p>
            <div class="actions">
              <a class="button-link" href={`/plugins/${p.id}`}>管理</a><span
                class="badge neutral"
                >{p.id === 'memory-disabled'
                  ? '暂不接入'
                  : p.enabled
                    ? '已加载'
                    : '已停用'}</span
              >
            </div>
            {#if !['storage', 'memory'].includes(p.kind)}<button
                class="secondary tiny"
                style="margin-top:16px"
                disabled={busy}
                onclick={() =>
                  action(async () => {
                    config.disabledPlugins = p.enabled
                      ? [...new Set([...config.disabledPlugins, p.id])]
                      : config.disabledPlugins.filter(
                          (id: string) => id !== p.id,
                        );
                    const result = await api('config', 'PUT', {
                      config,
                      revision,
                    });
                    revision = result.revision;
                    await load();
                  })}>{p.enabled ? '停用' : '启用'}</button
              >{/if}
          </section>{/each}
      </div>
    {:else if section === 'qq'}
      <section class="panel stack">
        <div class="notice">
          HTTPS 回调路径为 <code>/qq/webhook</code>，默认独立监听
          3211。全量接收和主动发送需要实际账号权限及群设置支持。
        </div>
        <label class="check"
          ><input type="checkbox" bind:checked={config.qq.enabled} />启用 QQ
          连接</label
        ><label>App ID<input bind:value={config.qq.appId} /></label><label
          >Client Secret（留空保留已有凭据）<input
            type="password"
            autocomplete="new-password"
            bind:value={secret}
          /></label
        ><label
          >接收能力<select bind:value={config.qq.receive}
            ><option value="mentions_only">仅 @ 消息</option><option
              value="all_messages">全量群消息（需已获准启用）</option
            ></select
          ></label
        ><label class="check"
          ><input
            type="checkbox"
            bind:checked={config.qq.proactive}
          />账号已获准主动发送</label
        ><label
          >运行模式<select bind:value={config.mode}
            ><option value="shadow">观察模式：生成但不发到 QQ</option><option
              value="live">实时模式：允许发送</option
            ></select
          ></label
        ><button
          disabled={busy}
          onclick={() =>
            action(async () => {
              if (secret) {
                config.qq.secretRef = (
                  await api('secrets', 'POST', {
                    name: 'qq-main',
                    value: secret,
                  })
                ).ref;
                secret = '';
              }
              const c = await api('config', 'PUT', { config, revision });
              revision = c.revision;
            })}>保存 QQ 设置</button
        >
      </section>
    {:else if section === 'safety'}
      <section class="panel stack">
        <label
          >语义安全模式<select bind:value={config.safety.mode}
            ><option value="enforce">Enforce · 拦截</option><option
              value="audit">Audit · 仅记录</option
            ><option value="off">Off · 关闭语义判断</option></select
          ></label
        ><label
          >原生风险概率阈值<input
            type="number"
            min="0"
            max="1"
            step="0.05"
            bind:value={config.safety.threshold}
          /></label
        >
        <div class="notice">
          使用模型配置中的 safety 角色。Enforce
          下模型不可用会阻止发送。关闭语义判断不会关闭数据隔离、工具权限或容器限制；代码工具需要
          Enforce。
        </div>
        <div class="actions">
          <button onclick={save} disabled={busy}>保存安全策略</button><a
            href="/models"
            ><button class="secondary">配置 Safety 模型</button></a
          >
        </div>
      </section>
    {:else if section === 'web'}
      <section class="panel stack">
        <label class="check"
          ><input
            type="checkbox"
            bind:checked={config.tools.web}
          />启用网页搜索与抓取</label
        >
        <p class="muted">
          web-search 角色引用 DeepSeek 连接，与聊天共用凭据。每次返回最多 5
          条候选，工具内容作为不可信资料处理。
        </p>
        <div class="notice">
          只允许公开 HTTP/HTTPS 地址，拒绝私网、localhost 和 metadata
          目标。查询结果保留来源，空结果不算命中。
        </div>
        <div class="actions">
          <button onclick={save}>保存</button><a href="/models"
            ><button class="secondary">配置搜索角色</button></a
          >
        </div>
      </section>
    {:else if section === 'sandbox'}
      <section class="panel stack">
        <label
          >运行驱动<select bind:value={config.tools.sandboxDriver}
            ><option value="apple">Apple Container</option><option
              value="docker">Docker</option
            ></select
          ></label
        ><label class="check"
          ><input type="checkbox" bind:checked={config.tools.node} />提供
          Node.js 计算工具</label
        >
        <div class="notice">
          需要运行独立 SandboxBroker
          并通过自检。每次执行使用无网络的一次性容器；1 CPU、256 MiB
          内存、只读根目录、无宿主目录挂载。不可用时不回退到宿主执行。
        </div>
        <div class="actions">
          <button onclick={save}>保存</button><button
            class="secondary"
            disabled={busy}
            onclick={() =>
              action(
                () => api('sandbox/preflight', 'POST', {}),
                '隔离自检通过。',
              )}>运行隔离自检</button
          >
        </div>
      </section>
    {:else if section === 'stickers'}
      <div class="columns">
        <section class="panel">
          <h2>已批准的素材</h2>
          {#each items as r}<div class="row">
              <img
                style="width:54px;height:54px;object-fit:contain;border-radius:8px"
                src={`/api/assets/${r.key.slice(6)}`}
                alt={r.value.alt}
              />
              <div class="grow">
                <h3>{r.value.name}</h3>
                <p class="muted">{r.value.tags}</p>
              </div>
              <button
                class="secondary tiny"
                onclick={() =>
                  action(async () => {
                    await api(`assets/${r.key.slice(6)}`, 'DELETE');
                    await load();
                  }, '已删除素材。')}>删除</button
              >
            </div>{:else}<div class="empty">
              导入有使用权的素材，模型才能选择发送。
            </div>{/each}
        </section>
        <section class="panel stack">
          <h2>添加素材</h2>
          <label
            >PNG / JPEG · 最大 1 MB<input
              type="file"
              accept="image/png,image/jpeg"
              onchange={fileSelected}
            /></label
          ><label>名称<input bind:value={asset.name} /></label><label
            >情绪与场景标签<input bind:value={asset.tags} /></label
          ><label>图片描述<input bind:value={asset.alt} /></label><label
            >来源与使用说明<input bind:value={asset.source} /></label
          ><button
            disabled={!asset.data || busy}
            onclick={() =>
              action(async () => {
                await api('assets', 'POST', asset);
                asset = {
                  name: '',
                  tags: '',
                  alt: '',
                  mime: 'image/png',
                  data: '',
                  source: '',
                };
                await load();
              }, '素材已保存。')}>批准并保存</button
          >
        </section>
      </div>
    {:else if section === 'tasks'}
      <div class="notice">
        任务只提交行为候选，仍需参与决策、安全检查与协议许可。随机间隔在落盘后不会因重启重新抽取。
      </div>
      <section class="panel table-wrap">
        <table>
          <thead
            ><tr
              ><th>任务</th><th>计划</th><th>下一次</th><th>最近状态</th><th
                >操作</th
              ></tr
            ></thead
          ><tbody
            >{#each items as r}<tr
                ><td
                  >{r.value.spec.name}<br /><span class="badge neutral"
                    >{r.value.spec.enabled ? '已启用' : '已暂停'}</span
                  ></td
                ><td
                  >{r.value.spec.kind}<br /><span class="muted"
                    >{r.value.spec.timezone}</span
                  ></td
                ><td>{time(r.value.nextAt)}</td><td
                  >{r.value.lastStatus ?? '尚未执行'}</td
                ><td
                  ><div class="actions">
                    <button class="secondary tiny" onclick={() => editTask(r)}
                      >编辑</button
                    ><button
                      class="secondary tiny"
                      disabled={busy}
                      onclick={() =>
                        action(
                          () =>
                            api('tasks/run', 'POST', {
                              id: r.value.spec.id,
                              dryRun: true,
                            }),
                          'Dry-run 完成，未发送。',
                        )}>Dry-run</button
                    ><button
                      class="secondary tiny"
                      disabled={busy}
                      onclick={() =>
                        action(
                          () =>
                            api('tasks/run', 'POST', {
                              id: r.value.spec.id,
                              dryRun: false,
                            }),
                          '提案已评估，请查看运行记录。',
                        )}>立即评估</button
                    >
                  </div></td
                ></tr
              >{:else}<tr
                ><td colspan="5" class="empty">创建 cron 或随机间隔任务。</td
                ></tr
              >{/each}</tbody
          >
        </table>
      </section>
    {:else if section === 'system'}
      <div class="columns">
        <section class="panel">
          <h2>运行环境</h2>
          <div class="row">
            <span class="grow muted">数据驱动</span><code
              >{system?.driver ?? '—'}</code
            >
          </div>
          <div class="row">
            <span class="grow muted">日志模式 / schema</span><span
              >{system?.journal ?? '—'} / {system?.schemaVersion ?? '—'}</span
            >
          </div>
          <div class="row">
            <span class="grow muted">Node / 平台</span><span
              >{system?.node ?? '—'} / {system?.platform ?? '—'}</span
            >
          </div>
          <div class="row">
            <span class="grow muted">记录数</span><span
              >{system?.records ?? '—'}</span
            >
          </div>
          <div class="row">
            <span class="grow muted">沙箱 Broker</span><span
              class="badge neutral"
              >{system?.sandboxConfigured ? '已配置' : '待配置'}</span
            >
          </div>
        </section>
        <section class="panel stack">
          <h2>数据维护</h2>
          <p class="muted">
            在线备份写入数据目录，保留事务一致性。加密主密钥需另行保管，恢复后先使用观察模式。
          </p>
          <button
            class="secondary"
            disabled={busy}
            onclick={() =>
              action(async () => {
                const result = await api('backup', 'POST', {});
                notice = `已创建 ${result.name}`;
              }, '在线备份已保存到数据目录。')}>创建数据库备份</button
          ><label
            >聊天保留天数<input
              type="number"
              min="1"
              bind:value={config.retentionDays}
            /></label
          ><button onclick={save}>保存设置</button>
          <p class="footnote">
            每 24
            小时清理到期的聊天、运行记录和调用明细。凭据、素材、任务配置与插件数据不随聊天清理。
          </p>
          <button
            class="secondary"
            disabled={busy}
            onclick={() =>
              action(async () => {
                await api('retention/run', 'POST', {});
                await load();
              }, '到期记录已清理。')}>立即清理到期记录</button
          >
        </section>
      </div>
    {/if}
  {:else if !error}<div class="loading">正在连接本地运行服务…</div>{/if}
  <Dialog.Root bind:open={dialog}
    ><Dialog.Portal
      ><Dialog.Overlay class="dialog-overlay" /><Dialog.Content
        class="dialog-content"
        ><Dialog.Title class="dialog-title"
          >{section === 'tasks' ? '定时行为' : '模型连接'}</Dialog.Title
        ><Dialog.Description class="muted" style="margin:10px 0 22px"
          >{section === 'tasks'
            ? '先预览，再启用。任务不会跳过聊天与安全判断。'
            : '凭据只写入后端，保存后不会回填。'}</Dialog.Description
        >
        {#if section === 'tasks'}<div class="stack">
            <label>名称<input bind:value={task.name} /></label><label
              >会话<select bind:value={task.workspaceId}
                >{#each workspaces as w}<option value={w.value.id}
                    >{w.value.name}</option
                  >{/each}</select
              ></label
            >
            <div class="form-grid">
              <label
                >类型<select bind:value={task.kind}
                  ><option value="random">随机间隔</option><option value="cron"
                    >Cron</option
                  ></select
                ></label
              ><label>时区<input bind:value={task.timezone} /></label>
            </div>
            {#if task.kind === 'cron'}<label
                >Cron 表达式<input bind:value={task.expression} /></label
              >{:else}<div class="form-grid">
                <label
                  >最小间隔（毫秒）<input
                    type="number"
                    min="1000"
                    bind:value={task.minMs}
                  /></label
                ><label
                  >最大间隔（毫秒）<input
                    type="number"
                    min="1000"
                    bind:value={task.maxMs}
                  /></label
                >
              </div>{/if}
            <div class="form-grid">
              <label
                >安静时段开始<input
                  type="time"
                  bind:value={task.quietStart}
                /></label
              ><label
                >安静时段结束<input
                  type="time"
                  bind:value={task.quietEnd}
                /></label
              >
            </div>
            <label>行为意图<textarea bind:value={task.prompt}></textarea></label
            ><label class="check"
              ><input
                type="checkbox"
                bind:checked={task.enabled}
              />启用任务</label
            ><button
              class="secondary"
              onclick={() =>
                action(async () => {
                  future = (await api('tasks/preview', 'POST', task)).times;
                }, '计划已预览，随机任务显示中位间隔示意。')}
              >预览未来时间</button
            >{#if future.length}<pre>{future
                  .map(time)
                  .join('\n')}</pre>{/if}<button
              disabled={busy || !task.workspaceId}
              onclick={() =>
                action(async () => {
                  await api('tasks', 'POST', {
                    spec: task,
                    revision: taskRevision,
                  });
                  dialog = false;
                  await load();
                })}>保存任务</button
            >
          </div>
        {:else}<div class="stack">
            <label
              >提供商<select
                bind:value={connection.provider}
                onchange={providerChanged}
                ><option value="deepseek">DeepSeek</option><option
                  value="typesafe">TypeSafe / Jev</option
                ><option value="openai">OpenAI</option><option value="local"
                  >本地 / 兼容服务</option
                ></select
              ></label
            ><label>名称<input bind:value={connection.name} /></label><label
              >Base URL<input bind:value={connection.baseUrl} /></label
            ><label
              >决策协议<select bind:value={connection.protocol}
                ><option value="chat">文本结构化桥接 / Chat Completions</option
                ><option value="systemone">TypeSafe System One</option><option
                  value="decisions">OpenAI Decisions</option
                ></select
              ></label
            ><label
              >API Key<input
                type="password"
                autocomplete="new-password"
                placeholder={connection.secretRef
                  ? '留空保留已保存凭据'
                  : '可选，本地无鉴权服务可留空'}
                bind:value={secret}
              /></label
            ><button disabled={busy} onclick={saveConnection}>保存连接</button>
          </div>{/if}<Dialog.Close
          class="secondary"
          style="margin-top:14px;width:100%">取消</Dialog.Close
        ></Dialog.Content
      ></Dialog.Portal
    ></Dialog.Root
  >
{/if}
