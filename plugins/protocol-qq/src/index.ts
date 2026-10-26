import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';
import type {
  Message,
  SendAction,
  Delivery,
  ProtocolAdapter,
} from '../../../packages/contracts/src/index.js';
import { State, hash } from '../../../packages/core/src/state.js';
import { limitedJson } from '../../../packages/ai-runtime/src/index.js';
function privateKey(secret: string) {
  if (!secret) throw new Error('qq_secret_missing');
  let seed = secret;
  while (Buffer.byteLength(seed) < 32) seed += secret;
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(seed).subarray(0, 32),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
}
export function verifyQQ(
  secret: string,
  timestamp: string,
  body: Buffer,
  signature: string,
  now = Date.now(),
) {
  if (
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^[a-f0-9]{128}$/i.test(signature)
  )
    return false;
  return verify(
    null,
    Buffer.concat([Buffer.from(timestamp), body]),
    createPublicKey(privateKey(secret)),
    Buffer.from(signature, 'hex'),
  );
}
export function qqChallenge(secret: string, plain: string, timestamp: string) {
  return {
    plain_token: plain,
    signature: sign(
      null,
      Buffer.from(timestamp + plain),
      privateKey(secret),
    ).toString('hex'),
  };
}
const envelope = z.object({
  t: z.string(),
  id: z.string().optional(),
  d: z.object({
    id: z.string(),
    content: z.string().default(''),
    timestamp: z.string(),
    group_openid: z.string().optional(),
    author: z.object({
      id: z.string().optional(),
      member_openid: z.string().optional(),
      user_openid: z.string().optional(),
      username: z.string().optional(),
      bot: z.boolean().optional(),
    }),
    mentions: z
      .array(
        z.object({
          id: z.string().optional(),
          member_openid: z.string().optional(),
        }),
      )
      .default([]),
    message_scene: z.object({ ext: z.array(z.string()).optional() }).optional(),
    attachments: z
      .array(
        z.object({
          url: z.string(),
          content_type: z.string().default('unknown'),
        }),
      )
      .default([]),
  }),
});
export function normalizeQQ(
  payload: unknown,
  appId: string,
  now = Date.now(),
): Message | undefined {
  const e = envelope.parse(payload);
  if (
    ![
      'GROUP_MESSAGE_CREATE',
      'GROUP_AT_MESSAGE_CREATE',
      'C2C_MESSAGE_CREATE',
    ].includes(e.t)
  )
    return;
  const d = e.d,
    group = d.group_openid,
    person = d.author.member_openid ?? d.author.user_openid ?? d.author.id;
  if (!person) throw new Error('qq_actor_missing');
  const ws = `qq:${appId}:${group ? 'g:' + group : 'u:' + person}`;
  const occurredAt = Date.parse(d.timestamp);
  if (!Number.isFinite(occurredAt)) throw new Error('qq_invalid_time');
  const ext = Object.fromEntries(
    (d.message_scene?.ext ?? []).map((v) => {
      const i = v.indexOf('=');
      return [v.slice(0, i), v.slice(i + 1)];
    }),
  );
  return {
    id: hash([ws, d.id]).slice(0, 32),
    sourceId: d.id,
    connectionId: 'qq',
    workspaceId: ws,
    actorId: hash([ws, person]).slice(0, 24),
    actorName: d.author.username ?? person.slice(0, 8),
    text: d.content,
    kind: 'created',
    revision: 1,
    occurredAt,
    receivedAt: now,
    bot: d.author.bot ?? false,
    direct: !group,
    mentions: [
      ...(e.t === 'GROUP_AT_MESSAGE_CREATE' ? ['bot'] : []),
      ...d.mentions.map((m) =>
        hash([ws, m.member_openid ?? m.id]).slice(0, 24),
      ),
    ],
    replyTo: ext.ref_msg_idx,
    attachments: d.attachments.map((a) => ({
      type: a.content_type,
      url: a.url,
    })),
    protocol: {
      groupId: group,
      userId: group ? undefined : person,
      replyId: d.id,
      referenceId: ext.msg_idx,
    },
  };
}
export class QQAdapter implements ProtocolAdapter {
  id = 'qq';
  #token?: { value: string; expires: number };
  #refresh?: Promise<string>;
  constructor(
    readonly state: State,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  coverage(
    workspace: import('../../../packages/contracts/src/index.js').Workspace,
  ) {
    return workspace.kind === 'direct'
      ? ('direct_only' as const)
      : this.state.config.qq.receive;
  }
  async #access() {
    if (this.#token && this.#token.expires > Date.now() + 60000)
      return this.#token.value;
    if (this.#refresh) return this.#refresh;
    this.#refresh = (async () => {
      const q = this.state.config.qq;
      const response = await this.fetcher(
        'https://bots.qq.com/app/getAppAccessToken',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: q.appId,
            clientSecret: await this.state.secret(q.secretRef),
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error(`qq_token_${response.status}`);
      const result = z
        .object({
          access_token: z.string(),
          expires_in: z.union([z.string(), z.number()]),
        })
        .parse(await limitedJson(response));
      this.#token = {
        value: result.access_token,
        expires: Date.now() + Number(result.expires_in) * 1000,
      };
      return result.access_token;
    })().finally(() => {
      this.#refresh = undefined;
    });
    return this.#refresh;
  }
  reset() {
    this.#token = undefined;
  }
  async send(action: SendAction, signal: AbortSignal): Promise<Delivery> {
    const config = this.state.config;
    if (!config.qq.enabled || config.disabledPlugins.includes('protocol-qq'))
      return { status: 'failed', code: 'qq_disabled' };
    if (Date.now() >= action.expiresAt)
      return { status: 'failed', code: 'reply_expired' };
    if (action.proactive && !config.qq.proactive)
      return { status: 'failed', code: 'proactive_not_authorized' };
    const p = action.trigger.protocol,
      group = p?.groupId,
      target = group
        ? `groups/${encodeURIComponent(group)}`
        : p?.userId
          ? `users/${encodeURIComponent(p.userId)}`
          : undefined;
    if (!target) return { status: 'failed', code: 'qq_target_missing' };
    let token: string;
    try {
      token = await this.#access();
    } catch {
      return { status: 'failed', code: 'qq_auth_unavailable' };
    }
    const headers = {
      'content-type': 'application/json',
      authorization: `QQBot ${token}`,
      'X-Union-Appid': config.qq.appId,
    };
    let media: { file_info: string } | undefined;
    if (action.assetId) {
      const asset = await this.state.asset(action.assetId);
      if (!asset) return { status: 'failed', code: 'asset_missing' };
      try {
        const upload = await this.fetcher(
          `https://api.sgroup.qq.com/v2/${target}/files`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              file_type: 1,
              file_name: asset.name,
              file_data: asset.data,
              srv_send_msg: false,
            }),
            signal,
          },
        );
        if (!upload.ok)
          return { status: 'failed', code: `qq_upload_${upload.status}` };
        media = z
          .object({ file_info: z.string() })
          .parse(await limitedJson(upload));
      } catch {
        return { status: 'failed', code: 'qq_upload_failed' };
      }
    }
    if (signal.aborted || Date.now() >= action.expiresAt)
      return { status: 'failed', code: 'reply_expired' };
    try {
      const response = await this.fetcher(
        `https://api.sgroup.qq.com/v2/${target}/messages`,
        {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify({
            msg_type: media ? 7 : 0,
            content: action.text,
            ...(media ? { media } : {}),
            ...(action.proactive
              ? {}
              : { msg_id: p?.replyId, msg_seq: action.sequence }),
            ...(action.referenceId
              ? { message_reference: { message_id: action.referenceId } }
              : {}),
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return {
          status: response.status >= 500 ? 'unknown' : 'failed',
          code: `qq_send_${response.status}`,
        };
      }
      const result = z
        .object({ id: z.string() })
        .parse(await limitedJson(response));
      return { status: 'sent', id: result.id };
    } catch {
      return { status: 'unknown', code: 'qq_delivery_unknown' };
    }
  }
}
