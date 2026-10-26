import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/daemon/src/app.js';
import type { Message, Config } from '../packages/contracts/src/index.js';
export const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input),
    body = JSON.parse(String(init?.body));
  if (url.endsWith('/systemone')) {
    const values: Record<string, string> = {
      addressed: 'direct',
      interest: 'high',
      contribution: 'information',
      tone: 'professional',
      timing: 'now',
      topic: 'new',
      style: 'mixed',
    };
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([name, q]) => {
        const question = q as {
          type: string;
          criteria?: Record<string, string>;
        };
        return [
          name,
          question.type === 'noul'
            ? {
                type: 'noul',
                noul: name === 'referent' || name === 'greeting' ? 0.99 : 0.01,
              }
            : {
                type: 'choice',
                choice: values[name] ?? Object.keys(question.criteria ?? {})[0],
                probabilities: Object.fromEntries(
                  Object.keys(question.criteria ?? {}).map((k) => [
                    k,
                    k === values[name] ? 1 : 0,
                  ]),
                ),
              },
        ];
      }),
    );
    return Response.json({
      model: 'fixture-decision',
      answers,
      usage: { input_tokens: 80, output_tokens: 12 },
    });
  }
  if (url.endsWith('/chat/completions'))
    return Response.json({
      model: 'fixture-chat',
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              action: 'reply',
              text: '先检查事务有没有及时提交，再确认是否有长时间占用写锁的连接。',
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    });
  throw new Error('unexpected_fixture_request');
};
export function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    sourceId: 'source1',
    workspaceId: 'group-a',
    connectionId: 'replay',
    actorId: 'a',
    actorName: '小林',
    text: '数据库写入为什么 busy？',
    kind: 'created',
    revision: 1,
    occurredAt: Date.now(),
    receivedAt: Date.now(),
    bot: false,
    direct: false,
    mentions: ['bot'],
    attachments: [],
    ...overrides,
  };
}
export async function fixture(fetcher: typeof fetch = fakeFetch) {
  const dir = await mkdtemp(join(tmpdir(), 'mimic-test-'));
  const app = await createApp(dir, {
    fetcher,
    internalToken: 'test-internal-token',
  });
  const config: Config = {
    ...app.state.config,
    mode: 'shadow',
    connections: [
      {
        id: 'fixture',
        name: 'Fixture',
        provider: 'local',
        baseUrl: 'http://127.0.0.1:9999',
        protocol: 'systemone',
        secretRef: '',
        enabled: true,
      },
    ],
    routes: Object.fromEntries(
      ['chat', 'participation', 'atmosphere', 'safety'].map((role) => [
        role,
        { connectionId: 'fixture', model: 'fixture' },
      ]),
    ),
    behavior: { ...app.state.config.behavior, debounceMs: 0 },
    budgets: { ...app.state.config.budgets, runTimeoutMs: 5000 },
  };
  await app.state.save(config, app.state.revision);
  return {
    ...app,
    dir,
    async cleanup() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
