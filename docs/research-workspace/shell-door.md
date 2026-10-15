# 研究工作台：桌面外壳的调用方校验与窗口导航

记录日期：2026-10-04。这里修掉的是 T03 顺带确认的那个既有问题（[workspace-service.md](workspace-service.md) 第 4 节）：旧通道不检查调用方，而应用窗口可以被带到别的页面。同一天后补了新窗口链接的协议（第 6 节）。

## 1. 问题

- `desktop/main.js` 里的旧通道（`agents:*`、`sessions:*`、`local:*`、`canvas:*`、`why:*`、`commands:*`、`codex:*`、`update:*`）都不检查是谁在调用。预加载脚本把桥接交给窗口显示的任何页面。
- 窗口的导航规则放行本机任意端口，以及 `file:` 和 `data:` 地址。窗口一旦被带过去，那个页面就能发起 Agent 运行、往任意目录写文件、读会话记录。
- 修的时候多确认了一点：旧规则是按字符串开头判断的，所以把应用地址写成用户名的地址（`http://127.0.0.1:x@别的主机/`）也能通过。用探针在真实 Electron 里试过，窗口落到了另一个主机名上。也就是说，能进到窗口里的不只是本机页面。

## 2. 改动

| 文件 | 改动 |
| --- | --- |
| `runtime/workspace/ipc-guard.cjs` | 新增 `isAppUrl(url, origin)`：地址是否在应用自己的源之内。`checkSender` 改用它，判断结果不变 |
| `desktop/main.js` | 新增共用的 `handle(channel, fn)`，全部通道都通过它登记；导航规则改为只认应用自己的源；新窗口链接和被拦下的导航共用 `openOutside`，只把 `http(s)` 和 `mailto` 交给系统（第 6 节） |
| `tests/host/workspace-service.test.cjs` | `isAppUrl` 的各种地址；`main.js` 里除 `handle` 之外没有别的登记入口 |
| `tests/e2e-desktop/workspace-door.spec.ts` | 原来的预期失败改成普通测试，并补了导航和新窗口链接的测试 |

规则：

- **每个通道先查调用方，再运行处理函数。** 只接受应用窗口的顶层框架，并且显示的是应用自己的地址（内置服务的 `http://127.0.0.1:<端口>`）。其它一律以 `refused: <原因>` 拒绝。处理函数本身没有改。`workspace:*` 的 `door` 现在建在 `handle` 之上，行为不变。
- **顶层页面只能在应用自己的源之内移动。** 其它导航都拦下：`http(s)` 和 `mailto` 链接交给系统浏览器（和以前一样），别的直接丢弃。响应里指向本机其它端口的链接，现在在系统浏览器里打开，不再占用应用窗口。
- **重定向按同一条规则处理**（只管顶层框架）：从应用自己的地址重定向出去，同样拦下。内置服务目前没有这样的重定向，这一条是把口子补齐。
- **启动页没有例外。** `splash.html` 没有脚本，不调用任何通道。

`preload.js` 里暴露的 57 个通道和 `main.js` 里登记的通道逐个对过，一一对应，全部经过 `handle`。

## 3. 应用自己的流程

逐项看过，用探针脚本在 Electron 43.3.0 里确认了各自触发什么导航事件：

| 流程 | 结果 |
| --- | --- |
| 启动页 → 应用，以及服务启动失败时的提示页 | 由主进程加载，不经过导航规则 |
| 页面自己发起的重新加载（发现新版本、`#view=` 切换） | 同源，放行 |
| `?dv=…` 地址、改 `#` 片段 | 同源；改片段不触发导航事件 |
| 导出下载（`blob:` 和 `data:` 下载链接） | 不触发导航事件，照常进入下载 |
| `thoughtdag://` 深链 | 主进程发消息给页面，不是导航；启动时拉取待处理深链的调用照常应答 |
| 响应里的外部链接、新窗口链接 | `http(s)` 和 `mailto` 照常交给系统浏览器；其它协议丢弃（第 6 节） |
| 界面里写死的链接（仓库、文档、更新说明、取密钥的页面、分享、下载新版本） | 都是 `https`，照常交给系统浏览器 |
| 第三方登录 | 桌面端用 `window.open` 打开一个 `https` 地址，交给系统浏览器；回调落在内置服务上，不涉及窗口导航 |
| 历史后退到启动页 | 现在拦下。以前会退回启动页并停在那里 |

