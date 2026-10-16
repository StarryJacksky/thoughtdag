# 研究工作台：运行记录、陈旧标记与受控重放（T13）

记录日期：2026-10-16。T13 是 M3 的第三个任务（计划第 12 节的 T13 条目），建立在 T11 的快照和运行信封、T12 的运行目录之上。

## 1. 做了什么

### 1.1 运行记录

每次运行在所读文件的工作区里留一份记录：`.thoughtdag/runs/<运行编号>/record.json`。它和快照分开存放，只列出快照的编号。

- **记录的内容**：
  - 运行编号、画布、任务、目标及其版本；
  - 两个摘要（`inputDigest`、`executionDigest`）和画布版本；
  - 运行时与模型；
  - 每个输入：快照编号、内容哈希、文件编号；
  - 原生会话（Agent 运行时）；
  - 写出的是第几版回答；
  - 状态、准备时间、结束时间。
- **什么时候写**：运行准备好、发送之前，先写一份“已准备”的记录。从这一刻起，它用到的快照就有记录在引用。运行结束后，用结局（完成、失败、取消）替换这份记录。没发出去的运行（发送前核对没过、材料写不出来）记为失败，不记输出。
- **怎么写**：整份写入。先写到旁边的临时文件并刷盘，再一步替换到位。记录的格式不对就拒绝，什么都不写：运行编号不合规、状态不认识、输入超过 200 个、快照编号不合规、整份超过 256 KiB。
- **写在哪里**：只写在有快照的工作区。按工作区分开写，每份只列这个工作区的输入。没读任何工作区文件的运行，只在画布上留摘要。只读文件夹不写记录，因为那里也不存快照。记录写不进去时不影响运行，回答上的摘要照常保存。

### 1.2 断电之后核对

`reconcileRuns` 把记录和快照对一遍：

- 记录里提到、但已经不在的快照：缺失；
- 字节和名字对不上的快照：损坏；
- 记录一直停在“已准备”“运行中”等中间状态的运行：未知，不当作已结束。

在测试里，用同一份状态目录重新启动服务来模拟断电后重开。

### 1.3 快照清理

`collectSnapshots` 只删同时满足两个条件的快照：没有任何记录引用它，并且比宽限期还旧。

- **宽限期**：默认 7 天，页面最多只能要求更长，不能短于 1 小时。这是为了已经冻结、还没来得及写记录的运行。
- **重新冻结**：同一份内容再冻结一次时，快照会被重新标为最新。所以就算正在运行的任务用的是一份很旧的快照，它也不会在写记录之前被删掉。
- **记录读不出来**：只要有任何一份记录读不出来，就什么都不删，因为无法确定它引用了哪些快照。
- **不会自动执行**：目前没有任何地方自动清理，见第 5 节。

### 1.4 旧回答找回当时读的文件

回答的每个版本都保存自己那次运行的摘要（`runs`，和 `responses` 等数组一一对应）。所以早先的版本也能找到当时读的文件，并按当时冻结的内容读回来（`snapshotsOfVersion`）。删除一个版本时，这个数组也一起删除对应的一项。任务面板上会列出当前显示的这一版读过哪些文件。

### 1.5 哪些回答过期了，为什么

判断一个回答是否过期，看它被给的东西有没有变（`detectStale`）：

- **运行读过的文件**：现在的内容和当时冻结的哈希不同，就是“内容变了”；文件找不到，就是“找不到了”。
  - 只改文件名、移动文件：文件编号和内容都没变，不算过期。
  - 导图（`.tdmap`）：比较的是去掉布局之后的内容。只挪节点位置、折叠节点都不算过期，改了文字才算。为此，画布上导图的副本旁边会记下它这一版内容去掉布局后的哈希。
- **其他上游**（对话、连进来的回答和笔记）：沿用原有的上下文指纹。导图副本在指纹里也按去掉布局的内容计算。

原因会写明，例如“notes.md 的内容变了”“上游变了：某个问题”。“上游变了”时，会对照写回答时记下的各上游摘要，指出是哪几个节点的内容变了。

### 1.6 受控重放

对一个过期的回答，可以选三种处理（`planReplay`、`runReplay`）：

