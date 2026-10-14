# 研究工作台：正文字体、笔记式 Markdown、公式、代码编辑与运行、大文本只读（T10c–T10f）

记录日期：2026-10-14。

这四项都是用户在 M2 之后提出、并在当天确认的，计划之外的任务编号已记入工程计划的修订记录：

- **T10c**：中文正文用宋体，英文用 Times New Roman；界面控件不改；代码保持现在的等宽字体。
- **T10d**：Markdown 编辑界面参考笔记软件，用 Obsidian 式的实时预览，不要和文本编辑器、代码编辑器长得一样；Markdown 和 LaTeX 里的公式要能快捷地实时渲染。
- **T10e**：给代码文件单独设计编辑界面和运行功能，仿照 VS Code 但更轻。要支持运行脚本、编译型语言、LaTeX 编译成 PDF。LaTeX 引擎内置到应用里，宏包按需下载；机器上已经装了 TeX 时优先用它。
- **T10f**：超过 8 MiB 的文本走计划里写的只读路径。

“默认用工具栏的 AI，单独选要先打开开关”这项修正也是同一天做的，记在 `ai-targets.md` 第 10 节。

| 提交 | 内容 |
| --- | --- |
| `97c0263` | T10c 正文字体 |
| `af22066` | T10f 大文本分段只读 |
| `ddb4c9c` | T10d 笔记式 Markdown 与公式 |
| `5d89408` | T10e 代码编辑器、运行、LaTeX 编译和内置引擎 |

## 1. T10c：正文字体

`src/index.css` 新增 `--font-text`，值为 `'Times New Roman', Times, 'Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC', serif`。拉丁字母用 Times New Roman，汉字落到宋体，Windows 上是 SimSun，Linux 上是思源宋体。

- **用这套字体的**：人读和写的正文。包括渲染出来的 Markdown（回答、笔记、预览）、输入问题和笔记的框、导图上的文字、正文类文档（Markdown、LaTeX、纯文本）的编辑器，以及从 Word 文档里取出的文字。
- **不改的**：界面自己的标签和控件，仍是无衬线字体。
- **保持等宽的**：代码，包括正文里的行内代码和代码块。公式用 KaTeX 自己的字体。

编辑器根据文件类型标出用哪套字体：`data-editor-face` 是 `text` 或 `code`。

测试有两条。`tests/unit/editor-views.test.tsx` 的 “is the text face for prose (Markdown, LaTeX, plain text) and the mono face for code” 检查编辑器选对了字体类别。真实 Electron 里，用计算后的样式检查正文、代码、界面控件各自的字体。

限制：字体没有随应用打包，用的是系统自带的字体。只在 macOS 上看过实际效果。

## 2. T10d：笔记式 Markdown 与公式

**Markdown** 打开后默认是“实时”模式：

- 在文字本身上排版。标题变大，粗体、斜体、删除线、行内代码、引用、列表符号、链接、分隔线都显示成排好的样子，公式由 KaTeX 画出。
- 标记只在光标所在的地方露出来，方便修改。这只在编辑器有焦点时生效，所以刚打开的文件不会露出第一行的标记。
- 版面像笔记：没有行号，正文字体，页面宽度的一栏。
- 另外两种模式：“源码”显示原文，“阅读”用上游的 Markdown 渲染器显示成整页。

**LaTeX 源文件**保持源码和行号，只画公式，用按钮或 Mod-Shift-M 开关。能识别的公式有 `$…$`、`\(…\)`、`\[…\]`、`$$…$$`，以及 equation、align 等显示环境；`%` 之后的注释不算。

**Markdown 里怎样算公式**：被转义的 `\$`、开头 `$` 后面跟空格的、结尾 `$` 前面是空格或后面跟数字的，都不算公式。这样可以和金额区分开。代码里的内容也不算。

**安全和文件内容**：

- KaTeX 用 `trust: false` 调用：公式里的链接和 HTML 都不生效，解析不了的公式原样显示并加标记，不报错。
- 文件里永远是输入的原文。所有排版都是覆盖在文字上的装饰，保存的就是键入的内容。

**实现**：`src/components/editors/live-preview.ts` 负责找公式，以及在 CodeMirror 的语法树上加装饰。装饰来自 StateField，因为跨行替换必须这样做。`MarkdownEditor.tsx` 提供三种模式；`TexEditor.tsx` 提供公式开关。

