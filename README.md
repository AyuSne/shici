# 拾词

**一本长在自己读过的文章里的克制单词本。**

不背孤立单词表，不做刷题软件，也不堆砌打卡与记忆曲线；你可以在纸质试卷或其他软件里安心刷题，做完后再打开它，从刚才读过的文章里圈出想学的词、连同原句收进本子，用词典与大模型整理理解，在日后重读文章时再次遇见。

> 最新版本：[**v0.2.0**](https://github.com/AyuSne/shici/releases/latest)（Windows x64，原名「素读」，本版起正式更名为「拾词」）

<!-- 建议在这里放 1～2 张实际界面截图：阅读页圈词高亮 / 词条页多篇原句与回到原文 -->

---

## 为什么做「拾词」

市面上的背单词软件大多把词从文章里抽出来，做成脱离语境的词表和卡片，靠遗忘曲线推着人一遍遍刷。

但真正有效、也让人愿意学下去的体验往往相反：

- **自己挑出来的词，才真的想记住。** 读书或做阅读时，把不认识的、或者虽然认识但觉得表达很好的词圈出来——选择权在自己手里，学习才是主动的。
- **记忆靠的是“亲身经历过的语境”。** 单词本里留下的不是词典编的陌生例句，而是当时亲眼读过、甚至费过一番功夫才看懂的那句原话。以后看到这句原句，整段阅读记忆都会跟着浮出来。
- **重读文章本身就是复习。** 读过的材料本来就要回头重读、培养语感；重新读一遍文章，顺眼撞见之前收过的词，不用刻意翻卡片，自然就又复习了一遍。

**拾词**做的，就是把高中时「在纸质卷子上做完题 → 翻开单词本集中查词典 → 把词连带卷子上的原句记进本子 → 以后重读原文复习」这套习惯搬到电脑上——**只是不用再一笔一划手抄原句**，再把大模型作为一个听你指挥的助教接进来。

---

## 它是什么，以及它刻意不做什么

拾词的定位很单纯：**专心做好一本语境单词本，不做 All-in-One。**

- **它专注做好一件事**：把你读过的文章、选出的词、当时的原句与句锚点、以及你整理下来的学习内容连成一张可来回跳转的网。
- **它刻意不做**：
  - **不做刷题、选项作答、判分与错题本** — 刷题交给纸质试卷或市面上已经很成熟的开源刷题项目，不重复造轮子，也不让做题焦虑抢走注意力；做完题再回到拾词收词整理，就像高中时放在手边的专用单词本。
  - **不做艾宾浩斯排程、卡片翻转、每日打卡与时长仪表盘** — 怎么复习、何时重读，由你自己的节奏决定。
  - **不让 AI 替你决定记什么** — 模型的回复再长，也不会自动灌进词库；只有你亲手选中并**钉住**的片段，才会留在词条里。

---

## 四步学习链路

1. **打开读过的文章**
   你可以直接在拾词里安静读全文，也可以在纸质试卷或其他软件刷完题后，再回来打开对应的干净原文。文章去掉了题干、选项与说明干扰，以单栏呈现；原卷自带的中文夹注默认浅色显示、可一键隐藏。

2. **圈词，连带原句收进词条**
   划选单个词或短语，正文当场高亮，常见词形变化自动归并到同一词条，并连同**逐字原句、所在文章及句锚点**一起保存；同一个词在不同文章里再次遇到，原句会按文章攒在下面，支持重新圈定与合并/拆分词条。

3. **查离线词典，按需问 LLM 并“钉住”**
   读完或刷完题后集中整理：内置离线词典（ECDICT 裁剪版）用来快速查音标与基本释义；需要结合原句追问语境词义、近义辨析或助记时，可以带上选好的上下文问你的模型（支持流式输出、思维链折叠、回答版本与改口分支），把真正有帮助的片段**钉住**进词条，或先放进右侧钉板稍后归位。

4. **翻本子，或者重读原文**
   打开词条按文章查看自己攒下的多条原句，点一下就能**回到原文**那句话并高亮定位；学习内容也附带出处，随时可以回跳原对话；重读文章时，收过的词带弱高亮，在原本的语境里再次遇见它们。

---

## 下载与开始使用

前往 [Releases 页面](https://github.com/AyuSne/shici/releases/latest) 下载 Windows x64 版本（校验值见同页 `SHA256SUMS.txt`）：

- **安装包（推荐）**：`shici-0.2.0-x64.exe` — NSIS 安装程序，按当前用户安装、无需管理员权限。
- **免安装版**：`shici-0.2.0-x64.zip` — 解压后直接运行 `拾词.exe`。

> 安装包暂未做代码签名，Windows 可能提示「未知发布者」，点击「更多信息 → 仍要运行」即可；介意的话可直接使用免安装压缩包。

**首次打开**：

1. 启动后会自动导入随包的 63 篇六级阅读真题，无需手动准备文件。
2. 阅读、圈词、查离线词典、整理学习内容与备份恢复均**完全离线可用**。
3. 如需使用 AI 对话辅助，到「设置 → 模型服务」添加内置提供商（DeepSeek、Kimi、智谱 GLM、MiniMax、OpenAI、Anthropic、Google Gemini、xAI、OpenCode GO）或配置自定义 API 接口、模型与密钥即可（本机密钥通过 Windows DPAPI 加密保存，明文不落库、不进备份）。

---

## 为什么这套方式有效

这套学习流程贴合二语习得（SLA）与认知心理学里的几项核心研究结论：

| 学习动作 | 对应的认知与习得机制 | 为什么有效 |
| --- | --- | --- |
| 自己边读边圈词 | **词汇自我收集策略（VSS）** & **注意假说（Noticing）** | 把选词主动权还给学习者，提高内在动机；有意识的“注意”是将阅读输入（Input）转化为真正吸收（Intake）的前提。 |
| 先做/先读后查、对照原句整理 | **投入量假说（Involvement Load Hypothesis）** | 一次完整的 *Need（内生需要）+ Search（检索）+ Evaluation（语境评估）* 过程，比脱离语境的被动刷词留痕更深。 |
| 保留原句并回到原文 | **情景记忆** & **编码特异性原则** | 将抽象词义挂在“自己读过、做过那篇文章”的个人情景记忆上，检索时用原句与上下文作线索，提取成功率更高。 |
| 跨文章攒原句、重读与多语境再遇 | **语境学习** & **重读（Repeated Reading）** | 同一词在不同文章下积累多个真实锚点，既避免单一语境依赖，又通过重读降低理解负荷，把注意力留给词形搭配与语感。 |

### 参考文献

- Haggard, M. R. (1982). The vocabulary self-collection strategy: An active approach to word learning. *Journal of Reading*, 26(3), 203–207.
- Haggard, M. R. (1986). The vocabulary self-collection strategy: Using student interest and world knowledge to enhance vocabulary growth. *Journal of Reading*, 29(7), 634–642.
- Ruddell, M. R., & Shearer, B. A. (2002). “Extraordinary,” “Tremendous,” “Exhilarating,” “Magnificent”: Middle school at-risk students become avid word learners with the Vocabulary Self-Collection Strategy (VSS). *Journal of Adolescent & Adult Literacy*, 45(5), 352–363.
- Laufer, B., & Hulstijn, J. (2001). Incidental vocabulary acquisition in a second language: The construct of task-induced involvement. *Applied Linguistics*, 22(1), 1–26.
- Schmidt, R. W. (1990). The role of consciousness in second language learning. *Applied Linguistics*, 11(2), 129–158.
- Tulving, E. (1972). Episodic and semantic memory. In E. Tulving & W. Donaldson (Eds.), *Organization of Memory*. Academic Press.
- Tulving, E., & Thomson, D. M. (1973). Encoding specificity and retrieval processes in episodic memory. *Psychological Review*, 80(5), 352–373.
- Nation, I. S. P. (2001 / 2013 / 2022). *Learning Vocabulary in Another Language*. Cambridge University Press.

---

## 现在与之后

- **已可用（`v0.2.0`）**：
  - **语境阅读与词汇积累**：随包内置 **2023—2026 年 21 套英语六级（CET-6）真题的 63 篇阅读正文**（长篇匹配与仔细阅读），支持「场次 → 套卷 → 题型」两级折叠浏览、重命名/删除、本篇选词与读完标记、首页「最近收集 / 稍后看」、跨词条与文章正文全局搜索，以及阅读页与词条页之间的状态保持与跳转回原文。
  - **对话、学习指令与生成文章**：支持保存与复用自定义学习指令、跨文章全文/多选段落/划选摘录与词条自由组合上下文、多选词条「用一组词学习」并显式存为 AI 生成文章（可阅读、圈词与回链）、Markdown 排版与片段级钉住、以及删除对话后保留钉住快照。
  - **多协议模型接入与品牌更新**：内置 9 家模型服务及 OpenCode GO 聚合入口，支持 OpenAI Chat Completions / Responses、Anthropic Messages、Gemini API 四种协议、本机 DPAPI 与环境变量双源密钥、可用模型拉取、连接测试与自动重试；应用正式更名为「**拾词**」并启用全新桌面图标与侧栏标识。
- **暂未包含**：**PDF 原文对照**与**长回答折叠**在本轮中暂未上线；软件内作答/判分/错题本、统计仪表盘、遗忘曲线排程、多设备同步与账号体系依然保持在产品范围之外。
- **更远（不止于六级）**：先把既有材料上的个人语境单词本体验做扎实，再逐步开放通用英文文章导入，脱离单一考试限制，服务外刊、论文等更多阅读材料。

---

## 数据主权与隐私

- **单库本地存储**：文章、词条、原句、笔记、对话树与钉住全部存在本机 SQLite 数据库中（`userData/english-learning.db`）。
- **密钥隔离**：支持配置并切换多套模型服务，API 密钥通过 Windows `safeStorage`（DPAPI）加密，默认不进入任何备份。
- **随时带走**：支持全库快照备份、恢复（恢复前自动留一份快照）以及单条对话导出为 JSONL。

---

## 本地运行与开发

需要 **Node.js >= 22.12.0**（Windows）。

```bash
npm install                # 安装依赖
npm run dev                # 启动开发模式（Electron + Vite）
npm run test               # 类型检查 + Vitest 单元测试
npm run test:e2e           # Playwright 端到端测试（开发产物）
npm run package:installer  # 构建 Windows 安装包（输出至 release-installer/）
npm run verify             # 运行完整检查链路（类型、单测、E2E 与打包产物验证）
```

<details>
<summary>开发环境变量与 Electron 下载镜像说明</summary>

尚未在应用「设置」页配置模型服务时，开发模式会读取仓库根目录 `.env`（参考 [`.env.example`](./.env.example)）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 无 | 开发调试用的 API 密钥 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容接口地址 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 模型名称 |

若 `npm install` 在下载 Electron 二进制时卡住，可先设置镜像再安装：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_CUSTOM_DIR = '{{ version }}'
npm install
```

</details>

### 结构与文档导航

```text
src/
├── main/      主进程（SQLite 迁移、语料导入、离线词典、模型调用、DPAPI 密钥、IPC）
├── preload/   受白名单约束的 contextBridge
├── renderer/  React 界面（首页、阅读、词条、对话与钉板、文章库、设置）
└── shared/    跨层类型与唯一 IPC 契约
docs/          领域术语、产品范围、架构决策（ADR）与语料
assets/        随包离线词典及版权声明
e2e/           Playwright 端到端测试
```

- 领域术语表：[GLOSSARY.md](./GLOSSARY.md)
- 首版产品范围：[docs/product-scope.md](./docs/product-scope.md)
- 架构决策记录（桌面技术栈 / 首批语料 / 会话存储）：[docs/adr/](./docs/adr)
- 首批 63 篇真题语料说明：[docs/corpus/README.md](./docs/corpus/README.md)
- 随包离线词典说明：[assets/dictionary/README.md](./assets/dictionary/README.md)

---

## 开源致谢

- 内置离线词典基于 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT License）裁剪构建，许可声明随包保留于 [`assets/dictionary/LICENSE-ECDICT`](./assets/dictionary/LICENSE-ECDICT)。
- 模型调用适配层使用 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)。
