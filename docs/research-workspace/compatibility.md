# 研究工作台：运行时兼容性

记录每个运行时的适配做了什么，在哪个版本上用什么方式验证过，以及没验证什么。“真实二进制”和“真实运行”是两回事：前者启动本机的程序，但用临时目录当它的主目录，不走账号；后者用用户的账号跑一轮，要用户先同意。

## 1. Codex（T15）

### 1.1 验证过的版本和方式

本机 `codex-cli 0.166.0-alpha.5.1`（2026-11-01）。

| 方式 | 内容 |
| --- | --- |
| 真实二进制，无账号 | `CODEX_HOME` 指向临时目录。读协议 schema，做握手，发未知方法，`thread/start`，`command/exec` 跑沙箱，`thread/fork` 的几种拒绝。没有登录，模型请求返回 401，没有用到任何额度，也没有读用户的 `~/.codex` |
| 假服务器 | `tests/fixtures/runtimes/fake-codex.cjs`，它拒绝的方式照真实服务器写 |

**真实运行没有做**：新建并得到回答、取消进行中的回答、审批、外部客户端占用、恢复后输入一致。这些要用用户的账号，会耗额度、在历史里留下测试会话，等用户同意。

### 1.2 在真实二进制上看到的

| 行为 | 结果 | 怎么处理 |
| --- | --- | --- |
| 握手前发请求 | `-32600 Not initialized` | 假服务器同样拒绝，测试覆盖顺序 |
| 未知方法 | `-32600 Invalid request: unknown variant`，**不是** `-32601` | 两种都认 |
| `thread.id` 和 `thread.sessionId` | 新线程两者相同；**分叉后 id 不同**，`sessionId` 也和来源不同（schema 说是“会话树共用”，实际看到的不同） | 续接和写入只认 `thread.id`，`sessionId` 另存，不据此定位 |
| `thread/fork` 带 `lastTurnId` | 进行中的轮次：`identifies an in-progress turn`；不存在：`turn not found`。不需要声明实验接口 | 见下 |
| `thread/turns/list` | 轮次带 `status`：`completed`、`interrupted`、`failed`、`inProgress` | 分叉前自己查 |
| `thread/read` | 线程带 `status.type`：`notLoaded`、`idle`、`active`、`systemError` | 续接前查，`active` 不续接 |
| `sandbox: read-only` 的命令 | 写入被挡（`Operation not permitted`）；联网被挡；**读工作目录外的文件没有被挡** | 见 1.4 |
| 未登录时 `turn/start` | 回答 `inProgress`，随后反复重连（401），不会很快结束；`turn/interrupt` 能结束它 | 用它验证了取消路径的协议形状，不算真实运行 |

### 1.3 能力探测

`probeCodex(binaryPath)` 返回 `CapabilityReport`。每个进程都用临时的 `CODEX_HOME`，结束后删除。不启动线程和轮次，所以到不了模型。

| 能力 | 怎么得出 | 本机结果 |
| --- | --- | --- |
| `fresh`、`resume`、`observeState`、`cancel`、`approvals` | schema 里列没列相应方法。列了只说明协议有，不说明真实运行时一定如此 | supported |
| `forkAtCompletedTurn` | schema 有 `thread/fork`、`lastTurnId`、`thread/turns/list` | supported |
| `readOnlyRoots` | 真的试：`command/exec` 在只读沙箱里读工作目录内外的文件。读内部成功才算数 | **unsupported** |
| `networkRestriction` | 真的试：连本进程开的本地监听，不出本机。只测了 `command/exec`，文档说它和回合用同样的沙箱形状 | supported |
| `autoContextControl` | 项目说明文件、技能、记忆能否排除，只有跑一轮才看得出来。一律 unknown | unknown |

一份报告在二进制路径和版本不变时一直用；版本变了重新探测。试不了或读不到的，一律 `unknown`，不算 supported。

命令：

```bash
node scripts/probe-runtime.cjs codex <path-to-codex>
```

### 1.4 研究隔离模式在 Codex 上目前不能用

结论：**当前版本的 Codex，研究模式的任务不发送**，提示能力未验证。原因是 `readOnlyRoots` 不成立，`autoContextControl` 未知。工作模式不受影响。

没有去试 `permissionProfile/list` 和配置里的权限配置（schema 里有）。它们也许能限制读取范围；要试就得另外验证，这次没有做。

### 1.5 适配器的行为

- **握手和启动**：同一时间只启动一个服务器，一起等它（L03）。旧服务器退出不再影响新的。握手失败会清理，下次重来。
- **消费路由**：`sessionPath` 续接，`forkEntryId` 是 `lastTurnId`，`mode: 'research'` 走只读。发的字段都在这个版本的 schema 里，提示词按数据传，不经过 shell。
- **分叉**：
  - 探测不支持，拒绝（`fork-unsupported`）；
  - 轮次没完成或不在这个线程里，拒绝（`fork-partial-turn`）；
  - 查不了轮次状态，也拒绝。
- **续接**：线程在这个服务器上 `active`，或服务器说忙，拒绝（`session-busy`），不偷偷开新线程。外部客户端占用只能靠服务器的拒绝发现，`thread/read` 看不到，真实行为没有验证。服务器真实的“忙”文案也没见过，判断用的是 `busy`、`in use`、`locked`、`another client` 这些词，认不出来时按普通错误结束，同样不开新线程。
- **未知方法**：说明这个版本不提供（`method-unsupported`），不换别的路。
- **研究模式**：能力不全或带着要续接的会话，不运行（`research-unverified`）。
- **取消（L01）**：准备阶段每一步之后都检查；停了就不再往下发，提示词不会发出去。`turn/start` 已发出时，拿到轮次 id 立刻中断。
- **绑定**：`session` 事件分别带 `threadId`、`nativeSessionId`；运行结束发 `binding` 事件，带真实的轮次 id 和最后完成的轮次。没完成时，`lastCompletedTurnId` 不是这一轮。节点上记到 `agentSession`。

### 1.6 没做的

- **页面还不会选分叉**：`decideRoute` 不返回 `fork-prefix`，适配器的分叉能力只有测试在用。要等真实运行验证后再打开。
- **续接时的 `lastCompletedTurnId`**：页面没有传给适配器，所以轮次没完成时 `binding` 里的 `lastCompletedTurnId` 是 `null`，节点上这一项不更新。下一步（页面选分叉）时要处理。
- **取消时撤回未决审批、审批幂等**：归 T17。
- **HTTP 断开取消（L04）、Pi 排队取消（L02）**：归 T17、T28。
- **Claude Code 的同类问题（L01、L03 的 Claude 部分）**：归 T16。
- **`legacy` 审批方法**（`applyPatchApproval`、`execCommandApproval`）：回错误，等于拒绝。真实版本是否还会发，没有验证。

## 2. 对计划的调整

计划写的测试文件是 `tests/integration/codex-adapter.test.ts`。实际放在 `tests/host/codex-adapter.test.cjs`：它测的是 Node 模块，和其他宿主测试同一个运行器。
