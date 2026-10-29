import { afterEach, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';
import { z } from 'zod';
import { fixture, fakeFetch, message } from './helpers.js';
import {
  installPlugins,
  type MimicPlugin,
} from '../packages/plugin-sdk/src/host.js';
import { catalog } from '../packages/plugin-sdk/src/catalog.js';
import { availableTools } from '../packages/core/src/tools.js';
import type { Run, Usage } from '../packages/contracts/src/index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('keeps all framework packages independent of concrete plugin implementations', async () => {
  for (const path of await readdir('packages', { recursive: true })) {
    if (!path.endsWith('.ts')) continue;
    const source = ts.createSourceFile(
      path,
      await readFile('packages/' + path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteral(node.arguments[0])
      )
        imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(
      imports.filter((value) => /(^|\/)plugins\//.test(value)),
      path,
    ).toEqual([]);
  }
  const engine = await readFile('packages/core/src/engine.ts', 'utf8');
  expect(engine).not.toMatch(
    /web_search|web_fetch|stickers_search|safety-decisions/,
  );
  const safety = await readFile(
    'plugins/safety-decisions/src/index.ts',
    'utf8',
  );
  expect(safety).not.toMatch(/packages\/(core|ai-runtime)\//);
});

it.each(['systemone', 'decisions', 'chat'] as const)(
  'routes default safety through an independent %s decision connection and the unified credential/usage runtime',
  async (protocol) => {
    const seen: { url: string; authorization: string | null; body: any }[] = [];
    const app = await fixture(async (input, init) => {
      const url = String(input),
        body = JSON.parse(String(init?.body));
      seen.push({
        url,
        body,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      if (url.startsWith('https://decisions.example')) {
        if (protocol === 'systemone') return fakeFetch(input, init);
        const answers = { harm: false, private: false, injection: false };
        return Response.json({
          model: 'fixture-safety',
          ...(protocol === 'decisions'
            ? {
                answers: Object.keys(answers).map((name) => ({
                  name,
                  type: 'predicate',
                  probability: 0.01,
                })),
              }
            : { choices: [{ message: { content: JSON.stringify(answers) } }] }),
          usage: { input_tokens: 20, output_tokens: 5 },
        });
      }
      return fakeFetch(input, init);
    });
    cleanups.push(app.cleanup);
    const secretRef = await app.state.setSecret(
      'decision-fixture',
      'fixture-decision-key',
    );
    await app.state.save(
      {
        ...app.state.config,
        connections: [
          ...app.state.config.connections,
          {
            id: 'decision-only',
            name: 'Safety decisions',
            provider: 'local',
            baseUrl: 'https://decisions.example',
            protocol,
            secretRef,
            enabled: true,
          },
        ],
        routes: {
          ...app.state.config.routes,
          safety: { connectionId: 'decision-only', model: 'safety-only' },
        },
      },
      app.state.revision,
    );
    const trigger = message();
    await app.engine.ingest(trigger, { schedule: false });
    await app.engine.start(trigger);
    expect((await app.db.list<Run>('run'))[0]!.value.status).toBe('shadow');
    const usage = (await app.db.list<Usage>('usage')).map((row) => row.value);
    const safety = usage.filter((row) => row.role === 'safety');
    expect(safety).toHaveLength(2);
    expect(
      safety.every(
        (row) =>
          row.connectionId === 'decision-only' &&
          row.pluginId === 'safety-decisions' &&
          row.status === 'reported',
      ),
    ).toBe(true);
    expect(
      usage
        .filter((row) => row.role !== 'safety')
        .every((row) => row.connectionId === 'fixture'),
    ).toBe(true);
    const requests = seen.filter((row) =>
      row.url.startsWith('https://decisions.example'),
    );
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (row) => row.authorization === 'Bearer fixture-decision-key',
      ),
    ).toBe(true);
    expect(
      requests.every(
        (row) => !JSON.stringify(row.body).includes('fixture-decision-key'),
      ),
    ).toBe(true);
  },
);

it('allows an SDK safety plugin to use decisions without exposing runtime state, credentials or storage handles', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  const contexts: any[] = [];
  const plugin: MimicPlugin = {
    manifest: {
      id: 'safety-custom',
      name: 'Custom decision policy',
      kind: 'safety',
      version: '1',
      permissions: ['ai.safety'],
      dependencies: [],
      admin: 'safety-custom',
      trust: 'trustedInProcess',
    },
    setup(registrar) {
      registrar.safety({
        id: 'policy-name-cannot-spoof-manifest',
        async check(stage, subject, context) {
          contexts.push(context);
          const answers = await context.ai.decide(
            'safety',
            { stage, subject },
            [
              {
                name: 'harm',
                type: 'predicate',
                instructions: 'Does this cause harm?',
              },
            ],
          );
          return {
            allow: (answers.harm!.probability ?? 1) < context.policy.threshold,
            reason: 'custom_policy',
          };
        },
      });
    },
  };
  await installPlugins([plugin], app, catalog);
  await app.state.save(
    { ...app.state.config, disabledPlugins: ['safety-decisions'] },
    app.state.revision,
  );
  expect(app.engine.safety.id).toBe('safety-custom');
  expect(
    availableTools(app.state, app.engine.tools, app.engine.safety).some(
      (tool) => tool.effect === 'network',
    ),
  ).toBe(true);
  const trigger = message();
  await app.engine.ingest(trigger, { schedule: false });
  await app.engine.start(trigger);
  expect((await app.db.list<Run>('run'))[0]!.value.status).toBe('shadow');
  expect(contexts.length).toBeGreaterThan(0);
  for (const context of contexts) {
    expect(context.scope.workspaceId).toBe('group-a');
    expect(context.scope.pluginId).toBe('safety-custom');
    expect(Object.isFrozen(context.scope)).toBe(true);
    expect(Object.isFrozen(context.policy)).toBe(true);
    for (const key of ['state', 'db', 'secret', 'credentials', 'fetcher'])
      expect(context).not.toHaveProperty(key);
    expect(context.ai).not.toHaveProperty('request');
  }
  expect(
    (await app.db.list<Usage>('usage'))
      .filter((row) => row.value.role === 'safety')
      .every((row) => row.value.pluginId === 'safety-custom'),
  ).toBe(true);
  const before = (await app.db.list('usage')).length;
  await app.state.save(
    { ...app.state.config, disabledPlugins: ['safety-custom'] },
    app.state.revision,
  );
  expect(
    availableTools(app.state, app.engine.tools, app.engine.safety).every(
      (tool) => tool.effect === 'read',
    ),
  ).toBe(true);
  expect(
    await app.engine.safety.check(
      'input.pre',
      {},
      {
        workspaceId: 'group-a',
        runId: 'disabled',
        pluginId: 'core',
        signal: AbortSignal.timeout(1000),
      },
    ),
  ).toMatchObject({ allow: false, reason: 'safety_plugin_disabled' });
  expect(await app.db.list('usage')).toHaveLength(before);
});

it('denies an undeclared decision role from a safety plugin before any provider dispatch', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  await installPlugins(
    [
      {
        manifest: {
          id: 'safety-no-permission',
          name: 'Unprivileged',
          kind: 'safety',
          version: '1',
          permissions: [],
          dependencies: [],
          admin: 'safety-no-permission',
          trust: 'trustedInProcess',
        },
        setup(registrar) {
          registrar.safety({
            id: 'ignored',
            async check(_stage, subject, context) {
              await context.ai.decide('safety', subject, []);
              return { allow: true, reason: 'unreachable' };
            },
          });
        },
      },
    ],
    app,
    catalog,
  );
  const trigger = message();
  await app.engine.ingest(trigger, { schedule: false });
  await app.engine.start(trigger);
  expect((await app.db.list<Run>('run'))[0]!.value).toMatchObject({
    status: 'failed',
    reason: 'plugin_permission_denied',
  });
  expect(await app.db.list('usage')).toHaveLength(0);
  expect(await app.db.list('send')).toHaveLength(0);
});

