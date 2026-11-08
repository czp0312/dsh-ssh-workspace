# DSH SSH / WSL Workspaces

在当前 DeepSeek Harness 桌面窗口中添加 SSH / WSL 项目，和本机项目一起显示在原生工作区侧边栏。独立入口为左侧栏的 **远程工作区**，不放在账户菜单内。

## 两种运行模式

SSH 和 WSL 的连接表单均支持切换模式，每个连接类型分别保留当前选择，默认选择全量模式。

| | 轻量模式 | 全量模式 |
| --- | --- | --- |
| 远端安装 DSH | 不安装 | 自动安装版本匹配的 DSH |
| Agent / 模型配置 | 本机 DSH | 远端 DSH |
| 文件访问 | WSL 共享目录 / SSHFS 挂载 | 远端原生文件系统 API |
| Shell | 会话专属 `remote_bash`，每次独立执行 | 远端 DSH 原生 Shell / 终端 |
| 后台任务、PTC、子代理 | 不支持，使用 Native 工具模式 | 由远端 DSH 原生后端承担 |
| 前置条件 | 远端 Python 3、Bash；SSH 文件访问另需挂载 | 远端 Linux/WSL、Python 3、Bash、安装包网络访问 |

首次添加时选择模式；之后可在已保存项目的“连接设置”中重新选择轻量或全量，点击“以该模式连接”后生效。另一模式已有登记时复用其工作区；没有登记时创建独立入口。两种模式使用同一远程文件夹，各自保留会话历史。原模式入口与会话仍可继续使用，切换不会迁移对话、改变运行中会话的位置或停止另一模式的任务。切换失败时原模式仍保留。

全量切回 SSH 轻量时需要已有 SSHFS 挂载；WSL 轻量使用原生目录共享。再次切回同一模式会恢复其原工作区与历史。旧版插件保存的项目自动归为轻量模式。

## 安装

当前已验证 **DSH 0.2.2-rc.1**，安装包为 `dsh-ssh-workspaces@0.2.5`。本项目使用该版本的原生 Client Module、Connection RPC、Remote Mux 和 Sidebar Panel 接口。远端 DSH 固定安装同一协议版本。未来 DSH 版本需要重新验证，不能仅凭版本范围视为兼容。

从 npm 安装到桌面版的 `desktop` profile：

```powershell
dsh plugin --profile desktop add dsh-ssh-workspaces@0.2.5
```

若尚未注册 `dsh` 命令，可在 DSH 的“应用 → 管理 dsh 命令”中配置，或使用安装目录内 `resources/runtime/cli/bin/dsh.cmd` 的完整路径。

从源码构建本地安装包：

```powershell
npm ci
npm run check
npm pack
```

通过官方 CLI 安装刚构建的本地包：

```powershell
& 'E:\Program\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'D:\Code\Workspace\dsh-ssh\dsh-ssh-workspaces-0.2.5.tgz'
```

也可以运行 `scripts/Install-Desktop.ps1 -DshCommand <dsh.cmd 路径>`，它会先备份 profile 配置和锁文件。更新插件后重启客户端一次；之后新增、切换和打开项目均在原窗口完成。

前端构建使用 DSH 原生 `window.__ModuleLoader__.load` 包装，回归测试会加载实际发布的经典脚本，防止再次出现 ESM `import failed` 导致客户端启动失败。

## 使用

1. 点击左侧栏 **远程工作区**。
2. 选择 **SSH** 或 **WSL**，再选择 **轻量模式** 或 **全量模式**。
3. 输入连接信息和远程绝对路径，或浏览选择目录。
4. 测试连接后点击 **添加到工作区**。
5. 从原生工作区列表或管理面板的 **打开** 进入项目。

如果通过“编辑侧栏”手动隐藏过该入口，可在原生“更多”菜单中重新固定。管理面板不锁定焦点，可直接点击左侧栏切换页面。

远程项目的原生侧栏文件夹标题旁会显示远程主机图标：绿色表示已连接，灰色表示未连接，黄色表示连接中，红色表示连接异常。悬停可查看状态、SSH 主机或 WSL 发行版，以及轻量/全量模式。登记成功不等于在线；宿主每 15 秒检查连接，客户端每 5 秒同步状态，面板关闭时图标仍会更新。本机项目保持原样；标记按工作区 ID 匹配，同名项目不会混淆。当前 DSH 未提供项目标题装饰插槽，因此使用隔离的 DOM 适配器，兼容性以已验证版本为准；卸载会清理标记，不修改项目名称。

