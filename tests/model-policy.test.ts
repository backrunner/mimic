import { expect, it } from 'vitest';
import { builtinModelProviders } from '../plugins/models/src/index.js';
import {
  chooseParticipation,
  participationQuestions,
} from '../packages/core/src/decisions.js';
import {
  configSchema,
  type Answers,
  type Workspace,
} from '../packages/contracts/src/index.js';
import { message } from './helpers.js';
it('OpenAI decision arrays preserve probabilities and reject mismatched choices', () => {
  const driver = builtinModelProviders.find((p) => p.id === 'openai')!;
  const q = [
    {
      name: 'interest',
      type: 'choice' as const,
      instructions: 'interest?',
      choices: { high: 'yes', low: 'no' },
    },
  ];
  const options = { model: 'fixture', protocol: 'decisions' };
  const answers = driver.decision!.decode(
    {
      answers: [
        {
          type: 'choice',
          name: 'interest',
          choice: 'high',
          probabilities: [
            { value: 'high', probability: 0.8 },
            { value: 'low', probability: 0.2 },
          ],
        },
      ],
    },
    q,
    options,
  );
  expect(answers.interest?.probabilities?.high).toBe(0.8);
  expect(() =>
    driver.decision!.decode(
      {
        answers: [
          {
            name: 'interest',
            choice: 'high',
            probabilities: [{ value: 'different', probability: 1 }],
          },
        ],
      },
      q,
      options,
    ),
  ).toThrow('invalid_distribution');
});
it('native uncertainty, coverage and soul relevance gate unsolicited participation', () => {
  const values: Record<string, string | boolean> = {
    addressed: 'open',
    interest: 'high',
    contribution: 'information',
    interrupts: false,
    resolved: false,
    referent: true,
    tone: 'professional',
    timing: 'now',
  };
  const answers: Answers = Object.fromEntries(
    participationQuestions.map((q) => [
      q.name,
      {
        type: q.type,
        value: values[q.name]!,
        uncertainty: 'native',
        ...(q.type === 'predicate'
          ? { probability: values[q.name]?.valueOf() === true ? 0.99 : 0.01 }
          : {
              probabilities: Object.fromEntries(
                Object.keys(q.choices!).map((k) => [
                  k,
                  k === values[q.name] ? 1 : 0,
                ]),
              ),
            }),
      },
    ]),
  );
  const config = configSchema.parse({
      behavior: { proactiveCalibrated: true },
    }),
    ws: Workspace = {
      id: 'group-a',
      name: 'test',
      connectionId: 'replay',
      kind: 'group',
      revision: 1,
      receive: 'all_messages',
      paused: false,
      proactive: true,
      lastSentAt: 0,
      lastObservedAt: 0,
    };
  const m = message({ mentions: [] });
  expect(chooseParticipation(answers, m, ws, config).action).toBe('reply');
  expect(
    chooseParticipation(answers, m, { ...ws, receive: 'mentions_only' }, config)
      .reason,
  ).toBe('partial_visibility');
  expect(
    chooseParticipation(
      { ...answers, referent: { ...answers.referent!, probability: 0.51 } },
      m,
      ws,
      config,
    ).reason,
  ).toBe('uncertain_context');
  expect(
    chooseParticipation(
      {
        ...answers,
        interest: { ...answers.interest!, value: 'low' },
        contribution: { ...answers.contribution!, value: 'none' },
      },
      message(),
      ws,
      config,
    ).reason,
  ).toBe('not_interested');
});
