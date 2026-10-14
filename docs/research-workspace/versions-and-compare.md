# 研究工作台：历史版本与冲突对比的界面（T10b）

记录日期：2026-10-14。T10b 是第二轮审查之后单独立项的任务（见工程计划修订记录）：文件每次保存前的内容，宿主从 M1 起就能列出和还原，但一直没有界面；冲突时只有三选一，没有逐行对比。这两件事先后被指给 T08 和 T10，都没有做。本文是它的交付说明。

## 1. 文件

| 文件 | 内容 |
| --- | --- |
| `src/components/surfaces/VersionsPanel.tsx` | 历史版本面板，以及冲突两边的并排对比 |
| `src/lib/documents/line-diff.ts` | 两段文字的逐行比较 |
| `src/components/surfaces/DocumentBody.tsx` | 状态栏上的历史按钮；冲突提示里的“逐行对比” |
| `src/lib/documents/document-service.ts` | `restoreVersion(documentId, revision)` |
| `runtime/workspace/file-ops.cjs`、`index.cjs`、`door.cjs`、`providers/local.cjs`、`desktop/preload.js` | 新增“读取某个历史版本的文字”这一个调用，供查看用 |
| `tests/unit/document-versions.test.tsx` | 11 条 |
| `tests/host/folders-and-recovery.test.cjs`、`workspace-door.test.cjs` | 宿主读取版本 |
| `tests/e2e-desktop/workspace-ui.spec.ts` | 真实桌面端 1 条 |
| `evidence/T10b-versions-before-implementation.txt` | 实现之前的失败记录 |

## 2. 历史版本

文档表面底部的状态栏多了一个历史按钮。点开后，在编辑器和状态栏之间出现一个面板，列出这个文件每次保存之前被替换掉的内容，最新的在前，每条显示保留的时间和大小。面板不显示任何版本的正文，直到点“查看”。

- **查看**：把那个版本的文字读出来显示在条目下面。不改文件，不改文档，不产生新版本。
- **放回**：用那个版本替换文件现在的内容。这是一次普通的保存：
  - 只在文档显示的那个内容之上进行。读取之后文件被别的程序改过，就不写，提示原因，文档改为显示文件当前的内容。
  - 被替换掉的内容作为一个新版本留下，可以再放回。
  - 有没保存的输入时不能放回（按钮禁用并说明要先保存），因为放回会把它替换掉。
  - 文件不可写时，只有“查看”，没有“放回”。
- 放回成功后，文档直接读取文件并显示新内容，不依赖文件夹监听。撤销历史从这里重新开始，和文件在别处被改时一样。

宿主一侧新增的 `readVersion(fileId, revision)` 只读不写：返回文字、版本号、编码和换行方式，和读取文件正文的格式一样。没有保留完整的版本返回 `not-found`；超过 8 MiB 的版本不读。

## 3. 逐行对比

冲突提示里多了“逐行对比”。点开后在三个处理按钮上方显示两栏：左边是缓冲里的内容，右边是文件现在的内容，不同的行有底色，相同的行变淡。三个处理动作（用磁盘上的、用我的覆盖、两边都保留）没有变。

比较按行进行：先找两边顺序一致的相同行，夹在它们之间的行按顺序两两并排，一边多出来的行旁边留空。超过 3000 行的文本不找移动的段落，直接按行号对齐比较，避免卡住。

它只是给人看的。合并仍然由人决定；没有做自动三方合并，因为没有保留共同的基线文本。

## 4. 验证

验收条件（工程计划修订记录里为 T10b 写的）和对应的测试：

| 验收 | 测试（`document-versions.test.tsx`，除非另注） |
| --- | --- |
| 保存三次后列出三个旧版本 | “is listed in the document's surface: one entry for each save that replaced something, newest first” |
| 放回其中一个后文件内容是那个版本，被替换的内容又成为一个可放回的版本 | “can be put back: the file and the document hold it, and what it replaced is kept as a version in turn”；桌面端 “what a file held before each save is listed in its surface, can be looked at, and can be put back” |
| 另一个程序改过文件后放回被拒绝 | “is not put back over a change another program made since…”；宿主 `folders-and-recovery.test.cjs` 原有的一条 |
| 只读工作区里只能看不能放回 | “can be looked at and not put back in a file that cannot be written” |
| 两边各改一行时，两行都被标出，其余行不标 | “marks the lines that differ and no others” |
| 三个处理动作保持不变 | “is offered in the document when its typing is in conflict with the file, and the three ways to settle it stay” |

另外：查看不改任何东西；有未保存输入时不能放回；还没有版本时明说；一边多出一行时后面的行仍然对齐。

回归结果（2026-10-14，macOS）：lint 和 build 通过；单元测试 469 通过、6 条预期失败；宿主 357；契约 193 + 91；网页端到端 2；桌面端到端 55（其中 1 条是 M0 登记的预期失败）；三个旧脚本通过。

## 5. 没做的和已知限制

- **版本只按时间和大小列出，没有“和当前内容相比改了什么”的摘要。** 要看差别，先“查看”，再自己比。把逐行对比用到历史版本上是顺手的下一步，没有做。
- **版本没有清理界面。** 每次保存都留一个版本，一直留在工作区的恢复区里。宿主也没有清理策略。
- **桌面端测试里没有验“别的程序改过之后放回被拒绝”。** 文件夹被监听时，变更通知和点击谁先到不由测试决定；这一条在单元测试里验，那里顺序是固定的。
- **阅读器（PDF、Word、图片）没有历史版本入口。** 它们不通过这个应用保存，所以没有版本。
- 只在 macOS 上验证过。
