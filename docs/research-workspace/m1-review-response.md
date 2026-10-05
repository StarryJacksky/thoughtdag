# 研究工作台：对 M1 后端审查的逐项回应

记录日期：2026-10-05。本文回应 Astra 对提交 `a3ffb85` 的审查报告（18 项 M1 缺陷 BR01–BR18、4 项既有运行时问题 L01–L04、与计划的出入、建议升级的模块）。每一项给出：结论、修复所在的提交、对应的回归测试、测试在修复前后的结果。

审查报告本身没有提交进仓库：它里面的链接是本机绝对路径，而这个分支是公开的。

## 1. 结论

- **BR01–BR18 全部修复。** 每一项都有回归测试，在 `a3ffb85` 上失败、在当前提交上通过。修复前的运行结果保存在 `evidence/M1-review-host-before-fix.txt` 和 `evidence/M1-review-renderer-before-fix.txt`。
- **L01–L04 没有在这一轮修。** 它们在运行时代码里，不属于文件工作区，已指派到后面的任务（第 5 节）。
- **与计划的出入**：五项里处理了四项，一项调整了范围并写明由谁承接（第 6 节）。
- **原先说“M1 全部交付”不准确。** R02 里文件夹的移动、改名、复制、回收，文件改名和复制的界面，以及从恢复区还原，当时都没做。这一轮补上了（第 7 节）。

提交顺序（都在 `a3ffb85` 之后）：

| 提交 | 内容 |
| --- | --- |
| `b36f5d3` | 宿主一致性：BR01–BR04、BR07–BR14，以及 BR18 用到的订阅模块 |
| `c140b5e` | 桌面壳接线：BR18 |
| `98e19fd` | 页面侧：BR05、BR06、BR15、BR16、BR17 |
| `8e29863` | 门经由 Provider 路由；按能力决定界面；宿主侧的大小限制；空画布的新建入口 |
| `81c2954` | 文件夹操作、改名、复制、恢复区还原、历史版本 |

## 2. P1

| 编号 | 结论 | 怎么修的 | 回归测试 |
| --- | --- | --- | --- |
| BR01 并发移动到同一目标会覆盖文件 | 已修 | 移动不再用会覆盖的改名。新名字用硬链接取得，目标已存在时这一步会失败；成功之后才去掉旧名字。同时给目标路径加了锁，本应用自己的两次移动不会同时去取同一个名字。两步之间崩溃时，下次启动会把它做完。卷不支持硬链接时退回“锁内检查再改名”，这时只剩别的程序恰好在那一瞬间占名这一种情况。 | `tests/host/concurrency.test.cjs`：“two files moved onto the same name at once…”、“a move onto a name another program took in the meantime…”；`crash-recovery.test.cjs`：“a move cut short between giving the file its new name…” |
| BR02 残缺的恢复副本被接受 | 已修 | 旧版本先写到临时文件、刷盘、读回核对哈希，再一步放到位。已有的同名副本只有哈希对得上才算数，残缺的会被替换。保不住旧版本时，原文件不替换。 | `crash-recovery.test.cjs`：“a disk that fills while the old version is being kept…”、“part of an old version left in the recovery area…” |
| BR03 并发首次登记丢失身份 | 已修 | 每个文件夹的登记表只建一次：建的过程中再来的调用拿到的是同一个。缓存的是建立过程本身，失败时只清掉这一次。 | `concurrency.test.cjs`：“two files given their identity at the same moment on a cold service…” |
| BR04 复制或移动工作区目录后路由到错误的根 | 已修 | 一个工作区 id 只通向一个文件夹。打开一个文件夹时，如果它带的 id 已经有主：原来那个文件夹不在了或不再带这个 id，就认定是移动，把授权改绑到新位置并清掉旧缓存；两个都在，就认定正在打开的是副本，给它新的工作区 id 和新的文件 id（它带来的那些是原件的），复制过来的事务日志挪到一边。缓存改为按授权而不是按工作区 id 存放。 | `tests/host/workspace-identity.test.cjs`：“a copy of an open workspace folder is a workspace of its own…”、“a workspace folder that was moved is the same workspace at its new place…” |
| BR05 刷新更换附件 ID，排除选择失效 | 已修 | 文件节点的内容副本在节点的一生里是同一个附件：刷新只换内容，id 不变，展示方式的选择也保留。副本和它对应的版本号一步换完。放在节点之外的大文件内容跟着 id 走。 | `tests/unit/graph-resource.test.ts`：“a file left out of a question stays left out after another program edits it”、“…left out further up the chain stays left out below, and a question that took it back in still has it”、“the copy stays the same attachment through a save from the app and through finding a lost file again”、“how the person chose to have the copy shown is kept…” |
| BR06 切换画布时工作区误绑定 | 已修 | 绑定时明确带着画布 id，请求开始时就定下来。一张画布的文件夹每次都从这张画布自己的记录里查，不看面板上显示的是什么。开始恢复某张画布时，面板立刻不再显示上一张画布的文件夹。迟到的回答对不上当前的访问代次就丢弃。 | `tests/unit/workspace-session.test.ts`：“a canvas and its folder while canvases are being switched” 下的 6 条，覆盖 A→B、A→B→A、延迟打开、恢复期间新建、乱序回答 |

