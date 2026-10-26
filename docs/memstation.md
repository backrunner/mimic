# MemStation 接入

未配置时不运行长期记忆；保存业务凭据和至少一个完整会话绑定后自动开启，无需再勾选启用。接入后可手动关闭，后续保存其他设置和重启会保留关闭状态；移除接入后再次配置则自动开启。AI broker 的服务开关独立配置。新收到的合规消息即使没有触发回复也会进入摄取队列；机器人输出只有协议确认投递后才会入库。不会自动回灌启用前的历史。

## 准备服务与身份

使用 [MemStation](https://github.com/backrunner/memstation) 的独立记忆服务契约 1.0，先完成迁移、删除清单初始化/恢复校验，运行 serve、worker、scheduler。服务必须报告 ready、server_isolation、multi_workspace、independent_ingestion、batch_idempotency 和 broker 能力。Mimic 要求 `runtime.ai_backend=broker`、`usage_authority=broker`，不接受另存厂商密钥的 direct 模式。

在 MemStation Manager 为每个群创建 Workspace，创建 Agent 与该 Workspace 的 grant，再配置 Integration 的平台命名空间、外部空间 ID 和观察 Agent。常规接入需要 events.write、memory.read、sources.read；候选写入、导出和删除还需对应的单独权限。Mimic 使用业务 Agent Key，不保存 MemStation 管理员 token。

在 Mimic「记忆 → 接入设置」保存地址和 Agent Key，添加绑定：

| 字段                           | 含义                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Mimic 会话 ID                  | 「会话」中的真实 workspace ID，不是群昵称                                        |
| MemStation Workspace           | 服务端返回的 Workspace ID                                                        |
| Integration / 外部空间         | 必须匹配 Manager 中授权的来源绑定                                                |
| partition / audience Actor IDs | 普通群聊留空；私有分区仅允许绑定真实 direct 会话，且需列出服务端授权的受众 Actor |

当前每个远端 Workspace 只能绑定一个本地会话，避免 broker 的 Workspace 归因歧义。一个 Agent Key 可在有 grant 的多个 Workspace 使用；同名人物不合并为同一身份。不要通过昵称或自行计算 MemStation 内部 ID 建立映射。

首次 mention 使用既有 `author` 的可信外部身份，要求服务端声明 `external_actor_mentions`。没有该能力时带 mention 的事件停止并等待重试，不伪造人物。接入前确认所部署版本已包含该能力，以及对 URL 编码 Node ID 的支持；这些能力未声明就不能用昵称或自行计算内部 ID 绕过。

## 共用 AI 配置

在「模型与连接」设置以下路由：

| 角色                             | 能力                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| memory.summary / memory.analysis | 非流式 JSON 文本，可复用 DeepSeek 连接                            |
| memory.embedding                 | OpenAI-compatible embedding；本地连接支持无 Key 服务              |
| memory.rerank                    | 本地 Jina-compatible `/rerank`，或自行注册实现该 codec 的模型插件 |

DeepSeek 文本接口不提供这里需要的 embedding/rerank codec；不能把四个角色全部填同一个文本模型。内置 rerank 请求为文本数组及完整 top_n，响应需要完整无重复的 index/relevance_score，以及真实 model 和 usage。上游缺少 usage/model 时 broker 会拒绝把调用标成完整，账本保留实际状态。

在「记忆 → AI broker」生成并保存受限服务凭据，复制到 MemStation 的环境配置。此凭据与数据面的 Agent Key 不同，二者都不是厂商 Key。保存后页面不回显原值；厂商 Key 始终只保存在 Mimic 的统一连接中。

```dotenv
MEMSTATION_MEMORY_AI_BACKEND=broker
MEMSTATION_MEMORY_BROKER_BASE_URL=http://<Mimic 可达地址>:3215/v1
MEMSTATION_MEMORY_BROKER_CREDENTIAL=<Mimic 生成的服务凭据>
MEMSTATION_MEMORY_BROKER_SUMMARY_ALIAS=memory.summary
MEMSTATION_MEMORY_BROKER_ANALYSIS_ALIAS=memory.analysis
MEMSTATION_MEMORY_BROKER_EMBEDDING_ALIAS=memory.embedding
MEMSTATION_MEMORY_BROKER_RERANK_ALIAS=memory.rerank
MEMSTATION_MEMORY_BROKER_EMBEDDING_MODEL=<实际且固定的 embedding model revision>
MEMSTATION_MEMORY_BROKER_EMBEDDING_DIMENSIONS=<维度>
MEMSTATION_MEMORY_BROKER_EMBEDDING_FINGERPRINT=<索引指纹>
```

embedding 的实际模型、维度、指纹须与 Mimic broker 和 MemStation generation profile 一致。更换模型需要在 MemStation 建立并激活新 generation，不能只改 alias。上述配置应应用到会调用记忆 AI 的服务角色。

源码默认 broker 监听 `127.0.0.1:3215`，可用 MIMIC_BROKER_HOST/PORT 调整。Apple Container/Compose 中监听容器内部接口，仅发布宿主 loopback；容器间通信需使用彼此可达的容器网络地址。不要把容器内的 `127.0.0.1` 当成另一容器。3210 管理页、3211 QQ 回调、3212 控制接口与 3215 记忆 broker 是不同入口，broker 仅接受受限服务凭据和四种记忆用途。

## 消息、召回与恢复

本地消息与引用型 pending_policy 占位同事务提交；未经检查的正文不进入 outbox。通过 Safety 后冻结 payload 和幂等键，网络结果未知或重启仍使用同一份请求。编辑被拒绝时，已投递过的旧正文会发送 tombstone；撤回不因语义 Safety 被阻止。更换绑定/后端不会把旧队列自动转投新位置。

引用先读取已映射且当前授权的原文，按 Unicode code point 计算区间。来源尚未摄取时等待重试，超限进入 dead_letter；不把引用文本猜成当前作者说的话。当前单个事件投递，不合并无界批次。最多 8 次退避尝试，可在面板手动重试；409 直接进入 dead_letter。MemStation 自身 worker 的 DLQ 仍在 Manager 管理，本地重试不等于重放远端失败任务。

accepted 表示服务器已接收，indexed/complete 表示连续水位已覆盖。默认窗口由 MemStation scheduler 封存，测试中可显式 finalize；「立即投递」只处理本地队列，不保证立即完成模型抽取。MemStation 的 idle 边界目前仍依赖 scheduler，需保持调度器运行。

召回有独立截止时间、结构大小预算、去重和当前 revision 复核。人物过滤使用服务端 Actor ID；SDK/API 可传时间范围。尚未传播的编辑/撤回会阻止旧证据注入；发送前再复核。超时、服务不可用或权限变化时降级为近期上下文，没有依据的过去事实要求澄清。

「处理与检索」提供能力探测、本地队列/receipt、水位、授权搜索、当前来源详情、导出/删除操作查询。日志只保存召回 ID、revision、来源引用和正文哈希，不复制长期记忆正文。历史条目查看时重新授权读取当前记录；usedRefs 暂无可靠模型归因，始终标为未验证，不显示虚假的采用成功率。

broker 的 Call-Id 与统一 AI usage ID 一一对应；重复请求不再次执行，可通过 `/v1/memory/calls/{id}` 对账。broker 不自动重发 unknown 模型调用；MemStation worker 的独立重试会使用新的 Call-Id，可能产生额外费用。账本记录调用/token/状态，当前没有供应商价格表或结算成本估算。预算也覆盖后台记忆处理。

暂停记忆、停用记忆插件或关闭 broker 后，broker 不接受新的后台模型调用。已发出的请求可能仍会计费，保留其实际结果或 unknown 状态。配置变更会取消原作用域，避免将旧消息投到新后端；机器人消息撤回同样传播，不要求再提供一次发送回执。

来源映射和终态队列为幂等/引用恢复元数据，当前不会随聊天保留期自动删除，部署者应关注增长；召回审计遵循普通历史保留期。导出正文不复制到 Mimic 的 operation 日志，读取结果时由远端重新校验。

## 验证与现有边界

`pnpm test` 覆盖可靠投递、撤回、重启、引用、隐私、候选和 broker 权限/账本；`pnpm test:e2e` 覆盖面板保存、密钥隐藏与手机布局。实际双项目联合测试使用专用 PostgreSQL/Redis 与确定性模型，不需要付费凭据：

```sh
export MEMSTATION_TEST_DATABASE_URL='<专用 PostgreSQL URL>'
export MEMSTATION_TEST_REDIS_URL='<专用 Redis URL>'
node tests/integration/memstation/run.mjs
```

测试默认使用相邻 ../memstation 检出，可设置 MEMSTATION_ROOT 指向兼容版本。测试通过 Go overlay 运行实际 MemStation HTTP/worker 与 Mimic TypeScript 适配器、broker、AI Runtime；每个用例隔离 schema/队列，不指向业务库。它证明协议和生命周期可协作，不证明真实群聊的召回质量或容量。

候选批准、人工修正、跨群发布与 generation 管理继续使用 MemStation Manager。本地没有后台自动回灌、熔断器或按轮召回缓存。MemStation 的 broker 客户端对缺失 model-version/usage 的严格拒绝尚待补齐；Mimic broker 已严格输出并拒绝不完整上游信息，这不等于修复其他 broker 的服务端兼容性。
