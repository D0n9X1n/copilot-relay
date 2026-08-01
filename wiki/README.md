# copilot-relay Wiki

> **Edit these pages in [`wiki/`](https://github.com/D0n9X1n/copilot-relay/tree/main/wiki) in the code repo, not here.**
> This tab is published automatically from that folder on every merge to `main`,
> so edits made in the browser editor are overwritten on the next publish.
> Keeping the source in the repo means a doc change is reviewed in the same pull
> request as the code it describes.
>
> **请在代码仓库的 [`wiki/`](https://github.com/D0n9X1n/copilot-relay/tree/main/wiki) 目录下修改，不要直接在这里编辑。**
> 本页面由该目录在每次合并到 `main` 时自动发布，浏览器里的改动会在下次发布时被覆盖。

This is the complete documentation for `copilot-relay` — using it, running it as
a service, and working on it. Every page exists in English and 中文.

这里是 `copilot-relay` 的全部文档 —— 如何使用、如何长期运行、以及如何参与开发。
每一页都有英文和中文两个版本。

## English

**Using it**

- [How copilot-relay works](EN-How-It-Works.md) — the short version
- [Configuration](EN-Configuration.md) — every key, hot reload vs restart
- [Logs and troubleshooting](EN-Logging-Troubleshooting.md) — log format, grep recipes, failure modes

**Running it as a long-lived background service** — setup, verification, shutdown:

- [Windows Task Scheduler](EN-Windows-Service.md)
- [macOS LaunchAgent](EN-macOS-LaunchAgent.md)
- [Linux systemd user service](EN-Linux-systemd.md)

Each service page covers registering the relay so it survives reboots, a
three-layer check for whether it is *actually* working rather than merely
listening, and how to stop it — including how `copilot-relay stop` interacts with
the platform's own restart policy.

**Working on it**

- [Architecture](EN-Architecture.md) — the map: modules, request flow, boundaries
- [Internals](EN-Internals.md) — precise mechanics, invariants, and why they hold
- [Development](EN-Development.md) — setup, tests, CI matrix, workflow, releasing

## 中文

**使用**

- [运行原理](ZH-How-It-Works.md) —— 简版说明
- [配置说明](ZH-Configuration.md) —— 每个配置键、热重载与需要重启
- [日志与问题排查](ZH-Logging-Troubleshooting.md) —— 日志格式、grep 配方、故障模式

**后台长期运行** —— 注册、验证、停止：

- [Windows 任务计划程序](ZH-Windows-Service.md)
- [macOS LaunchAgent](ZH-macOS-LaunchAgent.md)
- [Linux systemd 用户服务](ZH-Linux-systemd.md)

每个平台页面都包含：如何注册成重启后仍然存活的服务、如何用三层检查确认它**真的**能用
（而不只是端口在监听）、以及如何停止它 —— 包括 `copilot-relay stop` 与平台自身重启策略
之间的关系。

**开发**

- [架构](ZH-Architecture.md) —— 地图：模块、请求流程、边界
- [内部实现](ZH-Internals.md) —— 精确机制、不变量，以及它们成立的理由
- [开发指南](ZH-Development.md) —— 环境、测试、CI 矩阵、流程、发布