## 4. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过 |
| `npm run lint` | 通过 |
| `npm run test:unit` | 188 通过，8 条预期失败（基线里已有的缺口，与本次无关） |
| `npm run test:host` | 179 通过 |
| `npm run test:e2e:desktop` | 10 通过 |
| `npm run test:e2e`（开着 `npm run dev`） | 1 通过（第 6 节的改动之后没有重跑） |
| `npm run smoke`（开着 `npm run dev`） | 通过；控制台 4 条 `ERR_CONNECTION_REFUSED` 与基线相同（第 6 节的改动之后没有重跑） |

真实桌面应用里的测试（`tests/e2e-desktop/workspace-door.spec.ts`）：

- 旧桥接每一族各取一个调用，在应用自己的页面里照常应答；
- 页面想去本机另一个端口：拦下，链接交给系统浏览器，窗口留在原地；
- 把应用地址写成用户名的地址：拦下；
- 历史后退到启动页：拦下；
- 页面自己重新加载：放行，之后桥接照常可用；
- 开新窗口的链接和 `window.open`：网页和邮件地址交给系统浏览器，其它协议一个也没有交出去；
- 让主进程直接把窗口加载到另一个页面（窗口自己已经去不了）：那个页面拿得到桥接，`workspace:*` 和旧桥接的每个调用都被拒绝。

这个测试除了系统文件夹选择器之外又替换了一样东西：交给系统浏览器的链接只记录、不真的打开。

三处改动各自单独撤掉，测试都会失败：换回旧的 `main.js`，“窗口不离开应用”失败；去掉 `handle` 里的校验，“被拒绝在门口”失败；把新窗口的处理函数换回不看协议的写法，“新窗口链接”失败，多交出去 10 个地址。改动前，原来那条预期失败用 `TDAG_SHOW_GAPS=1` 复现过。

另外在临时配置目录上启动过一次真实应用：启动页之后正常进入应用，控制台没有被拒绝的调用，也没有报错。

## 5. 没有做的

- 主进程发给页面的事件（`agents:event`、`sessions:changed`、`update:event`、深链）不区分页面，窗口里是什么页面就发给什么页面。导航收紧之后，窗口里只会是应用本身、启动页或启动失败提示页，后两个没有脚本。
- 预加载脚本仍然把桥接暴露给窗口显示的任何页面；拦截发生在主进程。
- 新窗口链接的协议已评估并收紧，见第 6 节；那一节末尾列了它自己没做的事。
- 只在 macOS 的开发模式下验证过，没有验证打包后的应用。
- 上游以后新增的通道如果直接写 `ipcMain.handle`，主进程测试会失败，需要改成 `handle`。

## 6. 新窗口链接的协议

6.1–6.3 记录第一轮调查与外壳修复；6.4 起记录同日补上的渲染校验、入口校验与追加验证。前面的测试数字是第一轮结果，当前结果见本节后半。

第 5 节原来列着一条“没有评估”：`setWindowOpenHandler` 不看协议，把任何地址都交给 `shell.openExternal`。评估的结论是：非网页协议到得了，所以收紧了。

### 6.1 哪些入口，哪些协议到得了

页面里能开新窗口的地方只有 `target="_blank"` 的链接和 `window.open`。逐个看过源码，并在 Electron 43.3.0 里用探针实测（探针把 `shell.openExternal` 换成只记录，没有真的打开任何东西）：

| 入口 | 地址从哪来 | 到得了处理函数的协议 |
| --- | --- | --- |
| 响应下方的引用链接（`ThoughtNode.tsx`、`ResponseSection.tsx`） | 搜索服务返回的结果（`server.mjs` 只过滤域名，不看协议）；导入的画布文件（导入时不检查） | 不限。导入一张画布，引用写成 `smb:`，点击后原样到达 |
| 链接卡片的打开按钮（`ContentNode.tsx`） | 粘贴生成时只认 `http(s)`；导入的画布文件不检查 | 不限。导入画布里的 `ssh:` 点击后原样到达 |
| 响应正文里的 Markdown 链接（`Markdown.tsx`） | 模型输出、导入的画布、会话记录 | 消毒器只留 `http`、`https`、`mailto`、`irc`、`ircs`、`xmpp`，别的协议连 `href` 一起去掉。实测 `irc:` 到达；`smb:` 和 `file:` 的链接渲染出来没有地址 |
| 界面里写死的链接和 `window.open`（仓库、文档、更新说明、取密钥的页面、分享、下载新版本、第三方登录） | 源码里的常量 | 只有 `https` |
| HTML 阅读器里的链接（`HtmlMaterialView.tsx`） | 导入的 HTML 文件 | 到不了。页面放在沙箱框架里，没有开新窗口的权限，实测被拦下 |

