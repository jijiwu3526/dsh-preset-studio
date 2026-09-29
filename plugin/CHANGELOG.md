# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.2] — 2026-09-29

### 修复

- **重载一次，插件就永久失效**（`ctx.webServer.register()` 的返回值被丢弃）。
  `register()` 返回一个移除路由的 disposer，而且**遇到重复路径会直接抛错**。
  原写法把 disposer 扔掉了，于是旧路由在卸载后仍留在路由表里；下一次
  `apply()`——无论 HMR 重载还是改配置——就死在
  `webserver: duplicate exact route "/local-bridge/auth"` 上。
  更糟的是 cordis 会把这个异常吞进一个死掉的 fiber，进程照常运行，
  最终状态是**既没有路由也没有密钥文件**：一次静默且永久的桥接中断。

  这是与 0.1.1 三个问题**同一类**的第四个——「注册了资源却没有归属它的
  effect」。改法与其他所有 DSH 插件一致：

  ```js
  ctx.effect(() => ctx.webServer.register({ ... }), "dsh-local-bridge: route");
  ```

  复现与验证都对着真实的 `dsh-host-webserver` 语义做过。
- **测试脚手架看不到这类 bug**。原来的 mock `register()` 只是往数组里 push，
  从不释放任何东西，所以「disposer 被丢弃」在结构上不可能被测出来。
  现在 mock 忠实还原宿主语义：记录到共享表、返回移除路由的 disposer、
  重复路径抛错。
- README 与 `dsh_bridge/INSTALL.md` 里 `webserver` 的大小写更正为
  `webServer`——与 0.1.1 修的是同一个错，只是这次在正文里。

### 新增

- 4 项测试：路由随插件停止而释放、重载后可再次注册同一路径、
  「不释放就会抛错」的反向对照、响应里的 `secretPath` 与导出的 `name`
  （Python 客户端会读 `secretPath`，写错等于让用户去找一个不存在的文件）。

## [0.1.1] — 2026-09-29

### 修复

这一版修的是**插件根本加载不起来**的三个问题。0.1.0 虽已发布，但源码在
任何 Node 上都会在 import 阶段抛 `SyntaxError`——也就是说，此前任何按文档
执行 `dsh plugin add` 的人，装上的是一个不工作的插件。

- **`randomBytes` 从 `node:fs` 导入**：它属于 `node:crypto`。
  `import { randomBytes } from "node:fs"` 是语法错误，模块加载即失败：
  `The requested module 'node:fs' does not provide an export named 'randomBytes'`。
  注意 `node --check` **不会**报这个错——它只做语法解析，不解析 ESM 的
  具名导出，所以纯语法检查无法发现。
- **`inject` 里服务名大小写写错**：写的是 `webserver`，而宿主服务名为
  `webServer`。即使前一个问题修好，插件也不会被注入，路由不会注册。
- **`ctx.effect` 用法错误**：`ctx.effect` 要求回调**返回**一个 disposer，
  原写法 `ctx.effect(() => unlinkSync(path))` 会在启动时就把密钥文件删掉、
  且什么都没注册——密钥文件因此活过进程生命周期。改为
  `ctx.effect(() => () => unlinkSync(path))`。
- **`SECRET_PATH` 改为惰性求值**：原先在模块加载时求值，冻结了当时的
  `DSH_HOME`；若之后在另一个 home 下重新激活，密钥会写到客户端找不到的
  地方。
- **`lib/types/index.d.ts` 的 `BRIDGE_PATH` 类型与实际值不符**：声明为
  `"/api/local-bridge/auth"`，实际是 `"/local-bridge/auth"`。

### 新增

- **测试套件**（`test/index.test.js`，28 项，`node:test`）—— 此前的 144 行
  插件代码没有任何测试。覆盖：三道防护各自真的会挡（禁用任一守卫，测试即
  失败）、密钥每次启动重新生成、密钥文件 0600 且在预置为 0644 时收紧、
  停止时删除、拒绝时不铸造任何 URL、铸造失败返回 500 而非崩溃。
  测试全部使用临时 `DSH_HOME`，不触碰真实安装。
- `package.json` 加 `"test"` 脚本。

### 验证

对每个修复都做了变异测试（把修复改回原样，确认测试变红）：

| 变异 | 结果 |
| --- | --- |
| 改回 `node:fs` 导入 | 28 项全红 |
| 改回 `webserver` | 1 项红 |
| 改回 `() => unlinkSync(...)` | 22 项红 |
| 停用 loopback 守卫 | 6 项红 |
| 削弱密钥比较 | 3 项红 |

## [0.1.0] — 2026-09-27

初始版本：在 DSH 进程内注册 `/local-bridge/auth`，让本机 CLI 通过
loopback + 每次启动的 32 字节共享密钥自行取得带 token 的 URL。

⚠️ 这个版本无法加载，请直接升级到 0.1.2。
