# 10 线成本与合规锚点：大模型 API 定价 × Token 转售/聚合（2026-08 桌面研究）

> 用途：为 SaaS 线 10（模型 API Token 转售：用户无 DeepSeek key 也能用，我方卖模型额度）做成本锚点与合规锚点。
> 数据采集：2026-08-26，官方页面直接抓取（DeepSeek 定价页/限流页/服务协议、OpenRouter FAQ、Anthropic 定价聚合）＋ web_search 交叉验证；二手来源标注日期；官方抓不到（OpenAI/Google/Anthropic 官网出口不可达）以 2026 年第三方权威整理为准并标注。
> 单位：人民币默认 ¥（CNY），美元默认 $（USD）。价格随时可能调整，落地前以官网为准；查不到的标"待查证"，不编造。

---

## 1. DeepSeek 开放平台 API 定价（当前 2026-08：V4 系列，峰谷分时定价）

> 重要时间线（影响一切数字）：2026-08-06 前后官方预告"整体上调 API 定价"；**2026-08-17 0 时起**峰谷定价生效，同时 V4-Pro 结束测试转正式商用。调价前为统一计费（一口价），调价后按时段分价。

**当前官方价格表（单位：元/百万 tokens，2026-08-26 实测抓取官方定价页）**

| 模型 | 输入（缓存命中）空闲/高峰 | 输入（缓存未命中）空闲/高峰 | 输出 空闲/高峰 | 并发限制 |
|---|---|---|---|---|
| `deepseek-v4-flash`（DeepSeek-V4-Flash-0731） | 0.05 / 0.10 | 1.5 / 3.0 | 4.5 / 9.0 | 2500 |
| `deepseek-v4-pro`（DeepSeek-V4-Pro-0813） | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 | 500 |
| `deepseek-v4-flash-vision-exp`（多模态实验版） | 同 flash | 同 flash | 同 flash | 2500 |

- **高峰时段**：北京时间周一至周五 9:00–12:00、14:00–18:00；其余为空闲时段。空闲时段价格 = 高峰时段的一半。
- 上下文长度 1M，输出最大 384K；支持非思考/思考模式（默认）；同时提供 OpenAI 格式（https://api.deepseek.com）与 Anthropic 兼容格式（https://api.deepseek.com/anthropic）Base URL。
- 多模态：发送给 `deepseek-v4-flash-vision-exp` 的图片按尺寸换算成 token 计费（每张最多 384 tokens，按 flash 价格）。
- 扣费规则：token 消耗量 × 单价，从充值余额/赠送余额扣减。

**缓存折扣**：有，且力度大。缓存命中输入价 = 缓存未命中输入价的 **1/30**（flash 空闲档 0.05 vs 1.5 元）。机制：官方"上下文硬盘缓存"（Context Caching on Disk）自动生效、无需改动接口、按实际命中计费；**仅"从第 0 个 token 起前缀完全一致"的输入可命中**（多轮对话、长固定提示词、重复文档分析最受益）。历史参考：2024-08 官方宣布缓存命中 $0.014/M vs 未命中 $0.14/M，成本最高降 90%。

**并发/限流规则**（官方限速与隔离文档）：
- 并发限制为**账号级**（与 API key 无关）：v4-pro 500 / v4-flash 2500 / vision-exp 2500；超限返回 HTTP 429。
- **扩容免费**：有更高并发需求可提交账号扩容工单，按实际业务需求匹配，不额外收费。
- `user_id` 参数：同一账号下做业务侧多租户细粒度管理，提供内容安全隔离、KVCache 隔离、调度隔离——**官方 API 原生支持"一个账号服务多个终端用户"的场景**（对转售方是直接对口的功能）；提升并发配额后会对每个 user_id 单独限速（pro 500 / flash 2500）。
- 请求保活：等待响应期间持续返回空行 / SSE `: keep-alive` 注释；10 分钟未开始推理则断开。

**调价幅度（媒体口径，供波动性参考）**：媒体称"最高涨幅 1100%""高峰时段缓存命中价暴涨 11 倍"；另有口径"高峰时段成本是调价前 4.5 倍"（2026-08-13）。调价前各档位精确旧价公开渠道口径不一（官方 2026-05 曾"永久降价"、2026-08 又涨价），**本文不列无法核验的旧价**，以上表现行价为准。

