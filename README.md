# DSH Preset Studio

**[English](#english)** · 中文

> **117 tools is not a preset. Cut the tool set to the job.**
>
> Ship a minimal, task-specific tool set with [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
> — measured **101 → 14 tools** — and let a local CLI mint its own authenticated
> session URL instead of you hand-copying a token. Standard library only, no telemetry.

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 配一套**只够本次任务用的
最小工具集**（实测 117 → 14），并让本机 CLI **自己**取得带 token 的会话 URL，而不是让你从
终端手抄。仅用 Python 标准库，不发送任何遥测。

```bash
git clone git@github.com:jijiwu3526/dsh-toolsmith.git
cd dsh-toolsmith
python -m pip install .        # not on PyPI — install from source
```

### 谁该装

- 你给智能体一个任务，却发现它拿到 100+ 个工具、抓不住重点；
- 你想让不同任务用**不同**的工具集，而不是一套通用大工具；
- 你在写进程外的 DSH 工具，不想每次手工复制带 token 的 URL。

### 30 秒知道原理

Agent preset 是**叠加层，不是替代层**——官方文档原话：「没有本包时，会话只能回退到宿主
组装挂载的内容。」所以光写 preset 裁不掉宿主的工具，**必须 profile 层和 preset 层一起动**：

| 层 | 作用 | 配在哪 |
| --- | --- | --- |
| profile | 决定工具集**上限**（在所有 bundle 之后应用，`disabled: true` 胜出） | `~/.dsh/profiles/<p>/cordis.patch.yml` |
| preset | 在上限内**精确挑选** + 注入 persona 纪律 | `presets/*/agent.cordis.yml` |

```powershell
# 关掉本次任务用不到的 bundle —— 上限就降下来了
.\tools\profile-tool-switch.ps1 -Off univer,mnemon-bundle,dsh-taskboard,logicprobe
.\tools\profile-tool-switch.ps1 -Verify   # 读合成后的真实配置逐行核实
```

> 上面的 117 → 101 → 14 是 **0.1.x 实测**数据。0.2 把 preset 改成 bundle patch 行式
> （`settings.yaml` 已并入 `profiles/<name>/cordis.patch.yml`），但**「叠加层裁不掉宿主工具」
> 这一条在 0.2 依然成立**。

## 两个问题，一个仓库

本仓库由 [`dsh-skillmaster`](https://github.com/jijiwu3526/dsh-skillmaster) 与
[`dsh-local-bridge`](https://github.com/jijiwu3526/dsh-local-bridge) 合并而来。
合并前是两个仓库：前者是 Python 工具集，后者是它依赖的 DSH 插件——现在插件源码就在
`plugin/` 下。

### 一、让本机 CLI 能自己取得认证

`dsh-session` / `dshstudio` 是进程外工具，需要 DSH Web 的带 token URL。
不装插件时唯一获取方式是人从终端手抄，token 于是进入 shell 历史、CI 日志和聊天记录。

`plugin/` 里的插件跑在 DSH **进程内部**，那里可以随时铸造一个新鲜的带 token URL，
通过 loopback 路由交给本机工具。三层防护：仅 loopback、每次启动轮换的 32 字节
共享密钥、URL 不落盘不记日志。

### 二、按任务定制工具集

> 完整记录见 **[`docs/experience/按任务定制预设.md`](docs/experience/按任务定制预设.md)**。

**诉求**：跟智能体说清任务，让它现场配一套只含本次所需工具的预设，并建好会话。

**为什么单靠 preset 做不到**——这是最容易踩空的一点。`agent.cordis.yml` 是
**叠加层**不是替代层，官方文档原文：

> 没有本包时，会话只能回退到宿主组装挂载的内容。

preset 能加工具、能覆盖行配置，但**移不掉宿主 profile 已注入的工具**。
本机实测（0.1.x）：白名单 preset 单独使用，工具数 117 → 101，几乎没变。

```
┌─ profile 层 ────────────────────────────────┐
│  cordis.patch.yml（在所有 bundle 之后应用）   │
│  → disabled: true 胜出，能反向关掉 bundle     │
│  → tools/profile-tool-switch.ps1             │
└──────────────────────────────────────────────┘
                    ↓ 决定工具集上限
┌─ preset 层 ─────────────────────────────────┐
│  agent.cordis.yml（叠加层）                   │
│  → 在上限内精确挑选 + 注入 persona 纪律        │
│  → presets/*/agent.cordis.yml                │
└──────────────────────────────────────────────┘
```

| 层 | 作用 | 工具 |
| --- | --- | --- |
| profile | 决定工具集**上限** | `tools/profile-tool-switch.ps1` |
| preset | 在上限内**精确挑选** + 注入 persona 纪律 | `presets/*/agent.cordis.yml` |

```powershell
# 1. 关掉本次任务不需要的 bundle
.\tools\profile-tool-switch.ps1 -Off univer,mnemon-bundle,dsh-taskboard,logicprobe

# 2. 建会话（--register-workspace 不能省，否则侧栏进「未分组」）
dsh-session new --preset plan-executor --workspace-path "C:\your\project" --register-workspace

# 3. 核实真实工具集（读会话日志的 request/header，唯一可信来源）
```

实测 **101 → 14 个工具**，且与 preset 白名单严丝合缝。

> **唯一可信的验证方式是读会话日志**，不是看配置、不是问模型。
> 实测同一预设在「问模型你有哪些工具」时得到过 13 / 2 / 0 三种不同自述结果。

## 它解决什么

**问题一：新建的会话在侧栏看不见。**
DSH 把「还没有任何一轮对话」的会话标记为 `blank: true`，**Web 侧栏会隐藏它**。
`session/create` 明明返回成功、会话也确实存在，但你在界面里找不到。
本工具的 `create` 一站式命令会自动发一条首消息，让它立刻可见。

**问题二：预设有好几个，该用哪个？**
本工具从会话导出里读取 **DSH 发给模型的权威工具清单**，记住每个预设实际提供什么，
再结合你的使用习惯给出**可解释**的推荐：

```console
$ dshstudio recommend --want read,grep,web_search --avoid present,job_output
  review-focused   满足 4/4 项需求；你用过 1 次
  standard         满足 4/4 项需求，多出 2 项不需要的工具；你用过 3 次
  minimal          满足 0/4 项需求，缺少 ['glob', 'grep', 'read', 'web_search']
```

排序**先看功能匹配，用得多的只在打平时加分**——
一个你常用、但缺你明确要求的工具的预设，仍然是错误答案。

**问题三：想靠「问模型你有哪些工具」来判断预设能力。**
这条路不可靠。实测同一预设在自述中得到过 13 / 2 / 0 三种结果。
本工具改读会话归档里的 `request/header` 事件——那是宿主的真实视图。

**问题四：想让智能体按任务现场配工具组合。**
见上一节。这是本次实践新增的部分。

## 装插件（可选，但推荐）

让本机 CLI 自行取得 token，**不必再从终端复制 URL**。插件源码就在本仓库的
`plugin/` 目录。实际只执行一条命令，无需手改任何配置文件：

```bash
dsh plugin --profile web add github:jijiwu3526/dsh-local-bridge
# 然后完整重启 DSH
```

`dsh plugin add` 会装包、登记依赖，并因该包声明了 `dsh.bundle.patch`
而自动挂进层栈。**零运行时依赖**，只用 Node 内置模块。

> 若 `git` 拉不下来（连 `github.com:443` 被 reset），走 tarball + 本地链接的
> 替代路径，见 [`docs/experience/安装与运维.md`](docs/experience/安装与运维.md) 第 1 节。

细节与排障见 [`dsh_bridge/INSTALL.md`](dsh_bridge/INSTALL.md)。

## 三分钟上手

前提：DSH 已在运行，且下面二选一已经做好——

- **已装桥接插件**（推荐）：`dsh plugin --profile web add github:jijiwu3526/dsh-local-bridge`
  后**完整重启** DSH。脚本会自己取得 token，**下面不用传任何 URL**。
- **未装插件**：把 DSH 启动时打印的完整 URL（含 `?token=`）设进环境变量：

  ```bash
  export DSH_WEB_URL='http://127.0.0.1:3080/?token=...'
  ```

```bash
# 1. 看有哪些预设
python3 dsh_session.py presets

# 2. 一站式建会话：创建 + 首发消息（否则侧栏看见）+ 记录这次选择
#    --workspace-id 必填，填 DSH 里已有工作区的 ID
#    （工作区在 DSH 侧栏点开后即可看到其标识）。
#    若手头没有现成工作区，改用 dsh_session.py new --workspace-path <目录>，
#    它会先把目录登记成工作区再建会话。
python3 -m dshstudio.cli create \
    --preset standard \
    --text "开工" \
    --workspace-id <你的工作区ID> \
    --archive records/s.zip \
    --scenario "日常开发"

# 3. 从导出里学习该预设的真实工具面
python3 -m dshstudio.cli observe records/s.zip --notes "日常开发"

# 4. 以后就能问它该用哪个预设
python3 -m dshstudio.cli recommend --want bash,read --avoid present
```

## 目录

| 路径 | 内容 |
| --- | --- |
| `dsh_session.py` | 会话创建、消息发送、日志导出（`presets` / `new` / `send` / `export`） |
| `dshstudio/` | 预设选型记忆（`observe` / `compare` / `recommend` / `habit` / `create`） |
| `docs/` | 设计、协议、留存方案与测试记录 |
| `docs/reviews/` | 独立的代码评审与预设边界测试报告 |
| `presets/` | 实际使用的预设配置留档 |
| `tools/` | 协议保真测试、故障注入与隔离性测试脚本 |
| `templates/` | 需求访谈、规格确认、Creator 施工指令 |
| `tests/` | 67 项自动化测试 |

## 已知边界

- **预设裁剪不到宿主注入的插件。** `mcp__computer_use__*` 这类插件由宿主 profile 注入，
  不在任何预设的权威清单里，却出现在所有会话中。要真正限制工具面，
  必须在宿主配置层处理，改预设无效。
- **会话无法通过 API 删除。** DSH 没有 `session/delete` 端点，误建的会话只能在 Web 侧栏处理。
- **空白会话在侧栏不可见**，因为 DSH 标记 `blank: true`。用 `send` 发一条即可。
- **推荐只覆盖已学习过的预设。** 先 `observe` 若干归档，候选才会变多。
- **记忆文件含本机绝对路径**（`~/.config/dsh-conversation-studio/memory.json`），
  分享前请处理。详见 [会话资料保存方案](docs/会话资料保存方案.md)。
- 面向 DSH 0.1.5-rc.1 验证。DSH 属开发预览，接口会变；
  升级后建议先按 [`docs/协议与版本.md`](docs/协议与版本.md) 核对。

## 开发

```bash
python3 -m unittest discover -s tests -v      # 67 项
export DSH_WEB_URL='http://127.0.0.1:3080/?token=...'
python3 tools/preset_robustness.py            # 故障注入（不消耗配额）
```

## 致谢与依据

协议形状以本机安装的 DSH 生成的 Typert 描述符为准逐项核对，
不依赖文档推测。核对记录见 [`docs/资料来源.md`](docs/资料来源.md)。

MIT 许可。


## 先用起来

1. 安装并启动 DSH Web，设置好模型：`dsh --profile web`。保留终端打印的完整启动 URL（新版带 `?token=...`）。
2. 在 DSH 中新建一个规划会话，复制 [`templates/01-需求访谈提示词.md`](templates/01-需求访谈提示词.md) 作为第一条消息，聊完后把确定的事实填写到 [`templates/02-工作用途与预设规格.md`](templates/02-工作用途与预设规格.md)。
3. 切换到 Creator（或“创造模式”）会话，把 [`templates/03-Creator制作指令.md`](templates/03-Creator制作指令.md) 连同已填写的规格发给它。让 Creator 使用当前 DSH 的官方 Preset/插件管理能力创建预设。到 **设置 → Agent 预设** 检查它健康可用，并点击 **设为默认**。
4. 在本项目目录运行：

   ```bash
   export DSH_WEB_URL='http://127.0.0.1:3080/?token=把DSH启动行里的实际值放在这里'
   python3 dsh_session.py presets
   python3 dsh_session.py new --workspace-path /绝对路径/你的项目 --register-workspace --preset 你的预设ID
   ```

   `--preset` 可以省略，此时 DSH 采用设置页选定的默认预设。首次认证后，Cookie 保存在本机 `~/.config/dsh-conversation-studio/cookies.txt`，后续命令会复用它；也可以把 `DSH_WEB_URL` 改成不带 token 的本机地址。若 Cookie 已失效，脚本会用你传入的 `?token=` 链接自动重新换一次 Cookie；只有在链接也不带 token（或同样失效）时才需要手动删除该缓存。创建结果会写进 `records/<session-id>.json`。

5. 在 Web 中找到新会话并发第一条正式任务消息。空白会话可能暂不显示在侧栏。聊完后保存原始完整日志：

   ```bash
   python3 dsh_session.py export session-实际ID --output records/正式工作会话.zip
   ```

脚本只调用本机运行的 DSH Web；`--workspace-path` 的目录必须已存在。仅 `--register-workspace` 会将目录登记成 Web 工作区；否则会话按 `cwd` 创建，可能归入未分组。可用 `--workspace-id` 直接指定已有工作区——它与 `--register-workspace` 互斥，同时给出会被明确拒绝。

## 命令

```bash
python3 dsh_session.py --help
python3 dsh_session.py presets
python3 dsh_session.py new --workspace-id <id> --preset <preset-id>
python3 dsh_session.py new --workspace-path /path/to/work --register-workspace
python3 dsh_session.py send <session-id> --text "消息" --wait 60
python3 dsh_session.py export <session-id> --output records/session.zip
```

脚本使用 Python 3.10+ 标准库，无需 `pip install`。它先尝试新版 `/api/session/create`、`/api/agentPresets/list`，仅当端点返回 404 时退回旧版点分协议。业务错误不会触发降级，也不会悄悄创建另一个会话。`--session-id` 可用于网络中断后的同 ID 重试，但先核对 DSH 中该 ID 的状态。

### 新建后必须发一条消息

DSH 把「还没有任何一轮对话」的会话标记为 `blank: true`，**Web 侧栏会隐藏这类会话**。
所以 `new` 之后必须发一条消息，它才会出现在侧栏里。这就是 `send` 存在的理由：

```bash
python3 dsh_session.py new --workspace-id <id> --preset <preset-id>   # 拿到 session_id
python3 dsh_session.py send <session-id> --text "开工" --wait 60      # 发一条，进入侧栏
```

`--wait` 会轮询到会话脱离 `blank` 状态为止，并在输出里报告标题与可见性。
不做这一步的话，会话在服务端确实存在、也能导出，但你**在 Web 里找不到它**。

## 预设选型记忆

`dshstudio` 记住每个预设**实际提供什么工具**、以及你**习惯用哪个**，用来回答
「这个任务该开哪个预设」。

```bash
# 一站式：建会话 + 首发消息 + 学习工具面 + 记录这次选择
python3 -m dshstudio.cli create --preset review-focused --text "开工" \
    --workspace-id <id> --archive records/s.zip --scenario "代码审阅"

# 单独使用
python3 -m dshstudio.cli observe records/s.zip --notes "适合只读审阅"
python3 -m dshstudio.cli compare standard review-focused
python3 -m dshstudio.cli recommend --want read,grep,web_search --avoid present,job_output
python3 -m dshstudio.cli habit --cwd /path/to/project
python3 -m dshstudio.cli incident review-focused "挂载失败：prefix missing"
```

记忆文件在 `~/.config/dsh-conversation-studio/memory.json`（0600，原子写入，
损坏时自动重建而非崩溃）。每条画像都记着来源归档，每条偏好都记着会话 ID，
推荐结果完全可解释、可纠正。

**工具面来自会话导出里的 `request/header` 事件**——那是 DSH 发给模型的权威
清单，不是模型自述。这一点很重要：靠「问模型你有哪些工具」会因为格式漂移而
不可靠，实测中它把 `minimal` 报成 13 个工具，而权威值是 1 个。

**推荐先按功能匹配排序，用得多的只在打平时加分**；习惯不会盖过你明确提出的
工具需求。DSH 内置但你没学习过的预设不会出现在候选里。

## 包内内容

| 文件 | 用途 |
| --- | --- |
| `dsh_session.py` | 本机认证、预设校验、会话创建、消息发送、原始日志导出 |
| `dshstudio/profile.py` | 从会话归档提取预设的权威工具面 |
| `dshstudio/memory.py` | 预设画像、使用偏好、故障记录的持久化与推荐 |
| `dshstudio/cli.py` | 记忆与一键建会话的命令行入口 |
| `dsh_bridge.py` | 三级降级链取得带 token 的 URL：桥接插件 → `DSH_WEB_URL` → 裸 origin |
| `plugin/` | `dsh-local-bridge` 的 DSH 插件源码（进程内铸造 token 的那一个） |
| `tools/profile-tool-switch.ps1` | **profile 层工具开关**——preset 动不了宿主注入的工具，这里可以 |
| `presets/` | 实际使用的预设留档。DSH 的 preset API 是只读的，删了即永久丢失 |
| `docs/experience/按任务定制预设.md` | **按任务定制工具集的完整实践记录与踩坑** |
| `docs/experience/安装与运维.md` | 安装路径、git 绕行、本机环境备忘、已知测试失败 |
| `templates/01-需求访谈提示词.md` | 规划会话中的问答流程 |
| `templates/02-工作用途与预设规格.md` | 用户确认的业务规则与预设清单 |
| `templates/03-Creator制作指令.md` | 交给 DSH Creator 的施工任务 |
| `docs/设计稿.md` | 流程、数据模型、边界与验收设计 |
| `docs/会话资料保存方案.md` | 聊天和配置的留存、脱敏与回溯 |
| `docs/协议与版本.md` | 新旧 Web 协议与 Preset 格式演进 |
| `docs/资料来源.md` | 上游依据与核对日期 |
| `tests/` | 协议、画像提取、桥接降级、打包元数据，共 67 项 |

运行测试：`python -m unittest discover -s tests -v`（67 项）。
插件测试：`cd plugin && node --test`（32 项）。

> Windows 上有 2 项 Python 测试与 2 项 node 测试失败，**均为平台差异而非缺陷**：
> NTFS 用 ACL 没有 Unix 权限位，以及中文 Windows 的默认 GBK 解码。
> Linux CI 上 67 项 Python 测试全部通过。
> 详见 [`docs/experience/安装与运维.md`](docs/experience/安装与运维.md) 第 5 节。

---

<a id="english"></a>
# English

## What this is

**117 tools is not a preset. Cut the tool set to the job.** Measured **101 → 14 tools**
on a stock profile. Standard library only, no telemetry.

A toolkit for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) that does two things:

1. **Lets local CLIs authenticate themselves.** DSH prints a startup URL carrying a
   one-shot token; every later `/api` call authenticates with the HttpOnly cookie that
   URL exchanges for. Out-of-process tools therefore need that URL — and the only way to
   get it today is for a human to copy it off the terminal, which puts the token into
   shell history, CI logs and chat transcripts. The plugin in `plugin/` runs *inside* the
   DSH process, where a fresh authenticated URL can be minted on demand, and hands it to
   local tools over a loopback route (loopback-only + a per-boot 32-byte shared secret;
   the URL is never written to disk or logged).

2. **Assembles a task-specific minimal tool set.** Tell the agent what the job is; it
   builds a preset containing only the tools that job needs, then opens a session with it.

## The non-obvious part

An agent preset is an **overlay, not a replacement**. The official package docs say:

> Without this package, a session can only fall back to what the host composition mounts.

A preset can add tools and can shadow a row's config, but it **cannot remove** a tool the
host profile already injects. Measured on a stock `dsh web` profile (0.1.x): a
minimal-whitelist preset alone took the tool count from 117 to 101 — almost nothing, because
the ~100 host tools stayed. The overlay limitation still holds on 0.2, which changed presets
to bundle-patch rows and moved `settings.yaml` into `profiles/<name>/cordis.patch.yml`.

Trimming actually works only when both layers move together:

| Layer | Role |
| --- | --- |
| `~/.dsh/profiles/<p>/cordis.patch.yml` | Decides the **ceiling**. Applied *after* every bundle layer, so `disabled: true` wins. Driven by `tools/profile-tool-switch.ps1`. |
| `agent.cordis.yml` | **Selects precisely** within that ceiling and injects persona discipline. |

Measured result: **101 → 14 tools**, matching the preset whitelist exactly.

## Verify the truth, not the config

Do not trust the config, and do not ask the model. Read the authoritative tool list DSH
actually sent, from the `request/header` event in the session log:

```python
import zstandard, json, io
d = zstandard.ZstdDecompressor()
with open(LOG, 'rb') as fh:            # session.v3.jsonl.zstd, zstd-compressed
    with d.stream_reader(fh) as r:
        for line in io.TextIOWrapper(r, encoding='utf-8', errors='replace'):
            e = json.loads(line)
            if e.get('type') == 'request/header':
                print([x['name'] for x in e['data']['header']['tools']])
                break
```

Asking the model "what tools do you have" is unreliable — measured on this machine, the
same preset produced 13, 2 and 0 tools across three self-reports.

## Gotchas worth knowing

- **Row id ≠ bundle name.** `dsh-mnemon` injects a `cordis:group` whose row id is
  `mnemon-bundle`. Writing `- id: mnemon` fails **silently**.
- **Missing required config reports only the first failing row.** Read the real values out
  of `dsh --profile web --dump-config` instead of fixing them one at a time.
- **`tool-subagent-fork` is not a package** — it is a row *inside* `dsh-tool-subagent`.
- **`persona.prefix` is mandatory**, even when everything you wrote lives in `suffix`.
- **Installed ≠ active.** A dependency absent from `dsh.profile.bundles` with no
  `dsh.bundle` declaration is a dead package; activate it with an `- insert:` row.
- **`--register-workspace` is not optional.** Without it the session gets a `cwd` but no
  `workspaceId`, and the sidebar files it under "ungrouped".

Full detail, including the exact error messages, is in
[`docs/experience/按任务定制预设.md`](docs/experience/按任务定制预设.md).

## Install

```bash
git clone git@github.com:jijiwu3526/dsh-toolsmith.git
cd dsh-toolsmith
python -m pip install .                      # not on PyPI
dsh plugin --profile web add github:jijiwu3526/dsh-local-bridge
# then fully restart DSH (a page refresh is not enough)
```

If `git` cannot reach `github.com:443` but SSH works, see
[`docs/experience/安装与运维.md`](docs/experience/安装与运维.md).

## License

MIT.

---

# 附：随附文档

本工具包随附的设计、协议与流程文档。

| 文档 | 内容 |
| --- | --- |
| [`docs/设计稿.md`](docs/设计稿.md) | 流程、数据模型、边界与验收设计 |
| [`docs/协议与版本.md`](docs/协议与版本.md) | 新旧 Web 协议与 Preset 格式的演进 |
| [`docs/会话资料保存方案.md`](docs/会话资料保存方案.md) | 聊天与配置的留存、脱敏与回溯 |
| [`docs/资料来源.md`](docs/资料来源.md) | 上游依据与核对日期 |
| [`docs/reviews/REVIEW.md`](docs/reviews/REVIEW.md) | 首轮独立评审发现 |
| [`docs/reviews/PRESET-TEST-PLAN.md`](docs/reviews/PRESET-TEST-PLAN.md) | 预设裁剪边界的实测计划与数据 |
| [`docs/测试记录.md`](docs/测试记录.md) | 测试执行记录 |
| [`docs/experience/按任务定制预设.md`](docs/experience/按任务定制预设.md) | **按任务定制工具集**：分层模型、工作流、踩坑（0.1 时代机制，0.2 部分过时） |
| [`docs/experience/DSH-0.2-迁移笔记.md`](docs/experience/DSH-0.2-迁移笔记.md) | **0.1.5 → 0.2.0-rc.1 迁移笔记**：渠道、settings.yaml 移除、Preset 机制重写、认证链断点、迁移检查清单 |
| [`docs/experience/安装与运维.md`](docs/experience/安装与运维.md) | **安装与运维**：git 绕行、本机环境、已知测试失败 |
| [`presets/README.md`](presets/README.md) | 预设留档说明与恢复方式 |
| [`plugin/README.md`](plugin/README.md) | 桥接插件的安全模型与降级链 |