it('enforces host cancellation even when a safety plugin ignores its signal', async () => {
  const app = await fixture();
  cleanups.push(app.cleanup);
  await installPlugins(
    [
      {
        manifest: {
          id: 'safety-stalled',
          name: 'Stalled',
          kind: 'safety',
          version: '1',
          permissions: [],
          dependencies: [],
          admin: 'safety-stalled',
          trust: 'trustedInProcess',
        },
        setup(registrar) {
          registrar.safety({
            id: 'ignored',
            async check() {
              return new Promise(() => {});
            },
          });
        },
      },
    ],
    app,
    catalog,
  );
  const abort = new AbortController();
  const checking = app.engine.safety.check(
    'input.pre',
    {},
    {
      workspaceId: 'group-a',
      runId: 'cancelled',
      pluginId: 'core',
      signal: abort.signal,
    },
  );
  abort.abort();
  await expect(checking).rejects.toThrow('safety_cancelled');
  expect(await app.db.list('usage')).toHaveLength(0);
});

it.each([false, true])(
  'runs plugin-specific authorization and projection through a generic core tool pipeline (redacted=%s)',
  async (redacted) => {
    let chats = 0;
    const requests: string[] = [];
    const app = await fixture(async (input, init) => {
      if (String(input).endsWith('/chat/completions')) {
        chats++;
        requests.push(String(init?.body));
        if (chats < 3)
          return Response.json({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'custom-' + chats,
                      type: 'function',
                      function: {
                        name: chats === 1 ? 'source_lookup' : 'source_use',
                        arguments: '{}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          });
      }
      return fakeFetch(input, init);
    });
    cleanups.push(app.cleanup);
    let authorized = false;
    await installPlugins(
      [
        {
          manifest: {
            id: 'tool-custom-source',
            name: 'Custom source',
            kind: 'tool',
            version: '1',
            permissions: [],
            dependencies: [],
            admin: 'tool-custom-source',
            trust: 'trustedInProcess',
          },
          setup(registrar) {
            for (const name of ['source_lookup', 'source_use'])
              registrar.tool({
                name,
                effect: 'read',
                schema: z.object({}).strict(),
                definition: {
                  type: 'function',
                  function: {
                    name,
                    description: name,
                    parameters: { type: 'object', properties: {} },
                  },
                },
                async authorize(_input, context) {
                  expect(context.request.text).toBe('看看资料再帮我解释');
                  if (name === 'source_use') {
                    expect(context.results).toEqual([
                      {
                        name: 'source_lookup',
                        result: redacted ? null : { note: 'visible evidence' },
                      },
                    ]);
                    authorized = true;
                  }
                },
                projectResult: (value) =>
                  redacted
                    ? null
                    : {
                        note: (value as { note: string }).note,
                      },
                async execute() {
                  return {
                    note: 'visible evidence',
                    internalTransportMetadata: 'HIDDEN_PROVIDER_METADATA',
                  };
                },
              });
          },
        },
      ],
      app,
      catalog,
    );
    const trigger = message({ text: '看看资料再帮我解释' });
    await app.engine.ingest(trigger, { schedule: false });
    await app.engine.start(trigger);
    expect(authorized).toBe(true);
    expect(chats).toBe(3);
    expect(requests.join()).not.toContain('HIDDEN_PROVIDER_METADATA');
    expect((await app.db.list<Run>('run'))[0]!.value.status).toBe('shadow');
  },
);
