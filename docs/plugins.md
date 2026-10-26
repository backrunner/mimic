# 插件开发

实际类型在 `packages/contracts/src/index.ts`；注册与运行上下文在 `packages/plugin-sdk/src/host.ts` 和 `index.ts`。请从实际 SDK 导入类型。

普通插件实现 `MimicPlugin`，导出 `manifest` 和 `setup(registrar)`。宿主验证重复 ID、依赖缺失与循环，按依赖顺序安装。`MIMIC_PLUGINS` 指定逗号分隔的本地模块路径；生产环境加载编译后的 `.js`。模块安装由部署者控制，当前支持 `builtin` / `trustedInProcess`；不提供下载执行任意远程插件或隔离的第三方插件宿主。

| 注册入口                | 行为                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model(provider)`       | 编解码 decision / text / web / embedding / rerank 请求；ID 对应 `model-${provider.id}`。插件只拿模型 ID、协议和输入，不拿 API Key。连接、HTTP、预算、取消、usage 仍由 AI Runtime 执行。 |
| `memory(provider)`      | 注册 MemoryTransport；ID 对应 `memory-${provider.id}`，manifest kind 为 memory。接收核心绑定的 scope，提供事件编码、投递、进度、查询与生命周期操作；不拿数据库句柄。                    |
| `tool(tool)`            | Zod 参数、JSON Schema、效果声明与执行函数；统一经过工具前后安全检查、轮数和输出大小限制。                                                                                               |
| `hook(hook)`            | 指定阶段、优先级、超时和 required；声明 `hook.<stage>` 权限。required hook 超时或失败阻止该阶段。                                                                                       |
| `safety(provider)`      | 替换默认语义安全实现；停用一个已安装的安全提供方时阻止执行，不能静默绕过。                                                                                                              |
| `protocol(adapter)`     | `start(ingest, signal)` / `send` / `stop`，可选 `coverage(workspace)` 返回最新接收范围。支持类的原型方法并保留 this；禁用后的接收被阻止。传入统一消息，不得绕过核心直接生成聊天发送。   |
| `behavior(id, handler)` | 注册返回行为意图的函数。任务的 `handler` 填 `${pluginId}:${id}`；返回 `null` 表示无行为。所有意图重新经过参与判断和发送流水线。                                                         |

`ExecutionContext` 提供：

- `data.get/put`：只可操作本插件、当前会话的命名空间，写入必须带预期 revision；不接受任意表名、SQL、连接句柄。声明 `data.read` / `data.write`。
- `settings.get`：本插件全局配置，声明 `config.read`。管理页面通过同源 `GET/PUT /api/plugins/{id}/config/{key}` 管理 `{value, revision}`，上限 64 KiB。
- `ai.decide/generate/web`：使用统一角色与 scope，并检查 `ai.<role>` 权限。文本、决策、Safety、工具使用同一连接与凭据引用。
- `memory.recall(query, {actorIds?, from?, to?})`：声明 `memory.read`。人物过滤使用记忆服务的 Actor ID，时间使用 RFC3339；核心固定当前会话与受众，不能从工具参数切换到其他群。失败返回 degraded 与空记忆，未启用返回 disabled。
- `memory.propose(candidate)`：独立声明 `memory.propose`；提交带来源与人物的候选，先过 Safety，再由记忆服务验证。它不批准事实或发布跨群副本；审核在 MemStation Manager 完成。
- `scope`：当前 workspace/run/plugin 与 AbortSignal。合作式取消不是隔离边界。

替换数据引擎由启动装配层传 `createApp(dataDir, {storage})`，实现 `StorageProvider` 的原子 CAS 批量写入、条件读取、删除和关闭，以及按 key 稳定排序的 `scan(kind, after, limit)`。扫描不能只按时间分页，否则相同时间的队列记录会遗漏。普通插件不接触该对象。底层 SQLite/Drizzle 插件是唯一数据库所有者；内置素材插件经核心资产服务查询。插件自带的独立外部存储不由 Mimic 提供底层访问能力。

长期记忆的本地 outbox、幂等键、源消息映射、重试和日志由核心 MemoryService 持有；远程协议和事件编码由记忆插件实现。默认提供 [MemStation 插件](memstation.md)。替换提供方时，旧作业会因绑定指纹变化停止，不能自动写入新的后端。

Node 原生受信任模块仍有进程权限，SDK 的作用是规范服务访问，不能把 TypeScript 接口当作对恶意插件的操作系统隔离。模型生成的代码只进独立沙箱，不按此类插件加载。

## 前端页面

页面用 Svelte 编写，加入 `mimic.plugins.json` 的 `admin`：

```json
{ "id": "tool-counter", "entry": "examples/CounterAdmin.svelte", "props": {} }
```

`pnpm build` 会生成静态组件注册表，路由为 `/plugins/tool-counter`。不通过运行时字符串 eval 注入页面。对应后端也必须加载该插件。页面可以复用现有 CSS / Bits UI；配置请求走同源 API，不携带模型凭据或内部控制 token。

运行示例：将上面的条目追加到清单、构建，然后以 `MIMIC_PLUGINS=./dist/examples/counter-plugin.js pnpm start` 启动。`examples/counter-plugin.ts` 展示独立会话计数和管理页配置；示例默认不安装。

存储、协议和安全是不同信任职责；模型工具只能提出文本或已批准素材，最终对外发送始终由核心 outbox 与协议适配器完成。

`list(kind, scope, limit, before?, beforeKey?)` 按 at/key 降序；有 beforeKey 时需覆盖相同 at 且 key 更小的记录。管理列表 API 用返回的 nextCursor 作为下一页的 cursor；仅用旧 nextBefore 不能保证同时间戳完整性。管理 API 每次保存密钥生成新的加密引用，配置 CAS 成功后才切换；不要依赖相同 name 覆盖已激活凭据。
