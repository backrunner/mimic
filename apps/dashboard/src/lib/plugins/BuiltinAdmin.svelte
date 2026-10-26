<script lang="ts">
  import AdminPage from '../AdminPage.svelte';
  let { section }: { section: string } = $props();
</script>

<AdminPage {section} />
