# 研究工作台：Agent 续接会话的判断（T14）

记录日期：2026-10-17。T14 是 M3 的一项（计划第 12 节的 T14 条目），建立在 T11 的运行信封上。

## 1. 做了什么

画布可以镜像一个 Agent 会话（Codex、Claude Code 的原生会话），在会话最后一轮下面接着提问时，可以有两种做法：

- 接着原会话问：只发送新问题；
- 新开一个会话：把整段上下文编好发过去。

原来的规则只检查四件事：问题只有一条入边；父节点是镜像会话的最后一轮；工作目录一致；会话记录文件存在。它不看画布上面的内容还是不是原会话里的内容。所以在画布上改了上面的回答、连了材料、设了角色以后，仍然会接着原会话问。这时 Agent 看到的是原会话里的旧内容，画布上的改动它看不到。

现在，这四项检查是必要条件，但不够。还要比较两样东西：

- **原会话里有什么**：沿对话链往上，每个导入的轮次都留着导入时的问题和回答（`source`），画布后来怎么改都不影响它。
- **这次运行要给什么**：运行信封里，问题之前的全部消息。

只有两者完全一样、没有任何多余内容时，才接着原会话问。否则新开会话，把全部上下文发过去，并写明原因：

| 情况 | 结果和原因 |
| --- | --- |
| 上面完全是原会话的轮次，内容未改 | 接着原会话问（`same-conversation`） |
| 上面的问题或回答在画布上改过（包括高亮标注、过期标记改变了交给模型的文字） | 新开（`edited`） |
| 上面连了原会话里没有的材料、附件或其他回答 | 新开（`materials`） |
| 设了角色 | 新开（`role`） |
| 加了记忆或回忆 | 新开（`memory`） |
| 上面的轮次和原会话对不上（归档了一轮、多了一轮、不是同一段） | 新开（`conversation`） |
| 有一轮导入时没留下原文，无法确认原会话里有什么 | 新开（`unknown-history`） |
| 不是接在最后一轮后面 | 新开（`not-the-last-turn`）。从中间分叉还没验证可行，所以不分叉 |
| 研究隔离 | 新开（`research`）；Agent 还没验证能隔离时直接不发送（`research-unverified`） |
| 运行时报告不支持续接 | 新开（`resume-unsupported`） |
| 已知原会话正在别处使用 | 不发送（`session-busy`） |

排除规则也按同样的方式判断：

- 上面的节点排除了某份附件，问题继承了这条排除：上面的内容仍和原会话一致，可以接着问。
- 问题把这份附件重新纳入：多了原会话里没有的内容，新开会话。

判断必须在运行准备好之后做。没有信封时一律新开（`not-prepared`）。运行路径因此改成：先冻结、准备信封、检查权限，再决定续接还是新开，然后写运行记录、发送。判断不能执行时（例如已知原会话正在别处使用），这次运行不发送，并写明原因。

每次运行的路由结果记在回答版本的运行摘要里（`lastRun.route` 和 `runs[i].route`）。任务面板上会显示一行，例如“这一版：新开了会话（上面的问答在画布上和原会话里的不一样了）”。

## 2. 另外修正：附件按完整内容判断是否相同

原来判断两份附件是否相同，只看“文件名、大小、前 100 个字”。两份同名、同长度、开头相同、后面不同的文件，会被当成同一份，导致：

- 只有一份进入上下文；
- 往同一个节点上添加时，第二份会被丢掉。

现在改为看文件名、类型和完整内容（`attachmentIdentity`）。同一份文件给两次，比如沿对话链继承下来、或重复添加，仍然只算一次。改了三处：

- 上下文构建；
- 往节点添加附件；
- 面板里继承附件的列表。

导出包里的 `fingerprint` 字段没有改。这条原本是 T25 登记在 T11 名下的缺口测试，现在通过。

## 3. 文件