- **只重算这个**；
- **连同下游按顺序重放**：加上所有读它的回答，沿任何连线向下找，回馈线除外；
- **保留旧结果**：记成“保留”，不再标为过期，直到它读的东西再次变化。

重放计划按“谁读谁”排序，每一步列出它要等哪几步先完成。重放写出的是新版本，旧版本原样保留。

**会写文件的 Agent 任务（工作模式下的 Agent）不会被自动重跑。** 以下三种情况都不会启动它：

- 重放；
- 画布上原有的“全部重放”；
- 上游完成后的自动重跑（`autoRerun`）。

它在计划里标为“等你运行”，读它的回答也一起等，并提示用户自己运行。用户手动运行时照常执行。

## 2. 文件

| 文件 | 内容 |
| --- | --- |
| `runtime/execution/run-records.cjs` | `writeRecord`、`readRecords`、`reconcileRuns`、`collectSnapshots` |
| `runtime/workspace/snapshots.cjs` | 同一内容再冻结时，把快照的修改时间更新为现在 |
| `runtime/workspace/file-ops.cjs`、`index.cjs`、`providers/local.cjs`、`door.cjs` | `recordRun`、`readRuns`、`reconcileRuns`、`collectSnapshots`；通道 `workspace:record-run`、`read-runs`、`reconcile-runs`、`collect-snapshots`。写入类的通道需要来源支持 `update`；清理的宽限期不能短于 1 小时 |
| `runtime/execution/materialize.cjs` | 运行目录里已有本次运行的 `record.json` 时，照常写材料。清理旧材料时只删 `materials/`，保留记录 |
| `desktop/preload.js`、`src/desktop-bridge.d.ts`、`src/lib/workspace/client.ts` | 页面这一侧的对应函数 |
| `src/lib/context/run-records.ts` | `recordRun`、`summaryOf`、`persistRun`、`snapshotsOfVersion` |
| `src/lib/context/staleness.ts` | `detectStale`、`staleKeyOf`、`meaningHashOf` |
| `src/lib/context/meaning.ts` | 导图去掉布局后的内容（不依赖其他模块，供上下文构建器使用） |
| `src/lib/context/replay-plan.ts` | `planReplay`、`runReplay` |
| `src/lib/context/resource-resolver.ts`、`prepare-run.ts` | 冻结时记下文件所在的工作区；整份导图另算一个含义哈希 |
| `src/lib/agents/target-model.ts` | `writesFiles`：这个任务的运行会不会写文件 |
| `src/store/streaming.ts` | 准备好后先写记录，再发送；结束时写结局；每个版本保存运行摘要；上游完成后的自动重跑不启动会写文件的 Agent |
| `src/store/slices/nodes.ts` | `recomputeStaleness` 改用 `detectStale`，并保存原因（`staleReasons`）；`deleteVersion` 同步删除 `runs`，顺带补上漏删的 `generatedEfforts`、`gatewaySearches`（以前删一个版本后，模型和推理强度的标签会错位） |
| `src/store/slices/evaluator.ts` | “全部重放”改为按计划执行 |
| `src/lib/workspace/graph-resource.ts` | 刷新导图副本时，一并记下它去掉布局后的哈希 |
| `src/store/context-builder.ts` | 指纹里导图副本按去掉布局的内容计算 |
| `src/components/workspace/StaleSection.tsx`、`RunPreview.tsx` | 过期原因、三种处理、这一版读过的文件 |
| `src/types.ts`、`src/store/types.ts` | `RunSummary`、`runs`、`resourceHint.meaning`、`staleReasons`、判断结果里的 `kept` |
| `src/i18n/zh.ts`、`en.ts` | `run.stale.*`、`run.versionInputs`、`replay.waiting`、`replay.agentWaits` |

## 3. 测试

- **`tests/host/run-records.test.cjs`，7 条**：
  - 记录整份写入，用结局替换，不留临时文件；
  - 不合规的记录被拒绝，什么都不写；
  - 断电后重开，核对出未知、缺失、损坏三种情况；
  - 清理时，有记录引用的快照再旧也保留，太新的也保留；
  - 重新冻结的快照算作新的；
  - 有记录读不出来时什么都不删；
  - 经过通道写记录、读回、核对；页面不能把宽限期缩到 1 小时以下。

  实现之前全部失败（`evidence/T13-run-records-host-before-implementation.txt`）。只有第 7 条是后加的，它的失败证据在桌面那条里。
