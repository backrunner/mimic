import { readFile, writeFile, stat } from 'node:fs/promises';
import { relative, resolve, dirname } from 'node:path';
const manifest = JSON.parse(await readFile('mimic.plugins.json', 'utf8'));
const output = resolve('apps/dashboard/src/lib/plugins/registry.generated.ts');
const ids = new Set();
let imports = '',
  entries = '';
for (const [i, page] of manifest.admin.entries()) {
  if (!/^[a-z][a-z0-9-]{0,80}$/.test(page.id) || ids.has(page.id))
    throw new Error('Invalid or duplicate plugin ID');
  ids.add(page.id);
  const file = resolve(page.entry);
  if (
    !file.startsWith(process.cwd() + '/') ||
    !(await stat(file)).isFile() ||
    !file.endsWith('.svelte')
  )
    throw new Error('Invalid local admin entry');
  const path = relative(dirname(output), file).replaceAll('\\', '/');
  imports += `import Page${i} from ${JSON.stringify(path.startsWith('.') ? path : './' + path)};\n`;
  entries += `${JSON.stringify(page.id)}: { component: Page${i}, props: ${JSON.stringify(page.props ?? {})} },\n`;
}
await writeFile(
  output,
  `// Generated from mimic.plugins.json. Trusted, build-time extensions only.\n${imports}export const adminRegistry: Record<string, { component: any; props: Record<string, any> }> = {\n${entries}};\n`,
);