| 文件 | 内容 |
| --- | --- |
| `src/lib/agents/runtime-binding.ts` | `findBinding`、`bindingFor`：找到可以接着的镜像会话，以及原会话里有什么（`holds`）；找不到时给出原因 |
| `src/lib/agents/route-policy.ts` | `inspectExpectedPrefix`（`equal`、`changed`、`unknown`）、`decideRoute` |
| `src/lib/agents/agent-runtime.ts` | `agentOutbound(model, nodeId, envelope?)`：路由由信封决定；结果带 `decision`。导出 `agentSessionFile` |
| `src/store/streaming.ts` | 准备运行之后再决定路由；无法执行时不发送；路由记入运行摘要 |
| `src/lib/context/run-records.ts`、`src/types.ts` | 运行摘要多了 `route` |
| `src/components/workspace/StaleSection.tsx` | 显示这一版的路由及原因 |
| `src/lib/attachments.ts`、`src/store/context-builder.ts`、`src/store/slices/attachments.ts` | `attachmentIdentity` |
| `src/i18n/zh.ts`、`en.ts` | `route.*` |

## 4. 测试

- `tests/unit/route-policy.test.ts`，13 条：
  - 内容未变时接着原会话问，并给出原因；
  - 以下五种情况各一条，都新开会话：改了回答、改了问题、连了附件、设了角色、归档了一轮；
  - 排除和重新纳入；
  - 原文未知；
  - 没有信封；
  - 不是最后一轮；
  - 研究隔离；
  - 运行时报告不支持续接、会话正在别处使用；
  - 走真实运行路径：加了记忆就新开会话并带上全部上下文，没加就只发问题。

  实现之前全部失败（`evidence/T14-route-policy-before-implementation.txt`）。
- `tests/unit/agent-context-baseline.test.ts`：T25 登记的两条 `[T14]` 缺口（上面的回答在画布上改过时新开会话；把改过的文字交给 Agent）和一条 `[T11]` 缺口（同名同前缀的两个文件都进入提示词）现在通过，改为普通测试。辅助函数改为先准备信封，再决定路由。
- `tests/unit/attachment-identity.test.ts`，2 条：开头相同、后面不同的两个文件都进入上下文，同一个文件只进入一次；同一个节点上能保留这两个文件，不会重复添加同一个文件。修正之前都失败（`evidence/T11-attachment-identity-before-fix.txt`）。
- `tests/unit/stale-section.test.tsx` 新增 1 条：面板显示这一版的路由及原因。实现之前失败（`evidence/T14-route-line-before-implementation.txt`）。
- 全部回归（2026-10-17，macOS）：

| 检查 | 结果 |
| --- | --- |
| `npm run lint`、`npx tsc -b`、`npm run build` | 通过 |
| `npm run test:unit` | 650 通过，1 条预期失败 |
| `npm run test:host` | 437 通过 |
| `npm run test:contracts` | 193 + 91 通过 |
| `npm run test:e2e` | 3 通过 |
| `npm run test:e2e:desktop` | 74 通过 |
| `test:layout`、`test:live-log`、`test:subagents` | 通过 |

剩下的预期失败只有一条 `[T28]`（任务不应继承另一条对话线上的长期审批），以及宿主侧的一条 `[T27]`（同一工作目录下，一个任务读得到为另一个任务写的材料）。

## 5. 和之前行为不同的地方

- **镜像会话的续接更严格了。** 上面有任何改动或额外内容时都新开会话，并带上全部上下文。花费会多一些，但 Agent 看到的就是画布上的内容。
- **在本次更新之前导入、没有留下 `source` 的会话轮次**：无法确认内容，所以新开会话。重新导入或刷新镜像后，就能正常续接。

## 6. 没做的和限制

- **能力报告**：`capabilitiesOf` 对所有运行时都返回“未知”。续接因此只在运行时明确报告不支持时才禁止；从中间分叉一律不做。真实的能力探测属于 T15、T16。
- **原会话的状态（空闲、忙、锁定）现在没有观察。** 只有当它被报告为忙时才拒绝发送；观察属于 T15、T17。
- **只比较内容**：比较的是问答文字，不比较原生会话里的工具调用和中间步骤。画布上本来就没有这些内容。
- 只在替身上验证过，没有在真实的 Codex 和 Claude Code 上验证（见 T15、T16）。