**测试**：

- `tests/unit/live-preview.test.tsx`，13 条：找公式（Markdown 的各种分隔符、金额、代码，LaTeX 的环境和注释）；Markdown 打开时的排版；光标处露出标记；输入后的文件内容；失去焦点后整页排版；不显示行号、用正文字体；三种模式；公式里的 `javascript:` 链接不生效；LaTeX 的公式开关。
- 真实 Electron：“a Markdown file is written as it reads, formulas drawn, and markup in it is shown and never run”。
- 动手前，已有的 Markdown 编辑器在这些用例上的失败记录：`evidence/T10d-live-preview-before-implementation.txt`。

**限制**：实时模式不排版表格、图片、脚注和任务列表，这些在实时模式里显示为源码，阅读模式里由上游渲染器正常显示。LaTeX 文件只画公式，不排版其他命令。

## 3. T10e：代码编辑器、运行和 LaTeX 编译

### 界面

`.tex` 和 `.ltx` 之外的非正文文件，用 `CodeEditor.tsx` 打开。界面分四部分：

- **顶部工具条**：显示语言名；有运行或“编译并运行”按钮，运行中变成停止按钮；还有输出面板的开关。缺工具时，工具条上直接写明缺哪个，运行按钮不可用。
- **编辑区**：行号、代码折叠、查找替换（Mod-F）、括号自动补全、选中词的其他出现处高亮。
- **输出面板**：在代码下方。显示实际执行的命令；标准输出和标准错误分开显示，错误是红色；结尾写明完成、失败或已停止，以及退出码和耗时。
- **底部状态栏**：“行 n，列 n”、语言、编码。

数据、配置这类没有运行方式的文件（JSON、YAML、CSV 等）也用这个编辑器，只是没有运行按钮。

LaTeX 源文件仍在 `TexEditor.tsx` 里编辑，多了“编译 PDF”按钮、停止按钮和同样的输出面板。编译成功后，PDF 在右侧打开阅读；再编译时更新的还是这个阅读器，不会开第二个。

点运行或编译时，有未保存的输入就先保存，保存不成功就不运行。所以运行的总是屏幕上的内容。

### 运行器（宿主，`runtime/workspace/runner.cjs`）

- **只运行明确交给它的那个文件，只用固定的命令表。**
  - 脚本：Python（`python3 -u`），JavaScript（`node`），TypeScript（`node --experimental-strip-types`），Shell、zsh、Ruby、Perl、R（`Rscript`）、Julia、Lua、Swift、Java。
  - 编译型：C（`cc -std=c11`）、C++（`c++ -std=c++17`）、Rust（`rustc -O`）先编译再运行；Go 用 `go run`。
- **不经过 shell。** 用参数数组和 `shell: false` 启动，文件名只作为参数传进去。文件名里有空格、分号、`$(…)` 时也不会被当成命令执行，有测试专门覆盖。
- **在文件所在的文件夹里运行。** 编译产物写在工作区之外的临时目录，运行后不在工作区留下东西。
- **停止时连同它启动的子进程一起结束。** 每次运行是一个独立的进程组。
- **运行属于发起它的页面**：别的页面不能停它；页面关闭时，它的运行一起停。只有本地文件夹里的文件能运行。
- **输出上限 2 MB**，超过的部分截掉并注明。
- **找工具的位置**：除了窗口拿到的 PATH，还会看这台机器上常见的安装目录（`/opt/homebrew/bin`、`/usr/local/bin`、`/Library/TeX/texbin`、`~/.cargo/bin` 等）。从程序坞启动的应用拿到的 PATH 很短，不这样就找不到 Homebrew 装的工具。

**必须说清楚的一点**：脚本是用户自己的程序，以用户本人的权限运行，**没有沙箱**。运行器保证的是只运行被要求的那个文件、不经过 shell，不保证脚本本身做什么。

### LaTeX 编译

按下面的顺序选用：

1. 机器上有 `latexmk` 和对应的引擎时，用 `latexmk`。源文件里有中文，或用了 fontspec、ctex、xeCJK 时，引擎是 xelatex，否则是 pdflatex。
2. 只有引擎、没有 `latexmk` 时，直接用引擎编译两遍。
3. 都没有时，用应用自带的 Tectonic。