另外两点：

- 按住 ⌘ 点击一个不带 `target` 的链接，走的是同一个处理函数（实测）。
- `file:` 到不了处理函数：页面是 `http` 源，Chromium 自己拦下（控制台 `Not allowed to load local resource`），链接和 `window.open` 都一样。`javascript:` 到达时已经变成 `about:blank`。其余试过的协议（`smb:`、`ssh:`、`tel:`、`irc:`、`data:`、`thoughtdag:`、几种应用自定义协议）都原样到达。

### 6.2 到了会怎样

`shell.openExternal` 把地址交给操作系统，系统启动登记了这个协议的应用，并把整个地址传给它：连接地址里写的文件共享、向地址里写的主机发起远程登录、让别的应用执行它自己的链接指令，等等。地址是提供数据的一方选的，界面上只显示标题，看不到地址，触发只需要点一下。数据来源是别人给的画布文件，或者第三方搜索服务返回的结果。

这些是各协议公开的行为，没有在这台机器上真的执行过。Electron 的安全说明也明确要求不要把不可信的地址交给 `shell.openExternal`。

### 6.3 改动

`main.js` 里新增 `openOutside(url)`：只有 `http(s)` 和 `mailto` 才交给 `shell.openExternal`，别的丢弃。新窗口的处理函数和导航规则（`stayInApp`）都调用它，两处不会再各写各的。

应用自己用到的东西逐项确认过，不受影响：

- `thoughtdag://` 链接不经过这里。应用内的（回忆结果、记忆页）由页面自己的 `openWhyLink` 处理；系统发来的由主进程通过 `open-url` 或启动参数接收，再发消息给页面。
- 第三方登录用 `window.open` 打开 `https` 地址，照常交给系统浏览器（测试里有一条同样形状的地址）。
- 会话地图的“在应用里打开”是主进程自己调用 `shell.openExternal`，协议是主进程里写死的，不经过这个处理函数。

行为上的变化：Markdown 里的 `irc:`、`ircs:`、`xmpp:` 链接以前会交给系统，现在点了没有反应。

### 6.4 渲染与入口：保护不再只在桌面外壳

共享 `shared/web-url.mjs` 的 `isWebUrl` 只接受能被 `URL` 解析的绝对 HTTP(S) 地址；协议大小写不敏感，拒绝空白、相对路径、缺少主机和其它协议。通过校验的地址保留原始拼写。类型声明供前端使用；打包脚本原本就会复制 `shared/`，无需新增打包例外。

| 边界 | 处理 | 证据 |
| --- | --- | --- |
| `ThoughtNode`、`ResponseSection` 的引用 | 每次渲染都检查 URL；无效地址走原有纯文字分支，保留标题和引用编号 | 实际组件渲染测试，不经过入口清洗；三个位置逐一撤掉防护，各自失败 |
| `ContentNode` 的链接卡片 | 无效地址不渲染外部打开按钮；标题、正文仍是文字 | 实际组件渲染测试及独立撤销验证 |
| `server.mjs`、网页版 `functions/api/[[path]].js` | `pushNumbered` 在累积来源和形成给模型的编号文本之前清除无效 URL；保留整条来源及其顺序 | 两侧四种搜索提供方及跨工具编号，共 10 条主机测试 |
| `streaming.ts` 的 `onSources` | 保存来源前清除无效 URL，覆盖本地、托管及旧代理返回的数据 | 真实 SSE 解析、生成与 store 测试；只替换网络响应 |
| 普通画布导入、范式文件导入 | 写入 IndexedDB 和切换画布之前清理引用与链接卡片 URL | 测试真实导入和重载流程，同时断言持久化数据与 store；IndexedDB 使用测试环境已有的 fake-indexeddb |
| `instantiateParadigm` | 实例化后再检查素材 URL，覆盖 IndexedDB 里已有的旧范式 | note/file/link/frame 四条测试，输入被冻结以检查没有原地修改 |
| `decodeViewerHash` | 解压分享链接后、进入 viewer store 之前清理 | 用独立压缩器生成恶意载荷，再调用实际解码函数 |