关于 BR04 有一点要说明：当两个文件夹带着同一个 id、而原件当时没有打开时，先被打开的那个保留身份。只凭文件夹自身无法分辨谁是原件；用磁盘上的 inode 来分辨会让跨磁盘移动、备份还原、另一台机器上的同步副本全部被当成“副本”，那样身份就不能跟着文件夹走了。

## 3. P2

| 编号 | 结论 | 怎么修的 | 回归测试 |
| --- | --- | --- | --- |
| BR07 授权列表冷启动并发读到空 | 已修 | 授权只加载一次，读完整之后才对外可见。文件在但读不出来算错误，不算空列表（原来会在下次保存时把授权文件覆盖掉）。对授权的修改串行执行，同一个文件夹被同时打开两次也只有一条授权。 | `concurrency.test.cjs`：“the open workspaces are the same list for everyone…”、“the same folder opened twice at the same moment is one workspace” |
| BR08 回收后同路径新建继承旧身份 | 已修 | 登记表区分“登记一个已有的文件”和“登记一个刚新建的文件”。新建一定是新身份；按路径查只找现在在那里的文件，不找丢失的那条。丢失的文件原样放回原处时，仍然认回原来的身份。对账时也不会把别的有效记录占着的路径认给丢失的文件。 | `workspace-identity.test.cjs`：“a name used again after its file was trashed is a new file with a new identity…”、“a file put back where it was, the very same file, is its old identity again…” |
| BR09 同幂等键并发创建出两个文件 | 已修 | 同一个键的请求在第一次有结果之前再来，等的是同一件工作。 | `concurrency.test.cjs`：“the same creation asked twice before the first answer…”、“the same import asked twice…” |
| BR10 文件落盘但日志未写的崩溃窗口 | 已修 | 新建时，意图里记下要写的内容的哈希；每试一个名字之前先记下这个名字。恢复时，那个名字上的文件内容和意图里的哈希一致，才认作这次新建的结果。 | `crash-recovery.test.cjs`：“a crash after the new file was written and before that was noted…”、“every creation notes the name it is about to try…”、“a crash before the name that was about to be tried held this creation's content…” |
| BR11 旧的失败状态屏蔽后续尝试 | 已修 | 每条意图开始一次新的尝试，操作的状态就是最新一次尝试的状态。另外，保存已经落盘但“完成”没记上时，同一个键再来会被认出是已完成，不再报冲突。 | `crash-recovery.test.cjs`：“a save that failed, was asked again, and was cut short after the replacement…”、“…before the replacement…” |
| BR12 残缺尾行吞掉新记录 | 已修 | 加载时发现文件不以换行结尾，下一次追加先补一个换行。追加串行执行。 | `crash-recovery.test.cjs`：“the first thing noted after a half-written last line is not swallowed by it”、“two things noted at the same moment are two whole lines” |
| BR13 读取吞掉外部修改通知 | 已修 | 读取时发现内容和登记的不一样，除了更新登记，还向所有订阅者发一次变更通知。第一次看到内容（原先没有哈希）不算变更。 | `tests/host/change-notification.test.cjs`：“a file changed by another program and read for its text/bytes before the watcher speaks…”、“the first look at a file's content is not news” |
| BR14 新版登记的只读状态没拦住写入 | 已修 | 每个会改动的入口都检查两件事：文件夹的权限和登记表的访问模式。新版本写的登记表意味着整个文件夹对旧版本只读，事务日志也不写。 | `change-notification.test.cjs`：“a folder whose records were written by a newer version is not written to…”；`folders-and-recovery.test.cjs` 里对文件夹操作的同类一条 |
| BR15 撤销把文件缓存回退 | 已修 | 文件副本不属于画布的撤销历史。撤销或重做之后，每个文件节点立刻回到它的文件最后一次被看到时的状态；这里不知道的，再去问工作区。 | `graph-resource.test.ts`：“undoing something on the canvas after a file changed” 下的 3 条，覆盖移动的撤销与重做、删除节点的撤销 |
| BR16 旧画布的异步刷新覆盖当前画布 | 已修 | 一次读取属于发起它的画布、访问代次、节点和文件。回来时四者有一个变了就不写。访问代次在切换开始、当前画布 id 变化、画布从存储重新加载时各加一。 | `graph-resource.test.ts`：“a read that comes back after the canvas was switched” 下的 2 条，覆盖同节点 id 不同文件、A→B→A |
| BR17 首次订阅失败后不再重试 | 已修 | 同一个工作区的订阅共用一次向宿主的请求。失败时所有等待者一起失败，不留下任何“以为已订阅”的状态，下一个来的重新请求。请求期间全部离开的，请求成功后立即退订。 | `tests/unit/workspace-subscribe.test.ts` 的 4 条 |
| BR18 窗口销毁后订阅没释放 | 已修 | 订阅归发起它的页面所有。页面被销毁、渲染进程退出、或加载了另一份文档时，它的订阅全部释放，文件夹停止监听；授权保留。正在建立中的订阅在建好的那一刻释放。 | `change-notification.test.cjs`：“a page that is closed, reloaded or loses its process takes its subscriptions with it…” 等 4 条 |

