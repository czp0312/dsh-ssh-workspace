# 开发指南

[返回项目介绍](../README.md) · [开发约定](../AGENTS.md) · [使用指南](usage.md)

## 本地开发

需要 Node **24.9+** 和 npm。克隆仓库后：

```sh
npm ci
npm run check
npm pack
```

`npm run check` 执行类型检查、构建和回归测试；`npm pack` 会生成包含前后端入口及 SSH askpass helper 的安装包。

从仓库根目录把本地包安装到测试 profile：

```sh
dsh plugin --profile your-test-profile add ./dsh-ssh-workspaces-0.3.0.tgz
```

测试前应通过独立 `DSH_HOME` 配置隔离数据目录，并启动同名 profile。不要直接修改正在使用的桌面 profile 来做安装试验。

`scripts/Install-Desktop.ps1` 可用于已明确要更新桌面环境的场景，参数 `-DshCommand` 接受 CLI 路径，`-PackagePath` 接受本地安装包。脚本在安装前备份桌面 profile 的配置及锁文件。

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `src/client.tsx`、`src/client.css` | 左侧入口、表单、目录浏览、已保存项目和连接设置 |
| `src/workspace-badges.ts` | 原生工作区标题的远程图标和连接状态 |
| `src/manager.ts`、`src/transport.ts`、`src/tools.ts` | 轻量工作区、远程命令及本机工具边界 |
| `src/backends.ts`、`src/backend-bootstrap.ts` | 全量后端安装、生命周期与隧道 |
| `src/client-router.ts`、`src/backend-protocol.ts` | 原生客户端请求分流和后端 ID 转换 |
| `src/connections.ts`、`src/storage.ts` | 两种模式的连接管理、模式切换及持久化 |
| `src/skills-sync.ts`、`src/skills-helper.ts` | 默认预设技能发现、差异计划与远端资源导入 |
| `tests/` | 单元、协议、加载和界面回归测试 |
| `scripts/` | 构建、桌面安装及实机验证 |

## 运行边界

轻量模式使用本机 Agent，文件通过 WSL 共享、已有 SSHFS 挂载或 Docker 共享目录访问，命令由会话专属的 `remote_bash` 经 SSH / WSL / Docker exec 执行。每条命令独立执行；原生终端、PTC / `run_code`、后台任务、子代理和 worktree 没有接入轻量传输。

全量模式在远端运行版本匹配的 DSH，将原生请求、事件、终端上下行和文件数据经本机 broker 转发。全量项目和会话使用 `dsh-remote:<backendId>:<id>` 命名空间，避免不同后端产生相同 ID 时冲突。

- 客户端合并原生工作区流、会话列表、Session 控制流和转发事件，项目列表只展示已登记的远端目录。
- 显式本机会话继续访问本机服务；远端请求失败时报告失败，不退回本机执行。
- 订阅可以在自然断线后重试；提示词和工具调用不能自动重放。
- 手动断开持久化，不能被轮询或订阅重试绕过。
- 模式切换创建或复用另一模式入口，保留原入口、原历史和旧会话路由。
- 路由仅依赖 `connection`，必须先于原生控制器订阅安装；界面、导航和上传钩子分别等待所需服务，不能让 UI 依赖推迟整个路由启动。
- 客户端模块清单、插件管理和访问控制始终使用本机宿主；不能随着当前远程项目切换这些服务。初次读取项目目录也不应打断原生会话恢复。
- 每个合并的 Session 控制流只发送一份初始快照，再发送增量。目录登记或后端来源变化时，以可重试的传输错误结束旧订阅，重新建立快照，不重放业务请求。

DSH 当前未提供项目标题装饰插槽，远程图标由独立 DOM 适配器添加，按工作区 ID 匹配而非名称。卸载时清理图标，不修改原生项目名称。该适配器需要随 DSH 界面升级重新验证。

## 构建与兼容性

浏览器入口使用 DSH 的 `window.__ModuleLoader__.load` 包装，React 由宿主加载。测试必须检查实际发布的经典脚本，不能只测试 TypeScript 源码或 ESM 导入。

兼容范围见根目录 `package.json` 的 `dsh.engines.dsh`；已验证协议版本见 `src/types.ts` 的 `VERIFIED_DSH_VERSION`。当前为 **0.2.2-rc.1**。全量后端固定安装这个协议版本，不自动跟随 npm 的 DSH 最新版本。

扩大版本范围之前，先验证原生 RPC、Client Module、Sidebar Panel、二进制附件和 Remote Mux 行为，再同步 README 与使用指南。

## 远端部署与数据

默认部署目录：

```text
~/.local/share/dsh-ssh-workspaces/
  bootstrap.lock
  node-v24.12.0-linux-x64/       # 系统 Node 不满足要求时安装；另支持 arm64
  dsh-0.2.2-rc.1/
    node_modules/
    installed.ok
    backend.json
    backend.log
```