**来源**：
- 官方 Models & Pricing：https://api-docs.deepseek.com/quick_start/pricing/ （中文 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/）
- 官方 Rate Limit & Isolation：https://api-docs.deepseek.com/quick_start/rate_limit/
- 官方上下文硬盘缓存公告（2024-08-02）：https://api-docs.deepseek.com/news/news0802/
- 峰谷定价生效新闻（2026-08-17，站长之家/AIbase）：https://www.chinaz.com/ainews/30368.shtml
- 峰谷调价前后解析（实在智能，2026-08-18，含"旧价口径不一"说明）：https://www.ai-indeed.com/encyclopedia/29859.html
- 调价新闻（21 世纪经济报道，2026-08-06）：https://m.21jingji.com/article/20260806/herald/c04cfc511a7791c164081f744e025608.html
- 高峰时段成本为调价前 4.5 倍（腾讯新闻，2026-08-13）：https://news.qq.com/rain/a/20260813A0EBUA00

### 1b. 历史锚点：deepseek-chat（V3）/ deepseek-reasoner（R1）2025 年官方价（模型名已于 2026-07-24 停用）

用户调研中常引用的"DeepSeek 每百万 token 价格"多为 V3/R1 时代价格，记录如下（**均为标准时段官方价，单位：元/百万 tokens**）：

| 模型 | 输入（缓存命中） | 输入（缓存未命中） | 输出 |
|---|---|---|---|
| `deepseek-chat`（V3，64K 上下文） | 0.5 | 2 | 8 |
| `deepseek-reasoner`（R1，64K/32K 思维链） | 1 | 4 | 16 |

- 夜间优惠（2025-02-26 起，北京时间 00:30–08:30）：V3 打 5 折（0.25/1/4 元），R1 打 2.5 折（0.25/1/4 元）。
- **模型名停用**：`deepseek-chat` / `deepseek-reasoner` 两个模型名已于 **2026-07-24 停用**，官方指引迁移到 V4 Flash/Pro（改一行 model 名即可）。
- 运营风险先例：2025 年初因服务器资源紧张**一度停止 API 充值**，2025-02-25 重新开放——上游停充/限流对转售业务是现实风险。
- USD 口径（2026-02 第三方数据集）：V3 $0.25/$1.10（输入/输出），R1 $0.55/$2.19。

**来源**：
- 官方定价页（当前，已无 V3/R1 条目）：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
- 模型名 7 月 24 日停用公告解读（腾讯云开发者社区）：https://cloud.tencent.com.cn/developer/article/2715785?policyId=1004
- V3 恢复 8 元输出价（2025-02-10，澎湃）：https://m.thepaper.cn/newsDetail_forward_30119856
- V3/R1 官方价格表 + 夜间优惠（2025-02-26，IT之家）：https://www.ithome.com/0/833/846.htm
- R1 发布日定价（2025-01-20，IT之家）：https://m.ithome.com/html/826014.htm
- API 充值重新开放 + 价格（2025-02-26，新浪财经/上证报）：https://cj.sina.com.cn/articles/view/1905628462/7195952e01901mbzg?finpagefr=p_104
- USD 价格数据集（2026-02）：https://raw.githubusercontent.com/salttechno/LLM-Model-Comparison-2026/main/README.md

---

## 2. 国外厂商 API 定价对比（USD / 百万 tokens）—— 说明 DeepSeek 的成本优势

| 厂商 / 模型 | 输入 | 输出 | 备注 |
|---|---|---|---|
| OpenAI GPT-4o（2024-08-06） | $2.50 | $10.00 | 缓存读 $1.25（输入 5 折）；128K 上下文 |
| OpenAI GPT-4.1 | $2.00 | $8.00 | 1M 上下文；GPT-4.1 mini $0.40/$1.60 |
| Anthropic Claude Sonnet 5（当前 2026-08） | $2.00（8/31 前） | $10.00 | 之后标准价 $3/$15；缓存命中 = 输入 10%；Batch −50% |
| Anthropic Claude Opus 5（当前） | $5.00 | $25.00 | 缓存命中 $0.50 |
| Google Gemini 2.5 Pro | $1.25 | $10.00 | 1M 上下文 |
| Google Gemini 2.5 Flash | $0.30 | $2.50 | 1M 上下文 |
| 参考：DeepSeek V4-Flash 现行（空闲档，折 USD ≈ 7.2 汇率） | ≈¥1.5 ≈ $0.21 | ≈¥4.5 ≈ $0.63 | 高峰档翻倍：¥3.0 / ¥9.0 |