参数统一加 `-interaction=nonstopmode -halt-on-error -file-line-error -no-shell-escape`。Tectonic 用 `--untrusted`，它在这种模式下不执行 shell-escape。编译在临时目录里进行，PDF 写回源文件旁边，在工作区里是一个普通文件：已有同名 PDF 时整体替换，身份保持不变；看着它的阅读器会收到更新。编译失败时，原来的 PDF 不动，并给出原因。

### 内置的 Tectonic

用户选的是“内置引擎，宏包按需下载”。

- **版本**：Tectonic 0.17.0，官方发布的二进制文件。四个平台（mac-arm64、mac-x64、win-x64、linux-x64）各有固定的 SHA-256，写在 `desktop/scripts/fetch-tectonic.mjs` 里，校验不通过就不用。
- **为什么不用 Homebrew 版**：它链接了 Homebrew 的动态库，不能随应用分发。官方的 macOS 版只链接系统框架。
- **怎么打包**：`npm run tectonic --prefix desktop` 把它下载到 `desktop/vendor/tectonic/<平台>/`，并附上版本和许可说明。这个目录和下载缓存都不进仓库（`.gitignore`）。`dist:*` 打包脚本会先下载当前平台的版本；`extraResources` 把它放进应用资源目录；macOS 签名配置里把它列为需要签名的二进制。
- **宏包**：第一次用到某个宏包时联网下载，缓存在用户的缓存目录（macOS 是 `~/Library/Caches/Tectonic`）。第一次编译中文文档要下载不少宏包，测试里等过 30 秒以上。

### 这台机器上装了什么

按用户“没有就装”的要求，用 Homebrew 装了：

- TeX Live 20260301（约 4.6 GB）。
- `tectonic`，只用来在测试里代表应用自带的那份。
- Rust 和 Go，用来真实验证这两种语言的运行路径。

官方 Tectonic 二进制已下载到 `desktop/vendor`（mac-arm64）。

### 测试

- `tests/host/runner.test.cjs`，在真实临时目录里用真实工具运行；缺对应工具的机器会跳过并写明原因：
  - 脚本的输出、错误和退出码；文件名里带 shell 字符。
  - C 编译成功和编译失败；C++、Rust、Go 编译并运行。
  - 停止运行，页面离开时停止它的运行。
  - 运行前告知需要和缺少哪些工具；缺工具时立刻结束并说明。
  - 常见安装目录的查找。
  - LaTeX 编译成 PDF，并替换旁边的旧 PDF；编译失败；真实 TeX Live 编译带中文和公式的文档；在没有 TeX 时用 Tectonic 编译。
- `tests/unit/code-editor.test.tsx`，9 条：语言、行号、折叠、正文还是代码字体、光标位置；查找；先保存再运行，输出分流显示；停止；缺工具；数据文件没有运行按钮；两个文件各看各的输出；LaTeX 编译后右侧打开 PDF、再编译仍是同一个阅读器；编译失败不打开任何东西。
- 真实 Electron，两条：“a script is run from its editor with the interpreter installed here, and its output shows under the code”；“a LaTeX source with Chinese is compiled to a PDF beside it, which opens to read”。

### 如实说明

- **这部分的测试是和代码一起写的。** 这是新功能，之前没有可以先跑失败的旧行为，所以没有“动手前的失败记录”。
- **打包后的应用没有构建，也没有签名、公证。** Tectonic 放进应用资源目录、在签名后的 macOS 应用里能否运行，都没有验证；验证过的只是开发环境下的路径和测试。Windows、Linux 的运行器和 Tectonic 也没有验证。
- **没有的功能**：标准输入（程序要读输入时只会读到结束）、调试器、语言服务（补全、跳转、诊断）、多文件项目的构建系统。Go 只支持单文件的 `go run`。
- **宿主测试出现过一次没有复现的失败。** 全量宿主测试里有一次出现了一条失败，没有记下名字。之后重跑 4 遍全量、并把时序相关的测试单独跑了 6 遍，都没有再出现。
- **截图钩子仅用于验证。** `tests/e2e-desktop/workspace-ui.spec.ts` 里有几个按环境变量 `TDAG_SHOT_DIR` 截图的钩子，是为了人工看界面效果加的，平常不生效，不是断言。

