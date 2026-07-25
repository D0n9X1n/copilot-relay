# copilot-relay Wiki

> **Edit these pages in [`wiki/`](https://github.com/D0n9X1n/copilot-relay/tree/main/wiki) in the code repo, not here.**
> This tab is published automatically from that folder on every merge to `main`,
> so edits made in the browser editor are overwritten on the next publish.
> Keeping the source in the repo means a doc change is reviewed in the same pull
> request as the code it describes.
>
> **请在代码仓库的 [`wiki/`](https://github.com/D0n9X1n/copilot-relay/tree/main/wiki) 目录下修改，不要直接在这里编辑。**
> 本页面由该目录在每次合并到 `main` 时自动发布，浏览器里的改动会在下次发布时被覆盖。

Choose a language:

## English

- [How copilot-relay works](EN-How-It-Works.md)
- [Configuration](EN-Configuration.md)
- [Logs and troubleshooting](EN-Logging-Troubleshooting.md)
- Run as a long-lived background service — setup, verification, shutdown:
  - [Windows Task Scheduler](EN-Windows-Service.md)
  - [macOS LaunchAgent](EN-macOS-LaunchAgent.md)
  - [Linux systemd user service](EN-Linux-systemd.md)

Each service page covers registering the relay so it survives reboots, a
three-layer check for whether it is *actually* working rather than merely
listening, and how to stop it — including how `copilot-relay stop` interacts with
the platform's own restart policy.

## 中文

- [运行原理](ZH-How-It-Works.md)
- [配置说明](ZH-Configuration.md)
- [日志与问题排查](ZH-Logging-Troubleshooting.md)
- 后台长期运行 —— 注册、验证、停止：
  - [Windows 任务计划程序](ZH-Windows-Service.md)
  - [macOS LaunchAgent](ZH-macOS-LaunchAgent.md)
  - [Linux systemd 用户服务](ZH-Linux-systemd.md)

每个平台页面都包含：如何注册成重启后仍然存活的服务、如何用三层检查确认它**真的**能用
（而不只是端口在监听）、以及如何停止它 —— 包括 `copilot-relay stop` 与平台自身重启策略
之间的关系。
