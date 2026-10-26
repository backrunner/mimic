import type {
  Answers,
  Question,
  Message,
  Workspace,
  Config,
} from '../../contracts/src/index.js';
export const participationQuestions: Question[] = [
  {
    name: 'addressed',
    type: 'choice',
    instructions:
      '最新发言向谁寻求回应？判断 speaker、引用和 mentions，不要只看问号。',
    choices: {
      direct: '明确询问机器人或接续机器人',
      open: '向群体开放',
      other: '明确问其他人',
      unknown: '无法确定',
    },
  },
  {
    name: 'interest',
    type: 'choice',
    instructions: '当前话题与 soul 的兴趣和实际可贡献内容是否相符？',
    choices: {
      high: '感兴趣且能贡献',
      low: '不感兴趣或没有可贡献内容',
      unknown: '不确定',
    },
  },
  {
    name: 'contribution',
    type: 'choice',
    instructions:
      '此刻参与能提供什么？已有人说清不要重复；幽默也要看当下场合。',
    choices: {
      information: '有用的新信息',
      banter: '贴合场景的简短接梗',
      support: '必要的温和支持',
      none: '重复或没有贡献',
      unknown: '无法确认',
    },
  },
  {
    name: 'interrupts',
    type: 'predicate',
    instructions:
      '此时开口是否会打断别人之间的对答、抢答给别人的问题或增加无必要负担？',
  },
  {
    name: 'resolved',
    type: 'predicate',
    instructions: '拟回复的问题是否已经被别人回答、结束或撤回？',
  },
  {
    name: 'referent',
    type: 'predicate',
    instructions:
      '回答所需的人物和指代是否都有明确来源？重名或候选不完整时为否。',
  },
  {
    name: 'tone',
    type: 'choice',
    instructions:
      '这个话题当前适合什么语气？最近的严肃变化优先于群长期平均风格。',
    choices: {
      professional: '准确简短的专业讨论',
      playful: '轻松接梗',
      supportive: '温和支持',
      neutral: '中性短回应',
      unknown: '覆盖不足',
    },
  },
  {
    name: 'timing',
    type: 'choice',
    instructions: '当前是否适合机器人开口？碎片发言还未说完时等一下。',
    choices: {
      now: '已有明确空隙或邀请',
      wait: '正在连续发消息且尚未完成',
      skip: '目前没有必要参与',
    },
  },
];
export function chooseParticipation(
  answers: Answers,
  message: Message,
  workspace: Workspace,
  config: Config,
  now = Date.now(),
): { action: 'silence' | 'defer' | 'reply'; reason: string; tone: string } {
  const v = (key: string) => answers[key]?.value,
    tone = String(v('tone') ?? 'neutral');
  const result = (action: 'silence' | 'defer' | 'reply', reason: string) => ({
    action,
    reason,
    tone,
  });
  if (config.paused || workspace.paused) return result('silence', 'paused');
  if (message.bot) return result('silence', 'bot_loop');
  if (v('resolved') === true) return result('silence', 'already_resolved');
  if (v('addressed') === 'other')
    return result('silence', 'addressed_to_other');
  if (v('timing') === 'wait') return result('defer', 'unfinished_turn');
  const direct =
    message.direct ||
    message.mentions.includes('bot') ||
    (v('addressed') === 'direct' &&
      (answers.addressed?.probabilities?.direct ?? 0) >= 0.8);
  if (v('interest') === 'low' && v('contribution') === 'none')
    return result('silence', 'not_interested');
  if (direct)
    return result(
      'reply',
      v('referent') === false ? 'clarify_reference' : 'direct_invitation',
    );
  if (!workspace.proactive) return result('silence', 'proactive_disabled');
  if (workspace.receive !== 'all_messages')
    return result('silence', 'partial_visibility');
  if (!config.behavior.proactiveCalibrated)
    return result('silence', 'calibration_required');
  if (Object.values(answers).some((a) => a.uncertainty === 'unknown'))
    return result('silence', 'unknown_uncertainty');
  if (now - workspace.lastSentAt < config.behavior.cooldownMs)
    return result('silence', 'cooldown');
  if (
    v('interest') !== 'high' ||
    v('contribution') === 'none' ||
    v('contribution') === 'unknown'
  )
    return result('silence', 'no_contribution');
  if (
    v('interrupts') !== false ||
    v('referent') !== true ||
    v('timing') !== 'now'
  )
    return result('silence', 'poor_timing');
  if (
    (answers.interrupts?.probability ?? 1) > 0.25 ||
    (answers.referent?.probability ?? 0) < 0.75 ||
    (answers.resolved?.probability ?? 1) > 0.25
  )
    return result('silence', 'uncertain_context');
  for (const name of ['interest', 'contribution', 'timing'])
    if ((answers[name]?.probabilities?.[String(v(name))] ?? 0) < 0.7)
      return result('silence', 'uncertain_contribution');
  return result('reply', 'useful_participation');
}
export function isQuiet(
  now: number,
  start: string,
  end: string,
  timezone: string,
) {
  if (start === end) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(now));
  return start < end
    ? parts >= start && parts < end
    : parts >= start || parts < end;
}