入口清理共用 `src/lib/outbound-links.ts`，只把无效的 `url` / `linkUrl` 置为 `undefined`；不删除来源、不重排编号，不修改正文里的应用深链或本地路径。渲染层仍独立检查，因此以前已经存入 IndexedDB 的画布也不会因为跳过导入而露出可点击的非网页地址。

以下位置有意不重复加检查（均已读源码）：

- 各搜索提供方的字段映射：全部经过 `pushNumbered`，在这一处清理可以同时覆盖 `sources` 与给模型的编号文本，避免四处各写一套。`isBlockedUrl` 继续只负责域名策略。
- MCP：任务说明中“结果也进入 sources”与当前实现不符。MCP 的 `execute` 直接返回工具结果，不调用 `pushNumbered`；主机测试也确认执行它不改变来源列表。因此没有新增 MCP 格式转换或过滤任意工具正文。模型生成的 Markdown 仍受既有消毒器约束。
- `worker.js` 只转发到已修复的托管代理；没有第二份需要改的来源映射。
- 粘贴、适配器 `toolScope` 和事件 `urlArtifact` 已限制 HTTP(S)，保持原行为；它们不是本次不安全数据的入口。原有 IndexedDB 数据不做破坏性迁移，渲染时检查负责兜底。
- 导出和 `buildViewerLink` 不再额外清理：接收端解码/导入及渲染都检查，正文与原始证据可以保留。`/api/fetch-url` 及私有主机/重定向策略未改，本轮没有补测其 SSRF 防护。

### 6.5 点击方式与大写协议：实际运行的结果

实际 React DOM 事件测试确认：原来的 `onClick` 会阻止普通与 Shift 点击导航，但中键的 `auxclick` 不触发它。为本地路径的 Anchor 补上 `onAuxClick`，仅响应 `button === 1`，调用与普通点击相同的 `openLocalPath`，同时阻止默认导航与事件传播；右键保持原样。这一步没有调整 Markdown 的协议白名单；用户随后批准的收紧见 6.7。

补充在真实 Electron 43.3.0 / Chromium 150.0.7871.212 里验证，测试在 `main.js` 加载前把 `shell.openExternal`、本地文件打开与协议注册换成记录器，没有把任何非网页 URL 交给真实操作系统：

| 输入 | 实测结果 |
| --- | --- |
| 中键、Shift；普通链接与 `_blank` | `smb/ssh/tel/irc/ircs/xmpp/自定义应用/thoughtdag` 8 种协议 × 2 种 target × 2 种手势，共 32 次到达窗口处理器并被拒绝，外发记录为零 |
| 同样四种组合中的 HTTP、HTTPS、mailto、大写 HTTPS、HTTPS 登录回调地址 | 共 20 次正常交给外发记录器；新窗口均未创建 |
| `HTTPS://EXAMPLE.INVALID/UpperCase?Keep=Case` | `window.open`、`_blank`、普通导航到达处理器前都变成 `https://example.invalid/UpperCase?Keep=Case`；路径和查询大小写保留。外壳原有正则因此无需调整 |
| `file:` 的中键、Shift 点击 | Chromium 先拒绝，控制台出现明确的 `Not allowed to load local resource`；窗口处理器和外发记录均无新增 |
| 本地绝对路径、带 cwd 的相对路径、`~/` 路径 | 修复前中键进入窗口处理器，地址已解析成应用源下的 localhost HTTP 地址，随后被外发；没有触发 `will-navigate`，也没有走本地 bridge。修复后普通、中键、Shift 每次只调用一次本地 bridge，无导航、窗口或外发记录；右键不打开 |
| 模拟主进程收到 `open-url` 深链事件 | `thoughtdag://` 仍通过预加载桥接送给页面，没有外发 |

本地路径测试把当前真实 `Markdown` 组件独立打包后放进 Electron 页面，绕过画布导入 UI；没有替换组件或 `openLocalPath` 的实现。最初探针也试了 `data:` 的普通链接辅助点击：Chromium 没有把它送进窗口处理器，因此它不计入上述 32 次；既有测试继续覆盖普通 `_blank` 与 `window.open` 的 `data:` 输入。

