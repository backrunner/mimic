<script lang="ts">
  let { size = 48 }: { size?: number } = $props();
</script>

<img
  class="brand-icon"
  src="/brand/mimic-avatar.png"
  alt=""
  width={size}
  height={size}
/>