**当前代对标（第三方聚合口径 2026-08，供量级参考）**：Claude Opus 5 $5/$25 ≈ GPT-5.6 Sol $5/$30 与 Gemini 3.1 Pro $2/$12 同一量级；Claude Sonnet 5 $2/$10 ≈ GPT-5.6 Terra $2/$12。

**结论**：DeepSeek V4-Flash 空闲档输出约 $0.63/百万（≈¥4.5），为 GPT-4o（$10）、Claude Sonnet（$10）、Gemini 2.5 Flash（$2.5）的 **1/4～1/16**；缓存命中输入（¥0.05）比任何海外厂商都低一个量级。这是 10 线"卖 DeepSeek 额度"的成本优势基础。

**来源**：
- GPT-4o 官方价（Future AGI 计算器）：https://futureagi.com/llm-cost-calculator/openai/gpt-4o-2024-08-06/ ；OpenRouter 页（$2.50/$10，缓存读 $1.25）：https://openrouter.ai/openai/gpt-4o-2024-08-06
- GPT-4.1 官方发布（价格降幅说明）：https://openai.com/index/gpt-4-1/
- Claude 当前定价（benchlm.ai 聚合，2026-08-25 同步，注明"已核对 Anthropic 官方页面"）：https://benchlm.ai/anthropic/api-pricing ；Claude 官方文档定价页（抓取不可达，列备查）：https://platform.claude.com/docs/en/about-claude/pricing
- Gemini 2.5 定价（2026-02 数据集 + Google Cloud 定价页）：https://raw.githubusercontent.com/salttechno/LLM-Model-Comparison-2026/main/README.md ；https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
- Gemini 3.5 Flash $1.50/$9（2026-05，Future AGI 博文标题）：https://futureagi.com/

---

## 3. 国内"API 中转站 / 聚合"：常见定价方式与合规风险

**常见定价方式**（央广网/中国经营报 2026-07-28 调查 + 行业综述）：
1. **会员套餐**：按模型接入与 Token 消耗，月度费用 30 元～3000 元不等；数字人等实时生成场景每小时算力 5000 元～2 万元。
2. **充值兑换倍率**：如"充 50 元兑 110 美元 Token 额度、100 元兑 250 美元、200 元兑 560 美元、500 元兑 1700 美元"（最高约 1:3.4），明显低于官方渠道。
3. **"无限 Token"低价套餐**：将境外包月订阅账号（成本约 $200）拆分封装为按量 API 转售（"号池模式"），实为伪无限（有额度与频次上限）。
4. **低价引流 + 暗中加价**：业内总结常见手法——加价 10%～50%、模糊计费、偷跑 Token、乱扣费。

**合规风险**（同篇调查，引用北京大成彭凯、北京中伦刘新宇两位律师观点）：
- **业态三分法**：① 官方授权聚合/模型网关（合规中性：需增值电信业务等资质 + 与厂商签官方代理协议，只接授权模型）；② API 额度转售（额度来源正规属正常渠道经销，但长期以官方一折甚至更低供应则上游来源存疑）；③ 号池模式（高危黑灰产）。
- **刑事风险**：上海一名以"反向代理 + 账号池"模式运营的"中转站"站长因**涉嫌非法经营罪被刑事拘留**；近几个月已有一批中转站停摆、退出。
- **数据风险**：用户输入先达中转站服务器而非模型厂商，存在留存、倒卖可能（调查实例：买到的账号里残留上一位用户资料）；中转站通常被认定为**数据处理者**，无论服务器在境内还是境外都承担相应义务。
- **监管动作**：2026-04 中央网信办部署"清朗·整治 AI 应用乱象"专项行动（大模型备案登记、AI 数据安全、技术滥用）；2026-04、06 国家安全部两次发布提示，点名 AI 中转站，要求选官方直连、正规授权、安全合规平台。
- **资质与备案**：增值电信业务许可证；接入未在网信办完成备案的境外模型、数据是否合规出境、是否持有相应资质，是绕不开的三条红线；大模型备案登记义务。
- 合规聚合平台参照：硅基流动（国内直连、开源+国产模型为主）；海外 OpenRouter；2026-05 猎豹傅盛推出 EasyRouter.io（一个接口调 40+ 模型）。