## 4. 修复过程中顺带发现并修掉的

这些不在报告里，是写回归测试时碰到的。

1. **同一个文件夹被同时打开两次**会产生两条授权，甚至两个工作区 id，其中一个随后在磁盘上被覆盖。和 BR07 一起修了。
2. **授权文件读取出错被当成“没有授权”**，下一次保存会把原文件覆盖。和 BR07 一起修了。
3. **撤销半完成移动时的误删风险**：大小写不敏感的文件系统上，只改大小写的改名会让新旧两个名字指向同一个文件。恢复逻辑只在确实有两个名字时才去掉旧名字。
4. **超过 8 MiB 的文件原来会先整个读出来、传给页面，再由页面判断太大。** 现在宿主按文件大小直接拒绝，一个字节也不读。

## 5. 既有运行时问题：指派，本轮不修

这四项在 `b3616c0..a3ffb85` 之间没有变化的文件里，属于运行时而不是文件工作区。它们各自需要运行时任务才会建立的东西（统一的取消时序、按任务隔离的执行状态），所以放到对应任务里修，并把审查给出的回归要求作为那些任务的验收条件。

| 编号 | 承接任务 | 验收要求 |
| --- | --- | --- |
| L01 准备阶段取消后仍提交 | T15、T16、T17 | 准备中取消、提交中取消、重复取消，各只有一个终态 |
| L02 取消排队项中断了正在执行的项 | T17、T28 | 排队项只取消自己；正在执行的不受影响 |
| L03 冷启动并发各起一个进程 | T15、T17 | 并发启动只起一个；启动失败可重试；旧进程迟到的退出事件不影响新进程；关闭不留进程 |
| L04 中断回答流后后端仍在生成 | T17、T28 | 流中断后模型请求被取消，不再开补答；正常完成和并发请求不受影响 |

## 6. 与计划的出入

| 项目 | 处理 |
| --- | --- |
| T31：Provider 没有进入生产调用链 | **已处理。** 页面能调用的全部入口现在是一张表（`runtime/workspace/door.cjs`），每一项都先从 Provider 登记处拿到来源，问它支持什么，再让它做。列出、读取、保存、新建走 Provider 的五个调用和共用的能力检查；移动、复制、回收等是来源可选提供的能力。桌面壳只负责在这张表前面做调用方检查。`tests/host/workspace-door.test.cjs` 用一个“不是文件夹的来源”替身走同一张表，验证本地服务从不被问到它的内容。文件面板的按钮也改成按来源报告的能力决定，不再看来源的种类。 |
| T06/A01：从文件树新建后没有直接打开可输入文档 | **调整范围，由 T09、T10 承接。** 不依附节点的编辑界面就是 M2 的文档表面。现在节点上的最小编辑是过渡，T08 用共享文档缓冲替换它。T09、T10 的验收增加一条：从文件树新建或双击文件，打开文档表面并可输入，画布不增加节点。在此之前 A01 不算通过。 |
| 空画布不能从 Graph 新建 | **已处理。** 空画布上也有“新建文件”按钮。桌面端测试从零节点、没有选过文件夹开始：新建、出现节点、输入、保存，核对文件落在画布自己的文件夹里。 |
| 文件夹操作、文件改名、恢复区还原没有承接任务 | **已处理**，见第 7 节。 |
| 测试先行记录 | 不补造历史。这一轮每一项都是先写失败测试、确认在审查的提交上失败，再修。 |
| 接口描述与实现不一致 | 交付说明里“非文本只留引用”的说法已改正：PDF、图片、HTML、Word 会走附件处理得到内容副本；其余文件是合法 UTF-8 才有副本；超过 8 MiB 或读不出内容的只留引用，节点上会写明是哪一种。 |

