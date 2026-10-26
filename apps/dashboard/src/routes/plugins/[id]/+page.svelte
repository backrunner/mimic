<script lang="ts">
  import { page } from '$app/state';
  import { adminRegistry } from '#lib/plugins/registry.generated.ts';
  const entry = $derived(adminRegistry[page.params.id ?? '']);
</script>

{#if entry}{@const Component = entry.component}<Component
    {...entry.props}
  />{:else}<h1>插件页面未注册</h1>
  <p class="muted">将受信任的页面加入 mimic.plugins.json 并重新构建。</p>{/if}