**来源**：
- 央广网转载《中国经营报》调查（2026-07-28）：https://www.cnr.cn/mspd/msyx/20260728/t20260728_527733647.shtml
- 同文（东方财富财富号）：https://caifuhao2.eastmoney.com/news/20260725031042889215440
- "API 中转站，有没有钱途？"（与非网行业综述）：https://www.eefocus.com/article/2014251.html

---

## 4. DeepSeek 开放平台对"转售 / 代理"的条款 —— 查无明确条款，需向官方确认

**结论先行**：对《DeepSeek 开放平台服务协议》（更新 2026-04-22、生效 2026-04-29，中英文版均已全文检索）做关键词检索：**"转售 / 分销 / 代理 / 再授权（resell / resale / distribute / sublicense）"均无显式条款**——协议既未明文允许、也未明文禁止"API 额度转售"。这属于**待官方确认项**（联系方式：协议 §10.2，邮箱 api-service@deepseek.com）。

**与转售直接相关的条款**（均已核对原文）：
- **§1.1 / §3.2（倾向开放）**：开发者可将模型能力"集成于各种下游系统、应用或功能……向内外部的终端用户提供服务"；平台自称"中立、基础的模型技术服务……仅为价值链下游的一部分"，由开发者对下游服务承担责任。纯 API 转售是"下游系统"的一种极端形态，协议未排除，但也未给出专门授权。
- **§2.4（关键约束）**：API key 不得共享、公开或暴露于客户端。→ **转售方必须以自有 key 做服务端代理，绝不能把 key 交给客户**；把 key 卖/共享给客户即违约。
- **§5.2 / §5.3（品牌红线）**：不得暗示与 DeepSeek 存在"合资、合伙、控股、**代理**、特许经营"等特殊关联；不得使用"官方合作 / 战略伙伴 / 授权合作 / 认证集成方 / DeepSeek 官方推荐"等误导性称谓；违反即**根本违约**（单方终止、未消耗余额不退、要求公开声明无特殊合作关系）。→ 转售产品宣传时不得蹭官方背书。
- **§3.3 / §3.4 / §3.7（转售方义务，法律层）**：开发者作为**深度合成服务提供者 / 生成式人工智能服务提供者**，须承担算法备案、安全评估、内容安全审查、AI 生成内容标识（《人工智能生成合成内容标识办法》）、数据安全/个人信息保护等义务。→ 转售"模型额度"在国内法下同样适用 AIGC 服务提供者义务。
- **§2.3**：企业账号可供认证企业的内部员工**及关联主体**使用——官方只放开了"关联主体"内共享，未扩展到第三方转售。
- **§4.2**：输入输出可自由用于衍生产品开发、训练其他模型（模型蒸馏）等——服务端"输出"的使用场景是开放的。
- **英文版协议**同样无 resell/resale/distribution 措辞。

**注意区分另一套约束**：上述是"开放平台 API"的约束；若未来走"自部署开源权重"路线，注意 DeepSeek-V3 的 `LICENSE-MODEL`（GitHub 仓库，2026-05 起被合规监控捕获）含 **Non-Transferability and Sublicensing Restriction**（"限制被许可人个人使用范围、禁止商业再分发/再授权模型"）——与 API 转售是两套法律关系，需另行评估。

**来源**：
- DeepSeek 开放平台服务协议（中文）：https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-terms-of-service.html
- DeepSeek Open Platform Terms of Service（英文）：https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html
- 协议条款监控（ConductAtlas，指向 LICENSE-MODEL）：https://conductatlas.com/platform/deepseek/deepseek-open-source-license/provision/CA-P-010580/non-transferability-and-sublicensing-restriction/
- 云部署 License 雷区（CSDN，二手参考）：https://aicoding.csdn.net/6a237a9310ee7a33f278457b.html

---

## 5. 海外对标：OpenRouter 的"聚合 + 加价"模式

**OpenRouter 收费结构**（官方 FAQ 原文口径 + 2026-06 第三方拆解）：
1. **Token 价 pass-through 零加价**：官方 FAQ："We pass through the pricing of the underlying providers; there is no markup on inference pricing"。模型 token 按上游原价结算，OpenRouter 不公布自己的价目表。
2. **充值平台费**：购买 credits 时收 **5.5%**（最低 $0.80/笔；加密货币支付 5%）。
3. **BYOK（自带上游 key）**：超过每月前 100 万请求后按正常成本的 5% 收费（plan 相关有免费额度）。
4. 免费模型：限速约 20 请求/分钟。
- 商业本质：**marketplace take-rate（市集抽成）**——收入随用量线性增长，而非吃差价。
- 收购与估值：Stripe 收购 OpenRouter（2026 年中），金额口径不一：TNW "$7.5bn+"、Yahoo "up to $8 Billion"、中文媒体"70 亿美元"；有分析称这是"take-rate 套利"——OpenRouter 抽成 5.5% vs Stripe 自身费率 0.36%。