- **`tests/unit/provenance.test.ts`，10 条**，走真实运行路径：
  - 记录在发送前写成“已准备”，结束后写成“完成”，并带上输出版本；
  - 文件改过、任务重跑后，早先的版本仍能读回当时的快照；
  - 文件变了，只标出读过它的回答；
  - 文件丢了，说明是丢了；
  - 改名、挪动或折叠卡片，什么都不标；
  - 导图只挪节点，什么都不标；改了文字，就标出来；
  - 删掉一个出错的上游后，列出读它的回答和重放顺序，包括三种策略和顺序；
  - 重放写出新版本，旧版本保留；
  - 保留旧结果之后不再提示过期，上游再变时重新提示；
  - 会写文件的 Agent 不会被重放、全部重放或自动重跑启动，用户手动运行时照常执行。

  实现之前全部失败（`evidence/T13-provenance-before-implementation.txt`，三个新模块都是只会报错的占位）。
- **`tests/unit/stale-section.test.tsx`，4 条**：
  - 显示是哪个文件变了，“只重算这个”写出新版本，之后不再提示；
  - 保留旧结果；
  - 会写文件的 Agent 不提供重跑按钮；
  - 列出这一版读过的文件。

  实现之前全部失败（`evidence/T13-stale-section-before-implementation.txt`）。
- **`tests/e2e-desktop/workspace-door.spec.ts` 新增 1 条**：在真实桌面壳里写记录、核对、读回，并拒绝不合规的记录。实现之前失败（`evidence/T13-desktop-door-before-implementation.txt`）。
- **`tests/host/materialize.test.cjs` 新增 1 条**：运行目录里已有本次运行的记录时，照常写材料。清理旧材料的那条也改为：保留记录，只删材料。
- **全部回归**（2026-10-16，macOS）：

| 检查 | 结果 |
| --- | --- |
| `npm run lint`、`npx tsc -b`、`npm run build` | 通过 |
| `npm run test:unit` | 632 通过，4 条预期失败 |
| `npm run test:host` | 433 通过 |
| `npm run test:contracts` | 193 + 91 通过 |
| `npm run test:e2e` | 3 通过 |
| `npm run test:e2e:desktop` | 74 通过 |
| `test:layout`、`test:live-log`、`test:subagents` | 通过 |

## 4. 和之前行为不同的地方

1. **画布上原有的“全部重放”和上游完成后的自动重跑，不再启动会写文件的 Agent 任务。** 它们会提示用户自己运行。回馈线的自动来回（T26b）不受影响，因为那是用户自己发起、自己设定轮数的。
2. **过期判断多了两种情况**：文件丢失算过期；运行读过的文件内容变了，即使画布上的副本没有体现，也算过期。
3. **导图只挪位置不再算过期。** 但在这次更新之前就读过导图的回答，指纹是按旧算法记的，更新后会一次性显示为过期，重跑一次就恢复正常。
4. **删除回答版本时**，`generatedEfforts`、`gatewaySearches` 也会一起删除对应的一项（原来漏了）。

## 5. 没做的和限制

- **快照清理没有任何入口自动执行**，只提供了函数和通道。什么时候清理、要不要问用户，还没有决定；在这之前快照只增不减。
- **运行记录不会被删除。** 回答版本被删除后，它的记录仍然留着，记录引用的快照也就一直保留。这样不会误删，代价是占用空间。按画布版本释放记录还没有做。
- **重放计划只看画布上的连线**，看不到 Agent 在磁盘上留下的改动。Agent 写过的文件被别的任务读到，这种依赖不在计划里。
- **“上游变了”只能指出是哪几个节点**，前提是写回答时记下了各上游的摘要（`lastContextParts`），早期的回答没有，指不出来。
- **查看当时的版本**：目前只列出文件名，还不能直接打开当时的快照。函数 `snapshotsOfVersion` 已经可以读回内容，界面以后再接。
- **原生会话只记了运行时和会话编号**，线程编号、恢复方式属于 T15/T16。
- **“未知”状态只在核对时给出**，不会改写记录本身。
- 只在 macOS 上验证过。
