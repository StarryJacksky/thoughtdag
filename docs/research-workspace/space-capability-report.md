# 研究工作台：ChatGPT Space 能力报告（T32）

核对日期：2026-10-03。本文是工程计划 T32 的交付物：独立的桌面客户端今天能不能直接读写 ChatGPT Space。

## 1. 结论

**不能。Space 直连目前是 blocked。**

| 门槛 | 状态 | 依据 |
| --- | --- | --- |
| Gspace-read（列举、读取、稳定对象 id） | 未通过 | 没有找到任何文档化的接口可供独立客户端使用，无从探测 |
| Gspace-write（更新、带版本条件的写入） | 未通过 | 同上 |

所以规划里的 MS1（空间只读直连）和 MS2（空间读写闭环）都还没有开始的条件；R26 到 R30，以及 R31 里“聊天时选 Space”的部分，保持未交付。本地文件夹这条主线不受影响。

这个结论是“查了官方文档，没有找到接口”，不是“官方声明没有接口”。所以探测函数在没有接口时把每项能力记为 `unknown`，而不是 `unsupported`。

## 2. 查了哪些来源

| 来源 | 读法 | 关于第三方访问 Space，它说了什么 |
| --- | --- | --- |
| [Getting started with Space in ChatGPT](https://help.openai.com/en/articles/20001549-getting-started-with-space-in-chatgpt)（帮助中心） | 直接读原文 | 没有提到任何 API、SDK、导出或第三方访问 |
| [ChatGPT Space: sharing, data, and controls](https://help.openai.com/en/articles/20001544-chatgpt-space-sharing-data-and-controls)（帮助中心） | 直接读原文 | 同上；只讲页面权限、Memory 和训练设置 |
| [learn.chatgpt.com 的 Space 文档](https://learn.chatgpt.com/docs/space)（概览、入门、页面、与 Agent 协作） | 经摘要工具读取 | 都是 ChatGPT 产品内的用法；没有提到从外部访问 |
| [ChatGPT 开发者文档首页](https://developers.openai.com/chatgpt) | 经摘要工具读取 | 列出插件、工作区 Agent、Sign in with ChatGPT、Codex、API 等，没有 Space 或页面的接口 |
| [Sign in with ChatGPT](https://developers.openai.com/siwc) 及其 Codex app-server 令牌共享页 | 经摘要工具读取 | 给第三方应用的是用户身份，以及用用户的 ChatGPT 套餐做模型推理；没有列出对 Space、页面或文件的访问 |
| [Plugins](https://developers.openai.com/plugins) 首页 | 经摘要工具读取 | 插件是开发者托管的 MCP 服务器加可选界面，由 ChatGPT 来调用插件；没有提到插件读取 Space |

“经摘要工具读取”的意思是页面内容先经过一个小模型概括再给我，细节可能有出入。两篇帮助中心文章是直接读的原文，可信度更高。

## 3. 逐条路线

| 路线 | 能不能用来直连 Space | 说明 |
| --- | --- | --- |
| 官方 Space 接口 | 没有找到 | 文档里没有 |
| Sign in with ChatGPT 加 Codex app-server 令牌共享 | 不能 | 解决的是“用用户的套餐调模型”，需要先申请 client ID。能登录不等于能读 Space，不能把这个令牌当 Space 凭据用 |
| ChatGPT 插件（MCP 服务器） | 不能 | 调用方向是 ChatGPT 调插件，不是外部程序向 ChatGPT 取内容。它适合另一种用法：用户在 ChatGPT 里主动把内容交给 ThoughtDAG。那属于规划第 17.1 节的“ChatGPT 内嵌界面”，不算 Space 直连 |
| 连接的外部服务（如 Google Drive） | 不是 Space | Space 页面里链接的外部文件，权限和接口都归原服务。材料实际存在 Drive 里的话，可以另做一个 Drive 来源，但那是另一件事 |
| 手工复制或下载 | 只能得到副本 | 页面的块菜单有“Copy as Markdown”，上传的文件可以下载。得到的是脱离来源的导入副本，界面上必须标明，不能显示成同步 |

明确不做的：用浏览器 cookie 访问未公开的网页接口，逆向私有协议，读取 ChatGPT 桌面应用的本地存储。

## 4. Space 的产品事实

这些来自两篇帮助中心原文，对以后设计来源适配有用，也印证了契约里的对象分类。

- **结构**：一个 space 里可以有文件夹和页面；页面可以有子页面。每人有一个个人 space。Space 取代了原来的 Library；Projects 仍然独立存在。
- **页面**：是可编辑的文档，按块组织（标题、段落、表格等），可以包含图表和交互工具。不是一个 Markdown 文件。
- **文件**：上传到页面里的文件跟随页面的权限。链接到别处的文件不会因为页面被分享而变得可读；外部服务里的文件保持原服务的权限。
- **权限**：可以分享单个页面或整个 space，分查看和编辑。访问权可以来自对页面的直接邀请、父页面，或所在的 space；子页面继承父页面的权限。移动页面会改变谁能访问它。
- **可用范围**：Pro、Business、Enterprise。网页和桌面应用可以编辑；手机上只能查找、阅读和分享。
- **删除**：删除页面会把它和它的子页面一起移到废纸篓，包括别人拥有的子页面。
- **尚未提供**：自动更新页面（Keep updated）上线时不可用；Slides 和 Sheets 标注为即将推出。

对契约的印证：`ResourceLocator` 里空间对象分 `page`、`file`、`folder`、`external-link` 四种，和产品结构对得上。页面是块结构，所以“能下载文件”推不出“能编辑页面”，`pagePatch` 需要单独的证据。

## 5. 代码里的落地

`runtime/workspace/providers/space-capabilities.cjs` 提供 `probeSpaceAccess(connectionRef)`。它不带任何真实的接入实现；规则是：

- 没有接入实现时，每项能力 `unknown`，两个门槛都 `blocked`，并在报告里写明原因。
- 未授权、授权过期、只有分享链接，都不算已连接，无论探测声称做过什么。
- 授权必须指向一个具体的 space，不能是整个账户。
- 每项能力只看自己的证据：能读不代表能新建，能下载文件不代表能改页面。
- 读门槛要求列举、读取、稳定 id 三项都有实证；写门槛还要求更新和带版本条件的写入有实证。
- `checkSpaceOperation` 对任何不是 `supported` 的操作一律拒绝。
- 报告只保留约定的证据字段，接入实现多返回的东西（比如令牌）不会进入报告。

`tests/host/space-capabilities.test.cjs` 用假的接入实现逐条验证这些规则。这些测试证明的是 ThoughtDAG 这一侧的判定逻辑，不证明 Space 可用。

规划里提到的真实探测脚本 `scripts/probe-space-provider.mjs` 没有写：规划要求确认有接口之后才实现它。

## 6. 这次没有做的

- 没有在任何真实的 space 上做过探测：没有可用的接口，也没有用户提供的测试 space。
- 没有联系 OpenAI 询问接口计划。
- 插件文档只读了首页，没有逐页读它的 20 多个子页面。插件拿到的上下文里是否包含当前页面的内容，这次没有查清。
- 没有申请 Sign in with ChatGPT 的 client ID。

## 7. 接下来可以怎么走

这几条互不排斥，取舍需要人来定。

1. **照常推进本地主线**。T31 的来源抽象照做，本地实现先交付；Space 的实现留空，入口显示 blocked 和原因。这一条不需要等任何外部条件。
2. **向 OpenAI 问清楚**。申请 Sign in with ChatGPT 的 client ID 时一并询问 Space 是否会开放接口。
3. **评估插件路线**。做一个 ThoughtDAG 的 ChatGPT 插件，让用户在 ChatGPT 里把页面内容交给 ThoughtDAG。这能解决“把 Space 里的内容用起来”，但它是推送，不是挂载：做不到在 ThoughtDAG 里浏览 space、也做不到回写。
4. **先做导入副本**。支持把复制出来的 Markdown 或下载的文件作为普通本地文件用，明确标为副本。

每次开始做 Space 相关的任务之前，应当重新核对一遍第 2 节的来源：这个产品刚上线，文档在本报告核对的前一天还在更新。
