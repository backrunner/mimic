import type {
  Message,
  SafetyProvider,
  Scope,
} from '../../contracts/src/index.js';
import { State, hash } from './state.js';
import { selectMessages, conversationMessage } from './prompt.js';

/** Verdicts are revision-bound. Denied history is never returned to decision/text models. */
export async function screenedContext(
  state: State,
  safety: SafetyProvider,
  trigger: Message,
  scope: Scope,
) {
  const rows = (
    await state.db.list<Message>('message', scope.workspaceId, 60)
  ).reverse();
  const selected = selectMessages(
    rows.map((r) => r.value).filter((m) => m.kind !== 'deleted'),
    trigger,
    state.config.context.historyMessages,
    state.config.context.historyChars,
  );
  // Safety sees full source text, even where the conversational view is clipped.
  // Bound that workload too, while always reserving the current message first.
  let screeningChars = 32000;
  const included = new Set<string>();
  for (const message of [
    ...selected.filter((m) => m.id === trigger.id),
    ...selected.toReversed().filter((m) => m.id !== trigger.id),
  ]) {
    const size = JSON.stringify({
      ...conversationMessage(message),
      text: message.text,
      quote: message.quote,
    }).length;
    if (size > screeningChars) {
      if (message.id === trigger.id) throw new Error('input_budget_exceeded');
      continue;
    }
    screeningChars -= size;
    included.add(message.id);
  }
  const candidates = selected.filter((m) => included.has(m.id));
  const signatures = new Map(
    candidates.map((m) => [
      m.id,
      hash(['context-v2', m, state.revision, safety.id]),
    ]),
  );
  const policyRows = await Promise.all(
    candidates.map((m) =>
      state.db.get<{ signature: string; allow: boolean }>(
        `message-policy:${scope.workspaceId}:${m.id}`,
      ),
    ),
  );
  const policies = new Map(
    policyRows.filter((r) => r !== undefined).map((r) => [r.key, r]),
  );
  const known = (m: Message) => {
    const p = policies.get(
      `message-policy:${scope.workspaceId}:${m.id}`,
    )?.value;
    return p && p.signature === signatures.get(m.id) ? p.allow : undefined;
  };
  const store = async (messages: Message[], allow: boolean) => {
    scope.signal.throwIfAborted();
    await state.db.commit(
      messages.map((m) => {
        const key = `message-policy:${scope.workspaceId}:${m.id}`;
        return {
          key,
          kind: 'message-policy',
          scope: scope.workspaceId,
          value: { signature: signatures.get(m.id), allow },
          expected: policies.get(key)?.revision ?? null,
        };
      }),
    );
    for (const m of messages) {
      policies.set(`message-policy:${scope.workspaceId}:${m.id}`, {
        key: '',
        kind: '',
        scope: '',
        at: Date.now(),
        revision: 0,
        value: { signature: signatures.get(m.id)!, allow },
      });
    }
  };
  const current = candidates.find((m) => m.id === trigger.id);
  if (!current)
    return { messages: [], allow: false, reason: 'trigger_deleted' };
  if (known(current) === undefined) {
    const verdict = await safety.check(
      'input.pre',
      {
        ...conversationMessage(current),
        text: current.text,
        quote: current.quote,
      },
      scope,
    );
    if (verdict.reason === 'safety_unavailable')
      return { messages: [], ...verdict };
    await store([current], verdict.allow);
  }
  if (!known(current))
    return { messages: [], allow: false, reason: 'input_denied' };
  const pending = candidates.filter((m) => known(m) === undefined);
  if (pending.length) {
    const verdict = await safety.check(
      'input.history',
      pending.map((m) => ({
        ...conversationMessage(m),
        text: m.text,
        quote: m.quote,
      })),
      scope,
    );
    if (verdict.reason === 'safety_unavailable')
      return { messages: [], ...verdict };
    await store(pending, verdict.allow);
  }
  const messages = candidates.filter((m) => known(m));
  const byReference = new Map(
    messages
      .filter((m) => m.protocol?.referenceId)
      .map((m) => [m.protocol!.referenceId, m.id]),
  );
  return {
    allow: true,
    reason: 'context_screened',
    messages: messages.map((m) => ({
      ...m,
      replyTo: m.replyTo
        ? (byReference.get(m.replyTo) ?? m.replyTo)
        : undefined,
    })),
  };
}

export async function invalidateDerived(state: State, workspaceId: string) {
  for (const kind of ['group-profile', 'topic', 'frame'])
    for (const row of await state.db.list(kind, workspaceId, 1000))
      await state.db.delete(row.key, row.revision);
}
