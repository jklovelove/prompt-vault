# PromptVault（纯前端版 · GitHub Pages）

> **已部署：https://jklovelove.github.io/prompt-vault/**
> 直接打开即可用，首次访问会引导填写 Token。数据存在你自己的私有仓库 `ai-prompts` 里。

AI 提示词 / Agent / 多 Agent 编排的记录与同步工具。**无服务端、零依赖、零构建**，直接托管在 GitHub Pages 上。

数据存在你自己的 **GitHub 私有仓库** 里，所以任何一台电脑打开同一个网址都能看到同样的内容。

---

## 一、和「本地服务版」的区别

| | 本地服务版（`prompt-vault/`） | 纯前端版（本目录） |
| --- | --- | --- |
| 运行方式 | `start.bat` 起 Node 服务，访问 `localhost:4747` | 直接打开网页，无需任何进程 |
| 部署 | 只能本机 | GitHub Pages / 任意静态托管 |
| GitHub 调用 | 服务端代理（token 存 `config.json`） | **浏览器直连** `api.github.com` |
| Token 存放 | 服务端 `config.json`（gitignore） | **浏览器 localStorage** |
| `.skill` 打包 | 服务端 `zlib` | 浏览器 `CompressionStream('deflate-raw')` |
| 多设备 | 每台机器都要装一份 | 一个网址，处处可用 |

核心能力完全一致：三视图（提示词 / Agents / 编排）、多选 Agent 批量导出（复制 / TXT / JSON / API JSON）、导出时自动带上这些 Agent 参与的**编排链路**、按 skill-creator 规范打包 `.skill`、浅色/深色/跟随系统主题。

---

## 二、部署（5 分钟）

> 本仓库已经部署好了，下面这段是**换账号/换仓库**时的完整步骤。

### 1. 建代码仓库并上传

新建一个仓库（名字随意，示例用 `prompt-vault`）。**建议设为 Public**，因为 GitHub Pages 对免费账号只支持公开仓库。

把本目录这 5 个文件放到仓库根目录：

```
prompt-vault/
├── index.html      ← 页面
├── app.js          ← 逻辑（含浏览器直连 GitHub 的传输层）
├── pkg.js          ← ZIP 打包 + .skill 构建
├── styles.css      ← 样式（浅色/深色主题变量）
└── .nojekyll       ← 空文件，阻止 Jekyll 处理
```

> `.nojekyll` 是个空文件，作用是让 Pages 跳过 Jekyll 构建，避免文件名/目录被意外处理。没有它通常也能跑。

### 2. 开启 Pages

仓库 → **Settings** → 左侧 **Pages** → **Build and deployment**

- **Source**: `Deploy from a branch`
- **Branch**: `main` / `(root)`
- 点 **Save**

等 1～2 分钟，访问：

```
https://<你的用户名>.github.io/prompt-vault/
```

### 3. 首次使用

页面第一次打开会**自动弹出设置窗**，填两项：

| 字段 | 填什么 |
| --- | --- |
| **GitHub Token** | 见下方「Token 怎么建」 |
| **数据仓库名** | 存数据的仓库，建议 `ai-prompts`（可留空则自动新建） |

其余保持默认：分支 `main`、数据文件 `prompts.json`、勾选「仓库设为私有」。

点 **保存并同步** → 会自动校验身份、按需创建仓库、写入初始 `prompts.json`。看到 `✅ 已连接 …` 即成功。

---

## 三、Token 怎么建

推荐用 **Fine-grained token**（最小权限）：

1. 打开 https://github.com/settings/personal-access-tokens/new
2. **Repository access** → `Only select repositories` → 勾选你的数据仓库（如 `ai-prompts`）
   - 如果还没有这个仓库，先选 `All repositories`，或者先手动建一个空的私有仓库
3. **Permissions** → `Repository permissions` → 找到 **Contents** → 设为 **Read and write**
4. 生成后复制 `github_pat_…`，粘到设置窗里