**对"卖额度"产品的启示**：OpenRouter 证明了"不加价、只收平台费 + 统一结算"的模型可以规模化（一个余额用 300+ 模型）；其合规前提是与上游厂商的授权/合作（号池/共享账号在海外同样违规，OpenRouter 是授权渠道而非盗用账号）。

**来源**：
- OpenRouter 官方 FAQ（"no markup on inference pricing"）：https://openrouter.ai/docs/faq
- 收费拆解（Amnic，2026-06-24，5.5%/$0.80/5% crypto/BYOK 5%/免费模型 20 req/min）：https://amnic.com/blogs/openrouter-pricing
- "Hidden 5.5% Fee" 拆解（ofox.ai）：https://ofox.ai/blog/openrouter-pricing-hidden-markup-breakdown-2026
- OpenRouter 官方 FAQ 备查（docs 页）：https://openrouter.ai/docs/faq#1
- Stripe 收购（Yahoo Finance，up to $8B）：https://finance.yahoo.com/technology/ai/articles/stripe-bets-over-8-billion-050145096.html ；TNW（$7.5bn+）：https://thenextweb.com/news/stripe-openrouter-acquisition-confirmed ；中文报道（70 亿美元）：https://www.weiyangx.com/476191.html
- Take-rate 套利分析：https://businessmodelanalyst.com/stripe-openrouter-take-rate-arbitrage/
- 聚合模式解读（网易/OpenClaw）：https://m.163.com/dy/article/KP54NUG405568W0A.html?spss=adap_pc

---

## 对我们的启示（10 线 Token 转售）

1. **成本锚点（定价模型）**：DeepSeek 现行 V4-Flash 空闲档：输入（缓存未命中）¥1.5 / 输出 ¥4.5 / 缓存命中输入 ¥0.05 每百万 token（高峰翻倍；Pro 为其 3 倍档）。历史 V3/R1 为 2/8 元与 4/16 元。官方价格剧烈波动（2025 曾夜间 75% 降价、2026-08 最高涨 1100%）→ 转售定价应设计为**"成本 pass-through + 固定平台费/会员费"**（OpenRouter 式），而非固定倍率，并预留成本传导与余额风险机制（官方曾停充，见 §1b）。
2. **合规红线（产品形态）**：只能做"官方授权聚合"或"来源正规的额度转售"——**严禁号池/反向代理/共享账号**（已出现涉嫌非法经营罪刑拘案例）；需自行持 key 服务端代理（§2.4 禁止共享 key）；办增值电信业务资质、履行 AIGC 服务提供者义务（算法备案、内容安全、AI 内容标识、数据合规）；宣传不得暗示 DeepSeek 官方合作（§5.3 根本违约条款）；官方 `user_id` 参数天然支持多租户隔离，应作为转售架构的标准设施。
3. **商业参考（OpenRouter 范式）**：token 原价 pass-through + 充值抽成（5.5% 量级）＋ BYOK/会员分层，靠"统一入口 + 统一结算 + 可靠性"赚钱而非吃差价；Stripe 以 ~$7.5–8B 收购印证该模式的规模价值。对 rdsh 10 线：卖"DeepSeek 额度 + 免 key 体验"的差异化在于与 DSH/rdsh 生态集成（用户无 DeepSeek 账号也能跑 dsh），可叠加错峰调度与缓存命中优化（官方高峰=2 倍价）来压低单位成本、增厚毛利。
4. **待办/待查证**：① 向 DeepSeek 官方书面确认"API 额度转售"立场与是否需要分销授权（api-service@deepseek.com）；② 若官方提供企业 API/分销计划优先走官方通道；③ 国内中转站监管（清朗行动、国安部提示）持续跟踪，产品上线前完成备案/资质清单。

---

*关联：`doc/marketing/09-cloud-dsh-pricing-benchmark.md`（09 线）、`doc/marketing/market-analysis.md`（整线）、`doc/overview/roadmap.md`（10 线里程碑）*
