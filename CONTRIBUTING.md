# 参与贡献

欢迎协议、模型、记忆和工具插件，也欢迎修复边界情况、补回归场景与改进中文表达。较大的功能先开 issue 描述使用场景和接口，再开始实现。

## 本地开发

使用 Node.js 24.21+、pnpm 12.3.4：

```sh
pnpm install --frozen-lockfile
pnpm dev
# 另一个终端：
pnpm dev:dashboard
```

默认数据在 data/，不要把真实聊天、Key、备份或运行日志加入提交。新插件从 [SDK 文档](docs/plugins.md) 和 [计数示例](examples/counter-plugin.ts) 开始。模型调用复用 AI Runtime，普通插件通过作用域服务访问存储和记忆。

## 验证

```sh
pnpm check
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm replay
pnpm exec prettier --check packages plugins apps scripts tests compose.yaml
```

测试使用确定性模型替身，不需要真实厂商凭据。`pnpm replay` 默认只检查场景材料；`--run` 会调用配置好的模型并保留 shadow，请自行确认费用。新增测试应覆盖实际行为或失败边界，避免逐行镜像实现。

实际沙箱测试需要 Apple Container 或 Docker Engine，见 [部署文档](docs/deployment.md)。可选的 MemStation 联合测试需要相邻检出、Go、专用 PostgreSQL/pgvector 和 Redis，入口为 `tests/integration/memstation/run.mjs`；普通 check/test/build 不依赖这些服务。[接入说明](docs/memstation.md) 包含运行方式。

## 提交与 Pull Request

按单一目的拆分提交，使用 Conventional Commits，例如：

```text
feat(protocol): add an adapter for a new transport
fix(memory): reject stale source revisions before injection
docs: explain local broker configuration
```

已有签名配置时请使用签名提交。PR 描述具体触发条件、修改后的行为和运行过的检查；不要把源码核查写成真实模型、QQ 权限或生产容量已验证。界面改动附上无私人数据的截图。

提交的项目代码和文档使用 Apache-2.0。引入第三方代码、资源或依赖时保留原许可与来源，更新第三方声明。请勿提交不能按相应许可分发的内容。