兼容性证据的边界：应用内 `openWhyLink`、启动参数/`second-instance` 深链处理和登录流程源码均未改，已读代码核对；模拟的 `open-url` 到桥接已运行验证。登录测试只覆盖同形 HTTPS 地址外发，没有实际登录服务。系统协议注册被测试记录器截住，未验证安装后的操作系统关联；本地 `why.mjs` 缺失，其查询功能未实测。

### 6.6 本轮检查、打包范围与撤销验证

收紧 Markdown 白名单之前的完整运行结果（2026-10-04；macOS ARM64）；后续授权修改及其验证见 6.7：

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过；3031 模块。仍有 Vite 动态/静态导入和大 bundle 提示 |
| `npm run lint` | 通过，0 错误 |
| `npm run test:unit` | **200 通过，8 条预期失败**，总计 208；原有预期失败未改变 |
| `npm run test:host` | **189 通过**，0 失败 |
| `npm run test:e2e:desktop -- --output=<temp>/tdag-outbound-final` | **18 通过**，原有 10 条加本轮 8 条 |
| `APP_URL=http://127.0.0.1:5173 npm run test:e2e` | **1 通过** |
| `APP_URL=http://127.0.0.1:5173 npm run smoke` | **SMOKE PASS**；初始化、IndexedDB 保存及重载均通过，仍为基线的 4 条 `ERR_CONNECTION_REFUSED` |
| macOS 打包目录应用的 outbound 探针 | **8 通过**；运行时明确断言 `isPackaged=true`、darwin/arm64、Electron 43.3.0 |

网页两项运行时先启动 `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`，完成后已停掉本次启动的服务。最初沙箱禁止监听端口/启动 Electron；获得执行权限后实际运行上述检查。首次构建发现新增测试的 Node 类型声明和节点 props 缺项，首次 lint 发现 Playwright 空解构规则；修正后均通过，未把这些初次失败计作成功。

**打包验证做到的范围：** 使用 `tests/e2e-desktop/helpers/package-outbound-probe.mjs` 和本机已安装的 Electron、electron-builder，离线生成有 `app.asar` 与 `Resources/payload` 的未签名目录 `.app`；没有安装依赖、签名、公证或发布。包内 121 个 dist 文件与本次成功构建逐一比对 SHA-256，全部一致。可复跑：

```sh
node --experimental-strip-types tests/e2e-desktop/helpers/package-outbound-probe.mjs
TDAG_PACKAGED_EXECUTABLE='<生成的可执行文件>' npm run test:e2e:desktop -- tests/e2e-desktop/outbound-probe.spec.ts --output='<临时输出目录>'
```

这验证了真实 `app.isPackaged` 分支的出站链接行为，**不等于正式发行包验收**：使用已安装依赖的超集，不是发行脚本安装的最小生产依赖；更新器和系统关联被截住；缺少本地 `why.mjs`；没有验证 DMG/ZIP、签名、公证、Gatekeeper 或安装流程。**Windows、Linux、macOS Intel 均未验证。**

新增回归测试均实际做过先失败再通过，并撤掉相应防护确认会失败：

| 撤掉什么 | 失败的测试 |
| --- | --- |
| 三个渲染点分别撤掉校验 | 每次对应 1 条失败，共 3 条 |
| streaming / 普通导入 / 范式文件导入 / viewer 的入口清理分别撤掉 | 每次对应 1 条失败 |
| 范式实例化清理撤掉 | note/file/link/frame 共 4 条失败 |
| 共用引用清理 / 节点 URL 清理撤掉 | 分别 4 / 7 条入口测试失败 |
| 本地与托管代理的来源防护分别撤掉 | 各 5 条主机测试失败；两处都撤掉为 10 条失败 |
| 本地 Markdown 的 `onAuxClick` 撤掉 | React DOM 回归 1 条失败；Electron 中独立撤掉时 1 条失败，localhost 外发重新出现 |
| 在临时外壳副本移除 `openOutside` 白名单 | 中键、Shift 两条拒绝测试失败，各多外发 16 条非网页地址到记录器 |