部署使用跨进程锁、安装完成标记和原子连接记录；Node 下载校验官方 SHA-256。服务仅监听远端 `127.0.0.1` 的随机端口，不要求 root。

本机 broker 保管远端认证 Cookie 和启动令牌，不返回给插件 UI。`backend.json` 与 `backend.log` 可能含敏感令牌，不能原样公开。远端使用用户自己的 `~/.dsh`，不复制本机模型凭据或插件。

本机默认登记文件位于 `<DSH_HOME>/ssh-workspaces.json` 和 `<DSH_HOME>/ssh-backends.json`，未设置 `DSH_HOME` 时使用用户的 `~/.dsh`。轻量与全量记录分开保存；移除登记仍保留旧会话所需的路由。

## 实机验证

```sh
npm run check
npx tsx scripts/smoke-backend.ts
```

`npm run check` 覆盖实际发布脚本加载与交互、模式分流、本机 / 远端请求隔离、命名空间、审批事件回传、终端上行、二进制响应、原子存储和轻量命令传输。

`smoke-backend.ts` 面向已准备好的 `Ubuntu-22.04` 及专用测试目录，验证真实远端 DSH 的会话创建、工作区流、终端、文件、附件上传、事件握手，以及全量 → 轻量 → 全量、断开 / 重连与原会话保留。脚本会启动或复用远端后端，但不主动发起付费模型请求。运行前阅读脚本并确认发行版及测试路径适合当前环境。

WSL 验证不能替代真实 SSH 服务器验证；密码、密钥和证书等认证方式也应分别记录验证范围。不要将测试服务器地址或凭据写入公开文档。

## Docker 与 Skill 同步的验证边界

Docker 在传输层复用 Python helper 与字节隧道，本机 CLI 采用无 shell 的 argv；SSH Docker 把受控的 Docker argv 传给原有 SSH 通道，并复用进程内认证服务。`docker exec -i` 不分配 TTY，避免修改 HTTP / WebSocket 字节。首次连接通过 inspect 固定容器 ID，后续重连不能跟随复用的容器名。指定容器用户时依据 passwd 还原其 HOME，避免把其他用户的数据写入镜像默认 HOME。

轻量 Docker 与轻量 SSH 均需双向文件探针证明共享目录正确。全量 Docker 与其他全量连接复用后端生命周期；不会调用 `docker start`、`stop`、`run` 或修改镜像。

`skills-sync.ts` 通过 DSH 默认预设的 standing scope 读取技能注册表，释放 scope 不创建会话或 Agent。候选仅包含用户和自定义技能；导出目录资源、大小校验和哈希均在本机完成。同步计划绑定工作区、连接生命周期、来源哈希和远端目录哈希，十分钟失效且只消费一次。

`skills-helper.ts` 在远端只允许用户技能目录下的受控条目写入。大文件经 stdin 传输，避免 Windows 命令行长度上限；导入先校验路径、大小和哈希，再同盘暂存、备份与重命名，失败还原旧目录。`.env`、Git、依赖目录和缓存不导出；包含这些远端数据的目标不自动覆盖。导入锁只串行本插件的写入，目录哈希在提交前再检查；其他程序不遵循锁协议时仍存在最终检查与重命名间的极短竞态，不宣称跨进程事务隔离。

测试使用临时 DSH / Agents HOME，在真实 WSL Python 下覆盖资源传输、可执行脚本、缺失/一致/差异、显式更新、并发变化、跨工作区计划隔离、目录穿越和目标符号链接。DSH 实机验收使用独立本机 profile 和公开演示技能，已通过远端 `skills/list` 确认同步后的技能可被原生目录发现。

Docker 当前只有连接边界、认证复用、完整 ID、停止容器拒绝和 UI 回归；维护者需要在有 Docker daemon 的环境继续运行真实容器验收，不能把这些测试写成端到端 Docker 验收。

## 文档与市场维护

功能修改同步更新 README、`docs/usage.md` 和对应截图。README 面向使用者，内部协议、验证方法和部署细节集中在本文。

真实界面截图放入 `docs/images/`，使用独立演示项目。根目录 `screenshots.json` 声明市场截图的顺序；DSH Market 从同一仓库读取，不应上传包含私人项目或登录信息的画面。

市场条目保存在 [`docs/market-entry.yml`](market-entry.yml)。投稿时把这个文件作为 `data/plugins/czp0312__dsh-ssh-workspace.yml` 提交到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，遵循其最新贡献规则。DSH Market 与该目录共用数据；只有申请合并并更新目录后，才能称为已收录。

npm 包的 `repository` 已指向本仓库，目录会自动关联 npm 安装源，不应在市场 YAML 中添加未支持的 `npm` 字段。
