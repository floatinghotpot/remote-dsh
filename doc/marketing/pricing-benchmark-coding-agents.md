# 定价对标：AI 编程 / coding agent 工具（2026-08 桌面研究）

> 目的：为 rdsh SaaS 线（08 托管 hub / 09 云端 DSH / 10 Token 转售）提供定价对标事实。
> 方法：web_search 桌面研究；所有数字带来源 URL；查不到的标注"待查证"，不编造。
> 注意：本行业定价变动频繁（2026 年多家转向按量计费），使用前核对官网。

## 1. Cursor（Anysphere，AI 原生 IDE + 云端 agent）

- **一句话定位**：AI 原生代码编辑器，把补全/对话/云端后台 agent（background agent）打包进编辑器体验，是最主流的 coding agent 订阅锚点。
- **档位与价格**（2026 结构为 Hobby / Pro / Pro+ / Ultra / Teams(Business) / Enterprise，共 6 档，Free–$200/月）：
  - Hobby：$0（免费档）
  - Pro：$20/用户/月（有来源确认"$20/month Pro Tier"仍是主力档）
  - Pro+：$60/用户/月（2026 新增中间档，具体额度以官网为准）
  - Ultra：$200/用户/月（顶配）
  - Business / Teams：$40/用户/月（历史基准，2026 待核）
  - Enterprise：按需议价
- **模式**：订阅 + **credits 体系**：每月订阅附赠 credits（按模型定价折算），超出部分按量计费（overage/usage-based pricing），2026 年明确引入 usage-based overage 机制。
- **目标用户**：个人开发者（Pro）→ 重度 agent 用户（Ultra）→ 团队/企业（Business/Enterprise）。
- 来源：
  - 官网定价：https://cursor.com/pricing 、https://cursor.com/zh-Hant/pricing
  - 2026 档位综述：https://aitoolsrecap.com/Blog/cursor-pricing-explained-2026
  - Pro $20 佐证：https://dev.to/jovan_chan_9500711396d4e6/cursor-ide-review-2026-is-the-20month-pro-tier-still-worth-it-256a
  - credits/overage 机制：https://usagebox.com/articles/cursor-usage-based-pricing-overage-explained-2026 、https://dodopayments.com/blogs/cursor-billing-model
  - 六档综述：https://costbench.com/software/ai-coding-assistants/cursor/

## 2. GitHub Copilot（微软/GitHub，编辑器内 agent）

- **一句话定位**：嵌在 GitHub / VS Code 生态里的 coding agent（Copilot coding agent），订阅走 GitHub 账号，2026 年转向按量计费。
- **档位与价格**（2026-06 改版前后）：
  - 个人档：Free（$0）→ Pro（$10/用户/月）→ Pro+（$39/用户/月）；2026 年新增 **Max** 档（个人最强档），Pro/Pro+ 引入"flex allotments"（弹性额度）。
  - 团队/企业：Business $19/用户/月、Enterprise $39/用户/月（2025 基准，2026 待核）。
- **模式**：**2026-06-01 起正式转向按量计费**（usage-based billing / AI credits）：月订阅费不变，但用量改按 token 折算 AI credits 扣费，超出额度按量付费。官方公告确认 Pro/Pro+ 引入 flex allotments + 新增 Max 档。
- **目标用户**：GitHub 生态开发者（个人到企业全量），重点是"编辑器内协作 + 代码安全审查"场景。
- 来源：
  - 官方公告（Pro/Pro+ flex allotments + Max 计划）：https://github.blog/news-insights/company-news/github-copilot-individual-plans-introducing-flex-allotments-in-pro-and-pro-and-a-new-max-plan/
  - 官方计划页：https://docs.github.com/en/copilot/get-started/plans
  - 按量计费切换报道：https://windowsreport.com/github-copilot-officially-switches-to-usage-based-billing-starting-june-1/ 、https://www.c114.net.cn/industry/78816.html
  - 2026 费用分析：https://www.cloudzero.com/blog/github-copilot-cost/ 、https://usagebox.com/articles/github-copilot-usage-based-billing-2026

## 3. Claude Code（Anthropic，终端 coding agent）

- **一句话定位**：终端/编辑器里的 Claude coding agent，以订阅（Pro/Max）与 API 按量双轨计费，2026 年起程序化用量强制走按量。
- **档位与价格**：
  - Pro：$20/用户/月（2026 年有过一轮涨价报道，具体新价待核）
  - Max：$100/用户/月 与 $200/用户/月 两档（官方帮助中心确认存在 Max 计划；$100 档为 2026 新增中间档）
  - Team / Enterprise：按需
  - API（按量）：按 token 计费（输入/输出单价，见 Anthropic 定价页；2026 具体单价待核对）