## 4. T10f：超过 8 MiB 的文本，分段只读

8 MiB 是计划里规定的“可编辑”上限，不是“可读”上限。上一版只做到了“说明太大，并提供在文件管理器中显示”，计划写的“进入只读路径”没有做到。现在：

- 超过上限的文本文件仍在表面里打开，内容只读显示（`LargeTextView.tsx`）。先显示开头，向下滚动或点“显示更多”时再读下一段，每段 512 KiB。文件大小显示在底部。
- 宿主新增了 `workspace:read-text-range`。每次最多读 1 MiB；段的结尾对齐到行尾，不会切在一个字符中间；要求的起点不在字符边界上时，向前对齐。
- 这些内容不进入文档服务：不能输入，没有草稿，也不会保存。
- 显示期间文件被改了，已显示的内容作废，从头重新读。
- 原来的“在文件管理器中显示”按钮保留在底部。

测试：

- `tests/host/file-ops.test.cjs`：分段读取的边界（行尾、多字节字符、上限、超出文件末尾）。
- `tests/unit/editor-views.test.tsx`：“[T10f] a text file above the limit is shown read-only, a part at a time, and nothing of it is opened to type into”。
- 真实 Electron：“a text file above the limit is shown read-only, a part at a time, and offers to show the file”。

限制：没有在大文件里搜索，也不能直接跳到文件中间某个位置，只能从头往后读。

## 5. T10g：快捷输入公式（2026-10-15）

用户 2026-10-15 提出：在 Markdown 里打 LaTeX 公式要快一些。选定的内容是：命令补全和片段、`$` 自动配对加快捷键、光标在公式里时浮出预览（`src/components/editors/formula-input.ts`，提交 `d1673ab`）。

**命令补全**：

