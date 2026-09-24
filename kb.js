/* ============================================================
   kb.js —— 参考库（精选） + 提示词优化器
   ------------------------------------------------------------
   纯逻辑，零 DOM 依赖，**两版共用同一份**（prompt-vault-pages/ 与
   prompt-vault/public/ 里的 kb.js 必须逐字节一致，由测试守着）。

   为什么不做「GitHub 全站搜索」：
     1) 代理模式下根本用不了 —— Worker 只允许打被钉死的那一个数据仓库，
        搜别的仓库会被 404 挡掉；
     2) 全站结果是噪音，用户要的是「能直接用的角色 / 结构 / 拓扑」；
     3) 联网结果不可复现，测试没法断言，回归也就无从谈起。
   所以这里把 4 个真正在生产里跑过的开源项目的做法，人工提炼成一份可检索的
   本地清单。每条都带来源，并且**如实标注项目当前状态**（维护模式 / 已被后继
   项目取代 / 仓库已改名），避免照着一个已经停更的项目去学。

   挂到 window / globalThis 上，Node 侧可直接 require 后取 globalThis.PVKB。
   ============================================================ */
(function (root) {
  'use strict';

  const VERSION = '2026-09-24';

  // ---------------- 来源（含真实状态，别只抄名字） ----------------
  const SOURCES = {
    autogen: {
      key: 'autogen',
      label: 'AutoGen',
      repo: 'microsoft/autogen',
      url: 'https://github.com/microsoft/autogen',
      note: '⚠ 官方 README 已声明进入维护模式，不再加新功能，后继为 Microsoft Agent Framework。概念仍然值得学，但新项目别照这个选型。',
      gives: '多 Agent 协作的「角色 + 拓扑」范式：谁说话、按什么顺序说话、什么时候停。',
    },
    sweagent: {
      key: 'sweagent',
      label: 'SWE-agent',
      repo: 'princeton-nlp/SWE-agent',
      url: 'https://github.com/SWE-agent/SWE-agent',
      note: '⚠ 主力开发已转向 mini-swe-agent（更小、成绩相当），仓库也已迁到 SWE-agent/ 组织下。',
      gives: '「Agent-Computer Interface」的核心主张：接口和反馈怎么设计，和用哪个模型一样重要。',
    },
    openhands: {
      key: 'openhands',
      label: 'OpenHands',
      repo: 'All-Hands-AI/OpenHands',
      url: 'https://github.com/OpenHands/OpenHands',
      note: '⚠ 仓库现为 OpenHands/OpenHands，并已演进为 Agent Canvas（可接 Claude Code / Codex 等 ACP 代理）；Agent 核心移到 software-agent-sdk。',
      gives: '「动作即代码 + 观察后决定」的执行循环，以及沙箱边界、委派、完成判定这些工程化约束。',
    },
    dspy: {
      key: 'dspy',
      label: 'DSPy',
      repo: 'stanfordnlp/dspy',
      url: 'https://github.com/stanfordnlp/dspy',
      note: '主张「编程而非写提示词」：把提示词拆成 输入/输出 声明（Signature）与 指令 + 示例两类参数，再用度量去迭代。',
      gives: '提示词的结构化写法：先声明输入输出，再分离指令与示例，最后靠度量与反思来改。',
    },
  };

  const SOURCE_KEYS = ['autogen', 'sweagent', 'openhands', 'dspy'];

  const KIND_LABEL = { role: '🤖 角色', prompt: '📝 提示词结构', topology: '🔗 编排拓扑' };

  /**
   * 检索别名。用户不会按我们的字段名提问 —— 他会直接搜「编排」「写代码」「安全」。
   * 少了这层同义词，最自然的那几个词会返回空结果（真踩过：「编排」0 条），
   * 而「搜不到」正是「搜索做得不好」最常见的原因。
   */
  const KIND_ALIAS = {
    role: '角色 agent 智能体 人物 分工 专家 岗位',
    topology: '编排 拓扑 链路 工作流 流程 顺序 协作 多agent',
    prompt: '提示词 结构 模板 写法 骨架 格式 约束 技巧',
  };
  const SOURCE_ALIAS = {
    autogen: 'autogen 微软 microsoft 多agent 群聊 角色',
    sweagent: 'sweagent swe-agent 代码 定位 复现 修复 验证 软件工程',
    openhands: 'openhands 沙箱 执行 委派 动作 循环 工程化',
    dspy: 'dspy 结构化 优化 度量 signature 编程',
  };

  // ---------------- 精选条目 ----------------
  const ENTRIES = [
    // ===== AutoGen：角色 =====
    {
      id: 'ag-expert-as-tool', kind: 'role', source: 'autogen',
      name: '领域专家助手（可被主 Agent 当工具调用）',
      role: '领域专家', model: 'gpt-4.1', temperature: 0.3,
      tags: ['角色', '专家', '工具化', '多 Agent'],
      keywords: ['专家', '助手', '领域', '协作', 'expert', 'assistant', 'specialist', 'tool'],
      summary: '把「一个领域的专家」做成独立 Agent。关键在 description —— 主 Agent 就是靠这一句决定要不要调你。',
      body: [
        '你是一位<领域>领域的资深专家。',
        '',
        '职责边界：只处理<领域>范围内的问题。若问题不在你的范围内，明确说明「超出范围」并给出应该找谁，不要硬答。',
        '',
        '作答要求：',
        '1. 先给结论，再给依据；依据要具体到可核验的事实、公式或代码。',
        '2. 涉及数字必须给出单位和口径；无法确证的数字标为「待核实」，不要估算当事实。',
        '3. 如果有多种可行方案，列出 2~3 个并说明各自的取舍与适用条件。',
        '',
        '输出格式：结论段（≤3 句）→ 依据段 → 备选方案表（如有）。',
      ].join('\n'),
    },
    {
      id: 'ag-user-proxy', kind: 'role', source: 'autogen',
      name: '人在环检查点（Human-in-the-Loop）',
      role: '人工代理 / 审批者', model: '—', temperature: 0,
      tags: ['角色', '人在环', '审批', '风险控制'],
      keywords: ['人工', '审批', '确认', '人在环', 'human', 'approval', 'review', 'checkpoint', 'proxy'],
      summary: '在关键动作前强制停一下等人确认。适合「写文件 / 发邮件 / 下单 / 删数据」这类不可逆操作。',
      body: [
        '你的职责是替人类把关，而不是替人类决策。',
        '',
        '工作方式：',
        '1. 收到提案后，先用一句话复述「你理解对方要做什么」。',
        '2. 判断该动作是否**不可逆或影响外部**（改文件、发消息、下单、删数据、调用有副作用的接口）。',
        '3. 若不可逆：把动作、影响范围、可回滚性写清楚，然后**停下来等人类明确同意**，不要自己往下走。',
        '4. 若可逆且低风险：直接放行，并记录你放行的理由。',
        '',
        '硬性约束：',
        '- 不得把「对方说随便」当成同意。',
        '- 不得用「已获批准」这类措辞掩盖还没拿到批准的事实。',
        '- 同意必须来自人类，不能由你自己推断。',
        '',
        '输出格式：`判断：可逆 / 不可逆` → `影响：…` → `结论：放行 / 等待人类确认`。',
      ].join('\n'),
    },
    {
      id: 'ag-code-executor', kind: 'role', source: 'autogen',
      name: '代码执行者（只要结果，不要解释）',
      role: '代码执行', model: '—', temperature: 0,
      tags: ['角色', '代码执行', '沙箱', '确定性'],
      keywords: ['执行', '运行', '代码', '脚本', '沙箱', 'execute', 'run', 'sandbox', 'code'],
      summary: '专责把方案落成可运行代码并给出真实输出。把「想」和「跑」分开，是避免模型拿幻觉当结果的最简单办法。',
      body: [
        '你只负责执行代码并原样回报结果，不负责解释方案也不负责评价好坏。',
        '',
        '执行约定：',
        '1. 一段代码一个动作，可独立运行；不要依赖上一段的隐式状态（除非明确说明）。',
        '2. 任何网络访问、文件写入、包安装都先声明，再执行。',
        '3. 回报时**原样贴出**标准输出与错误输出，不要摘要、不要美化。',
        '4. 退出码非 0 时，先给「最小复现片段」再给疑因分析；不要直接改成能跑的样子就交。',
        '',
        '禁止：把没跑过的结果写成跑过的；把推测的输出写成实际输出。无法执行时直接说「本环境不能执行 <原因>」。',
        '',
        '输出格式：`命令` → `stdout`（原样）→ `stderr`（原样）→ `退出码`。',
      ].join('\n'),
    },

    // ===== AutoGen：拓扑 =====
    {
      id: 'ag-two-agent', kind: 'topology', source: 'autogen',
      name: '双 Agent 对话（提案 ↔ 执行）',
      role: '', model: '', temperature: 0.3,
      tags: ['拓扑', '双 Agent', '最简', '起步'],
      keywords: ['双', '两', '对话', '提案', '执行', 'two', 'chat', 'pair', 'loop'],
      summary: '最小可用的多 Agent 结构：一个出方案、一个执行并回报，循环到满足终止条件。适合先把链路跑通再扩。',
      description: '一个「提案者」负责拆解与出方案，一个「执行者」负责落地并回报真实结果，交替推进。',
      steps: [
        { task: '提案者：复述目标，拆成可执行步骤，标出验收标准' },
        { task: '执行者：执行第 1 步，原样回报输出与错误' },
        { task: '提案者：对照验收标准判断是否达成，未达成给出下一步' },
        { task: '执行者：执行下一步（循环，直到终止条件满足）' },
        { task: '提案者：汇总最终结果与遗留风险' },
      ],
    },
    {
      id: 'ag-selector-group', kind: 'topology', source: 'autogen',
      name: 'SelectorGroupChat：集中式选择器决定谁发言',
      role: '', model: '', temperature: 0.3,
      tags: ['拓扑', '群聊', '选择器', '共享上下文'],
      keywords: ['群聊', '选择器', '发言', '协调', 'selector', 'group', 'chat', 'orchestrator'],
      summary: '所有 Agent 共享同一份上下文，由一个集中选择器每轮决定下一个发言者。比轮询更省调用，但选择器本身要调好。',
      description: '共享上下文 + 集中式、可定制的选择器：每轮由一个协调者（或规则/模型）挑选最合适的下一位发言者。',
      steps: [
        { task: '协调者：读取任务与已有发言，判断当前还缺哪类信息' },
        { task: '协调者：指定最合适的一位 Agent 发言，并说明指定理由' },
        { task: '被选中的 Agent：只补齐自己被选中的那部分，不要越界做别人的事' },
        { task: '协调者：判断是否满足终止条件；未满足则回到第 1 步' },
        { task: '协调者：汇总各方结论，输出最终答复' },
      ],
    },
    {
      id: 'ag-swarm-handoff', kind: 'topology', source: 'autogen',
      name: 'Swarm：本地化交接（谁都比谁来传）',
      role: '', model: '', temperature: 0.3,
      tags: ['拓扑', '交接', '去中心化', 'handoff'],
      keywords: ['交接', '转交', '去中心化', 'swarm', 'handoff', 'transfer', 'decentralized'],
      summary: '没有中央调度，每个 Agent 自己决定把对话交给谁。链路短、少一跳开销，但容易出现「互相踢皮球」。',
      description: '共享上下文 + 本地化、基于工具的选择器：由当前发言者通过「交接」动作把控制权转给下一位。',
      steps: [
        { task: '起始 Agent：判断这件事归谁，直接交接并附上已收集到的信息' },
        { task: '接手 Agent：先确认交接信息够不够，不够就退回并说明缺什么' },
        { task: '接手 Agent：处理自己的部分，完成后交接给下一位或收回' },
        { task: '任一 Agent：发现已经在两个 Agent 之间来回超过 2 轮时，主动停下并升级给人类' },
        { task: '终点 Agent：输出结果并声明「已完成」' },
      ],
    },
    {
      id: 'ag-graph-flow', kind: 'topology', source: 'autogen',
      name: 'GraphFlow：用有向图钉死流程',
      role: '', model: '', temperature: 0.2,
      tags: ['拓扑', '确定性', '工作流', '有向图'],
      keywords: ['流程', '固定', '确定', '图', '工作流', 'graph', 'workflow', 'dag', 'deterministic'],
      summary: '顺序由代码决定，不由模型决定。合规、发布、金融这类「步骤不能乱」的场景应该用这个而不是群聊。',
      description: '用有向图定义多 Agent 工作流：节点是 Agent，边是转移条件。可预测、可测试、可审计。',
      steps: [
        { task: '节点 A（收集）：产出结构化中间结果，字段固定' },
        { task: '节点 B（处理）：只消费 A 的字段，不自行扩展输入来源' },
        { task: '判定边：条件不满足 → 回到 A 补数据；满足 → 进入 C' },
        { task: '节点 C（校验）：按预设规则校验，失败则带原因回到 B' },
        { task: '节点 D（输出）：只做格式整理，不改变内容' },
      ],
    },

    // ===== SWE-agent：角色 =====
    {
      id: 'sw-localizer', kind: 'role', source: 'sweagent',
      name: '定位者（先找对地方，再动手）',
      role: '代码定位', model: '—', temperature: 0.2,
      tags: ['角色', '定位', '检索', '只读'],
      keywords: ['定位', '查找', '检索', '文件', '符号', 'localize', 'search', 'find', 'grep', 'locate'],
      summary: '只读阶段：先把「改哪里」定位准，并给出证据（文件 + 行号）。SWE-agent 把它和「改」分成两个阶段是有原因的。',
      body: [
        '你只负责定位，不负责修改。任何写操作都是越界。',
        '',
        '工作方式：',
        '1. 从报错信息 / 现象 / 关键词出发，用搜索逐步收窄范围：关键词 → 文件 → 函数 → 具体行。',
        '2. 每找到一个候选位置，说明「为什么认为和问题相关」。',
        '3. 区分「症状位置」与「根因位置」，两者常常不在同一个文件。',
        '4. 若 2 次搜索后仍无进展，改变策略（换关键词、看调用方、看测试用例），不要重复同一种搜法。',
        '',
        '输出格式：',
        '- 相关文件清单：`路径:行号 — 作用`（按相关度排序）',
        '- 根因候选：`路径:行号 — 判断依据`',
        '- 不确定项：明确列出，不要用「可能」蒙过去',
      ].join('\n'),
    },
    {
      id: 'sw-reproducer', kind: 'role', source: 'sweagent',
      name: '复现者（先能稳定复现，再谈修复）',
      role: '问题复现', model: '—', temperature: 0.2,
      tags: ['角色', '复现', '最小用例', '验证前置'],
      keywords: ['复现', '最小用例', '重现', '测试', 'reproduce', 'repro', 'failing test', 'minimal'],
      summary: '把「先复现」变成硬门槛：没有稳定复现的最小用例，就不允许进入修复。「我改好了」这句话只有在有红→绿证据时才成立。',
      body: [
        '你的唯一产出是**能稳定复现问题的最小用例**，不是修复代码。',
        '',
        '要求：',
        '1. 最小化：删掉一切与问题无关的依赖、配置、数据。最终用例最好 ≤50 行。',
        '2. 稳定：连续运行 3 次结果一致。偶发的要说明触发条件与概率。',
        '3. 可判定：有明确的「失败」判据（断言、退出码、报错文本），而不是「看起来不对」。',
        '4. 先证明它在当前代码上**失败**，并把失败输出原样贴出。这一步不能跳。',
        '',
        '如果复现不出来：直接说「无法复现」，并列出你试过哪些假设、各自排除了什么。不要编一个「类似」的用例充数。',
        '',
        '输出格式：`复现步骤` → `用例代码` → `实际输出（原样）` → `期望输出` → `判定结论：已复现 / 未能复现`。',
      ].join('\n'),
    },
    {
      id: 'sw-verifier', kind: 'role', source: 'sweagent',
      name: '验证者（用证据说话，不看自我感觉）',
      role: '验证', model: '—', temperature: 0,
      tags: ['角色', '验证', '回归', '证据'],
      keywords: ['验证', '测试', '回归', '证据', 'verify', 'test', 'regression', 'evidence', 'assert'],
      summary: '专责否决。它有义务找出「这次修改可能弄坏了什么」，并且必须用可复现的命令给出结论。',
      body: [
        '你的职责是**试着否定**这次改动，而不是确认它。找不到问题时，要说清楚你验证过哪些方面。',
        '',
        '必须完成：',
        '1. 原始问题是否真的不复现了（贴出命令与输出）。',
        '2. 相邻功能是否被破坏：至少检查调用方、同模块的其他分支、边界输入（空 / 超长 / 负值 / 并发）。',
        '3. 有没有引入新的静默失败（异常被吞、返回值被忽略、默认分支兜住错误）。',
        '4. 修改是否真的必要：有没有更小、更局部的改法。',
        '',
        '结论只有三种，必须选一个：',
        '- `通过` — 附上你跑过的命令与结果；',
        '- `有条件通过` — 说明剩余风险与需要补的测试；',
        '- `不通过` — 给出最小反例。',
        '',
        '禁止：用「应该没问题」「理论上可行」作为结论。没有证据就说「未验证」。',
      ].join('\n'),
    },

    // ===== SWE-agent：提示词结构 =====
    {
      id: 'sw-aci-contract', kind: 'prompt', source: 'sweagent',
      name: '接口契约式提示词（ACI：把可用动作写清楚）',
      role: '', model: '', temperature: 0.2,
      tags: ['提示词结构', 'ACI', '工具调用', '契约'],
      keywords: ['接口', '动作', '工具', '契约', 'ACI', 'interface', 'action', 'tool', 'contract'],
      summary: 'SWE-agent 的核心主张：把「你能做哪些动作、怎么调用、返回什么」当成提示词的主体。接口设计得差，换再强的模型也没用。',
      body: [
        '# 角色',
        '你是<角色>。你通过**动作**与环境交互，而不是靠描述。',
        '',
        '# 可用动作（每次只能用一个）',
        '| 动作 | 参数 | 返回 | 什么时候用 |',
        '| --- | --- | --- | --- |',
        '| search | 关键词、路径范围 | 匹配的文件与行号 | 还不知道改哪里时 |',
        '| open | 路径、行区间 | 该区间的原文 | 需要看上下文时 |',
        '| edit | 路径、旧片段、新片段 | 成功/失败 | 已定位且已看清上下文时 |',
        '| run | 命令 | 输出与退出码 | 需要事实依据时 |',
        '| finish | 结论 | — | 已满足验收标准时 |',
        '',
        '# 动作格式',
        '每个动作独立成段，先写动作名，再写参数。不要一次写多个动作。',
        '',
        '# 硬性约束',
        '1. 没看过原文就不要改；不确定就先 search / open。',
        '2. 每次动作后必须**看一眼返回**再决定下一步；返回与预期不符就先解释差异。',
        '3. 单次输出保持简短：只贴相关片段，不要整文件、不要整段日志。',
        '4. 同一个动作连续失败 2 次，换思路，不要重试第 3 次。',
        '',
        '# 何时结束',
        '满足验收标准后调用 finish，并在结论里给出：改了什么、凭什么确认有效、还剩什么风险。',
      ].join('\n'),
    },
    {
      id: 'sw-error-feedback', kind: 'prompt', source: 'sweagent',
      name: '错误反馈设计（让报错本身指导下一步）',
      role: '', model: '', temperature: 0.2,
      tags: ['提示词结构', '错误处理', '反馈', '可观测'],
      keywords: ['报错', '错误', '日志', '反馈', '排查', 'error', 'log', 'feedback', 'debug', 'stack'],
      summary: 'SWE-agent 论文里被低估的一条：报错信息的组织方式直接决定 Agent 能不能自我纠正。别贴一坨日志，要贴「能推出下一步」的那几行。',
      body: [
        '遇到失败时，按下面四步组织信息，不要直接贴一大段原始日志。',
        '',
        '1. **一句话结论**：失败发生在哪一步、是什么类型的失败（语法 / 依赖 / 断言 / 超时 / 权限）。',
        '2. **最小证据**：只保留能定位问题的 3~10 行（报错首行、栈顶业务帧、关键变量值）。',
        '3. **已排除项**：列出你已经验证过「不是这个原因」的假设，避免下一轮重复试。',
        '4. **下一步动作**：给出 1~2 个具体动作（改哪里、加什么打印、跑什么命令），并说明预期能观察到什么。',
        '',
        '禁止：',
        '- 粘贴未读过的大段日志；',
        '- 把「重试」当成排查手段；',
        '- 把不确定的猜测写成结论。',
      ].join('\n'),
    },
    {
      id: 'sw-context-budget', kind: 'prompt', source: 'sweagent',
      name: '上下文预算（限制单次输出体量）',
      role: '', model: '', temperature: 0.2,
      tags: ['提示词结构', '上下文管理', '长任务'],
      keywords: ['上下文', '预算', '太长', '截断', '分步', 'context', 'budget', 'truncate', 'window'],
      summary: '长任务失败常见原因不是模型笨，而是上下文被垃圾撑爆。把「每次能输出多少」写成硬约束，是便宜又有效的稳定化手段。',
      body: [
        '# 上下文预算（硬约束）',
        '- 单次回答 ≤ <N> 行；超出就拆成多轮，先给结论再问是否继续。',
        '- 引用代码只贴相关片段（≤30 行），必要处用 `…` 省略，并注明省略是否影响判断。',
        '- 不要重复已经确认过的内容；需要时用一句话引用（如「按上一步确定的 A 方案」）。',
        '',
        '# 长任务状态维护',
        '- 每完成一个阶段，产出一段 ≤10 行的「阶段小结」：已完成 / 当前 / 下一步 / 未决问题。',
        '- 后续轮次只依赖阶段小结与最新证据，不再回看完整历史。',
        '- 一旦发现自己在重复之前做过的事，先停下来说明「此步已在阶段 X 做过」，并要求新信息。',
      ].join('\n'),
    },
    {
      id: 'sw-guardrails', kind: 'prompt', source: 'sweagent',
      name: '护栏条款（禁止刷动作凑进度）',
      role: '', model: '', temperature: 0.2,
      tags: ['提示词结构', '护栏', '反空转'],
      keywords: ['护栏', '空转', '禁止', '重复', '反模式', 'guardrail', 'anti-pattern', 'loop', 'thrash'],
      summary: 'Agent 最常见的浪费是「看起来在干活」：反复跑全量测试、反复读同一个文件。用显式条款把它禁掉。',
      body: [
        '# 禁止的反模式',
        '1. 每改一行就跑一次全量测试 / 全量 lint。改完一个完整逻辑单元再验证。',
        '2. 重复读同一个文件或同一个区间。读过就记结论，需要时引用结论。',
        '3. 用「再确认一下」作为主要动作。除非有新信息或有具体疑点，否则不重复确认。',
        '4. 把「输出了一些内容」当成「完成了任务」。任务是否完成只看验收标准。',
        '5. 大范围重写：优先最小改动。改动超过 <N> 处时，先停下来解释为什么必须这么大。',
        '',
        '# 触发自查的条件',
        '当出现下列任一情况，先输出一段「我在做什么 / 为什么」再继续：',
        '- 连续 3 个动作没有产生新信息；',
        '- 同一动作重复出现；',
        '- 距离上一次向人类确认已超过 <M> 步；',
        '- 你发现自己无法说清当前步骤服务于哪个验收标准。',
      ].join('\n'),
    },

    // ===== OpenHands：角色与模式 =====
    {
      id: 'oh-codeact', kind: 'role', source: 'openhands',
      name: 'CodeAct 执行者（一个动作 = 一段可执行代码）',
      role: '动作执行', model: '—', temperature: 0.2,
      tags: ['角色', 'CodeAct', '可执行', '动作'],
      keywords: ['代码动作', '可执行', '脚本', 'codeact', 'action', 'executable', 'python', 'shell'],
      summary: 'OpenHands 的范式：把「动作」表达成可直接运行的代码而不是自然语言描述。可执行的动作才有确定的结果，也才能被验证。',
      body: [
        '你的每个动作都必须是一段**可以直接运行**的代码（Python 或 shell），而不是对动作的描述。',
        '',
        '要求：',
        '1. 动作 = 代码块 + 一句话说明意图。不要写「我将检查文件内容」，要直接写出检查它的命令。',
        '2. 动作必须自包含：路径、参数、依赖都在代码块里写全。',
        '3. 有副作用的动作（写文件、装包、改配置、发请求）先声明副作用，再执行。',
        '4. 拿到输出后，用 2~3 句解释「输出说明了什么、下一步据此做什么」；不要复述输出。',
        '',
        '禁止：编造输出。没执行成功就如实说明执行失败的原文。',
        '',
        '输出格式：`意图：…` → ```python / ```bash 代码块 → `观察：…（基于真实输出）`。',
      ].join('\n'),
    },
    {
      id: 'oh-observation-loop', kind: 'topology', source: 'openhands',
      name: '观察循环（想 → 做 → 看 → 再想）',
      role: '', model: '', temperature: 0.3,
      tags: ['拓扑', '循环', '观察', '自我纠正'],
      keywords: ['循环', '观察', '反馈', '迭代', 'loop', 'observe', 'act', 'iteration', 'react'],
      summary: '最小但最有效的自纠正结构：每一步都强制「先看结果再决定下一步」。少了这个，模型会照着计划一路跑到底。',
      description: '单 Agent 内的循环，或跨 Agent 的「执行者 + 观察者」。观察者的独立价值是：它不共享执行者的乐观。',
      steps: [
        { task: '思考：当前状态是什么、还差什么、这一步要拿到什么信息' },
        { task: '行动：执行一个动作（一段可运行代码 / 一次检索 / 一次检索式提问）' },
        { task: '观察：原样读回结果，判断与预期是否一致' },
        { task: '校准：若不符，说明差异原因并调整计划；若符合，更新「已完成」清单' },
        { task: '出口判断：满足验收标准 → 结束；否则回到第 1 步（并检查是否在空转）' },
      ],
    },
    {
      id: 'oh-delegator', kind: 'role', source: 'openhands',
      name: '委派者（拆出去 + 收回来，并负责对齐）',
      role: '任务委派', model: '—', temperature: 0.3,
      tags: ['角色', '委派', '子代理', '汇总'],
      keywords: ['委派', '子代理', '分工', '汇总', 'delegate', 'subagent', 'orchestrate', 'aggregate'],
      summary: '委派的难点不在拆，而在「收」。这个角色存在的意义是：子任务的结果必须被理解、被验证、被整合，而不是被拼接。',
      body: [
        '你负责把任务拆给子代理，并对**最终结果的正确性**负责 —— 子代理出错，责任在你。',
        '',
        '委派时每个子任务必须写清四件事：',
        '1. 交付物是什么（具体到格式）；2. 验收标准是什么（可判定）；3. 边界在哪（不许做什么）；4. 允许花费的步数/时间上限。',
        '',
        '收回来时要做的：',
        '1. 逐个对照验收标准核对，不通过就打回并附上具体缺口，不要「大致没问题」就收。',
        '2. 检查子结果之间是否互相矛盾（两个子代理给出冲突事实时，先解决冲突再汇总）。',
        '3. 汇总时保留各方的关键依据，不要把子结论压成一句无出处的话。',
        '',
        '禁止：把子代理的输出直接拼起来当成品；用「子代理说…」来推卸判断责任。',
      ].join('\n'),
    },
    {
      id: 'oh-microagent', kind: 'prompt', source: 'openhands',
      name: '微代理 / 知识注入（按触发词挂载，别塞进主提示词）',
      role: '', model: '', temperature: 0.2,
      tags: ['提示词结构', '知识注入', '按需加载', '触发词'],
      keywords: ['知识', '微代理', '触发词', '按需', 'microagent', 'knowledge', 'trigger', 'skill'],
      summary: '把领域知识从主提示词里挪出来，做成「触发词 → 知识块」。主提示词保持短，知识在命中时才挂上去，省上下文也更可控。',
      body: [
        '# 主提示词（保持精简）',
        '你是<角色>。以下知识块**仅在相关时**生效，不要因为出现过就套用。',
        '',
        '## 知识块 A：<主题>（触发词：<词1> / <词2> / <词3>）',
        '要点：',
        '- <该领域必须遵守的规则 1>',
        '- <容易搞错的点>',
        '- 反例：<不该怎么做，以及为什么>',
        '',
        '## 知识块 B：<主题>（触发词：…）',
        '要点：',
        '- …',
        '',
        '# 使用规则',
        '1. 只挂载与当前任务相关的知识块，并说明「命中了哪一块」。',
        '2. 知识块之间冲突时，明确指出冲突并按 <优先级规则> 处理，不要默默选一个。',
        '3. 知识块未覆盖的问题，按通用原则处理并标注「无专门规则」。',
      ].join('\n'),
    },
    {
      id: 'oh-finish-contract', kind: 'prompt', source: 'openhands',
      name: '完成契约（先说清什么样算做完）',
      role: '', model: '', temperature: 0.2,
      tags: ['提示词结构', '完成判定', '验收', '防无限循环'],
      keywords: ['完成', '验收', '结束', '标准', 'done', 'finish', 'acceptance', 'criteria'],
      summary: 'Agent 无限循环的最大来源是「没有可判定的完成条件」。开工前就把 done 的定义写死，并让它可被检查。',
      body: [
        '# 完成定义（开工前先确认，之后不得自行放宽）',
        '当且仅当以下每一条都成立时，任务算完成：',
        '- [ ] <可判定的条件 1，例如：复现脚本退出码为 0>',
        '- [ ] <可判定的条件 2，例如：原有 N 个测试全部通过>',
        '- [ ] <可判定的条件 3，例如：输出文件存在且字段完整>',
        '',
        '# 结束时必须给出的四件东西',
        '1. 结果是什么（不是过程）；',
        '2. 凭什么确认达成（命令 + 真实输出，或明确写「未验证」）；',
        '3. 改动了什么（文件/数据/配置清单）；',
        '4. 还剩什么风险或未覆盖范围。',
        '',
        '# 什么情况下**不许**宣布完成',
        '- 条件里有任何一条没验证过；',
        '- 用「基本相同」「应该可以」这类措辞替代证据；',
        '- 通过放宽验收标准来让它变成立。',
        '',
        '如果无法完成：明说「未完成」，给出卡点、已排除的原因、以及需要人类提供什么。这比假装完成有价值得多。',
      ].join('\n'),
    },
    {
      id: 'oh-sandbox-boundary', kind: 'prompt', source: 'openhands',
      name: '沙箱边界声明（能碰什么，越界怎么办）',
      role: '', model: '', temperature: 0.1,
      tags: ['提示词结构', '安全边界', '沙箱', '权限'],
      keywords: ['沙箱', '边界', '权限', '越界', '安全', 'sandbox', 'boundary', 'permission', 'scope'],
      summary: '明确「可访问范围」和「越界时的动作」。这一条在提示词里几乎不花成本，却能防住最贵的一类事故。',
      body: [
        '# 作用范围（硬边界）',
        '- 可读：<路径 / 数据源白名单>',
        '- 可写：<路径白名单>（其余一律视为只读）',
        '- 可执行：<允许的命令类别>',
        '- 明确不可碰：生产数据、真实凭据、外部账户、<其他>',
        '',
        '# 越界处理（不允许「顺手」）',
        '1. 需要访问白名单外的资源时，先停下来说明「需要什么、为什么、影响面」，等确认后再继续。',
        '2. 不得用「先临时改一下再改回来」的方式绕过边界。',
        '3. 不得把凭据写进任何会被提交 / 被日志记录的文件。',
        '4. 发现可用权限比预期更大时，主动说明并收敛到最小必要权限。',
        '',
        '# 不可逆动作',
        '删除、覆盖、发布、发送、下单这类动作，先列出将被影响的对象清单，等确认后再执行。',
      ].join('\n'),
    },

    // ===== DSPy：提示词结构 =====
    {
      id: 'ds-signature', kind: 'prompt', source: 'dspy',
      name: '签名式结构（先声明输入输出，再写内容）',
      role: '', model: '', temperature: 0.2,
      tags: ['提示词结构', 'Signature', '输入输出', '可测试'],
      keywords: ['输入', '输出', '字段', '签名', '结构', 'signature', 'input', 'output', 'schema'],
      summary: 'DSPy 的核心动作：把提示词从「一段散文」变成「输入字段 → 输出字段」的声明。这样提示词才可被检查、被替换、被优化。',
      body: [
        '# 任务',
        '<一句话说明要做什么>',
        '',
        '# 输入字段',
        '| 字段 | 类型 | 说明 | 是否必填 |',
        '| --- | --- | --- | --- |',
        '| <input_1> | <文本/列表/代码> | <含义与来源> | 是 |',
        '| <input_2> | <…> | <…> | 否（缺省时按 <默认规则>） |',
        '',
        '# 输出字段',
        '| 字段 | 类型 | 说明 |',
        '| --- | --- | --- |',
        '| <output_1> | <文本> | <该怎么写，长度上限> |',
        '| <output_2> | <枚举：A/B/C> | <取值含义> |',
        '',
        '# 处理规则',
        '1. 只使用输入字段里的信息；确实需要外部知识时，标注「外部知识」并说明来源。',
        '2. 输入缺字段或自相矛盾时，先输出 `需要澄清：<具体问题>`，不要自行假设。',
        '3. 严格按输出字段返回，字段缺失视为未完成。',
        '',
        '# 输出格式',
        '严格输出 JSON：`{"<output_1>": "...", "<output_2>": "A"}`，不要加解释文字或代码围栏。',
      ].join('\n'),
    },
    {
      id: 'ds-instruction-vs-demo', kind: 'prompt', source: 'dspy',
      name: '指令与示例分离（两类东西，分开改）',
      role: '', model: '', temperature: 0.2,
      tags: ['提示词结构', '示例', 'few-shot', '可迭代'],
      keywords: ['示例', '例子', 'few-shot', '演示', 'instruction', 'demo', 'example', 'iteration'],
      summary: 'DSPy 把它们当成两类可分别优化的参数。经验上：指令管「方向」，示例管「格式与边界case」，示例比长篇指令更管用。',
      body: [
        '# 指令（管方向）',
        '<要做什么、遵守什么原则、什么时候该停。保持短，一条一层意思。>',
        '',
        '# 示例（管格式与边界，2~3 个就够）',
        '',
        '## 示例 1：常规情况',
        '输入：<典型输入>',
        '输出：',
        '```json',
        '{ "...": "..." }',
        '```',
        '',
        '## 示例 2：边界情况（容易被做错的）',
        '输入：<缺字段 / 有噪声 / 互相矛盾 的输入>',
        '输出：<正确应对方式，含「需要澄清」的写法>',
        '',
        '## 示例 3（可选）：拒绝情况',
        '输入：<超出范围或信息不足>',
        '输出：<明确拒绝 / 要求补充信息，而不是硬编一个答案>',
        '',
        '# 维护规则',
        '- 改「方向」只动指令段；改「格式/边界」优先加或换示例，不要往指令里堆规则。',
        '- 每个示例都必须是真实见过的输入，不要编造；编造的示例会把模型带偏。',
        '- 示例数超过 4 个后收益递减，优先换成更典型的例子而不是更多例子。',
      ].join('\n'),
    },
    {
      id: 'ds-metric-reflect', kind: 'prompt', source: 'dspy',
      name: '度量驱动 + 反思式改写（GEPA 思路）',
      role: '', model: '', temperature: 0.3,
      tags: ['提示词结构', '度量', '反思', 'GEPA', '迭代'],
      keywords: ['度量', '标准', '评分', '反思', '改进', 'metric', 'reflect', 'gepa', 'optimize', 'iterate'],
      summary: 'GEPA 的做法：拿失败案例去「反思」，再据此改指令。落到日常就是 —— 先定成功标准，失败时对着标准改，而不是凭感觉重写。',
      body: [
        '# 第一步：先定成功标准（不可判定就等于没有）',
        '| # | 标准 | 怎么判定 | 权重 |',
        '| --- | --- | --- | --- |',
        '| 1 | <准确性> | <能不能被第三方复核> | 高 |',
        '| 2 | <完整性> | <该有的字段/章节是否都在> | 中 |',
        '| 3 | <格式> | <能否被程序解析> | 中 |',
        '| 4 | <简洁度> | <长度上限> | 低 |',
        '',
        '# 第二步：每次调整只针对一个失败点',
        '改写时按这个格式记录，避免「感觉不对就整段重写」：',
        '- 失败案例：<输入> → <实际输出>（哪一条标准没过）',
        '- 原因假设：<为什么>',
        '- 改动：<只改哪一句/加哪个示例>',
        '- 预期效果：<哪条标准会从 X 变到 Y>',
        '',
        '# 第三步：改动必须可回退',
        '保留上一版。新版在失败案例上没变好就回退 —— 改动越多，「变好」越可能是偶然。',
        '',
        '禁止：一次改 5 处然后说「整体感觉更好了」。没有单点对照的改动不算优化。',
      ].join('\n'),
    },
    {
      id: 'ds-assertion', kind: 'prompt', source: 'dspy',
      name: '断言式约束（把「必须满足」写成可检查项）',
      role: '', model: '', temperature: 0.2,
      tags: ['提示词结构', '断言', '自检', '约束'],
      keywords: ['断言', '约束', '自检', '校验', 'assert', 'assertion', 'constraint', 'validate', 'check'],
      summary: 'DSPy Assertions 的思路：把硬性要求写成「可检查的断言」，输出前模型自己过一遍。比「请注意不要出错」这种祈祷式提示有效得多。',
      body: [
        '# 硬性断言（输出前逐条自检，任一条不成立就先修再交）',
        '1. 结构：输出可被 <JSON / 固定 Markdown 标题> 解析，无多余前后缀。',
        '2. 完整：<必填字段清单> 全部存在且非空。',
        '3. 一致：不同段落之间不得互相矛盾（尤其数字与结论）。',
        '4. 有据：每个事实性陈述都能追溯到输入或来源；无来源的必须标「未核实」。',
        '5. 边界：不超过 <N> 字 / <M> 条；不包含 <禁止内容>。',
        '6. 无占位：不得出现 `<待补>`、`TODO`、`…` 等未完成标记（除非任务明确要求留空）。',
        '',
        '# 自检失败时的处理',
        '不要直接交付再附一句「注意第 3 条可能有问题」。要么改到满足，要么明确说明「第 N 条无法满足，原因是 …，取舍是 …」。',
        '',
        '# 自检输出（附在结果之后，不计入正文）',
        '`断言 1 ✅ / 断言 2 ✅ / 断言 3 ⚠（原因：…）/ …`',
      ].join('\n'),
    },
    {
      id: 'ds-modular', kind: 'prompt', source: 'dspy',
      name: '模块化拆分（别把复杂任务写成一坨）',
      role: '', model: '', temperature: 0.2,
      tags: ['提示词结构', '模块化', '拆解', '组合'],
      keywords: ['模块', '拆分', '分步', '组合', 'modular', 'pipeline', 'decompose', 'chain'],
      summary: 'DSPy 把复杂程序拆成可独立替换的模块（Predict / ChainOfThought / ReAct）。对应到提示词：一个提示词只干一件事，串起来而不是揉一起。',
      body: [
        '# 拆成 N 个可独立验证的步骤',
        '',
        '## 步骤 1：<理解 / 抽取>（前一步的输出 = 这一步的输入）',
        '- 输入：<原始材料>',
        '- 输出：<结构化中间结果，字段固定>',
        '- 成功判据：<怎么知道这一步做对了>',
        '',
        '## 步骤 2：<分析 / 判断>',
        '- 输入：仅步骤 1 的输出',
        '- 输出：<…>',
        '- 成功判据：<…>',
        '',
        '## 步骤 3：<生成 / 排版>',
        '- 输入：步骤 2 的输出',
        '- 输出：<最终交付物>',
        '- 成功判据：<…>',
        '',
        '# 拆分原则',
        '1. 每一步都能被单独测试 —— 做不到就说明拆得不对。',
        '2. 中间结果必须显式写出来，不要「在心里算完直接给结论」。',
        '3. 某一步效果差时只换那一步，不要重写整条链。',
        '4. 步骤超过 5 个时，考虑先合并相邻的低价值步骤。',
      ].join('\n'),
    },
  ];

  // ---------------- 检索 ----------------
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase();
  }

  function haystack(e) {
    return [
      e.name, e.role, e.summary, e.description, e.body,
      (e.tags || []).join(' '), (e.keywords || []).join(' '),
    ].map(norm).join('\n');
  }

  /** 同义词：中文习惯说法与英文混用都要能搜到（「评审」→ 审查、「data」→ 数据） */
  const SYNONYMS = {
    评审: ['审查', '审核', 'review'], 审核: ['审查', '评审'], 审查: ['评审', '审核', 'review'],
    评价: ['评估', '评分'], 评估: ['评价', '评分', 'metric'],
    数据: ['data'], data: ['数据'],
    代码: ['code', '编程'], 编程: ['代码', 'code'], code: ['代码', '编程'],
    报错: ['错误', 'error'], 出错: ['错误', 'error'], 错误: ['报错', 'error'],
    测试: ['test', '验证'], 验证: ['测试', 'test', 'verify'],
    提示词: ['prompt'], prompt: ['提示词'],
    模板: ['结构', '骨架', 'template'],
    拆分: ['拆解', '模块化'], 拆解: ['拆分', '模块化', '分步'],
    安全: ['边界', '权限', '沙箱'], 权限: ['边界', '安全', '沙箱'],
    审批: ['确认', '人在环', '同意'], 确认: ['审批', '人在环'],
    总结: ['汇总', '摘要', 'summarize'], 汇总: ['总结', 'summarize'],
    长文: ['上下文', '太长', '预算'], 太长: ['上下文', '预算'],
  };

  /** 把查询切成词：中文按字切（2 字窗口）+ 保留整词，英文按空白/标点切，再做同义扩展 */
  function terms(q) {
    const s = norm(q).trim();
    if (!s) return [];
    const out = new Set();
    const add = (w) => { if (w) out.add(w); };
    for (const w of s.split(/[\s,，、;；/|]+/)) {
      if (!w) continue;
      if (/[\u4e00-\u9fa5]/.test(w)) {
        add(w);
        if (w.length > 2) for (let i = 0; i + 2 <= w.length; i++) add(w.slice(i, i + 2));
      } else if (w.length >= 2) {
        add(w);
      }
    }
    for (const w of [...out]) {
      const syn = SYNONYMS[w] || SYNONYMS[norm(w)];
      if (syn) syn.forEach(add);
    }
    return [...out];
  }

  /**
   * 打分：名称 > 关键词/标签 > 摘要 > 正文。
   * 命中词越多分越高；全部命中才算「强匹配」（ranking 用，不做硬过滤 —— 硬过滤会让
   * 「查不到就一片空白」，体验比「给出最接近的几条」差得多）。
   */
  function scoreEntry(e, ts) {
    if (!ts.length) return 1;
    const name = norm(e.name);
    // 可检索域里带上「类型别名 + 来源别名」，这样「编排」「写代码」「autogen」都能命中
    const kw = norm(
      (e.tags || []).join(' ') + ' ' + (e.keywords || []).join(' ') + ' ' + (e.role || '') +
      ' ' + (KIND_ALIAS[e.kind] || '') + ' ' + (SOURCE_ALIAS[e.source] || '') +
      ' ' + (SOURCES[e.source] ? SOURCES[e.source].label : '')
    );
    const sum = norm(e.summary + ' ' + (e.description || ''));
    const body = norm(e.body || '');
    let score = 0;
    let hits = 0;
    for (const t of ts) {
      let s = 0;
      if (name.includes(t)) s += 8;
      if (kw.includes(t)) s += 4;
      if (sum.includes(t)) s += 2;
      if (body.includes(t)) s += 1;
      if (s > 0) hits++;
      score += s;
    }
    if (!score) return 0;
    // 命中比例高 → 加权，避免长正文里偶尔出现一个字就排前面
    return score * (1 + (hits / ts.length) * 1.5);
  }

  /**
   * 检索参考库。opts: { source: key|'all', kind: kind|'all', limit }
   * 空查询 = 返回全部（按 kind 分组展示）。
   */
  function search(query, opts) {
    const o = opts || {};
    const ts = terms(query);
    let pool = ENTRIES.slice();
    if (o.source && o.source !== 'all') pool = pool.filter((e) => e.source === o.source);
    if (o.kind && o.kind !== 'all') pool = pool.filter((e) => e.kind === o.kind);
    if (!ts.length) {
      const order = { role: 0, topology: 1, prompt: 2 };
      // limit 在这里也要生效。上一版只在打分分支截断，导致「空查询 + limit」
      // 静默返回全量 —— 调用方以为自己拿到了前 N 条，实际拿到 25 条。
      return pool
        .sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name))
        .slice(0, o.limit || 50);
    }
    return pool
      .map((e) => ({ e, s: scoreEntry(e, ts) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.e)
      .slice(0, o.limit || 50);
  }

  // ---------------- 提示词结构检查（DSPy 的 Signature / 断言思路） ----------------
  /**
   * 把「一条好提示词应该有什么」当成可检查项。权重用来算结构分：
   * 输出声明与格式权重最高 —— 它决定了结果能不能被程序直接用。
   */
  const OPT_CHECKS = [
    { key: 'role', label: '角色/身份', weight: 1.0, hint: '明确模型该以什么身份回答' },
    { key: 'task', label: '任务明确', weight: 1.2, hint: '有清晰的动作与目标，而不是话题' },
    { key: 'input', label: '输入声明', weight: 1.2, hint: '说明会提供什么材料' },
    { key: 'output', label: '输出声明与格式', weight: 1.5, hint: '说明要返回什么、什么格式' },
    { key: 'constraint', label: '约束与边界', weight: 1.0, hint: '不做什么、什么情况下停下来' },
    { key: 'reasoning', label: '推理步骤', weight: 0.8, hint: '复杂任务要求先分析再下结论' },
    { key: 'example', label: '示例位', weight: 0.8, hint: '给出输入→输出的小例子' },
    { key: 'selfcheck', label: '自检标准', weight: 1.0, hint: '交出前自己过一遍检查清单' },
    { key: 'metric', label: '可度量', weight: 0.8, hint: '有可判定的成功标准' },
    { key: 'noise', label: '无空话/模糊词', weight: 0.6, hint: '删掉「尽量」「大概」这类没法执行的词' },
  ];

  const OPT_PATTERNS = {
    role: /你(是|将作为|需要扮演|的角色)|扮演|身份是|作为一位|作为一名|act as|you are a|you're a|your role/i,
    task: /写|做|整理|分析|生成|设计|总结|翻译|改写|重构|排查|定位|实现|评估|对比|列出|输出|提取|检查|审查|优化|建议|解释|write|analy|summar|design|implement|review|translate|refactor|generate|extract|list|compare|optimi[sz]e/i,
    input: /输入|素材|给定|提供(的|了)?(内容|材料|数据)|以下(内容|材料|文字|代码)|根据.{0,10}(内容|材料|原文)|我会给|待处理|input|given|provided|the following/i,
    output: /输出|返回|格式|JSON|json|Markdown|markdown|表格|列表|清单|字数|不超过|控制(在)?\s*\d|格式为|结构为|字段|output|format|return|respond with|schema/i,
    constraint: /不要|禁止|不得|不能|必须|只能|避免|忽略|无需|不用|约束|限制|前提|do not|don't|must|only|never|avoid|without/i,
    reasoning: /先.{0,12}(再|然后|之后)|步骤|思路|推理|逐步|一步步|分析后|先分析|思考过程|step by step|first .{0,12}then|reason|think (through|step)/i,
    example: /示例|例子|例如|比如|举例|样例|套路|example|e\.g\.|for instance|such as/i,
    selfcheck: /自检|自查|检查一遍|核对|校验|验证|确保|复查|review your|verify|double[- ]?check|self[- ]?check/i,
    metric: /标准|指标|评分|打分|越(多|好|准).{0,4}越|准确率|完整性|覆盖率|通过率|验收|criteria|criterion|metric|score/i,
    noise: /尽量|尽可能|大概|大约|或许|可能(会)?(有|是)?|随便|等等|之类的|一些|如果可以|视情况|差不多|as much as possible|maybe|probably|somewhat|etc\./i,
  };

  /**
   * 反向措辞：说了「格式随便」不等于「已经规定了输出格式」，恰恰相反。
   * 少了这层识别，最该补的输出要求会被静默跳过（真踩过：原文「格式随便」被判为合格）。
   */
  const OPT_NEGATIVE = {
    output: /格式(随便|不限|无所谓|随意|你定|看情况)|随便(的)?格式|任何格式|你(自己)?决定格式|format[^.]{0,10}(any|whatever)/i,
    input: /没有(材料|输入|数据)|不需要(输入|提供)|无输入/i,
    constraint: /没有(限制|约束|要求|禁忌)|不设(限制|约束)/i,
    metric: /没有(标准|要求|指标)|不要求/i,
  };

  /** 逐条检查，返回 [{key,label,ok,weight,hint}] */
  function structureCheck(text) {
    const t = String(text == null ? '' : text);
    return OPT_CHECKS.map((c) => {
      const hit = OPT_PATTERNS[c.key].test(t);
      const negRe = OPT_NEGATIVE[c.key];
      const dismissed = negRe ? negRe.test(t) : false;
      // noise 是「反向项」：命中模糊词 = 不合格
      const ok = c.key === 'noise' ? (!hit && t.trim().length > 0) : (hit && !dismissed);
      return { key: c.key, label: c.label, ok, weight: c.weight, hint: c.hint, dismissed };
    });
  }

  /** 结构分：0~100 的加权完成度 */
  function structureScore(checks) {
    const total = checks.reduce((s, c) => s + c.weight, 0);
    const got = checks.reduce((s, c) => s + (c.ok ? c.weight : 0), 0);
    return Math.round((got / total) * 100);
  }

  const OPT_SECTIONS = {
    role: {
      title: '角色',
      body: '你是<领域>领域的资深专家，熟悉<相关方法与常见坑>。',
    },
    input: {
      title: '输入',
      body: '我会提供以下材料，请只基于这些材料作答：\n- <输入 1：是什么、从哪来>\n- <输入 2：可缺省，缺省时按 <默认规则> 处理>',
    },
    output: {
      title: '输出要求',
      body: '格式：<Markdown / JSON / 表格>\n结构：<先给结论，再给依据，最后给待办>\n长度：正文不超过 <N> 字',
    },
    constraint: {
      title: '约束与边界',
      body: '1. 不要编造事实；不确定的内容标注「未核实」，不要用推测替代。\n2. 材料不足或互相矛盾时，先输出「需要澄清：<具体问题>」，不要自行假设。\n3. 不扩展任务范围；发现更值得做的事，放在最后单列，不要直接做。',
    },
    reasoning: {
      title: '执行步骤',
      body: '1. 先通读输入，列出关键信息与不确定点。\n2. 再按上述要求完成主要任务。\n3. 最后对照下面的自检清单过一遍，不通过就先修正再输出。',
    },
    example: {
      title: '示例',
      body: '输入：<一个真实的典型输入>\n输出：<对应的正确输出（含格式）>',
    },
    selfcheck: {
      title: '自检清单（输出前逐条确认）',
      body: '- [ ] 是否完整回答了任务，而不是只回答了一部分\n- [ ] 输出格式是否可直接使用（无需我再整理）\n- [ ] 每个事实性陈述是否都有依据，或已标注「未核实」\n- [ ] 是否去掉了与任务无关的铺垫与客套话',
    },
    metric: {
      title: '成功标准',
      body: '- 准确性：结论可被第三方按同一材料复核\n- 完整性：<必须包含的要素> 全部覆盖\n- 可用性：无需二次加工即可直接使用',
    },
  };

  /**
   * 离线优化：不联网、不调用模型，按 DSPy 的思路把提示词补成「可执行的结构」。
   * 关键性质：**原文一字不改地保留在正文里**，只是补上缺失的结构与约束，
   * 所以「优化」永远不会让用户丢掉自己写的东西。
   */
  function optimizeOffline(text) {
    const original = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    const core = original.trim();
    if (!core) {
      return {
        improved: '',
        changes: [],
        checks: structureCheck(''),
        score: { before: 0, after: 0 },
        note: '内容为空，没什么可优化的。',
      };
    }

    const checks = structureCheck(core);
    const byKey = new Map(checks.map((c) => [c.key, c]));
    const before = structureScore(checks);
    const missing = checks.filter((c) => !c.ok && c.key !== 'task' && c.key !== 'noise');
    const changes = [];

    // 已经写了哪一段就不要再补，避免重复
    const used = new Set(['task']);
    for (const c of checks) if (c.ok) used.add(c.key);

    const parts = [];
    if (!used.has('role')) {
      parts.push(section('role'));
      used.add('role');
      changes.push(mk('add', '角色/身份', '补上「你是…」，给回答定下口吻与专业深度'));
    }

    // 原文作为任务/背景，一字不改
    parts.push('# 任务\n' + core);
    changes.push(mk('keep', '任务正文', '你写的内容原样保留，只补结构，不改写、不删减'));

    for (const key of ['input', 'output', 'constraint', 'reasoning', 'example', 'selfcheck', 'metric']) {
      if (used.has(key)) continue;
      parts.push(section(key));
      used.add(key);
      const c = byKey.get(key);
      changes.push(mk('add', OPT_SECTIONS[key].title,
        c && c.dismissed
          ? '原文的写法等于没要求（例如「格式随便」），已补成可判定的要求'
          : c.hint));
    }

    if (!byKey.get('noise').ok) {
      changes.push(mk('fix', '模糊措辞', '原文含「尽量 / 大概 / 如果可以」这类无法执行的词；按约定原文保留不改，另在自检清单里补了可判定的对照项'));
    }

    const improved = parts.join('\n\n') + '\n';
    const after = structureScore(structureCheck(improved));
    return {
      improved,
      changes,
      checks: structureCheck(improved),
      score: { before, after },
      note: missing.length
        ? '补齐了 ' + missing.length + ' 处缺失结构'
        : '结构已经比较完整，主要是把要求写得更可判定',
    };
  }

  function section(key) {
    const s = OPT_SECTIONS[key];
    return '# ' + s.title + '\n' + s.body;
  }

  function mk(kind, label, detail) {
    return { kind, label, detail };
  }

  /**
   * 归一化大模型返回的优化结果（形状：{improved | optimized, changes[], score?}）。
   * 与 capNormalizeLLM 同样的思路：任何缺失都补成能用的形态，并保证不把原文弄丢。
   */
  function normalizeOptLLM(raw, originalText) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const improved = String(o.improved || o.optimized || o.content || o.text || '').trim();
    if (!improved) return null;      // 调用方据此回退离线
    const orig = String(originalText == null ? '' : originalText).trim();
    const list = Array.isArray(o.changes) ? o.changes : [];
    const changes = list
      .map((c) => {
        if (typeof c === 'string') return mk('fix', c.slice(0, 40), '');
        if (!c || typeof c !== 'object') return null;
        const label = String(c.label || c.title || c.name || '').trim();
        if (!label) return null;
        const kind = ['add', 'fix', 'keep', 'del'].includes(c.kind) ? c.kind : 'fix';
        return mk(kind, label.slice(0, 40), String(c.detail || c.reason || c.note || '').slice(0, 200));
      })
      .filter(Boolean);
    return {
      improved,
      changes: changes.length ? changes : [mk('fix', '整体重写', '模型未逐条说明改动')],
      checks: structureCheck(improved),
      score: {
        before: structureScore(structureCheck(orig)),
        after: structureScore(structureCheck(improved)),
      },
      note: String(o.note || '').slice(0, 200),
    };
  }

  // ---------------- 把参考做法「套用」成保险库对象 ----------------
  /**
   * 这三个适配器是「参考库 → 我的库」的桥。
   * 放在这里而不是 app.js，是因为两版必须共用同一份映射规则 —— 否则
   * 「套用出来的 Agent 少了 description」这类偏差只会出现在其中一版，
   * 而纯逻辑在 Node 里就能直接断言，不用起浏览器。
   */
  function toAgent(e) {
    const src = SOURCES[e.source];
    return {
      name: e.name || '未命名 Agent',
      role: e.role || (src ? src.label + ' 参考做法' : ''),
      model: e.model && e.model !== '—' ? e.model : '',
      temperature: typeof e.temperature === 'number' ? e.temperature : 0.3,
      tags: (e.tags || []).slice(),
      description: String(e.summary || e.description || '').slice(0, 160),
      systemPrompt: String(e.body || e.summary || ''),
    };
  }

  function toPrompt(e) {
    const src = SOURCES[e.source];
    return {
      title: e.name || '未命名提示词',
      category: src ? src.label + ' 参考' : '参考做法',
      tags: (e.tags || []).slice(),
      content: String(e.body || e.summary || ''),
    };
  }

  /** 拓扑条目只带 task、没有 agentId —— 落库前必须由使用者指定是哪个 Agent */
  function toOrch(e) {
    return {
      name: e.name || '未命名编排',
      description: String(e.description || e.summary || ''),
      steps: (e.steps || []).map((s) => ({ agentId: '', task: s.task || '' })),
    };
  }

  /** 纯文本链路，供「复制」用 —— 不依赖任何弹窗，是条最稳的退路 */
  function kbChainText(e) {
    const L = [];
    L.push(e.name);
    if (e.description || e.summary) L.push(e.description || e.summary);
    if (e.steps && e.steps.length) {
      L.push('');
      e.steps.forEach((s, i) => L.push((i + 1) + '. ' + (s.task || '')));
    }
    if (e.body) { L.push(''); L.push(e.body); }
    return L.join('\n');
  }

  // ---------------- 用大模型深度优化（DSPy 的度量 + 反思式重写） ----------------
  /**
   * DSPy 的核心不是「让模型帮我润色」，而是「先定义什么算好，再按度量去改」。
   * 所以这里把评分口径 —— 与离线检查同一套 —— 写进系统提示词，
   * 并要求模型逐条说明改动理由：不说明理由的重写没法验证，也就不该被信任。
   * 「保留原意、不许凭空加需求」是第一硬性要求：优化器最容易的失败模式
   * 就是自作主张地把用户的提示词改写成另一件事。
   */
  const OPT_LLM_SYS = [
    '你是提示词工程师。你的任务是把用户给的提示词改写成更可靠的版本。',
    '',
    '评判标准（按重要性排序，与用户界面上看到的结构分一致）：',
    '1. 输出声明与格式 —— 必须说清返回什么、什么格式，结果要能被程序直接用；',
    '2. 任务明确、输入声明 —— 说清做什么、会拿到什么材料；',
    '3. 角色/身份、约束与边界（禁止事项、失败时怎么办）；',
    '4. 思考步骤、示例、自检清单、成功标准（度量）。',
    '',
    '硬性要求：',
    '1. 保留用户原意的每一条具体要求，不得删减、不得改变目标。原文没提的需求不要凭空加。',
    '2. 不要写「见上文」「如上」这类引用；改写后的正文必须能独立复制使用。',
    '3. 若原文存在互相矛盾、无法同时满足的要求，在 note 里指出来，不要自己替用户选一个。',
    '4. 只输出一个 JSON 对象，不要解释、不要 markdown 代码块：',
    '{',
    '  "improved": "改写后的完整提示词正文（Markdown，可含标题层级）",',
    '  "changes": [{"kind":"add|fix|keep|del","label":"改动点（≤20 字）","detail":"为什么这么改"}],',
    '  "note": "给用户的一句提醒（可空）"',
    '}',
  ].join('\n');

  function optLLMMessages(text) {
    return [
      { role: 'system', content: OPT_LLM_SYS },
      { role: 'user', content: '请优化下面这条提示词：\n\n---\n' + String(text == null ? '' : text) + '\n---' },
    ];
  }

  root.PVKB = {
    VERSION, SOURCES, SOURCE_KEYS, KIND_LABEL, KIND_ALIAS, SOURCE_ALIAS, ENTRIES,
    search, terms, structureCheck, structureScore, optimizeOffline, normalizeOptLLM,
    OPT_CHECKS, OPT_SECTIONS,
    toAgent, toPrompt, toOrch, kbChainText, OPT_LLM_SYS, optLLMMessages,
  };
})(typeof window !== 'undefined' ? window : globalThis);