- **模式**：**订阅 vs 按量双轨**。互动使用（编辑器/终端订阅额度）走 Pro/Max 订阅；**agent SDK / 程序化调用自 2026-06-15 起转向按量计费**（agentic billing / API credits），不再含在 flat 订阅里——被媒体称为"告别 flat 订阅"。
- **目标用户**：重度 agent 用户（Max 档主打 5 倍额度）、SaaS 开发者（API 按量）、企业（Team/Enterprise）。
- 来源：
  - Max 计划官方说明：https://support.claude.com/en/articles/11049741-what-is-the-max-plan
  - 2026 计费变更：https://usagebox.com/articles/claude-code-cost-2026-per-token-per-month-june-deadlines 、https://amux.io/guides/anthropic-agentic-billing-june-2026/
  - Pro 涨价/弃 flat：https://en.theblockbeats.news/news/62116 、https://www.tomshw.it/business/claude-anthropic-credito-agent-sdk-15-giugno-2026
  - 价格对比综述：https://www.cloudzero.com/blog/claude-code-pricing/

## 4. OpenAI Codex / ChatGPT（OpenAI，云端 agent + ChatGPT 集成）

- **一句话定位**：OpenAI 的 coding agent（云端沙箱跑代码），按 ChatGPT 订阅体系分层 + credits 按量。
- **档位与价格**：
  - Free：$0（限量）
  - Go：$8/月（2026 新增入门档）
  - Plus：$20/月（ChatGPT 主档，含 Codex 额度）
  - Pro：$100/月（2026 新增，对标 Claude Max；另有 $200 档）
  - Business：按量/按席位（待核）
- **模式**：**订阅 + credits 按量**：Codex 用量按 credits 折算（agent 任务、token 消耗都吃 credits），订阅内含额度、超出按量。
- **目标用户**：ChatGPT 存量用户升级（Plus/Pro）、重度 agent 用户、企业（Business）。
- 来源：
  - 官方 Codex 定价页：https://chatgpt.com/zh-Hant-HK/codex/pricing/
  - 2026 档位综述（Free/$8 Go/$20 Plus/$100 Pro/Business）：https://www.morphllm.com/codex-pricing 、https://www.taskade.com/blog/codex-pricing-explained
  - $100 Pro 档对标 Claude Max：https://m.economictimes.com/tech/artificial-intelligence/openai-challenges-anthropics-claude-max-with-100-pro-plan-for-codex/amp_articleshow/130174007.cms
  - 费用分析：https://www.cloudzero.com/blog/openai-codex-pricing/

## 5. Windsurf（Codeium → 被 Cognition/Devin 收购）

- **一句话定位**：老牌 AI IDE（credits 计费），2026 年被 Devin 母公司 Cognition 以 $2.5 亿收购，并入其 agent 产品线。
- **档位与价格**（历史基准，2026 收购后新定价见 Devin 官方博客）：
  - Free：$0
  - Pro：$15/用户/月（有来源确认 $15）
  - Teams：$60/用户/月（历史基准，待核）
  - Enterprise：按需
- **模式**：**订阅 + credits（flow credits）**：模型用量按 credits 折算。
- **目标用户**：价格敏感的 IDE 用户；收购后转向 Devin 生态（agent 优先）。
- 来源：
  - 收购与新定价公告：https://devin.ai/blog/windsurf-pricing-plans 、https://www.nxcode.io/zh/resources/news/cognition-windsurf-acquisition-swe-1-5-codemaps-2026
  - 2026 定价综述（Free/Pro $15/Teams）：https://pecollective.com/tools/windsurf-pricing/ 、https://www.cloudzero.com/blog/windsurf-pricing/

## 6. Devin（Cognition，自主云端 coding agent）

- **一句话定位**：**云端自主 agent**（不是本地 IDE）——用户给任务，Devin 在云端工作区独立完成；2026 年推出 self-serve 订阅 + ACU 按量。
- **档位与价格**（2026 新版 self-serve，5 档：Free / Pro / Max / Teams / Enterprise）：
  - Free：$0（限量）
  - Pro：$20/用户/月
  - Max：$100/用户/月（待核）
  - Teams：$500/用户/月（旧版基准，2026 被重构，报道称"The $500 Plan Is Dead"；现价待核）
  - Enterprise：按需
  - **ACU（Agent Compute Unit）按量**：agent 运行时长按 ACU 计费，单价约 **$2.5/ACU**（报道值，见 docs.devin.ai 计费文档）；订阅内含 ACU 额度，超出按量。
