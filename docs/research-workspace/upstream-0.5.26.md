# 研究工作台：与上游 0.5.26 衔接

记录日期：2026-10-26。把上游 `chenxiachan/thoughtdag` 的 0.5.17 至 0.5.26（`5e3318a`）合入 `research-workspace`。

## 1. 上游历史重写

本分支是从上游 0.5.16（`b3616c0`）开出来的。之后上游重写了 0.5.13 至 0.5.16 这几个提交：内容不变，哈希变了。新的 0.5.16 是 `4fb1032`，它的文件树和 `b3616c0` 完全相同。

如果直接合并，git 会把 0.5.12 当成共同祖先。0.5.13 至 0.5.16 里两边一致的改动也会被报成冲突，涉及 22 个文件。所以分两步合并：

1. 用 `-s ours` 方式并入 `4fb1032`。不改任何文件，只记录“这段历史已经包含”。
2. 再合并 `origin/main`。共同祖先变成 0.5.16，真正有冲突的只剩 13 个文件。

本地的 `v0.5.13` 至 `v0.5.16` 标签仍指向旧提交。标签只在本地，按约定也不推送。

## 2. 冲突怎么解决的

| 文件 | 上游改了什么 | 怎么合 |
| --- | --- | --- |
| `desktop/main.js` | 关窗口时隐藏而不是退出，Windows 和 Linux 可以放到托盘（#77）；更新安装时加了 `quitting` 标记 | 两边都保留。上游新增的 `shell:tray` 和 `update:install` 改用我们的 `handle()` 注册，所有通道都要先核对调用方 |
| `src/desktop-bridge.d.ts`、`src/lib/agents/http-bridge.ts` | 权限模式新增 `auto`；新增由宿主写本地备份的 `backupJson`（#66、#67） | 采用 `auto` 和 `backupJson`；保留我们的 `materialize`，不恢复已删除的 `writeMaterials` |
| `src/lib/api.ts` | harness 参数加了 `permission` | 和我们的 `effort` 都保留 |
| `src/store/projects.ts` | `agentGuard.mode` 改为 `AgentPermissionMode` | 采用上游类型，保留我们的 `workspaceId` |
| `src/lib/content.ts` | 新增节点前先记一个撤销点，再读取最新状态（#79） | 采用上游写法，保留我们的 `more` 参数 |
| `src/store/context-builder.ts` | 指纹用 `compileContext(…, 'raw')`，工具步骤的新写法不让旧回答误判为过期（#74）；支持笔记本 | 指纹同时保留两边：去掉导图布局、按 `raw` 编排；附件去重仍用我们的 `attachmentIdentity` |
| `src/store/slices/nodes.ts` | 已归档的回答不算过期（#51） | 用我们按原因判断过期的写法，并把“已归档不算”加进 `detectStale` |
| `src/store/streaming.ts` | 发送前按模型把执行记录改写成三种说法之一：给 Agent 的、声明了工具的、什么工具都没有的 | 这一步放在准备运行信封之前，让信封里的消息就是实际发出的消息；工具设置仍只算一次；请求里仍写明任务绑定的模型 |
| `src/components/MaterialReader.tsx` | 阅读器停靠在画布左侧（#65）；支持笔记本；PDF 页上的对话气泡移到页边（#81） | 我们之前把 `PdfPage` 拆到了 `readers/PdfPage.tsx`，上游这次对它的唯一改动（气泡位置）移植到那里 |
| `src/lib/viewer.ts`、`src/lib/attachment-vault.ts` | 笔记本 | 两边都保留 |
| `package-lock.json` | 新增 mermaid；补回了 npm 10 需要的嵌套条目 | 以上游的锁文件为底，把我们原来锁定的包按原版本补进去（npm 自动解析会把测试工具升到新版本，所以没有用它）。两边都有、版本不同的 4 个包取我们原来的版本。上游原有的条目一个都没删，`npm ls` 无报错 |

## 3. 合并后另外改的