### 连接、断开与移除

已保存项目提供“连接/重新连接”“断开”和“连接设置”。“打开”会在已连接的当前模式下新建会话；要继续旧会话，从相应模式的侧栏入口打开原对话。

- **轻量断开**：停止插件的远程命令通道并取消正在执行的插件命令，阻止该项目的 Agent 继续调用文件或命令工具。用户管理的 SSHFS / WSL 挂载不会卸载，目录登记和历史保持不变。
- **全量断开**：关闭本机的 HTTP/WebSocket 隧道，远端 DSH 和后台任务继续运行。同一身份下多个全量项目共用后端，它们会一起离线；卡片会显示影响范围。
- **主动断开后**：项目在侧栏保留为灰色，状态轮询及订阅重试不会将它自动连回。断开选择会保存，重启客户端后仍需手动连接。自然网络故障允许原订阅重试；不会重放提示词或工具调用。
- **移除登记**：隐藏该模式的项目入口，保留文件、会话历史及旧会话路由；需要暂停连接时使用“断开”。

### 轻量 WSL

不安装远端 Node 或 DSH。Windows 通过 `\\wsl.localhost\发行版\...` 读取 Linux 文件；`/mnt/c/...` 等目录映射到相应本机盘符。命令经 `wsl.exe --distribution ... --exec python3 ...` 进入记录的发行版和用户，Agent 与模型仍在本机。

WSL 内需要 `python3` 和 `bash`。文件共享受 Windows 的 WSL 共享身份与权限约束。原生终端、后台任务、PTC/run_code、子代理和 worktree 未接入轻量传输；这些需求请选择全量模式。

### 轻量 SSH

SSH 表单提供四种登录方式，轻量和全量模式均支持：

- **自动选择**：沿用系统 OpenSSH 的 `~/.ssh/config`、默认私钥和 Agent；也可以临时填写密码，让 OpenSSH 按服务器允许的方式继续认证。填写配置的 `Host` 别名时，可省略配置中已有的用户名和端口。
- **仅密码**：只尝试 SSH password 认证，关闭公钥和键盘交互认证。密码通过本机一次性 askpass 通道交给 OpenSSH，不进入命令行、远端命令、环境变量或工作区记录。
- **密钥**：手动填写本机绝对路径或 `~/.ssh/id_ed25519`；桌面版也可点击“选择密钥文件”。使用系统 OpenSSH 的 `-i` 和 `IdentitiesOnly=yes`，同一文件用于测试连接、目录浏览、命令、全量部署和隧道。
- **证书**：填写 OpenSSH 用户证书（通常为 `id_ed25519-cert.pub`）和配套私钥。这里的证书是 SSH CA 用户证书，不是 HTTPS/X.509 证书；服务器还必须信任签发该证书的 CA。

应选择 OpenSSH 私钥（例如 `id_ed25519`、`id_rsa` 或 OpenSSH 格式 `.pem`），不是 `.pub` 公钥。PuTTY `.ppk` 需要先转换格式。加密私钥可以在表单填写私钥口令，也可以先通过 `ssh-add` 加入本机 ssh-agent。密码和私钥口令只保留在当前客户端进程内，重启后需要在已保存项目的“连接设置”中重新填写。插件只保存私钥/证书路径，不读取、上传或复制密钥内容。

插件使用严格主机密钥检查；首次连接请先在终端完成主机密钥核对。不提供主机指纹确认弹窗，也不保存密码。未配置默认身份、未填写密码、也未选择密钥时，单独填写用户名无法认证。私钥文件权限过宽时 Windows OpenSSH 会拒绝读取，需将文件访问权限限制到当前用户；插件不会自动修改私钥 ACL。

Windows 文件访问需要 WinFsp + SSHFS-Win，或预先建立的 SSHFS 挂载。留空时使用 SSHFS-Win 的绝对路径共享；复杂别名、跳板机、带口令密钥、IPv6 等建议填写已经建立的挂载路径。macOS/Linux 必须填写挂载路径。挂载必须对应整个远程项目目录，添加时会创建并清理随机校验文件，确认文件访问与命令访问相同目录。

