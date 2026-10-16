# 研究工作台：材料物化与执行权限（T12）

记录日期：2026-10-16。T12 是 M3 的第二个任务（计划第 12 节的 T12 条目），建立在 T11 的运行信封上（见 `run-envelope.md`）。

## 1. 做了什么

### 1.1 两种运行模式

每个任务现在有两种运行模式，在任务面板里切换：

- **工作模式**（默认）：和以前一样。可以联网搜索，带记忆和回忆；Agent 在工作目录里用它自己的工具。
- **研究隔离**：只给连线的输入和问题。不加记忆，不加回忆，不给联网搜索、学术搜索和 MCP 工具。

模式记在任务的目标上（`policyId: 'research'`）。切换模式会给这个任务新建一个目标；和它共用目标的其他任务不受影响。在它下面追问，继承同一个目标，所以也是研究隔离。

### 1.2 发送前检查能不能做到

运行准备好之后、发送之前，按同一条规则检查一次（`verifyPolicy`）：

- **通过 API 调用的模型**：研究隔离要求的几件事都由应用自己控制，能做到，照常发送。检查的是信封里实际记录的内容：用了工具、联网、加了自动记忆，都会被拦下。
- **Agent**：它有自己的工具。研究隔离要求运行时被验证过能做到三件事：只读所选材料（`readOnlyRoots`）、断网（`networkRestriction`）、不带它自己的记忆和项目说明（`autoContextControl`）。这三项要靠 T15/T16 在真实安装上探测；现在一项都不知道。按计划“未知则 blocked”，Agent 的研究隔离运行一律不发送，任务上写明原因。宿主在写材料前还会再查一遍。
- **工作模式**：照常运行。Agent 的运行会提示：它的工具可以读工作目录里的其他文件，不只是列出的输入。

页面和宿主各有一份规则（`src/lib/context/policy.ts`、`runtime/execution/policy.cjs`），由一张 240 种情况的表保证两边结论一致。

### 1.3 Agent 的材料按信封写出

原来的 `materialsToDisk` 有这些问题：沿任意连线遍历所有祖先；不管排除列表；按文件名去重，同名文件只留一个；PDF 整份写出；最多 40 个文件。它已经删掉，换成按运行信封写出：

- **位置**：`<工作目录>/.thoughtdag/runs/<运行编号>/materials/`，每次运行一个目录。`manifest.json` 列出每个输入：输入编号、相对路径、整份内容的哈希、写出内容的哈希、大小、权限。
- **文件名**：以输入编号开头，例如 `in_3f2a…-notes.md`。两个同名文件分别写出。
- **内容从哪来**：
  - 工作区文件：从运行所指的快照读回，必须和冻结时的哈希一致。
  - 只读文件夹里的文件：没有快照，读它现在的内容，必须仍和冻结时一致。
  - 画布上的副本：页面交给宿主，宿主核对哈希。
- **选中的段落**：只写那一段，文件名带 `.excerpt`。宿主按引文和前后文在快照里重新找到它。
- **被排除的**：不在信封的输入里，宿主根本不会去读。
- **先查后写**：先把所有输入读出来、核对完，再写。任何一项不对（快照没了、哈希不符、段落出现多处或找不到、合计超过 64 MiB、超过 200 个输入），就什么都不写，这次运行不发送，任务上写明原因。
- **只读**：写出的都是普通只读文件，不是链接；名字里的路径部分会被去掉，跑不出运行目录。
- **清理**：只保留最近 20 个运行目录。更早的，只有内容和清单完全一致时才删；别的程序往里写过东西的不动。
- **提示词**：列出每个文件的位置，以及它是整份还是某个文件的一段。
- **发出的时间点**：材料写好之后，才算请求发出（`onDispatch` 记录在写材料之后）。材料写不出来的运行，不会被记成发出过。

### 1.4 运行预览

任务面板里新增一块（`RunPreview`）：

- 模式切换；
- 这个模式对这个 AI 意味着什么，包括 Agent 在工作模式下的提示、研究隔离下不能发送的原因；
- 展开后显示：输入列表（选段有标记，附大小）、不发送的项（划掉）、上次运行用了几个输入。

预览读的是画布当前的样子，不保存、不冻结。真正发送的内容，以运行开始时冻结的为准。

## 2. 文件