- **撤销历史和文件节点**（`src/store/slices/history.ts`）。上游 0.5.22（#79）在每次撤销、重做前，先比较“人做的改动”和当前快照，没被记录的改动会自成一步。但文件节点的副本和 `resourceHint` 是跟着磁盘文件更新的，不是人做的。如果把它们算进去，另一个程序改了文件之后，第一次撤销撤掉的是“副本更新”，而不是人刚才做的那一步。现在：
  - 比较时，文件节点的这两项不算；
  - 恢复快照时，仍指向同一个文件的节点保留它此刻的文件状态；
  - 节点指向哪个文件（`resourceRef`）仍然算人做的改动。

  这和 T07 的规则一致：节点显示的是文件现在的内容。这一项由已有的两条测试覆盖：`graph-resource.test.ts` 里“撤销移动、不撤销文件内容”和 R2-14；上游的 `test:undo` 33 条也通过。
- **`src/lib/appearance.ts`**：上游的 `Markdown.tsx` 现在会引入它，而它在模块加载时直接调用 `window.matchMedia`。测试用的 DOM 里没有这个函数，导致 10 个测试文件加载失败。改成没有 `matchMedia` 时按浅色处理。
- **上游新加的两套脚本测试**：
  - `test:notebook`：给打包时用的 `lib/attachments` 桩补上 `attachmentIdentity`。
  - `test:background`：除了复制 `server.mjs`，还把 `shared/` 链接过去，因为我们的代理会引用 `./shared/web-url.mjs`。

  另外，这套测试要求先有 `dsh/lib/runtime`，它是插件构建时从 `runtime/` 复制过去的，已被 git 忽略。我按构建脚本的做法复制了一份，并确认 `runtime/agents/http.cjs` 和 `ops.cjs` 在插件的这份副本里能正常加载，包括我们新加的 `runtime/execution`。
- **测试期望**：
  - `tests/host/agent-runtimes-baseline.test.cjs`：Codex 的线程参数多了上游新加的 `approvalsReviewer`（默认 `user`）。
  - `tests/e2e/target-wiring.spec.ts`：上游 0.5.26 起新增节点不再挪动已有卡片，连线外框的中心可能被卡片盖住。测试改为像人一样，点在连线上没被遮住的一处。

## 4. 测试

| 检查 | 结果 |
| --- | --- |
| `npm run lint`、`npx tsc -b`、`npm run build` | 通过 |
| `npm run test:unit` | 651 通过，1 条预期失败（`[T28]`） |
| `npm run test:host` | 437 通过 |
| `npm run test:contracts` | 193 + 91 通过 |
| `npm run test:e2e` | 3 通过，连跑 3 遍 |
| `npm run test:e2e:desktop` | 74 通过，连跑 2 遍 |
| `test:layout`、`test:live-log`、`test:subagents` | 通过 |
| 上游新增的 `test:backup`、`test:inject-source`、`test:undo`、`test:notebook`、`test:background` | 21、7、33、19、35 条全部通过 |

**一个原来就有的偶发失败**：桌面测试“另一个程序改了文件，引用它的节点会显示新内容”偶尔超时（20 秒）。合并后整个文件跑 5 次失败 1 次；在合并前的代码上同样跑 5 次，也失败 1 次。所以它不是这次合并带进来的，已另行记录待查。另有一次整套运行里，Word 文档那条也失败过一次，单独跑和之后的几轮都通过。

## 5. 上游这几版里，和研究工作台计划有关的

- **停靠阅读器（0.5.17）**：和我们的编辑表面、“在旁边打开”并存，测试都通过。两者的交互还没有统一，留到 UI 整理时再看。
- **每张画布一个权限开关（询问 / 自动审核 / 全部放行，0.5.21）**：和我们的运行模式是两件事。权限开关管 Agent 每一步要不要人来批；运行模式（工作 / 研究隔离）管它能读什么、会不会写文件。`writesFiles` 只看运行模式。
- **后台调用只走 API 模型（0.5.24）**：和 T27 的方向一致，没有冲突。
- **新增节点不挪动已有卡片（0.5.26）**：我们的回馈线布局规则仍然有效（`layout.ts` 自动合并）。
