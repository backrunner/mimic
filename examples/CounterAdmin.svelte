<script lang="ts">
  import { onMount } from 'svelte';
  let enabled = $state(true),
    revision = $state<number | null>(null),
    notice = $state('');
  const endpoint = '/api/plugins/tool-counter/config/settings';
  onMount(() => {
    void fetch(endpoint)
      .then((r) => r.json())
      .then(({ record }) => {
        enabled = record?.value.enabled ?? true;
        revision = record?.revision ?? null;
      });
  });
  async function save() {
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: { enabled }, revision }),
    });
    const result = await response.json();
    if (!response.ok) {
      notice = result.error;
      return;
    }
    revision = result.record.revision;
    notice = '已保存';
  }
</script>

<h1>示例计数工具</h1>
<section class="panel stack">
  <p>工具数据由核心按会话隔离，设置通过统一管理 API 保存。</p>
  <label class="check"
    ><input type="checkbox" bind:checked={enabled} />允许计数</label
  ><button onclick={save}>保存</button>
  <p role="status">{notice}</p>
</section>
