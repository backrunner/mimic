# 数据维护与恢复

## 数据与凭据

默认 SQLite 使用 WAL，Drizzle sqlite-proxy 通过独立 worker 调用 Node node:sqlite。底层存储插件持有数据库，核心提供作用域服务；普通插件不拿 SQL 或连接句柄。数据库 schema 高于程序支持版本时拒绝启动。

厂商凭据加密存储。`master.key` 是独立解密主密钥，`control.token` 是本地控制入口凭据；两者和数据库一起放在私密数据目录，不提交或分享。管理 API 每次上传创建新的引用，配置 CAS 成功后才切换，失败的保存不会覆盖正在使用的密钥。未引用凭据目前不会自动删除。

## 备份与恢复

「系统」可创建事务一致的 SQLite 在线备份。备份数据库不能替代 master.key；应以同一实例的匹配主密钥单独妥善保存。

恢复流程：

1. 停止应用，并保留当前数据的一份副本。
2. 将备份放回数据目录，命名为 mimic.sqlite，恢复匹配的 master.key。
3. 确认没有运行中的实例，再移除旧的 mimic.sqlite-wal / mimic.sqlite-shm。
4. 先在独立数据目录/卷、观察模式启动并检查；确认后切换业务部署。

不要让两个实例同时使用同一个数据目录。旧程序不自动降级数据库。MemStation 的独立删除清单与备份恢复由该服务管理，不能只还原 Mimic SQLite 来替代其恢复屏障。

## 保留期与恢复状态

默认保留期 30 天，每 24 小时清理过期消息、调用、运行、任务执行、审计和召回记录；可在面板手动执行。配置、凭据、素材、任务定义和插件自己的数据不随聊天清理。记忆终态队列与来源映射保留用于幂等/引用恢复，目前没有自动压缩策略。

重启先全量处理遗留状态，再开放协议摄取：发送中与待确认用量标记 unknown；运行记录根据投递状态结束，未发送的运行取消。不自动重发未知网络请求，也不把未知用量补成零。

cron/随机任务的 nextAt、抽样结果、occurrence 与租约落盘，错过任务按 skip/coalesce 处理。行为只提出意图，不能绕过参与决策或安全流水线。

## 上下文预算与延迟排查

运行记录的 `context` 阶段记录历史/记忆条数及序列化字符数，不记录额外聊天副本。用量记录的 `requestChars` 是实际发送的 JSON 请求长度，`durationMs` 是该次 AI 请求耗时，`inputTokens` 仅采用厂商报告。比较相同模型和相似聊天场景下的调用次数、请求体积、端到端耗时与 p50/p95；本地模拟 provider 的耗时不能代替线上延迟。

默认 `context` 配置：

```json
{
  "historyMessages": 16,
  "historyChars": 6000,
  "decisionMessages": 8,
  "decisionChars": 4000,
  "memoryItems": 3,
  "memoryChars": 1800,
  "toolResultChars": 4000,
  "maxPromptChars": 24000
}
```

优先保持人格简短、记忆条目完整、引用清晰。`prompt_budget_exceeded` 表示生成请求超过总限额；`context_trigger_too_large` / `input_budget_exceeded` 表示当前消息无法在上下文或完整输入审查预算内处理。缩短长消息或冗长人格，不通过关闭安全审查来减少开销。