恢复后所有相关测试通过。大写规范化、Chromium 的 `file:` 拒绝、既有深链和正常网页/邮件外发属于兼容性/行为探针；这些行为本来已存在，不声称它们会因撤掉本轮渲染或入口改动而失败。撤销试验未回滚交接前的改动；桌面外壳和已有 `workspace-door.spec.ts` 保持交接时的内容。保存的探针记录已将仓库路径替换为 `<repo>`、临时素材路径替换为 `<temp>`。独立代码审阅未发现新增问题。

### 6.7 Markdown 协议白名单：用户批准收紧，已实施

用户在同日明确选择“准许收紧”。`SANITIZE_SCHEMA.protocols` 继承其它默认策略，仅将 `href` 限制为 `http`、`https`、`mailto`。`irc`、`ircs`、`xmpp` 的链接文字保留，`href` 被消毒器移除，桌面和网页版均不能再通过这些 Markdown 链接跳转。没有更改应用内 `openWhyLink` 或 OS 深链接收路径。

`tests/unit/markdown-link-protocols.test.tsx` 新增 4 条回归：普通 / 高亮组件 × Markdown / 原始 HTML，覆盖被禁协议的混合大小写、HTML 实体冒号、既有禁止协议，以及保留的网页、邮件、本地路径和片段地址。测试实际渲染组件，没有模拟消毒器；每个用例都先因 IRC 的 `href` 未移除而失败。单独撤掉新增的 `protocols` 配置后，4 条再次全部失败；恢复后通过。本地路径普通、中键、Shift 与右键行为的已有回归也通过。

补充区分大小写的证据：安装的 Markdown 消毒器本来就不保留大写 `HTTPS:`（直接调用默认 schema 与收紧后的 schema 均得到无 href），本次没有改变这个既有行为。6.5 中的大写规范化结论针对送入 Electron 的实际链接 / `window.open`，不代表 Markdown 消毒器接受所有协议大小写。

本次重跑 `npm run build`、`npm run lint` 均通过；`npm run test:unit` 为 **204 通过、8 条预期失败**（212 条），新增的 4 条全部通过。构建后重跑 `npm run test:e2e:desktop -- --output=<temp>/tdag-markdown-protocol-desktop`，**18 条全部通过**。构建仍有此前记录的 Vite 提示。6.6 中的打包 `.app`、网页 E2E、smoke 和主机测试结果属于此前一轮，未将其计作这次白名单修改后的新验证。

## 7. 合入主线（2026-10-15）

这一份工作一直留在主检出里，没有提交。从 10 月 4 日起，主线又往前走了 31 个提交（M1 审查修复、M2、T10b–T10h、T26、T26b）。用户让我把两边对齐，做法如下：

- 主检出里的改动先原样存成一个本地分支 `backup/main-checkout-wip-2026-10-04`（提交 `e32d32d`），没有推送。工作区和索引都没有动。
- 在主线最新提交上应用这些改动。只有 `desktop/main.js` 冲突：主线后来把工作区通道改成了“门的一张表”（`runtime/workspace/door.cjs`），再循环登记。合并时保留这个结构。这里新增的 `handle(channel, fn)` 和导航规则都原样保留，门的循环也改为通过 `handle()` 登记。现在 `main.js` 里，`ipcMain.handle` 只出现在 `handle()` 内部，第 2 节的测试照样成立。
- `tests/unit/outbound-ingress.test.ts` 的流式用例改了一处：给模型列表补上一个合成模型。原用例故意用了空的模型列表，依赖上游“没有模型也照样发请求”的行为。第三轮审查的 L06 已经修掉了这个行为，所以不补模型的话请求根本不会发出。这条用例要测的是来源链接的清洗，和有没有模型无关。
- 原来记作“预期失败”的那条“旧桥接拒绝不是应用的页面”，现在是普通测试并且通过。

合入后的回归：

| 检查 | 结果 |
| --- | --- |
| lint、build | 通过 |
| 单元测试 | 574 通过，6 条预期失败 |
| 宿主测试 | 403 通过 |
| 契约测试 | 193 + 91 通过 |
| 网页 E2E | 3 通过 |
| 桌面 E2E | 70 通过，含这里的外链探针和门的测试 |
| layout、live-log、subagents | 通过 |

桌面 E2E 的“文档在画布旁打开”这一组偶尔会失败：大约 9 次里有 1 次，失败的是不同的用例，比如点进编辑器超时、放回旧版本的断言。合入之前这套测试也出现过一次偶发失败，所以不是这次合入引起的，原因还没查。
