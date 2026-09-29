# DSH 0.2 迁移笔记（0.1.5-rc.2 → 0.2.0-rc.1）

本文只写**这台机器上实测验证过**的事实，不写推测。凡是未验证的内容都在第 12 节
单独列出并标注「未验证」。

- 起点版本：`0.1.5-rc.2` → 目标版本：`0.2.0-rc.1`
- 宿主包（全部同步到 `0.2.0-rc.1`）：`dsh-llm` / `dsh-agent` / `dsh-subagent` /
  `dsh-tools` / `dsh-user-questions` / `dsh-settings`
- 配套阅读：[`按任务定制预设.md`](按任务定制预设.md)（0.1 时代的方法论）、
  [`本机配置经验.md`](本机配置经验.md)（本机环境基线）

---

## TL;DR：0.2 迁移必知的 5 件事

| # | 事实 | 一句话后果 |
| --- | --- | --- |
| 1 | **0.2 在 npm `next` 渠道，是预发布** | 升级 = 主动跳出稳定渠道，`npm i @deepseek-ai/dsh@latest` 拿不到它 |
| 2 | **`settings.yaml` 被移除，内容自动搬进 profile** | 配置**没丢**，但「配置文件在哪」变了：去 `~/.dsh/profiles/web/cordis.patch.yml` 找 |
| 3 | **Preset 机制是架构级重写** | 0.1 的「目录扫描式 preset」彻底没了，改成「bundle patch 行式」；`agentPresets/list` 会少 preset |
| 4 | **preset 依然裁剪不了宿主工具** | 8 行插件的 preset 实际拿到 **52 个工具**；要减工具只能回 profile 层 |
| 5 | **preset 挂载失败 → 会话 agent 不可用 → send 报 provider 错** | 报错信息是**症状不是病因**；旧会话救不回来，必须新建 |

---

## 1. 版本与渠道（已实测）

### 1.1 dist-tags

实测 `npm` 上的 dist-tags：

| tag | 版本 |
| --- | --- |
| `latest` | `0.1.7-rc.2` |
| `next` | `0.2.0-rc.2` |
| `alpha` | `0.1.7-alpha.2` |

> **0.2 系列走 `next` 渠道，且带 `-rc` 后缀。**
> 也就是说 `latest` 仍然指向 0.1.x 线，`npm install -g @deepseek-ai/dsh`
> 装到的是 0.1 线，**不会**自动升到 0.2。

### 1.2 宿主包版本对齐

实测以下包全部同步到 `0.2.0-rc.1`（读 `package.json` 的 `version` 字段核对）：

```
dsh-llm            0.2.0-rc.1
dsh-agent          0.2.0-rc.1
dsh-subagent       0.2.0-rc.1
dsh-tools          0.2.0-rc.1
dsh-user-questions 0.2.0-rc.1
dsh-settings       0.2.0-rc.1
```

核对命令（PowerShell）：

```powershell
$root="C:\Program Files\nodejs\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
foreach($m in @('dsh-llm','dsh-agent','dsh-subagent','dsh-tools','dsh-user-questions','dsh-settings')){
  $pj=Join-Path $root "$m\package.json"
  if(Test-Path $pj){ "{0,-22} {1}" -f $m,(Get-Content $pj -Raw|ConvertFrom-Json).version }
}
```

---

## 2. `settings.yaml` 被移除并自动迁移（已实测）

### 2.1 事实

- 0.2 **取消了 `~/.dsh/settings.yaml`**。
- 旧文档（尤其 `dsh-lan-proxy` 的提示文字）里还提到「直接编辑 settings.yaml」，**这句在 0.2 已失效**。
- 配置**没有丢**：旧文件的各 section 被写进当前 profile。

### 2.2 代码依据

`@deepseek-ai/dsh-settings` 的 `lib/index.js`（0.2.0-rc.1）里：

```js
// 第 343 行，注释原文
/** Move the sections of the removed `settings.yaml` into the active profile once the Loader has settled every entry.
* The document is renamed before the first write, so a partial import never repeats; a section the running
* composition rejects is logged and remains only in the renamed file. */
async importLegacyDocument() {
    const profile = this.ownerContext.profileContext;
    const path = join(profile.home, "settings.yaml");     // 第 348 行
    if (!existsSync(path)) return;
    const imported = `${path}.imported`;
    await rename(path, imported);
    ...
}
```

两个可核对的机制细节：

