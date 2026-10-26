import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { uid } from '../packages/core/src/state.js';
const flags = process.argv.slice(2),
  file =
    flags.find((x) => !x.startsWith('--')) ??
    'tests/fixtures/conversation-scenarios.jsonl';
const schema = z.object({
  id: z.string(),
  messages: z.array(
    z.object({
      id: z.string(),
      actor: z.string(),
      text: z.string(),
      mentions: z.array(z.string()).optional(),
    }),
  ),
  expected: z.unknown(),
});
const cases = (await readFile(file, 'utf8'))
  .trim()
  .split('\n')
  .map((line) => schema.parse(JSON.parse(line)));
if (!flags.includes('--run')) {
  process.stdout.write(
    JSON.stringify(
      {
        cases: cases.length,
        mode: 'validate_only',
        note: 'Use --run with a configured local daemon for billable model calls. Results remain shadow.',
      },
      null,
      2,
    ) + '\n',
  );
} else {
  const base = process.env.MIMIC_API_URL ?? 'http://127.0.0.1:3212',
    token =
      process.env.MIMIC_INTERNAL_TOKEN ??
      (
        await readFile(
          resolve(process.env.MIMIC_DATA_DIR ?? 'data', 'control.token'),
          'utf8',
        )
      ).trim();
  const headers = {
    authorization: 'Bearer ' + token,
    'content-type': 'application/json',
  };
  const c = await fetch(base + '/api/config', { headers });
  if (!c.ok) throw new Error('daemon_unavailable');
  const config = (await c.json()).config;
  if (config.mode !== 'shadow') throw new Error('replay_requires_shadow_mode');
  const results = [];
  for (const scenario of cases) {
    if (!scenario.messages.length) {
      results.push({ id: scenario.id, skipped: 'non_text_fixture' });
      continue;
    }
    const workspace = 'eval-' + uid() + '-' + scenario.id;
    for (const m of scenario.messages) {
      const r = await fetch(base + '/api/replay', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workspace,
          actor: m.actor,
          text: m.text,
          mention: m.mentions?.includes('bot') ?? false,
        }),
      });
      if (!r.ok) throw new Error('replay_ingest_failed');
    }
    await new Promise((r) => setTimeout(r, config.behavior.debounceMs + 100));
    let runs: any[] = [];
    for (let i = 0; i < 130; i++) {
      const r = await fetch(
        base + '/api/runs?scope=' + encodeURIComponent('replay:' + workspace),
        { headers },
      );
      runs = (await r.json()).items;
      if (runs[0]?.value.endedAt) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    results.push({
      id: scenario.id,
      expected: scenario.expected,
      runs: runs.map((r) => r.value),
      requiresHumanReview: true,
    });
    process.stdout.write('Recorded ' + scenario.id + '\n');
  }
  await mkdir('.artifacts', { recursive: true });
  await writeFile(
    '.artifacts/replay-' + Date.now() + '.json',
    JSON.stringify(
      {
        mode: 'shadow',
        results,
        limitations:
          'Text/mention replay only. Source IDs, edits, quotes and visibility-specific cases require integration fixtures. Proactive participation remains gated by the current configuration. This is not an automatic humanlikeness score.',
      },
      null,
      2,
    ),
  );
}