| 文件 | 内容 |
| --- | --- |
| `runtime/execution/materialize.cjs` | `materialize(envelope, runDirectory, readers)` → 回执；`pruneRuns`；宿主一侧的 `locatePassage` |
| `runtime/execution/policy.cjs` | `verifyPolicy(envelope, capabilities)` → `{ ok, blocked, notice }` |
| `runtime/agents/ops.cjs` | `materializeRun(cwd, envelope, provided, readers)`：先查策略，再写到运行目录，最后清理旧目录。替换了 `writeMaterials` |
| `desktop/main.js`、`desktop/preload.js` | 新通道 `agents:materialize`，经工作区服务从快照读回；删掉 `agents:write-materials` |
| `runtime/agents/http.cjs`、`src/lib/agents/http-bridge.ts` | `/agents/materials` 改为按信封写。那里没有工作区，只能写画布上的副本 |
| `src/desktop-bridge.d.ts` | `materialize` 及回执的类型 |
| `src/lib/context/policy.ts` | 页面一侧的同一条规则；`capabilitiesOf` 目前对所有运行时都返回“未知” |
| `src/lib/context/materials.ts` | `materialsFor(envelope)`：请宿主写材料，返回提示词里的说明；宿主拒绝时抛出 `RunBlocked` |
| `src/lib/context/prepare-run.ts` | 记录画布副本的字节（`envelopeHeld`）；策略按实际用到的工具、记忆和回忆记录（新参数 `recall`）；`previewRun`；“被排除的”规则抽成一处 |
| `src/lib/context/resource-resolver.ts` | 新原因 `policy`、`inputs-too-large` |
| `src/lib/agents/target-model.ts`、`targets.ts` | `RESEARCH_POLICY`、`runModeOf`、`setRunMode` |
| `src/lib/agents/agent-runtime.ts`、`src/lib/api.ts` | 删掉 `materialsToDisk`；Agent 的材料由运行提供，写好后才发出 |
| `src/store/streaming.ts` | 研究隔离下不加记忆和回忆、不给工具；发送前检查策略；宿主拒绝写材料时不发送 |
| `src/components/workspace/RunPreview.tsx`、`focus-panel/index.tsx` | 运行预览 |
| `src/i18n/zh.ts`、`en.ts` | `run.blocked.policy`、`run.blocked.inputs-too-large`、`run.policyBlocked`、`run.policyPart.*`、`run.preview.*` |

## 3. 测试

- `tests/host/materialize.test.cjs`，15 条：
  - 每个输入各有自己的文件名，同名文件分别写出；写出的字节和回执、清单一致；运行目录里只有材料和清单；
  - 选中的段落只写段落，不夹带整份文件；
  - 被排除的 `EXCLUDED_SECRET_K7` 不出现在运行目录的任何文件里；
  - 哈希不符时什么都不写；合计超限在写之前拒绝；
  - 输入给的名字（`../../../etc/passwd`、绝对路径、Windows 路径）跑不出运行目录；运行目录已有东西时不写；
  - 策略：Agent 的研究隔离在能力未知、部分不支持时拒绝，全部支持时放行；API 的研究隔离不许工具、联网、自动记忆；工作模式放行，Agent 有提示；
  - 宿主通道：写到 `.thoughtdag/runs/<运行编号>`，普通只读文件；拒绝 Agent 的研究隔离且不留任何东西；拒绝可能跑出目录的运行编号和相对工作目录；
  - 只读文件夹的文件只在仍是冻结时内容时写出；
  - 旧运行目录的清理，别的程序写过东西的不动。
  
  实现之前全部失败（`evidence/T12-materialize-host-before-implementation.txt`，三个模块都是只会报错的占位）。
- `tests/unit/run-policy-wiring.test.ts`，6 条，走真实的运行路径：
  - 研究隔离、API 模型：请求里有连线的材料，没有被排除的、没连线的、记忆，也没有联网搜索；
  - 同一个任务在工作模式下有记忆和联网搜索（对照）；
  - 研究隔离、Agent：不发送、不写材料、写明原因；
  - 研究隔离是任务自己的目标，共用目标的另一个任务不变，追问继承；
  - 工作模式、Agent：材料按信封写出，段落只写段落，同名文件分别写出，被排除的不写，提示词列出每个文件；
  - 宿主拒绝写材料时不发送。