1. `removed` 这个词是**官方代码注释里的原词**，不是我们推断的。
2. 导入前**先重命名**为 `settings.yaml.imported`，所以半途失败不会重复导入；
   运行期组合拒绝的 section 会被打日志（`settings: section %s of %s was not imported into entry %s`）
   并且**只留在改名后的文件里**——那一行是排障时会用到的。

### 2.3 迁移目标位置

用户原先写在 `settings.yaml` 里的 **LLM provider 配置**（本机是 `cc-clirelay` 和
`aizex-codex`）现在作为 patch 行存在于：

```
~/.dsh/profiles/web/cordis.patch.yml
```

对应的 row id 是 **`llm-pi-ai`**。核对命令：

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" -Pattern 'llm-pi-ai' -Context 0,6
```

### 2.4 结论

> **数据没丢，但「找配置文件」的位置变了。**
> 任何「去 `~/.dsh/settings.yaml` 改设置」的操作在 0.2 都会静默无效——
> 文件不存在，写了也没人读。改设置要去 profile 的 patch / settings 条目。

---

## 3. Preset 机制是架构级变更（已实测，本节最重要）

### 3.1 0.1 与 0.2 对照

| | 0.1.5-rc.2 | 0.2.0-rc.1 |
| --- | --- | --- |
| 包名 | `@deepseek-ai/dsh-agent-presets` | `@deepseek-ai/dsh-agent-preset-registry` |
| 发现方式 | **扫描** `~/.dsh/.agent-presets/<id>/` 目录 | **不扫描目录，不接受 preset 路径** |
| 产物 | `preset.yml` + `agent.cordis.yml` | 无文件；只有 bundle 里的静态 row |
| 写回 | preset 目录即事实来源 | **没有任何接口接受 YAML 写回** |

### 3.2 官方原文依据

`@deepseek-ai/dsh-agent-preset-registry/README.zh.md` 第 46、48 行原文：

> Web 内置定义来自 `dsh-web-app` bundle。定义使用普通插件行；**注册表不扫描目录，也不接受 preset 路径。**

> 注册表不写入任何声明。……**没有任何接口接受 YAML 写回。新建 preset 或覆盖内置 preset
> 都是 bundle 补丁**：插入一行 `@deepseek-ai/dsh-agent-preset`，或按该行 id 写覆盖补丁，
> 再用 `plugin_manager` 安装到 profile。

### 3.3 0.2 的实际写法（实测可用）

在 `~/.dsh/profiles/web/cordis.patch.yml` 里写一行 patch：

```yaml
- insert:
    - id: preset-ops                    # row id 用 preset-<id> 形式
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ops                         # 真正的 preset id
        name: 号池运维
        description: CliRelay 号池日常运维与事故响应。
        order: 10
        plugins:                        # 内联插件行列表
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                You are the operations owner for the CliRelay account pool ...
              suffix: |
                你的工作目录是 {{cwd}}，但号池在远程服务器 cn-server 上 ...
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
```

要点：

| 要点 | 说明 |
| --- | --- |
| `id: preset-<preset-id>` | **row id** 是 `preset-ops` 形式，`config.id` 才是 `ops`。两者不同 |
| `name` 固定 | 必须是 `@deepseek-ai/dsh-agent-preset` |
| `plugins` 是内联行列表 | 插件直接内嵌在 preset 的 config 里，不再是外部文件 |
| `persona.prefix` 必填 | 0.1 的老坑在 0.2 依然存在 |

实测本机 profile 中已有 4 个这样声明的自定义 preset：

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" -Pattern '^\s*-?\s*id:\s*preset'
# preset-component-executor / preset-cpl-lead / preset-ops / preset-plan-executor
```

### 3.4 内置 preset 变成静态 row

0.2 的内置 preset 是**静态 row**，不再是运行时发现：

```
preset-standard / preset-minimal / preset-ptc / preset-cordis
```

要改内置 preset，写**覆盖补丁**（按 row id），而不是改文件。

### 3.5 迁移期现象

| 阶段 | `agentPresets/list` 返回 |
| --- | --- |
| 修复前 | **4 个**（只剩内置） |
| 用 0.2 新机制重新声明后 | **8 个全部回来** |

> 这是本次迁移最容易误判为「preset 数据丢了」的地方：
> 实际上没丢，是**新机制不再读旧位置**，所以没被列出来。

---

## 4. Preset 依然裁剪不了宿主工具（已实测，机制未变）

