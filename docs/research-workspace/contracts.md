# 研究工作台：数据契约（T02）

记录日期：2026-10-03。本文是工程计划 T02 的交付说明：契约放在哪里、两侧怎么读、版本规则是什么，以及实现时相对规划做了哪些调整。契约本身以 schema 文件为准，本文不重复字段。

## 1. 文件

| 文件 | 内容 |
| --- | --- |
| `shared/schemas/workspace-v1.json` | 工作区来源、文件、选区引用、保存结果、编辑表面 |
| `shared/schemas/run-envelope-v1.json` | 一次运行的冻结输入、执行策略、运行时选择、原生会话绑定、路由决定、运行状态 |
| `shared/schemas/validate.mjs` | 校验器，界面和主进程共用同一份 |
| `shared/schemas/host.cjs` | 主进程（CommonJS）的加载入口 `loadContracts()` |
| `src/lib/workspace/contracts.ts` | 工作区契约的 TypeScript 类型，`validateDTO`，`versionAccess` |
| `src/lib/context/contracts.ts` | 运行契约的 TypeScript 类型，`validateRunDTO` |
| `tests/fixtures/contracts/samples.json` | 两侧测试共用的样例，每条写明应得的结论和应报的错误 |

`npm run test:contracts` 依次跑界面一侧（`tests/unit/contracts.test.ts`）和主进程一侧（`tests/host/contracts.test.cjs`）。两侧读的是同一批 schema、同一个校验器、同一份样例。

## 2. 校验器

校验器是自己写的，没有用第三方库在运行时校验，原因有两个：

- 常见的 JSON Schema 库靠运行时生成代码来校验，界面一侧以后收紧内容安全策略、禁止 eval 时会用不了。
- 界面和主进程要对同一个值得出同一个结论，最稳妥的办法是两侧跑同一份代码。

它只实现契约用到的那部分 JSON Schema（2020-12）。为了不出现“某个约束被悄悄跳过”的情况，做了三件事：

- 构造校验器时检查全部 schema，遇到不认识的关键字直接报错，不会忽略。
- 构造时解析全部 `$ref`，指向不存在的定义直接报错。
- 测试里用完整的 JSON Schema 实现（ajv，严格模式，只在测试中使用）对每条样例再判一次，两者结论必须一致。

校验只报告，不修改：不允许的字段报错，不会被丢掉；缺少的字段报错，不会被补上。测试对每条样例都断言校验前后值不变。

## 3. 约定

- **版本**：两份契约的版本都是 `1.1`。`.tdmap` 是另一份格式，版本 `1.0`，由 T18 定义。
- **读到别的版本时**：`versionAccess(found, supported)` 给出四种结论。

  | 存储的版本 | 结论 | 含义 |
  | --- | --- | --- |
  | 主版本相同，次版本不更新 | `read-write` | 正常读写 |
  | 次版本更新，或主版本更新 | `read-only` | 可能带有本版本不认识的字段，只读，绝不重写 |
  | 主版本更旧 | `migrate` | 需要先迁移 |
  | 不是 `主.次` 形式 | `unsupported` | 不处理 |

- **ID 不透明**：所有 id 都是不透明字符串，不解析，不同种类的 id 不能互相替代。线程 id 和会话 id 是两个字段。
- **三态能力**：`supported`、`unsupported`、`unknown`。`unknown` 永远不当作 `supported`。
- **内容哈希**：写作 `sha256:` 加 64 位小写十六进制，和上游现有的哈希写法一致。远端来源自己的版本标记放在 `sourceRevision`，两者不混用。
- **Space 与本地对等**：`WorkspaceRecord` 的两个变体没有主次之分；调用方按能力分支，不按来源类型分支。

## 4. 与上游“上下文包”的关系

读代码时发现上游已经有一套自己的机制，规划里没有提到：

- `protocol/context-bundle/v0/` 定义了“上下文包”：下一轮要给模型看什么，每一条从哪来。它带 JSON Schema 和夹具，状态是提案。
- `src/lib/context-bundle.ts` 是它的编译器。它包着 `buildContext`，不自己组装上下文，并提供了确定性序列化（`canonicalStringify`）、`sha256Hex`、只含语义不含布局的图快照（`semanticSnapshot`、`graphSnapshotHash`）。
- `src/store/streaming.ts` 在每次请求发出时记一条 `commit` 事件，内容是对消息、每张图片的字节、模型和工具开关算的 SHA-256。

所以规划里“另建 SHA-256 语义摘要”的那部分，上游已经有了可用的基础。运行契约据此调整为建在这套机制上，而不是并排再造一套：

- `RunEnvelope.messages` 的每条消息带着 `buildContext` 给出的来源，结构与上下文包一致。
- `RunEnvelope.graphRevision` 就是 `graphSnapshotHash` 的结果。
- 摘要统一用 `canonicalStringify` 加 `sha256Hex` 计算。
- 上下文包 v0 里材料的身份是“文件名、大小、内容前 100 字符”，它自己的说明里写着以后要升级成 sha256。`ResolvedInput.contentHash` 就是这个升级，同时解决基线里记录的同名文件丢失问题。

T11 实现 `prepareRun` 时应当复用上述函数，并让 `inputDigest` 与现有的 `commit` 事件对得上。

## 5. 相对规划的调整

| 规划里的写法 | 契约里的写法 | 原因 |
| --- | --- | --- |
| T11 的 `PrepareRunRequest.targetNodeId` | 统一用 `taskNodeId` | 规划 4.5 节和 `RunEnvelope` 都用 `taskNodeId`，T11 一处不一致 |
| `ResolvedInput.sourceRef` | `source`，三种来源：工作区资源、节点上的附件、显式回忆 | 现有附件是存在节点上的导入副本，不是工作区资源，也要能作为输入被冻结 |
| `SaveResult` 四种状态 | 加上 `pending-sync` 和 `unknown-ack`（带 `opId`） | 规划 4.4 节的正文要求，接口定义里没列 |
| 文本选区只有引文和前后文 | 可选带 `baseRevision` 和 `lines` | 规划 4.1 节正文要求记录原版本和行号用于显示 |
| `RuntimeBinding` 的字段是散列的描述 | 加 `bindingId`、`nativeState`、`ownership` | `RouteDecision` 要引用 `bindingId`；状态和所有权需要可枚举的取值 |
| `WorkspaceRecord` | 没有 `role` 字段 | Space 和本地文件夹对等，见规划 v1.2 |
| `ExecutionPolicy` 只有文字描述 | 定成 `read`、`write`、`tools`、`network`、`recall`、`budget` 六项 | 规划 7.1 和 8.5 节的内容落成具体字段 |

`test:contracts` 在规划里只有名字，这里定为“界面一侧加主进程一侧”。

## 6. 还没有的东西

- `WorkspaceAPI` 和 `WorkspaceProvider` 只有接口，没有实现（T03、T04、T31）。
- `DocumentModel` 和 `DocumentEdit` 只有 TypeScript 类型，没有 schema：它们只在界面进程内部使用，不跨进程。
- `shared/` 目录目前没有被桌面打包脚本复制（`desktop/scripts/prepare-payload.mjs` 只复制 `runtime/` 和 `dist/`）。T03 把契约接进主进程时要一并处理。
- 契约是定义，不是行为。能证明行为的是后续任务各自的测试。