- `tests/unit/policy-parity.test.ts`，2 条：页面和宿主的规则在 240 种情况下结论一致。
- `tests/unit/run-preview.test.tsx`，4 条：工作模式 Agent 的提示；切换到研究隔离后的不能发送说明，再切回；API 研究隔离的说明；输入和不发送的列表。
- `tests/unit/agent-context-baseline.test.ts`：T25 登记的两条 `[T12]` 缺口（被排除的不写给 Agent；两个同名文件都写出）现在通过，改为普通测试。辅助函数改成先准备信封，和真实运行一样。
- `tests/e2e-desktop/workspace-door.spec.ts` 新增 1 条，在真实桌面壳里：冻结文件、改动磁盘，再经 `agents:materialize` 写出，写出的是冻结时的内容；伪造的哈希被拒；Agent 的研究隔离被拒；只留下一个运行目录。
- `tests/host/multi-ai-baseline.test.cjs` 改用新的写入函数，新增 1 条：每次运行的输入在自己的目录里。`[T27]` 那条缺口仍然成立：同一工作目录下，后一个任务还能读到前一个任务的运行目录。
- 页面测试实现之前的失败记录：`evidence/T12-wiring-before-implementation.txt`、`evidence/T12-run-preview-before-implementation.txt`、`evidence/T12-desktop-door-before-implementation.txt`。其中工作模式那条对照测试、以及“被排除的不写给 Agent”在实现之前也通过：前者本来就是对照；后者是因为新的桌面替身没有旧的写入函数，什么都没写。
- 全部回归（2026-10-16，macOS）：

| 检查 | 结果 |
| --- | --- |
| `npm run lint`、`npx tsc -b`、`npm run build` | 通过 |
| `npm run test:unit` | 618 通过，4 条预期失败 |
| `npm run test:host` | 425 通过 |
| `npm run test:contracts` | 193 + 91 通过 |
| `npm run test:e2e` | 3 通过 |
| `npm run test:e2e:desktop` | 73 通过 |
| `test:layout`、`test:live-log`、`test:subagents` | 通过 |

宿主测试第一次全量运行时，`reconcile.test.cjs` 里“另一个程序的修改只通知一次”失败过一次；单独连跑 5 次、再全量跑一次都通过。它测的是文件监视的计时，和本任务无关。

## 4. 和之前行为不同的地方

1. **模式的含义变了。** T11 只是把 API 运行记成 `research`、Agent 运行记成 `workspace`，不执行。现在默认都是工作模式，研究隔离由人选择。所以 API 运行的 `executionDigest` 和以前不同（策略变了），`inputDigest` 不变。
2. **材料目录变了。** 从 `.thoughtdag/materials/` 改成按运行分开的 `.thoughtdag/runs/<运行编号>/`。旧目录里以前写的文件不再更新，也没有删除；工作模式下 Agent 仍可能读到它们，但提示词不再指向它们。
3. **画布上的 PDF 副本**（不是工作区文件）现在写出的是交给模型的那份抽取文字，不再是 PDF 原件：写出的必须是冻结并做了哈希的内容。工作区里的 PDF 仍写原件（来自快照）。
4. **图片输入也写成文件**，以前跳过。
5. **上限**：40 个文件换成 200 个输入、合计 64 MiB。超过时不再悄悄丢掉一部分，而是不发送并说明。

## 5. 没做的和限制

- **Agent 的研究隔离现在用不了**，要等 T15/T16 的能力探测。计划的验收要求“读上级目录、完整 `snapshots/`、home 和未选材料时被阻止”。对 Agent 来说，这要靠运行时自己的沙箱做到。没验证过之前，我们选择不发送，而不是声称做到了。宿主这边能保证的是：运行目录里只有清单列出的文件，都是普通只读文件，没有链接，名字跑不出目录。
- **工作模式下，Agent 能读 `.thoughtdag/` 下的所有东西**，包括快照和其他运行的目录。面板上有提示；按目标隔离属于 T27。
- **PDF 按页、导图节点的选区还不能单独写出**，会以 `unsupported-selector` 拒绝。这种引用在 T11 里也仍是整份。
- **输入的 token 预算**（`policy.budget.maxInputTokens`）仍然只记录。字节上限在写材料时执行；模型窗口的检查沿用原有逻辑。
- **研究隔离下忽略回忆开关**，也就是说，人手动打开的回忆也不加。研究隔离只给连线的输入。
- **HTTP 桥**（插件宿主、本地服务器）上没有工作区，只能写画布上的副本；工作区文件的输入会被拒绝。
- **运行预览不冻结**，见 1.4。
- **只在 macOS 上验证过**；Codex 和 Claude Code 这台机器上没装，Agent 的运行都是在替身上核对的。