### 4.1 0.2 把关键能力做成了官方 experimental bundle

| 包 | 提供的 row / 能力 |
| --- | --- |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | `agent-team` / `tool-agent-team` / `ui-agent-team` |
| `@deepseek-ai/dsh-experimental-schedule-bundle` | `schedule` / `time-context` |
| `@deepseek-ai/dsh-experimental-auto-review` | `auto-review`（提供 `code_review` 工具） |
| `@deepseek-ai/dsh-experimental-voice-input-bundle` | `speech-to-text` |

它们**不在 preset 层，也不在 preset 的控制范围内**——它们是 profile 的 bundle。

### 4.2 实测数字

`ops` preset **只声明了 8 个插件行**，而该会话**实际拿到 52 个工具**。

| 来源 | 工具数 | 备注 |
| --- | --- | --- |
| `univer-office` | 15 | 宿主 bundle，preset 动不了 |
| agent-team | 22 | `task_board_*` + `team_task_*` + `spawn_teammate` + `wait_agent` 等 |
| schedule | 4 | |
| 其余 | — | 来自 `dsh-web-app` 与已装插件 |

### 4.3 结论

> **「preset 是叠加层、裁剪不了宿主工具」这条根本原则在 0.2 完全没变。**
> 要减工具必须回到 **profile 层**（`cordis.patch.yml` 里 `disabled: true`），
> 光改 preset 无效。

这与 0.1 时代 [`按任务定制预设.md`](按任务定制预设.md) 的分层模型是**同一条结论**，
该文档的 profile 层方法在 0.2 依然有效。0.2 的变化是**preset 的声明方式**变了，
不是分层模型变了。

---

## 5. 日志格式 v3 → v4（已实测）

### 5.1 磁盘上

| 版本 | 文件名 |
| --- | --- |
| 0.1 | `session.v3.jsonl.zstd` |
| 0.2 | `session.v4.jsonl.zstd` |

本机 `~/.dsh/sessions/` 下两种文件**同时存在**（升级前的旧会话还是 v3）。

### 5.2 导出的 ZIP

`dsh-session export` 产出的 ZIP 内部是 **`session.v4.jsonl`，纯文本，不是 zstd**。

> 读导出件不要套 zstd 解压，直接按 UTF-8 逐行 JSON 解析。

### 5.3 `dsh-conversation-studio` 实测完全兼容

`dshstudio observe <zip>` 正常识别 preset 和全部工具，**不需要改一行代码**。

原因：`profile.py` 是按 **`.jsonl` 后缀**找文件的，v4 正好匹配。

```powershell
# 导出后再读，无需 zstandard
python -m dshstudio.cli observe records\s.zip --notes "日常开发"
```

---

## 6. dsh-session 工具链在 0.2 的可用性（已实测）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| `agentPresets/list` | ✅ 可用 | 修复前只返回 4 个内置 |
| `session/list` | ✅ 可用 | 实测返回 332 个会话 |
| `session/create` | ✅ 可用 | **必须带 `--register-workspace` 才进具名分组** |
| `session/prompt`（`dsh-session send`） | ⚠️ 修复前失败 | 见 6.2 |

### 6.1 `--register-workspace` 的坑在 0.2 依然存在

0.1 时代的结论**没有变**：不带 `--register-workspace`，会话只有 `cwd` 没有
`workspaceId`，侧栏归入「未分组」。

### 6.2 `session/prompt` 的报错与真正的病因

修复前 `dsh-session send` 报：

```
session/model-unavailable — no adapter serves provider "direct-deepseek"; select a model for this session
```

根因排查结果：

| 检查项 | 实际值 |
| --- | --- |
| `direct-deepseek` 这个 provider id | **在任何配置里都不存在** |
| 本机默认模型 | `cc-clirelay/space-bunny-alpha` |
| 真正症状 | 新建会话的 **`agentAvailable: false`**（agent 侧没起来） |

用 0.2 新机制重新声明 preset 之后，新建的会话 **`agentAvailable: true`**，`send` 成功。

> **教训（本文最值钱的一条）**：
> `provider not found` 是**症状不是病因**。
> 看到「某个 provider 不存在」的报错，先去查 `agentAvailable`，
> 再回头查 preset 挂载——**preset 挂载失败会让会话 agent 不可用**，
> 而这个不可用在上层被翻译成了一个误导性的 provider 报错。

### 6.3 旧会话救不回来

