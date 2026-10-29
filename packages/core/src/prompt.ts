import type { Message, MemoryItem } from '../../contracts/src/index.js';

function clip(text: string, limit: number) {
  return text.length <= limit ? text : text.slice(0, limit) + '…[truncated]';
}

/** Only these fields enter models; transport metadata and attachment URLs stay out. */
export function conversationMessage(message: Message) {
  return {
    id: message.id,
    speaker: message.actorId,
    name: message.actorName,
    text: clip(message.text, 2000),
    at: message.occurredAt,
    ...(message.bot ? { bot: true } : {}),
    ...(message.mentions.includes('bot') ? { addressed: true } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.quote
      ? { quote: { ...message.quote, text: clip(message.quote.text, 600) } }
      : {}),
    ...(message.attachments.length
      ? { unparsedMedia: message.attachments.length }
      : {}),
  };
}

/** Pin the trigger and its reply chain, then fill with the newest turns. */
export function selectMessages(
  messages: Message[],
  trigger: Message,
  maxMessages: number,
  maxChars: number,
) {
  const current = messages.find((m) => m.id === trigger.id);
  if (!current) return [];
  if (JSON.stringify(conversationMessage(current)).length + 2 > maxChars)
    throw new Error('context_trigger_too_large');
  const priority = [current];
  let child = current;
  for (let depth = 0; depth < 2; depth++) {
    const parent = messages.find(
      (m) =>
        (child.replyTo &&
          (m.id === child.replyTo ||
            m.protocol?.referenceId === child.replyTo)) ||
        (child.quote?.sourceId && m.sourceId === child.quote.sourceId),
    );
    if (!parent || priority.includes(parent)) break;
    priority.push(parent);
    child = parent;
  }
  priority.push(...messages.toReversed());
  const selected = new Set<string>();
  let remaining = maxChars - 2;
  for (const message of priority) {
    if (selected.has(message.id)) continue;
    const cost =
      JSON.stringify(conversationMessage(message)).length +
      (selected.size ? 1 : 0);
    if (cost > remaining || selected.size >= maxMessages) continue;
    selected.add(message.id);
    remaining -= cost;
  }
  return messages.filter((m) => selected.has(m.id));
}

export function memoryEvidence(item: MemoryItem) {
  return {
    id: item.id,
    content: item.content,
    sourceIds: item.sourceIds,
    actorIds: item.actorIds,
  };
}

export function selectMemories(
  items: MemoryItem[],
  maxItems: number,
  maxChars: number,
) {
  const selected: MemoryItem[] = [];
  const seen = new Set<string>();
  let remaining = maxChars - 2;
  for (const item of items) {
    if (!item.content.trim() || !item.sourceIds.length || seen.has(item.id))
      continue;
    const cost =
      JSON.stringify(memoryEvidence(item)).length + (selected.length ? 1 : 0);
    if (cost > remaining) continue;
    selected.push(item);
    seen.add(item.id);
    remaining -= cost;
    if (selected.length >= maxItems) break;
  }
  return selected;
}

/** Budget includes JSON escaping; oversized results are explicitly incomplete evidence. */
export function toolEvidence(value: unknown, maxChars: number) {
  const serialized = JSON.stringify({ untrusted: true, result: value });
  if (serialized.length <= maxChars) return serialized;
  let low = 0,
    high = maxChars;
  const wrap = (length: number) =>
    JSON.stringify({
      untrusted: true,
      truncated: true,
      content: serialized.slice(0, length),
    });
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (wrap(mid).length <= maxChars) low = mid;
    else high = mid - 1;
  }
  return wrap(low);
}
