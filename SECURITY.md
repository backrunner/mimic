# 安全政策

请通过 [GitHub 私密漏洞报告](https://github.com/backrunner/mimic/security/advisories/new) 提交可利用的安全问题，避免在公开 issue 中披露凭据、真实聊天或可直接利用的细节。

提供受影响的提交/版本、部署方式、可复现步骤、预期边界和实际结果。维护者会确认问题后协调修复与披露；目前没有承诺响应时限或提供托管服务 SLA。

## 支持范围

项目处于开发阶段，安全修复优先落在 main。尚无长期维护分支或稳定版兼容承诺。

## 部署边界

- Dashboard 没有用户鉴权，默认只监听本机。不要直接发布到公网；外层访问控制由部署者负责。
- QQ Webhook、内部控制 API、记忆 AI broker 和代码沙箱 broker 是独立入口，不共用服务凭据。
- Node 代码必须在独立容器运行。Node permission、Safety 模型与 SDK 权限都不能单独替代操作系统隔离。
- 第三方进程内插件必须可信；当前没有隔离的第三方插件宿主。
- master.key、数据库、control.token 和环境变量均属于实例私密数据，不应出现在截图、日志附件或版本控制中。

部署与恢复方法见 [部署文档](docs/deployment.md)、[数据维护](docs/operations.md) 和 [记忆接入](docs/memstation.md)。