preset 修复**之前**创建的会话，`agentAvailable` 永远是 `false`，
不管怎么重发消息都救不回来。**必须新建会话**。

---

## 7. CLI 参数顺序的坑（已实测）

### 7.1 `--url` 是全局参数，必须放在子命令之前

```bash
# ❌ unrecognized arguments
dsh-session send <sid> --text "..." --url http://127.0.0.1:3080

# ✅ 正确
dsh-session --url http://127.0.0.1:3080 send <sid> --text "..."
```

### 7.2 消息里含 `&&` 时 PowerShell 会把它当参数分隔符

`&&` 在 PowerShell 中是**命令分隔符**，出现在 `--text` 的值里会被切碎。

两种可靠做法：

- 用 Python subprocess 转发（不走 shell 解析）
- 把消息写进文件，从文件读内容再传

---

## 8. 认证链在 0.2 的断点（已实测）

### 8.1 现象

`dsh-local-bridge` 插件被移出 profile 依赖（磁盘上**文件还在**
`~/.dsh/profiles/web/node_modules/`，但不在 bundle 列表里），
所以 `/local-bridge/auth` 路由返回 **404**。

`dsh_bridge.py` 的三级降级链（桥接插件 → `DSH_WEB_URL` → 裸 origin）中，
**bridge 这一级失效**。

### 8.2 可用的临时方案

从启动日志里 grep 启动 token。日志形如：

```
dsh web: http://127.0.0.1:3080/?token=XXXX
```

```powershell
# 日志位置
Select-String -Path "$env:USERPROFILE\.dsh\dsh-launch-0.2.log" -Pattern 'token='
```

拿到后配 `DSH_WEB_URL` 环境变量。

> ⚠️ **token 每次重启都变，不能硬编码进任何文件或提交。**
> 迁移期间每次重启 DSH 后都要重新取一次。

---

## 9. 旧插件的移除与恢复（已实测）

### 9.1 被物理移除的 13 个

```
dsh-logicprobe
dsh-mnemon
dsh-taskboard
dsh-code-index
@nanmicoder/dsh-agent-teams
@liustack/modlens
@liustack/modsearch
@x1a0f3n9/dsh-context
dsh-codebase-memory-mcp
dsh-file
dsh-tokensaver
@wingsky-1/dsh-gzip
dsh-file
```

> 清单按实测记录原样保留——`dsh-file` 出现两次，
> 这也是实测记录的原样，未做去重「美化」。

### 9.2 profile 瘦身幅度

| 指标 | 升级前 | 升级后 |
| --- | --- | --- |
| `package.json` 字节数 | 2104 | 1020 |
| bundles 数量 | 27 | 14（迁移后又加回 5 个） |

### 9.3 恢复情况

- 已恢复：`@michengai/dsh-code-review` `0.1.8`（该版本支持到 `0.2.0-rc.1`）。

### 9.4 重要发现：没有版本硬阻塞

这批被移除的插件**大多数不声明 `engines.dsh`**——实测抽查 **11 个全是 `None`**。

| 后果 | 说明 |
| --- | --- |
| 好消息 | 装回去**不会被版本检查拒绝** |
| 坏消息 | 能否正常运行**只能逐个实测**，没有静态判据 |

### 9.5 唯一明确声明版本要求的：`@linxin666/dsh-ssh`

- 版本 `0.4.4`，是**唯一明确声明 `engines.dsh >= 0.2.0-rc.1` 的**插件。
- 它依赖 **0.2 才有的 `configForms` 服务**。
- 因此在 `0.1.5-rc.2` 上**永远卡在 pending**（此前已被误判为被拒）。

> 这条同时说明：**「卡 pending」和「被版本拒绝」是两种不同的失败**，
> 前者通常意味着缺某个运行时服务（像 `configForms`），后者才是版本号不匹配。

---

## 10. 本机环境（已实测）