- **模式**：**订阅 + ACU 按量**，云端运行（自带沙箱/工作区）——是"云端租用 agent 环境 + 按算力用量计费"最接近 rdsh 云端 DSH 形态的标杆。
- **目标用户**：想要"外包式"自主开发的企业/团队（Pro/Max 个人尝鲜，Teams/Enterprise 落地）。
- 来源：
  - 官方 self-serve 公告：https://cognition.com/blog/new-self-serve-plans-for-devin
  - 官方计费文档：https://docs.devin.ai/admin/billing/self-serve 、https://docs.devin.ai/zh/admin/billing
  - 2026 定价综述（Free/Pro/Max/Teams/Enterprise + ACU）：https://easyclaw.com/blog/knowledge/devin-pricing/ 、https://brainroad.com/devin-pricing-in-2026-real-cost-hidden-spend-and-alternatives/
  - "$500 Plan Is Dead"：https://dev.to/thedevbrief/devin-vs-cursor-2026-the-500-plan-is-dead-heres-what-changed-4hij

## 7. 其他对标：Trae（字节）& Qoder（阿里，原灵码）

### Trae（字节跳动，AI 原生 IDE）
- **一句话定位**：字节的免费起步 AI IDE，2026-02 起由"按次数收费"改为"**按 token 计费**"。
- **价格**：免费档 + token 套餐；具体 token 单价 **待查证**（官方/token 计价页未在本次检索中给出精确数字）。
- **模式**：免费 + **按量（token）**，转向国内罕见的 token 计价。
- 来源：https://www.ithome.com/0/923/234.htm 、https://www.c114.net.cn/ainews/61805.html 、https://stock.jrj.com.cn/2026/02/24172056052020.shtml

### Qoder（阿里云，原灵码）
- **一句话定位**：阿里云的 AI 编码助手，个人社区版免费 + credits 计费 + 企业版订阅。
- **价格**：个人社区版 $0；credits 计费额度、个人/企业订阅价格 **待查证**（官方公告存在，具体金额未在本次检索中确认）。
- **模式**：免费 + **credits 按量** + 订阅。
- 来源：https://developer.aliyun.com/article/1757140 、https://developer.aliyun.com/article/1745285 、https://www.aliyun.com/notice/118264 、https://qoder.com/zh/blog/qoder-subscriptions-are-here

## 对我们的启示（2–4 条）

1. **$20/月是铁打的个人锚点，$100/$200 是 agent 重度档**：Cursor Pro $20、Codex Plus $20、Claude Pro $20、Devin Pro $20 全部钉在 $20；重度/云端 agent 档则统一在 **$100–$200**（Claude Max $100/$200、Codex Pro $100、Cursor Ultra $200）。→ 我们的 SaaS 线应把 **$20/月（约 ¥145）** 定为个人档锚点，云端 DSH 租用（对标 Devin 的云端 agent）可设 $100 档，避免凭空定价。
2. **全行业从"flat 订阅"转向"订阅 + 按量（credits/token/ACU）"双轨**：Cursor（credits+overage）、GitHub Copilot（2026-06 起 AI credits）、Claude（2026-06-15 起程序化用量按量）、Trae（按 token）、Devin（ACU）都在同一时间窗转向按量。→ Token 转售线（10）正好踩在这个趋势上：订阅兜底 + token/算力按量是市场已被教育好的收费结构；务必在订阅条款里写明额度上限与超量计费。
3. **"从 coding 扩展到通用 agent"是明确市场信号**：Devin（自主 agent）收购 Windsurf（IDE）、Cursor 从补全走向云端后台 agent、Codex/Claude 都从 IDE 插件走向"云端沙箱 + agent"形态。→ 佐证"浏览器即用、免部署的通用 agent"（我们的北极星）方向正确；对标定价时可把"云端租用环境"（Devin ACU 模型）而非"编辑器订阅"作为主收费形态。
4. **免费档是获客标配，但免费额度被持续收紧**：所有竞品都有 Free 档（$0 限量），同时 2026 年集体收紧免费/低价档额度（Claude Pro 涨价、Copilot 转按量、Trae 从免费转 token 计费）。→ 我们应保留 Free 档做拉新，但一开始就设计好额度墙（免费体验 → $20 个人 → $100 云端 agent → 企业议价），并透明标注超量价格，避免"先养熟再割"的差评。

## 附：检索快照（2026-08）

- 未确认项：GitHub Copilot Max 档具体价格、Claude Pro 涨价后新价、Cursor Pro+/Business 2026 现价、Trae token 单价、Qoder 订阅具体金额、Devin Max/Teams 现价 —— 均标"待查证"，使用前需核对官网。
- 官方定价页优先：cursor.com/pricing、docs.github.com（Copilot plans）、support.claude.com（Max）、chatgpt.com/codex/pricing、devin.ai、qoder.com、trae 官网。