## 7. 这一轮补上的 R02

| 能力 | 宿主 | 界面 |
| --- | --- | --- |
| 新建文件夹 | 原有 | 新增：工具栏按钮，在当前位置输入名字 |
| 文件改名 | 原有（移动时给新名字） | 新增：行内改名，引用它的节点跟着更新 |
| 文件复制 | 原有 | 新增：在旁边生成“名字 副本” |
| 文件夹移动、改名 | 新增：里面每个已登记的文件保留身份，并在新位置被通知 | 新增：行内改名；拖到另一个文件夹上 |
| 文件夹复制 | 新增：在旁边建好再一步放到位，失败不留半成品 | 新增 |
| 文件夹回收 | 新增：有系统回收站就进系统回收站，否则进工作区恢复区；里面的文件标为丢失 | 新增，带确认 |
| 从恢复区还原 | 新增：恢复区里每样东西带一份说明（是什么、原来在哪）；可以列出、放回原处；原处被占就不放，留在恢复区；回来的文件还是原来的身份 | 新增：恢复区视图 |
| 历史版本 | 新增：列出每次保存前的内容；把某个旧版本放回去走同一条带条件的保存，被替换的内容再存为一个版本 | 尚无界面，由 T08 的冲突与版本界面使用 |

文件夹被移动或回收期间，工作区里别的修改都等它做完：正在进行的先做完，之后来的排在后面。

进了系统回收站的东西不在恢复区视图里：那由系统还原，还原之后文件会被认回原来的身份（有测试）。

契约新增两种：`RecoveryItem`、`FileVersion`。

## 8. 建议升级的模块

| 建议 | 状态 |
| --- | --- |
| 1 工作区事务协调 | 做了：初始化、操作 id、源身份、目标路径各有并发控制；恢复版本带完整性校验；日志按尝试恢复 |
| 2 资源状态与事件 | 做了：新建、丢失、重连、只读分开处理；版本登记和事件发布统一；订阅共享初始化并绑定页面生命周期 |
| 3 Graph 活资源缓存 | 做了：附件身份稳定；与撤销历史分开；异步请求带画布访问代次。T08 的共享文档缓冲会建在这上面 |
| 4 Provider 实际门面 | 做了，见第 6 节 |
| 5 文件规模与监听状态 | 做了一部分：宿主读取前按大小拒绝；监听不可用时面板会说明。“合并扫描与读取”没做，目前没有性能测量说明它是瓶颈 |
| 6 运行时生命周期 | 没做，随 L01–L04 放到运行时任务 |

## 9. 验证

全量回归（2026-10-05，macOS）：

| 命令 | 结果 | 上一轮 |
| --- | --- | --- |
| `npm run build` | 通过 | 通过 |
| `npm run lint` | 通过 | 通过 |
| `npm run test:unit` | 295 通过，8 条预期失败 | 260 + 8 |
| `npm run test:host` | 321 通过 | 263 |
| `npm run test:contracts` | 177 + 83 通过 | 165 + 77 |
| `npm run test:e2e` | 1 通过 | 1 |
| `npm run test:e2e:desktop` | 35 条，其中 1 条预期失败 | 27 |
| `test:layout`、`test:live-log`、`test:subagents` | 通过 | 通过 |

8 条预期失败仍是 M0 登记的缺口，1 条桌面端的预期失败仍是旧 IPC 桥的来源校验，都没有变化。

审查环境里没跑成的两项（网页端和桌面端的端到端测试）在这里跑通了。审查环境里失败的那条真实监听用例在这里通过；审查报告已说明那是环境里文件句柄用尽，和代码无关。

## 10. 还没做的

- A01（从文件树新建后直接打开可输入文档）：等 T09、T10。
- 历史版本的界面：等 T08。
- L01–L04：等运行时任务。
- 别的程序新建的文件不会自动出现在树里，要点刷新。
- 面板打开时画布不让位。
- 两个带相同 id 的文件夹、原件当时没打开时，无法分辨谁是原件（第 2 节的说明）。
- 卷不支持硬链接时，移动还剩“别的程序在检查和改名之间占了名字”这一种覆盖可能。
- 只在 macOS 上验证过。真实断电下的耐久性、Windows 和 Linux 的行为、系统回收站的真实往返，都没有验证。
