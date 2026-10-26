import type {
  Message,
  SafetyProvider,
  Scope,
} from '../../contracts/src/index.js';
import { State, hash } from './state.js';

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
  let remaining = 24000;
  const candidates = rows
    .map((r) => r.value)
    .filter((m) => m.kind !== 'deleted')
    .reverse()
    .filter((m) => {
      const size = m.text.length + (m.quote?.text.length ?? 0);
      if (size > remaining) return false;
      remaining -= size;
      return true;
    })
    .reverse();
  const signatures = new Map(
    candidates.map((m) => [
      m.id,
      hash([m.revision, m.text, m.quote, state.revision, safety.id]),
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
      { text: current.text, quote: current.quote },
      scope,
    );
    if (verdict.reason === 'safety_unavailable')
      return { messages: [], ...verdict };
    await store([current], verdict.allow);
  }
  if (!known(current))
    return { messages: [], allow: false, reason: 'input_denied' };
  const pending = candidates.filter(
    (m) => !(m.bot && m.actorId === 'bot') && known(m) === undefined,
  );
  if (pending.length) {
    const verdict = await safety.check(
      'input.history',
      pending.map((m) => ({ id: m.id, text: m.text, quote: m.quote })),
      scope,
    );
    if (verdict.reason === 'safety_unavailable')
      return { messages: [], ...verdict };
    await store(pending, verdict.allow);
  }
  let budget = 24000;
  const messages = candidates
    .filter((m) => (m.bot && m.actorId === 'bot') || known(m))
    .reverse()
    .filter((m) => {
      const size = m.text.length + (m.quote?.text.length ?? 0);
      if (size > budget) return false;
      budget -= size;
      return true;
    })
    .reverse();
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
