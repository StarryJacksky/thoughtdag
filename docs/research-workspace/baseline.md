# 研究工作台：基线记录（T01）

记录日期：2026-10-03。本文是工程计划 T01 的交付物，记录开工时上游的状态、既有检查的结果、新增的测试入口，以及用测试复现出来的现有行为缺口。本文只写实际跑过的东西；没有跑的单独列在最后。

## 1. 基线提交

| 项目 | 值 |
| --- | --- |
| 工作分支 | `research-workspace` |
| 分支起点 | `b3616c0`（上游 main，0.5.16，2026-10-03） |
| 规划审查时固定的提交 | `f1afae2`（0.5.5，2026-09-29） |
| 两者之间 | 61 个提交，359 个文件，+10956 / −311 行；`f1afae2` 是 `b3616c0` 的祖先 |

分支建在最新 main 而不是规划固定的 `f1afae2` 上。理由：规划审查过的核心文件在这 61 个提交里没有变化，规划里的代码判断仍然成立；从旧提交开工只会多出一次合并。

这段时间内**没有变化**的文件：`src/lib/agents/agent-runtime.ts`、`src/store/context-builder.ts`、`src/lib/attachments.ts`、`src/lib/api.ts`、`runtime/agents/` 全部文件、`src/components/focus-panel/FollowUpInput.tsx`、`src/components/focus-panel/AttachmentsSection.tsx`。

有小幅变化的相关文件：`src/App.tsx`（+49/−9）、`src/components/focus-panel/` 下的角色与问题编辑（新增 `RoleEditor.tsx`）、`src/types.ts`（+7）、`src/components/MaterialReader.tsx`（+4）、`desktop/main.js` 与 `desktop/preload.js`（各 +1）。新增内容主要是“问画布”、回忆开关和角色编辑。

## 2. 环境

| 项目 | 值 |
| --- | --- |
| 系统 | macOS，Darwin 25.5.0，arm64 |
| Node / npm | v22.23.1 / 10.8.2 |
| git | 2.55.0 |
| 浏览器 | 本机 Google Chrome（冒烟与端到端测试都驱动它，不另下载浏览器） |
| Electron | `desktop/package.json` 声明 `^43.3.0`；本次没有安装 desktop 依赖，也没有启动桌面应用 |
| Codex CLI | 当前 shell 的 PATH 里没有 `codex` |
| Claude Code CLI | 当前 shell 的 PATH 里没有 `claude` |

## 3. 既有检查的结果