指定密码、密钥或证书时，自动 SSHFS 共享不能接收表单中的凭据：轻量模式必须填写已经使用同一凭据建立的挂载路径。全量模式不依赖 SSHFS，不受此限制。Windows 轻量 SSH 需要 WinFsp + SSHFS-Win；普通本地目录不能作为挂载路径。

### 全量 SSH / WSL

项目所在机器运行完整 DSH 后端，桌面端只显示 UI，并通过 SSH/WSL 隧道传递原生请求、事件、终端上下行和文件数据。SSH 不再依赖 SSHFS；WSL 不再依赖 UNC 目录共享。

首次连接会在远端用户目录中部署：

```text
~/.local/share/dsh-ssh-workspaces/
  bootstrap.lock
  node-v24.12.0-linux-x64/       # 仅系统 Node 不满足要求时安装；另支持 arm64
  dsh-0.2.2-rc.1/
    node_modules/
    installed.ok
    backend.json               # 用户专属启动状态，包含令牌，勿公开
    backend.log                # 用户专属启动日志，可能包含启动令牌
```

自动 Node 安装支持 Linux x64/arm64，并校验官方 SHA-256。系统已有 Node 24.9+ 时直接复用。部署使用跨进程锁、安装完成标记及原子本地连接记录；不需要 root。

后端只监听远端 `127.0.0.1` 的随机端口，不对外开放服务。本机 broker 保管远端认证 Cookie 和启动令牌，不向插件 UI 返回。移除项目登记或关闭客户端不会停止远端 DSH 进程与其任务；再次连接复用同一个后端。

远端使用自己的 `~/.dsh` 配置、模型凭据和插件。**不会自动复制本机 API Key、账号凭据或第三方插件。** 首次使用需为远端 DSH 配置可用的模型提供方。全量模式接入的是原生引擎，具体工具及运行能力取决于远端 DSH 配置和系统依赖。

## 路由与数据

- 全量项目和会话使用 `dsh-remote:<backendId>:<id>` 区分不同后端，同名远端 UUID 不会互相覆盖。
- 原生工作区流、Session 控制流、会话列表和转发事件在客户端合并。只在项目列表中展示已登记的远端文件夹。
- 显式本机会话继续调用本机服务；远端请求失败时报告失败，不退回本机，也不自动重放提示词或工具调用。
- 断线后重试事件订阅；管理面板的“重新连接”可重建隧道。
- 移除只撤销本机登记，保留文件、历史与历史路由。轻量模式保留旧 `ssh-workspaces.json`；全量模式另存 `ssh-backends.json`。
- 默认记录路径为 `<DSH_HOME>/ssh-workspaces.json` 与 `<DSH_HOME>/ssh-backends.json`，通常在 `%USERPROFILE%\.dsh` 下。它们不保存远端密码、私钥或 Cookie。

## 开发与验证

```powershell
npm run check
npx tsx scripts/smoke-backend.ts
```

`npm run check` 包括类型检查、实际发布客户端脚本的加载和交互、双模式分流、本机/远端请求隔离、命名空间、审批事件回传、终端上行、原生二进制数据恢复、原子存储及原轻量命令传输测试。

`smoke-backend.ts` 使用已存在的 `Ubuntu-22.04` 和专用测试项目，验证真实远端 DSH 的会话创建、工作区流、终端输入输出、文件写入/读取、二进制响应、流式附件上传及事件握手，还会验证全量→轻量→全量、两种模式的断开/重连及原会话与文件保留。脚本使用独立项目登记，不发起付费模型请求。无真实 SSH 测试服务器时，不能将 WSL 验证等同于已完成 SSH 服务器联调。

## 参考

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：原生工作区、Connection、Remote 和侧栏接口。
- [ZCode](https://github.com/zai-org/ZCode)：同窗远程项目和远程执行环境的产品交互参考。
- [dsh-wsl-workspace](https://awesome-dsh-plugin.com/zh/p/6Mikao9/dsh-wsl-workspace/)：现有 WSL 工作区插件。
- [SSHFS-Win](https://github.com/winfsp/sshfs-win)：轻量 SSH 的可选目录挂载组件。

MIT License。