> **Classic token** 也可以，需要勾选 `repo` 整个权限范围（权限比 fine-grained 大）。

---

## 四、安全说明（重要）

这是纯前端页面，安全边界和你平时用的网站不一样，请务必了解：

- **Token 只存在你自己的浏览器里**（localStorage），请求由浏览器直接发往 `api.github.com`，不经过任何第三方服务器。**这一点和别的在线工具不同，是本方案的前提。**
- **换电脑 / 换浏览器 / 无痕模式**都要重新填 Token，不会自动带过去。
- **不要在公司或公共电脑上保存 Token**。用完点设置窗左下角的 **「清除本机凭据」**，会清掉 Token 和离线缓存。
- 页面本身是公开的，但**别人打开只会看到一个空工具**——他们没有你的 Token，读不到你的私有仓库，你的数据不会泄露。
- Token 有权限范围，一旦泄露请立刻去 GitHub 吊销重建。
- 导出网页给别人看之前，请确认没把 Token 截图或复制进去。

---

## 五、日常使用

- **拉取 / 保存**：改完内容点「保存」即写入 GitHub；换设备后点右上角 **⟳ 拉取** 取最新。
- **离线可用**：`localStorage` 会缓存一份数据。GitHub 读失败时自动回落缓存，并在状态标签上提示「本地缓存（GitHub 异常）」，不会丢内容。
- **多选导出**：切到 Agents 视图，勾选多个 Agent，底部出现工具栏：
  - `复制` — 拼成一段纯文本进剪贴板
  - `TXT` / `JSON` — 纯提示词或完整结构
  - `API JSON` — 可直接投喂 OpenAI 兼容接口的 messages 结构
  - **`打包 .skill`** — 生成符合 skill-creator 规范的技能包
- **`.skill` 包结构**（解压后）：

```
<skill-name>/
├── SKILL.md                        # YAML frontmatter + 何时使用 + 执行流程
├── agents/1-<slug>.md              # 每个 Agent：角色 / 模型 / 生成参数 / 系统提示词
├── references/orchestration.json   # 编排链路结构化数据
├── references/agents.json          # Agent 完整定义
└── references/api-messages.json    # 可直接调 API 的 messages
```

导出时**只选 Agent 也会自动带上它们参与的编排链路**；反过来，如果编排里引用了你没勾选的 Agent，打包会自动把它们补全，避免出现空引用。

---

## 六、常见问题

**打开是空白 / 一直弹设置窗**
Token 没填或填错。点右上角 ⚙ 重新填，用 **测试连接** 看具体报错。

**保存报错 `Bad credentials`**
Token 过期或被吊销，重新生成一个。

**保存报错 `Not Found`**
仓库名写错，或 Token 没勾选这个仓库的权限（fine-grained 最常见）。Owner 留空时会自动用 Token 对应的账号。

**保存报错 `sha wasn't supplied` / 冲突**
数据文件在你上次拉取之后被别处改过。点 **⟳ 拉取** 再改一次即可。

**打包 `.skill` 名称是一串 `skill-xxxxxxxx`**
skill-creator 规范要求 `name` 只能是 `a-z0-9-`。中文编排名会被 slug 清空，于是回退成一个**基于名称的稳定短哈希**——同一个编排每次导出名字都一样，不同的编排名字不重复。想自定义名字，在打包弹窗的「技能名」里填英文（如 `analog-ic-flow`）。

**`.skill` 下载后解压是空的**
浏览器需支持 `CompressionStream`（Chrome/Edge 103+、Safari 16.4+、Firefox 113+）。老浏览器会自动退化为不压缩打包，文件仍可正常解压。

---

## 七、要不要用本地服务版？

纯前端版够用的话就不用。以下情况建议回本地服务版（`prompt-vault/`）：

- 想在**公共电脑**上用，不想把 token 落在浏览器里 → 服务端版 token 只在本机文件
- 需要**团队多人共用一个部署**，且不想每个人都配 token
- 想完全离线跑（本地服务版数据在磁盘 `vault.json`，不依赖 GitHub）
