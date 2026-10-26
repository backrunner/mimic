# 部署与代码沙箱

## 本地进程

Node.js 24.21+、pnpm 12.3.4，运行 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm start`。数据默认为 `./data`，可用 `MIMIC_DATA_DIR` 指定。环境变量示例见 [`.env.example`](../.env.example)；进程不自动加载 .env，请通过 shell 或服务管理器注入。

| 默认端口 | 用途                              |
| -------- | --------------------------------- |
| 3210     | 无登录的本地 Dashboard            |
| 3211     | 独立 QQ Webhook：POST /qq/webhook |
| 3212     | 带内部 token 的控制 API           |
| 3214     | 独立 Node 沙箱 broker             |
| 3215     | 带受限服务凭据的记忆 AI broker    |

宿主进程默认只监听本机。容器内服务监听容器接口，发布到宿主的端口仍绑定 127.0.0.1。管理入口、QQ 公网回调和两个 broker 的用途与凭据彼此独立。

## Apple Container

在已安装并启动 Apple Container 的 macOS 上：

```sh
pnpm container:dev
pnpm container:down
```

使用 `mimic-dev` 容器与 `mimic-dev-data` 专属卷，停机保留数据。脚本校验 owner 标签，不接管同名的其他项目资源；不依赖外接盘目录共享。

宿主沙箱 broker 绑定默认虚拟网络网关，连接记录写入 `data/dev-broker/connection.json`（600 权限）。应用只接收这个受限接口的地址和服务凭据，不持有宿主容器 socket。`container:down` 同时关闭本项目 broker。只看状态可执行 `node scripts/apple-container.mjs status`，不会输出环境变量中的凭据。

## Docker

```sh
docker compose up -d --build
docker compose logs -f mimic
docker compose down
```

Compose 使用同一 Containerfile，命名卷、只读根目录、非 root、移除 capabilities；不挂载宿主 Docker socket。仅把 QQ Webhook 的 3211 入口接到公网反向代理，不转发管理页或控制接口。

在可信宿主独立运行代码沙箱 broker 时：

```sh
# 从本地私密环境注入随机服务凭据，不写进版本控制。
export MIMIC_SANDBOX_TOKEN='<至少 32 字符的随机值>'
export MIMIC_SANDBOX_HOST='<应用可达的宿主 IP>'
node scripts/sandbox-broker.mjs
```

为应用注入 `MIMIC_SANDBOX_URL` 和相同服务凭据，面板选择 docker 驱动并执行隔离自检。Compose 默认没有这些宿主凭据，也不默认启用代码工具。容器内的 localhost 不是另一容器；记忆 broker 的跨容器接线同样使用实际可达的网络地址。

## 沙箱行为与校验

每个任务使用固定镜像、无网络、非 root、只读根目录、临时目录和独立的 CPU/内存/进程/时间/输出上限。不接受任意镜像、挂载、启动参数或宿主 shell。Node permission 叠加在容器隔离之上，不能单独作为恶意代码的安全边界。

```sh
pnpm sandbox:verify
# Docker Engine 环境：
MIMIC_VERIFY_DRIVER=docker pnpm sandbox:verify
```

验证包含计算、宿主文件、子进程、网络、墙钟时间、输出限制和 Unicode 分块输入；使用实际容器，结果写到 `.artifacts/sandbox-verification.json`。这组约束用例不等于内核或容器运行时的完整安全审计。
