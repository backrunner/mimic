# 首次配置

首次启动为 shadow（观察）模式。QQ 未启用，模型未配置；默认 Safety 为 enforce，模型或安全检查不可用时不会发送。

## 模型与角色

在「模型与连接」保存连接后分配角色。厂商 Key 只保存一次，其他能力引用连接，不在插件里分别复制。

| 角色                             | 用途                                   |
| -------------------------------- | -------------------------------------- |
| chat                             | 回复生成与工具调用                     |
| participation                    | 兴趣、贡献、指代、时机、氛围与话题判断 |
| atmosphere                       | 基于多人物、多时间窗口的群风格先验     |
| safety                           | 输入、工具与输出检查                   |
| web-search                       | DeepSeek 官方 Search/Fetch             |
| memory.summary / memory.analysis | 记忆摘要与抽取                         |
| memory.embedding / memory.rerank | 记忆向量与精排                         |

DeepSeek 连接可以承担 chat、参与判断、群风格与 Safety。决策桥接使用 JSON，uncertainty 为 unknown；这类返回不开放未经邀请的主动插话。网页搜索角色引用 DeepSeek 连接，模型栏可填 `search` 作为计量标识。

TypeSafe/Jev、OpenAI Decisions 或提供对应协议的本地服务可用于原生概率决策。模型 ID 取账号实际可用值；不要把文本模型名当作决策、embedding 或 rerank 能力证明。记忆的 embedding/rerank 需要对应模型插件和实际服务，详见 [接入指南](memstation.md)。

无 usage、请求取消或网络结果未知时，用量保留 unknown。面板显示 token、调用次数和搜索单位，不是供应商结算账单；没有价格表时不估算为零费用。

## Soul

在面板编辑名字和 Soul。首次启动前也可放置文件：

```sh
mkdir -p data
cp examples/soul.md data/soul.md
```

数据库配置是运行时来源；面板保存同步更新 soul.md。之后手动修改文件，点击「重新载入 soul.md」。配置变更会取消旧上下文中的待发回复。

描述兴趣、知识边界和相处方式，比罗列性格词更有用。表达语气根据当前话题调整，不用长期群风格覆盖刚刚发生的严肃变化。

## QQ

1. 创建 QQ 官方机器人，保存 App ID / Client Secret。
2. 将独立 3211 入口的 `/qq/webhook` 接到 HTTPS 回调，按官方后台要求配置事件。
3. 明确账号是仅 @ 接收还是全量群消息接收；这决定模型实际能看到多少上下文。
4. 在本地回放查看决策、草稿和用量；确认权限后再启用 QQ 并切换 live。

全量接收与主动发送能力分别依赖实际账号授权。只接收 @ 消息时，不将可见片段当作完整群氛围。主动接话还要求会话授权、原生概率、已校准声明、冷却、安静时段及明确的兴趣/贡献/时机证据。管理员勾选校准不是模型效果验收。

## 记忆与工具

长期记忆不是聊天的前置依赖。保存业务凭据和完整会话绑定后自动开启；可手动暂停，不回灌启用前的历史。审核、跨群发布和 generation 管理在 MemStation Manager 完成。

内置搜索、网页抓取与批准素材工具；Node 计算需要 enforce Safety、独立沙箱 broker 和隔离自检。不开启代码工具时，其他聊天能力仍可运行。