上游仓库没有 `test` 脚本，这不算功能失败。下表是开工前在 `b3616c0` 上逐项跑的结果。

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm ci` | 通过 | 580 个包 |
| `npm run build` | 通过 | 有一条分块体积超过 500 kB 的提示，是上游既有的 |
| `npm run lint` | 通过 | 退出码 0，无输出 |
| `npm run smoke` | 通过 | 需要先起 `npm run dev`。控制台有 4 条 `ERR_CONNECTION_REFUSED`，原因是没有起 :3001 的代理；脚本只打印不判失败 |
| `npm run test:layout` | 通过 | |
| `npm run test:live-log` | 通过 | |
| `npm run test:subagents` | 通过 | |
| `node scripts/test-memory-judge.mjs` | 0/20 | 这个脚本没有接进 `package.json`，需要本地代理和一把模型 key 才能跑；没有这些条件时全部失败，不是回归 |

T01 改动之后，上面除最后一项外全部重跑，结果不变。

## 4. 新增的测试入口

| 命令 | 运行器 | 范围 |
| --- | --- | --- |
| `npm run test:unit` | Vitest（jsdom，fake-indexeddb） | `tests/unit`、`tests/integration` |
| `npm run test:host` | `node --test` | `tests/host/**/*.test.cjs`；带参数时只跑指定文件 |
| `npm run test:e2e` | Playwright，驱动本机 Chrome | `tests/e2e`；自动起 dev server，已有则复用 |
| `npm run test:contracts` | Vitest 加 `node --test` | 契约测试，界面一侧和主进程一侧各跑一遍；T01 时为空，T02 填充，见 [contracts.md](contracts.md) |

新增的开发依赖：`vitest`、`jsdom`、`fake-indexeddb`、`@playwright/test`。安装时锁文件里的 `playwright-core` 从 1.61 升到 1.63（仍在原声明范围内），升级后冒烟测试照常通过。

`tsc -b` 现在也检查测试代码（新增 `tsconfig.test.json`）。`docs/research-workspace/` 已从文档站的构建里排除。

## 5. 夹具与假运行时

所有夹具都是合成数据，标记是编造的字符串（如 `EXCLUDED_SECRET_K7`），路径都在 `/synthetic/` 下。`tests/host/fixture-smoke.test.cjs` 检查夹具里没有本机的 home 目录或真实用户路径。

- `tests/fixtures/research/`：研究夹具，`fixture(name)` 把精简的 JSON 展开成 store 里的节点和连线。
- `tests/helpers/fake-desktop.ts`：假的桌面桥接（`window.desktopAgents`）。它不运行任何东西，只记录画布交给运行时的请求和为 Agent 写出的材料文件。
- `tests/fixtures/runtimes/fake-codex.cjs`、`fake-claude.cjs`：假的 `codex app-server` 和 `claude -p`，按真实适配器使用的协议应答，不调用模型。它们记录收到的参数、每条消息，以及一轮开始时工作目录下 Agent 能读到的全部材料文件。
- `tests/helpers/fake-runtimes.cjs`：把两个假可执行文件放到主进程查找得到的位置，并把 `HOME` 指向临时目录，所以测试不会读到真实的 `~/.codex` 或 `~/.claude`。目前只支持 POSIX。

## 6. 用测试复现的缺口

下面五条在 `tests/unit/agent-context-baseline.test.ts` 里以“预期失败”的形式存在：断言写的是规划要求的行为，在今天的代码上失败。平时跑测试它们显示为 expected fail，不影响整体通过；后续任务修好之后它们会变成“意外通过”，届时改成普通用例。

查看原始失败：

```bash
VITE_TDAG_SHOW_GAPS=1 npm run test:unit
```

失败输出存档在 [evidence/T01-baseline-gaps.txt](evidence/T01-baseline-gaps.txt)。

| 缺口 | 现象 | 代码位置 | 归属任务 |
| --- | --- | --- | --- |
| 上游回答被改过仍然续接旧会话 | 新问题挂在镜像会话的尾节点上、只有一条入边时，即使祖先回答在画布上被改写，路由仍是续接 | `agentOutbound`，`agent-runtime.ts:168` | T14 |
| 续接时只发问题 | 同一场景下，交给 Agent 的提示词只有问题本身，改写后的祖先文本没有送出；Agent 按原生会话里的旧文本回答 | `agentCallStream`，`agent-runtime.ts:328` | T14 |
| 被排除的附件仍写到磁盘 | 附件在提问节点上被排除后不进提示词，但仍被写进 `<cwd>/.thoughtdag/materials`，Agent 可以用工具读到 | `materialsToDisk`，`agent-runtime.ts:224` | T12 |
| 同名文件只写出第一份 | 两份内容不同、文件名相同的附件，写材料时按文件名去重，第二份丢失 | `materialsToDisk`，`agent-runtime.ts:244` | T12 |
| 同名、同大小、前 100 字符相同的文件在提示词里丢一份 | 编译上下文时按“文件名、大小、内容前 100 字符”去重，表头相同的两份导出会被当成同一份 | `attachmentFingerprint`，`attachments.ts:37` | T11 |

最后一条是这次读代码时新发现的，规划里没有列出。

同一个测试文件里还有四条**现在成立、之后必须保持**的行为：上游没变时续接并只发问题；多接一条边时新开会话并带上完整上下文；被排除的附件不进提示词；内容从开头就不同的同名文件都能进提示词。

## 7. 主进程适配器的现状

`tests/host/agent-runtimes-baseline.test.cjs` 用假运行时记录了两个适配器今天的行为。这些是事实记录，不是缺口断言。

**Codex（`runtime/agents/codex.cjs`）**

- 握手顺序是 `initialize`、`initialized`，之后才有其他请求。
- 新开一轮：`thread/start`，参数为 `cwd`、`approvalPolicy: on-request`、`sandbox: workspace-write` 和模型；然后 `turn/start`，提示词作为数据放在 `input` 里。
- 给了会话文件就 `thread/resume`，线程 id 取自路径里最后一个 UUID。
- 分叉时 `thread/fork` 只带线程 id，不带任何轮次边界；画布传来的 `forkEntryId` 只起开关作用。所以分叉继承的是整段历史。
- 线程在别处忙时，运行以服务端给的原因结束，不会自动改走新线程。
- 策略只有两档，取决于 `guard.json`：默认是上面那组；`allow` 模式是 `approvalPolicy: never` 加 `sandbox: danger-full-access`。没有只读或限制可读范围的档位。

**Claude Code（`runtime/agents/claude.cjs`）**

- 每轮起一个进程，参数以数组传给 `spawn`，不经过 shell；带引号、`$(...)` 和反引号的提示词原样到达。
- 固定参数是 `-p --output-format stream-json --input-format stream-json --verbose --include-partial-messages --permission-mode <mode>`；默认模式再加 `--permission-prompt-tool stdio`。
- 给了会话文件就加 `--resume <id>`；分叉再加 `--fork-session`，得到新的会话 id。
- 没有限制工具、可读目录或配置加载的参数。

两个适配器目前都没有能兑现“研究隔离模式”的参数，这是 T12、T15、T16 要补的。

**顺带发现的一个问题**：Codex 适配器在 `shutdown()` 或空闲回收后立刻开始新的一轮时，旧进程的 `exit` 事件会落到新进程头上，把新进程的引用清掉，新进程变成没人管的孤儿。测试里用独立的运行时实例绕开了它，没有修。它和 T17 的运行恢复有关。

## 8. 这次没有做的

- 没有安装 desktop 依赖，没有启动 Electron 桌面应用。
- 没有用真实的 Codex 或 Claude Code 跑过任何东西；本机当前 PATH 里也没有这两个 CLI。T15、T16 要求的真实 CLI 验证都还没做。
- 只在 macOS arm64 上跑过；Windows 和 Linux 没有验证，假运行时的启动脚本也还不支持 Windows。
- 没有评估把 `MaterialReader` 拆成可多实例复用的成本。
- 没有核验多目标并行时全局状态串用的问题（T25 的范围）。
- 没有做 Space 接口调查（T32 的范围）。