- 在 Markdown 的公式里输入 `\` 开头的命令时会弹出候选；正文里不弹。LaTeX 文件里任何地方都弹，并且多一组文档命令（`\section{}`、各种环境等）。
- 候选包括希腊字母、运算符、函数名，每个都标出它画出来是什么样（如 `\alpha` 标 α）。
- 结构类命令是片段：选中 `\frac` 后得到 `\frac{}{}`，光标停在第一个空，按 Tab 跳到下一个。同类的还有 `\sum_{}^{}`、`\int_{}^{}`、`\sqrt[]{}`、矩阵、cases、aligned 等。

**配对**：

- 输入 `$` 时自动补上配对的 `$`；在公式结尾再输入 `$`，光标跳过那个配对符，不会多出一个。
- 选中文字后输入 `$`，选中的文字变成公式。
- 转义的 `\$`、紧跟在单词或数字后面的 `$`（比如 US$），不会配对。
- 公式里输入 `{` 会配上 `}`；LaTeX 文件里任何地方都这样。

**快捷键**：

- Mod-E 插入行内公式，Mod-Shift-E 插入独占几行的公式（Markdown 用 `$$`，LaTeX 用 `\[ \]`）。有选中文字时，会把选中的内容包进去。
- 没有用 Mod-M：macOS 上 Cmd+M 被“最小化窗口”占用，按键到不了页面。
- 原来的 Mod-Shift-M（切换排版和源码）不变。

**浮出预览**：编辑器有焦点、光标停在公式里时，公式下方浮出 KaTeX 画好的结果。KaTeX 以 `trust: false` 调用；还解析不了的公式照原样显示，并加上标记。

**测试**：`tests/unit/formula-input.test.tsx`，13 条。实现之前，10 条失败、3 条对照通过（`evidence/T10g-formula-input-before-implementation.txt`）。测试里的“输入”走的是编辑器自己的输入处理链；按 Shift 时键名用大写，和真实键盘一致。

## 6. T10h：Markdown 导出成 Word，阅读 Word 时显示公式（2026-10-15）

用户选的是“Markdown 写，导出成 Word”，并且读 Word 文档时也要把公式显示出来（提交 `464c73d`）。

**导出**：Markdown 编辑器工具栏上的“Word”按钮。

- 先保存当前输入，保存不成功就不导出。然后在页面里生成 .docx（`src/lib/docx/write.ts`），放在笔记旁边。
- 生成的 Word 文档：
  - 标题、加粗、斜体、删除线、行内代码、链接、引用、代码块、表格（首行加粗、对齐方式保留）都用 Word 自己的样式。
  - 列表用 Word 的编号，有序列表各自从头编号，任务列表用 ☐ 和 ☑。
  - 正文字体是 Times New Roman，中文用宋体，和应用里一致。
- **公式是 Word 自己的公式（OMML）**，在 Word 里可以直接编辑。转换路径：KaTeX 先把 LaTeX 转成 MathML，`omml.ts` 再按结构写成 OMML，包括分式、上下标、根号、带上下限的求和与积分、重音、上下划线、极限、括号、矩阵、公式里的文字和直立的函数名。解析不了的公式按原样写成文字。
- **每次导出都是新文件**：已有同名文件时用下一个空名字（`笔记-2.docx`），不会覆盖你可能已经在 Word 里改过的那份。
  - 宿主的新建文件现在可以直接接收字节。
  - 门上新增的入口 `workspace:export-beside` 只接受 .docx、只接受字节、上限 64 MiB，并且只用于本地文件夹。
- 导出后，Word 文档在右侧打开，笔记停到左侧，两边并排。LaTeX 编译出 PDF 后也改成这样。这是测试时发现的：右侧停靠的结果窗会盖住原文件窗口的工具栏，没法再点导出或编译。

**阅读 Word 文档时的公式**：

- 只有含公式的 Word 文档走新的读取方式（`read.ts`）：逐段读出文字和公式，公式由 `mathml.ts` 用 DOM 一个元素一个元素地建成 MathML，交给浏览器画。文档里的任何内容都不会被当成标记解析进页面。
- 阅读器可引用的文本，就是屏幕上显示的内容拼起来的，所以跨公式选中引用时，引用到的文字和看到的一致。
- 不含公式的 Word 文档仍按原来的方式读（mammoth），结果不变。

**验证**：

- `tests/host/export-beside.test.cjs`，4 条（实现前全部失败，见 `evidence/T10h-export-host-before-implementation.txt`）：放在旁边、用原文件名；再导出不覆盖，在 Word 里改过的那份保持原样；同一操作只生成一份；格式、类型、大小、只读文件夹的限制。
- `tests/unit/word-documents.test.tsx`，11 条：
  - 各种 LaTeX 结构转成 OMML，以及再读回成 MathML。
  - 生成的文件能被 mammoth 读出，各部件齐全。
  - 阅读器显示公式，跨公式引用的文字与显示一致；不含公式的文档照旧显示。
  - 编辑器按钮：先保存再导出，结果在右侧打开。
  
  这些是全新的模块，实现前的失败就是“找不到模块”（`evidence/T10h-word-documents-before-implementation.txt`）。
- 应用之外的检查：用 Homebrew 装了 pandoc 3.12.1。它把生成文件里的全部公式读回成了正确的 LaTeX（`evidence/T10h-word-export-read-back-by-pandoc.txt`），标题、列表编号、引用、表格也都还原了。macOS 自带的 `textutil` 也能打开这个文件。
- 真实 Electron：“a Markdown note with formulas is made into a Word document beside it, whose formulas are drawn where it is read”。分式的分子确实画在分母上方；再导出一次得到 `formulas-2.docx`，第一份字节不变。

**如实说明和限制**：

- **没有在 Microsoft Word 里打开验证。** 这台机器装了 Word，但用脚本驱动它会在你的屏幕上开窗口，所以没做。验证靠的是 pandoc、mammoth 和 textutil。建议你自己用 Word 打开一份导出的文件看看。
- 求和、积分把同一行里后面的全部内容当作作用对象。Word 里看起来一样，只是语义上的分组比手写的宽。
- 图片不写进 Word 文档，原位置写成 `[说明文字]`；脚注只保留标记。
- **画布上作为材料的 Word 文档，交给模型的文字仍然不含公式。** 那条路径还在用 mammoth 取文字，把 OMML 转成 LaTeX 交给模型没有做。
- 含公式的 Word 文档，阅读器的文本换成了新的读法。在这之前从这类文档里取的引用，位置偏移可能对不上，引用里存的原文还在。