| 项 | 值 / 结论 |
| --- | --- |
| PowerShell | **5.1** |
| 中文输出 | 需 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` + `$env:PYTHONIOENCODING='utf-8'` |
| Python | **`python` 命令在某些情况下解析到不含 `zstandard` 的解释器** |
| 读会话日志 | 必须用绝对路径 `C:\Program Files\Python312\python.exe` |
| git → github.com HTTPS | **会被 reset，不通** |
| git → github.com SSH | **正常** |
| push 走 | **SSH** |

```powershell
# 读会话日志的安全写法
& 'C:\Program Files\Python312\python.exe' -c "..."
```

> 坑的本质：`python` 命中了哪个解释器取决于当前 PATH / App Execution Aliases，
> 不稳定。凡是依赖 `zstandard` 的脚本都别用裸 `python`。

---

## 11. 迁移检查清单

### 11.1 升级前

- [ ] 确认目标渠道是 `next`（**0.2 是预发布，不是 `latest`**）
- [ ] 备份 `~/.dsh/`（至少 `profiles/*/cordis.patch.yml` 与 `settings.yaml`）
- [ ] 留档现有 preset 定义——**0.2 的 preset API 是只读的，删了就没了**
- [ ] 记录升级前的 `package.json` 字节数与 bundles 列表，用于对比

### 11.2 升级后立即核对

- [ ] 宿主包版本是否全部为 `0.2.0-rc.1`
- [ ] `~/.dsh/settings.yaml` 是否已消失；旧 provider 配置是否出现在
      `~/.dsh/profiles/web/cordis.patch.yml` 的 `llm-pi-ai` 行
- [ ] `agentPresets/list` 返回数量：**4 个 = preset 全丢了**（要按第 3 节重新声明）
- [ ] 新建会话后 `agentAvailable` 是否为 **`true`**
- [ ] `dsh-session send` 是否成功（`provider not found` 先查 `agentAvailable`）

### 11.3 Preset 迁移

- [ ] 每个自定义 preset 改写成 `id: preset-<id>` 的 bundle patch 行
- [ ] `config.id` 与 row id 分清（`preset-ops` vs `ops`）
- [ ] `persona.prefix` 已填（必填项）
- [ ] 重新声明后 `agentPresets/list` 数量与迁移前一致
- [ ] **preset 修复前创建的会话全部作废，重新建会话**

### 11.4 工具面核对

- [ ] 读会话日志 `request/header`，核对真实工具数
- [ ] 确认「preset 声明 8 个插件 → 实际 52 个工具」这类叠加现象符合预期
- [ ] 确认用减工具走的是 **profile 层** `disabled: true`，不是改 preset

### 11.5 工具链与认证

- [ ] `session/list` 正常
- [ ] `session/create` **带 `--register-workspace`**
- [ ] `/local-bridge/auth` 是否仍 404；是则改用 `DSH_WEB_URL`（**token 每次重启都变**）
- [ ] `dsh-session --url ... send ...` 参数顺序正确
- [ ] 消息含 `&&` 时改走 Python subprocess 或文件

### 11.6 插件

- [ ] 对比 bundles 列表，识别被移除的插件（见第 9.1 节清单）
- [ ] 抽查 `engines.dsh` 是否为 `None`（无静态阻塞）——**能否运行仍需逐个实测**
- [ ] `@linxin666/dsh-ssh` 需要 `>= 0.2.0-rc.1`（依赖 0.2 才有的 `configForms`）

### 11.7 日志与本机环境

- [ ] 新会话落盘为 `session.v4.jsonl.zstd`
- [ ] `dshstudio observe <zip>` 能识别 preset 与工具（预期**无需改代码**）
- [ ] 读日志用 `C:\Program Files\Python312\python.exe`，不用裸 `python`
- [ ] `git push` 走 **SSH**（HTTPS 会被 reset）

---

## 12. 未验证 / 待确认

以下内容本次**没有实测**，属于推测或未完成验证，**不要当结论用**：

| 项 | 状态 |
| --- | --- |
| `0.2.0-rc.2`（`next` 当前版本）与 `0.2.0-rc.1` 的差异 | **未验证**。本文所有实测均针对 `0.2.0-rc.1` |
| 被移除的 13 个插件逐个装回后的运行情况 | **未验证**。只验证了「无 `engines.dsh` 阻塞」 |
| `settings.yaml.imported` 里被拒绝的 section 有哪些 | **未验证**。只确认了代码路径存在 |
| `preset-standard` / `minimal` / `ptc` / `cordis` 四个内置 preset 的覆盖补丁写法 | **未验证**。README 说明了机制（按 row id 写覆盖），本机未实际执行过 |
| `dsh-lan-proxy` 等插件提示里「直接编辑 settings.yaml」的文案何时更新 | **未验证** |
| `0.1.7-rc.2`（`latest`）与 `0.1.5-rc.2` 的差异 | **未验证** |
| 旧 v3 会话日志被 `dshstudio` 处理的边界行为 | **未验证**。只实测了 v4 导出件 |
