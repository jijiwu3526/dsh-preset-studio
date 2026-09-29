# dsh-local-bridge

让本机 CLI **自行取得** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 的带 token URL —— 不再需要人工从终端复制。

## 问题

DSH 启动时打印一个带一次性 token 的 URL：

```
http://127.0.0.1:3080/?token=<40位随机串>
```

之后所有 `/api` 请求靠它换发的 HttpOnly Cookie 鉴权。进程外的命令行工具因此需要那个 URL —— 但目前唯一的获取方式是人从终端抄下来，于是 token 会进入 **shell 历史、CI 日志、聊天记录**。

## 解决

插件跑在 DSH **进程内部**，那里 `ctx.connection.authenticatedUrl()` 能现场铸造一个新鲜有效的 URL。装上之后：

```bash
python3 dsh_session.py presets      # 直接能跑，不必传 --url
python3 dsh_bridge.py --quiet       # 打印带 token 的 URL
```

**零依赖**：只用 Node 内置模块，不 import 任何 `@deepseek-ai/*` 包，不会和其他插件冲突。

## 安装

```bash
dsh plugin --profile web add github:jijiwu3526/dsh-local-bridge
# 重启 DSH
```

`dsh plugin add` 会自动装包、登记 `dependencies`，并因该包声明了 `dsh.bundle.patch`
而把它挂进 `dsh.profile.bundles` 层栈。**不需要手改任何配置文件。**

> ⚠️ 只把目录复制进 `node_modules/` 是不够的 —— DSH 会完全看不到它。
> 实测确认：未登记的目录在 `--dump-config` 里条目为 0。
> 手工往 `cordis.patch.yml` 插条目虽能生效，但 `dsh plugin list` 认不出，
> 后续 pnpm 操作可能清掉。**请用官方命令。**

## 验证

```bash
dsh plugin --profile web list | grep dsh-local-bridge      # 装上了吗
dsh --profile web --dump-config | grep -c dsh-local-bridge # 应为非 0
python3 dsh_bridge.py                                       # source 应为 bridge-plugin
```

## 安全模型

路由会交出凭据，因此有三层防护：

| 防护 | 作用 |
| --- | --- |
| **仅 loopback** | `Host` 头必须是 loopback 字面量。经隧道或 DNS rebinding 进来的请求**在铸造 token 之前**就被拒绝 |
| **每次启动的共享密钥** | 启动时生成 32 字节随机密钥，写入 `~/.dsh/local-bridge.secret`（`0600`），调用方必须回传 |
| **URL 不落盘** | 带 token 的 URL 只在响应体里出现一次，不写文件、不进日志 |

**不防御什么**：以同一用户身份运行、且能读取密钥文件的进程。但这样的进程本来就能附着到 DSH 进程上。威胁模型是「走失的本机工具与意外泄露」，不是「已在你账号下运行的恶意软件」。

## 为什么路由不在 /api 下

DSH 在派发之前先对**整个 `/api` 通道**做鉴权：

```js
const rejection = connection.requestRejection(req);
if (rejection !== void 0) { res.writeHead(rejection); res.end(...); return; }
await bridge(req, res, fetchHandler, ...);
```

所以挂在 `/api` 下的桥接，恰恰只有它要服务的那个**未认证**调用方访问不到 ——
先有鸡还是先有蛋。本插件的首版就踩了这个坑，自己的路由返回 401。
现在经 `ctx.webServer.register` 挂在 `/local-bridge/auth`，脱离鉴权通道，
保护该路由的责任随之落到插件自己身上（即上面那三层）。

## 故障排查

| 现象 | 原因 |
| --- | --- |
| `dsh plugin list` 里没有它 | 没用 `dsh plugin add`，只复制了目录 |
| `--dump-config` 找不到 | 同上，或装完没重启 |
| 403 `bad-secret` | 密钥已随 DSH 重启轮换。重新读 `~/.dsh/local-bridge.secret`（程序会自动） |
| 404 | 插件没加载 |
| 401 `unauthorized` | 路由被误挂在 `/api` 下，必须是 `/local-bridge/auth` |

## 卸载

```bash
dsh plugin --profile web remove dsh-local-bridge
```

密钥文件在进程退出时自动删除。

## 升级

⚠️ **从 0.1.0 或更早升级，必须完整重启 DSH，不能只替换文件。**

0.1.0 把 `webServer.register()` 返回的 disposer 丢掉了，于是旧路由在插件
卸载后仍留在路由表里。0.1.1+ 修好了，但若你只是把文件换上去，新实例会撞上
`webserver: duplicate exact route "/local-bridge/auth"` 而加载失败——
此时进程里既没有路由也没有密钥文件，桥接会一直不通，直到你**完全退出并重启
DSH**（不是改配置，是进程重启）。

```bash
dsh plugin --profile web add github:jijiwu3526/dsh-local-bridge
# 然后完整重启 DSH 进程
```

验证是否已到 0.1.2：

```bash
grep '"version"' ~/.dsh/profiles/web/node_modules/dsh-local-bridge/package.json
```

## 前提

- DSH **≥ 0.1.5-rc.1**（`engines` 声明）
- 需要 `webServer` 与 `connection` 两个宿主服务，因此装在 **web profile**。
  其它 profile 请把命令里的 `web` 换成对应名字。

## 配套工具

[dsh-skillmaster](https://github.com/jijiwu3526/dsh-skillmaster) 是配套的
Python CLI（会话创建/归档 + 预设选型记忆）。装上本插件后它能自动认证。

MIT 许可。
