/* ============================================================
   PromptVault 前端逻辑
   - 三视图：提示词 / Agents / 编排
   - Agents 多选批量导出（复制 / TXT / JSON / API JSON）
   - 导出含所选 Agent 参与的编排链路
   - 明暗主题（浅色 / 深色 / 跟随系统）
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let vault = { version: 2, prompts: [], agents: [], orchestrations: [] };
// 最近一次「与远端一致」的快照，用于写入前的三方合并。
// 没有它就分不清「本地新增」和「远端他人新增」，整份覆盖会把别人刚提交的内容抹掉。
let baseVault = { version: 2, prompts: [], agents: [], orchestrations: [] };
let currentView = 'prompts';
let editingPromptId = null;
let editingAgentId = null;
let editingOrchId = null;
let selectedAgents = new Set();
let searchPrompts = '';
let searchAgents = '';
let activeTag = null;

// ---------------- 基础工具 ----------------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseTags(str) {
  return String(str || '')
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// ============================================================
//  数据通道：浏览器直连 GitHub API（纯静态部署，无服务端）
//  - Token 仅存本机 localStorage，绝不写入代码或提交
//  - 通过 api() 路由保持与原服务端版完全一致的接口语义
// ============================================================
const CFG_KEY = 'pv-config';
const CACHE_KEY = 'pv-vault-cache';

function cfgDefaults() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (e) { c = {}; }
  return {
    token: c.token || '',
    owner: c.owner || '',
    repo: c.repo || '',
    file: c.file || 'prompts.json',
    branch: c.branch || 'main',
    private: c.private !== false,
    // 代理模式：填了 apiBase 就由服务端代持 Token，浏览器里不需要任何凭据
    apiBase: (c.apiBase || '').replace(/\/+$/, ''),
    accessCode: c.accessCode || '',
    // 捕捉页的 AI 生成（可选）：OpenAI 兼容接口。三项齐全才走大模型，否则用离线启发式。
    llmBase: (c.llmBase || '').replace(/\/+$/, ''),
    llmKey: c.llmKey || '',
    llmModel: c.llmModel || '',
  };
}
function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }
/** 走代理时：浏览器不持有 Token —— 仓库等配置由 Worker 的 /gh/_config 提供，所以有地址即可用 */
function isProxy(c) { return !!(c && c.apiBase); }
function isConfigured(c) { return isProxy(c) ? true : !!(c && c.token && c.repo); }
function maskToken(t) { return !t ? '' : (t.length <= 10 ? '***' : t.slice(0, 7) + '...' + t.slice(-4)); }

// ------------------------------------------------------------
//  「免填写链接」：把配置放进 URL 片段，换设备时打开一次即自动完成配置
//
//  为什么放在片段(#)而不是写进代码：
//    · 片段不会发送给服务器、不进 Referer、不被搜索引擎收录；
//    · 更关键的是——写进代码仓库等于公开泄露。本页代码仓库是 PUBLIC，
//      GitHub 的 secret scanning 会自动「检测并吊销」公共仓库里的 GitHub 令牌，
//      所以内置 Token 不但不安全，而且会直接失效。
//  代价：这条链接本身等价于密码（只存书签，别外发/截图）。
//  建议搭配「仅授权这一个数据仓库」的 fine-grained token，把影响面压到最小。
// ------------------------------------------------------------
function readTokenLink() {
  const raw = String(location.hash || '').replace(/^#/, '');
  if (!raw) return null;
  let q;
  try { q = new URLSearchParams(raw); } catch (e) { return null; }
  const pick = (...keys) => {
    for (const k of keys) { const v = q.get(k); if (v) return v.trim(); }
    return '';
  };
  const token = pick('t', 'token');
  const apiBase = pick('p', 'proxy').replace(/\/+$/, '');
  if (!token && !apiBase) return null;   // 与视图锚点之类的无关片段区分开
  const inc = {};
  if (apiBase) inc.apiBase = apiBase; else inc.token = token;
  const accessCode = pick('c', 'code'); if (accessCode) inc.accessCode = accessCode;
  const owner = pick('o', 'owner');   if (owner)  inc.owner = owner;
  const repo = pick('r', 'repo');     if (repo)   inc.repo = repo;
  const file = pick('f', 'file');     if (file)   inc.file = file;
  const branch = pick('b', 'branch'); if (branch) inc.branch = branch;
  return inc;
}

/** 应用链接注入的配置；返回 true 表示本次启动是由「一键链接」完成的 */
function applyTokenLink() {
  const inc = readTokenLink();
  if (!inc) return false;
  const next = Object.assign(cfgDefaults(), inc);
  if (inc.apiBase) next.token = '';   // 改走代理后，本机不再保留 Token
  saveCfg(next);
  // 读完立刻把片段从地址栏抹掉，降低截图/复制时带出 Token 的概率
  try { history.replaceState(null, '', location.pathname + location.search); }
  catch (e) { location.hash = ''; }
  return true;
}

/** 用本机已存配置生成「一键链接」，供换电脑 / 分享给同组的人 */
function buildAutoLink() {
  const c = cfgDefaults();
  if (!isConfigured(c)) return '';
  const q = new URLSearchParams();
  if (isProxy(c)) {
    // 代理模式：owner/repo/文件名由 Worker 决定，链接只需地址+访问码，尽量短
    q.set('p', c.apiBase);
    if (c.accessCode) q.set('c', c.accessCode);
  } else {
    q.set('t', c.token);
    if (c.owner) q.set('o', c.owner);
    if (c.repo) q.set('r', c.repo);
    if (c.file && c.file !== 'prompts.json') q.set('f', c.file);
    if (c.branch && c.branch !== 'main') q.set('b', c.branch);
  }
  return location.origin + location.pathname + '#' + q.toString();
}

function readCache() {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return normalizeVault(v || { prompts: [], agents: [], orchestrations: [] });
  } catch (e) {
    return { version: 2, prompts: [], agents: [], orchestrations: [] };
  }
}
function writeCache(v) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(normalizeVault(v))); } catch (e) { /* 配额满则忽略 */ }
}

/** 请求基址：代理模式指向 Worker 的 /gh 前缀，否则直连 GitHub */
function ghBase() {
  const c = cfgDefaults();
  return isProxy(c) ? c.apiBase + '/gh' : 'https://api.github.com';
}

function ghHeaders(extra) {
  const c = cfgDefaults();
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (isProxy(c)) {
    // 代理模式下不带 Authorization：Token 在服务端，浏览器里没有
    if (c.accessCode) h['X-Access-Code'] = c.accessCode;
  } else if (c.token) {
    h.Authorization = 'Bearer ' + c.token;
  }
  return Object.assign(h, extra || {});
}

async function ghJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!r.ok) {
    const err = new Error((data && data.message) || ('HTTP ' + r.status));
    err.status = r.status;
    throw err;
  }
  return data;
}

// UTF-8 安全的 base64（分块避免超长参数栈溢出）
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(String(b64 || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

async function ghGetUser() {
  return ghJson(ghBase() + '/user', { headers: ghHeaders() });
}

/** 代理模式：owner/repo/文件名由 Worker 决定（它被钉死在单个仓库上），用户无需知道任何配置 */
async function ghProxyConfig() {
  const c = cfgDefaults();
  if (!isProxy(c)) return c;
  const r = await ghJson(c.apiBase + '/gh/_config', { headers: ghHeaders() });
  const next = Object.assign({}, c, {
    owner: r.owner || c.owner,
    repo: r.repo || c.repo,
    file: r.file || c.file,
    branch: r.branch || c.branch,
  });
  saveCfg(next);
  return next;
}

async function ghEnsureRepo() {
  const c = await ghProxyConfig();
  if (!c.owner) {
    const u = await ghGetUser();
    c.owner = u.login;
    saveCfg(c);
  }
  const url = ghBase() + `/repos/${c.owner}/${c.repo}`;
  try {
    const repo = await ghJson(url, { headers: ghHeaders() });
    return { repo, created: false };
  } catch (e) {
    if (e.status !== 404) throw e;
    if (isProxy(c)) {
      throw new Error('代理模式不代建仓库：请把 Worker 的 OWNER / REPO 指向已存在的仓库');
    }
    const repo = await ghJson(ghBase() + '/user/repos', {
      method: 'POST',
      headers: ghHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: c.repo, private: !!c.private, auto_init: true,
        description: 'PromptVault 提示词库（AI 提示词 / Agent / 编排）',
      }),
    });
    await new Promise((r) => setTimeout(r, 1500));
    return { repo, created: true };
  }
}

async function ghReadFile() {
  const c = await ghProxyConfig();
  const url = ghBase() + `/repos/${c.owner}/${c.repo}/contents/` +
    encodeURIComponent(c.file) + `?ref=${encodeURIComponent(c.branch)}`;
  try {
    const d = await ghJson(url, { headers: ghHeaders() });
    let vault;
    try {
      vault = normalizeVault(JSON.parse(b64decodeUtf8(d.content || '')));
    } catch (e) {
      vault = { version: 2, prompts: [], agents: [], orchestrations: [] };
    }
    return { vault, sha: d.sha, exists: true };
  } catch (e) {
    if (e.status === 404) return { vault: { version: 2, prompts: [], agents: [], orchestrations: [] }, sha: null, exists: false };
    throw e;
  }
}

async function ghWriteFile(vault, sha, message) {
  const c = await ghProxyConfig();
  const url = ghBase() + `/repos/${c.owner}/${c.repo}/contents/` + encodeURIComponent(c.file);
  const body = {
    message: message || 'PromptVault sync ' + new Date().toISOString(),
    content: b64encodeUtf8(JSON.stringify(vault, null, 2)),
    branch: c.branch,
  };
  if (sha) body.sha = sha;
  return ghJson(url, {
    method: 'PUT',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

// ---- 各接口的本地实现（语义对齐原服务端） ----
async function localVaultGet() {
  const c = cfgDefaults();
  if (!isConfigured(c)) {
    return { vault: readCache(), source: 'local', configured: false };
  }
  try {
    const r = await ghReadFile();
    writeCache(r.vault);
    return { vault: r.vault, source: 'github', sha: r.sha, fileExists: r.exists, configured: true };
  } catch (e) {
    return {
      vault: readCache(), source: 'local-fallback',
      warning: 'GitHub 读取失败，已回落浏览器本地缓存: ' + e.message, configured: true,
    };
  }
}

async function localVaultPost(body) {
  const localVault = normalizeVault(body.vault);
  writeCache(localVault);
  const c = cfgDefaults();
  if (!isConfigured(c)) {
    return { ok: true, saved: 'local', message: '未配置 GitHub，仅保存在浏览器本地' };
  }

  // 先取远端最新 → 与本地做三方合并 → 再写入。
  // 少这一步就会出现「A 提交、B 提交、A 的内容没了」的静默丢数据（真机复现过）。
  const pushOnce = async () => {
    const remote = await ghReadFile();
    const m = mergeVault(baseVault, localVault, remote.vault);
    const merged = normalizeVault(m);
    const r = await ghWriteFile(merged, remote.sha, body.message);
    baseVault = vaultClone(merged);
    vault = merged;               // 写回全局，界面才能反映合并进来的内容
    writeCache(merged);
    return {
      ok: true, saved: 'github',
      sha: r.content && r.content.sha,
      commit: r.commit && r.commit.sha,
      conflicts: m.conflicts,
      broughtIn: JSON.stringify(merged) !== JSON.stringify(localVault),
    };
  };

  try {
    return await pushOnce();
  } catch (e) {
    // 极窄的竞态窗口：读出之后、写入之前别人又提交了 → GitHub 返回 409/422。
    // 重新读一次再合并重试即可，不需要让用户手动操作。
    if (e.status === 409 || e.status === 422) {
      try { return Object.assign(await pushOnce(), { retried: true }); }
      catch (e2) { return { ok: false, saved: 'local', warning: 'GitHub 写入冲突且重试失败，已保存到浏览器本地: ' + e2.message }; }
    }
    return { ok: false, saved: 'local', warning: 'GitHub 写入失败，已保存到浏览器本地: ' + e.message };
  }
}

function localConfigGet() {
  const c = cfgDefaults();
  return {
    configured: isConfigured(c), owner: c.owner, repo: c.repo, file: c.file,
    branch: c.branch, private: c.private, hasToken: !!c.token, tokenMasked: maskToken(c.token),
    isProxy: isProxy(c), apiBase: c.apiBase, hasAccessCode: !!c.accessCode,
    // LLM Key 只回「有没有」，不回明文
    llmReady: !!(c.llmBase && c.llmKey && c.llmModel),
    llmBase: c.llmBase, llmModel: c.llmModel, hasLlmKey: !!c.llmKey,
  };
}

async function localConfigPost(body) {
  const c = Object.assign({}, cfgDefaults());
  if (typeof body.apiBase === 'string') c.apiBase = body.apiBase.trim().replace(/\/+$/, '');
  if (typeof body.accessCode === 'string') c.accessCode = body.accessCode.trim();
  if (typeof body.token === 'string' && body.token.trim()) c.token = body.token.trim();
  if (typeof body.owner === 'string') c.owner = body.owner.trim();
  if (typeof body.repo === 'string') c.repo = body.repo.trim();
  if (typeof body.file === 'string') c.file = body.file.trim() || 'prompts.json';
  if (typeof body.branch === 'string') c.branch = body.branch.trim() || 'main';
  if (typeof body.private === 'boolean') c.private = body.private;
  // 捕捉页的 LLM 配置：key 为空表示「不改动」，避免每次保存都要重填
  if (typeof body.llmBase === 'string') c.llmBase = body.llmBase.trim().replace(/\/+$/, '');
  if (typeof body.llmModel === 'string') c.llmModel = body.llmModel.trim();
  if (typeof body.llmKey === 'string' && body.llmKey.trim()) c.llmKey = body.llmKey.trim();
  saveCfg(c);

  if (isProxy(c)) {
    if (!c.repo) c.repo = '（待代理返回）';
    saveCfg(c);
    try {
      const filled = await ghProxyConfig();   // owner/repo/文件名以 Worker 为准
      const user = await ghGetUser();
      await ghEnsureRepo();
      const remote = await ghReadFile();
      if (!remote.exists) {
        await ghWriteFile({ version: 2, prompts: [], agents: [], orchestrations: [] }, null, 'chore: init PromptVault vault');
      }
      return {
        ok: true, user: user.login, repo: filled.owner + '/' + filled.repo, created: false, configured: true,
        owner: filled.owner, repoName: filled.repo, file: filled.file, branch: filled.branch,
        tokenMasked: '(由代理服务端代持)', proxy: true,
      };
    } catch (e) {
      throw new Error('代理连接失败: ' + e.message);
    }
  }

  if (!c.token || !c.repo) throw new Error('需要提供 GitHub Token 和仓库名');
  try {
    const user = await ghGetUser();
    const { repo, created } = await ghEnsureRepo();
    const remote = await ghReadFile();
    if (!remote.exists) {
      await ghWriteFile({ version: 2, prompts: [], agents: [], orchestrations: [] }, null, 'chore: init PromptVault vault');
    }
    const now = cfgDefaults();
    return {
      ok: true, user: user.login, repo: repo.full_name, created, configured: true,
      owner: now.owner, repoName: c.repo, file: c.file, branch: c.branch, tokenMasked: maskToken(c.token),
    };
  } catch (e) {
    throw new Error('GitHub 校验失败: ' + e.message);
  }
}

async function localGithubTest() {
  const c = cfgDefaults();
  if (!isConfigured(c)) throw new Error(isProxy(c) ? '代理地址无效' : '尚未配置 Token 与仓库');
  const user = await ghGetUser();
  await ghEnsureRepo();
  const remote = await ghReadFile();
  const now = cfgDefaults();
  return {
    ok: true, user: user.login, repo: `${now.owner}/${now.repo}`, file: now.file,
    proxy: isProxy(c),
    fileExists: remote.exists,
    counts: {
      prompts: remote.vault.prompts.length,
      agents: remote.vault.agents.length,
      orchestrations: remote.vault.orchestrations.length,
    },
  };
}

function localExportSkill(body) {
  const orchs = body.orchestrations || [];
  const name = PV.kebabName(body.skillName, (orchs[0] && orchs[0].name) || 'agent-orchestration');
  const description = PV.safeDescription(body.description || (orchs[0] && orchs[0].description) || '');
  const agents = body.agents || [];
  const entries = PV.buildSkillEntries({ name, description, agents, orchestrations: orchs });
  if (body.dryRun) {
    return {
      ok: true, name, description,
      files: entries.map((x) => ({ name: x.name, bytes: new TextEncoder().encode(String(x.data)).length })),
      agentCount: agents.length, orchestrationCount: orchs.length,
    };
  }
  return { entries, name };
}

async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const body = opts.body || {};
  if (path === '/api/vault' && method === 'GET') return localVaultGet();
  if (path === '/api/vault' && method === 'POST') return localVaultPost(body);
  if (path === '/api/config' && method === 'GET') return localConfigGet();
  if (path === '/api/config' && method === 'POST') return localConfigPost(body);
  if (path === '/api/github/test') return localGithubTest();
  if (path === '/api/export/skill') return localExportSkill(body);
  throw new Error('未知接口: ' + path);
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function setSyncState(text, kind) {
  const el = $('#syncState');
  if (!el) return;
  el.textContent = text;
  el.className = 'sync-state ' + (kind || '');
}

// ---------------- 主题 ----------------
const THEME_ORDER = ['system', 'light', 'dark'];
const THEME_ICON = { system: '🖥️', light: '☀️', dark: '🌙' };

function currentThemeMode() {
  return localStorage.getItem('pv-theme') || 'system';
}

function applyTheme(mode) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  const btn = $('#themeBtn');
  if (btn) {
    btn.textContent = THEME_ICON[mode];
    btn.title = '主题：' + (mode === 'system' ? '跟随系统' : mode === 'dark' ? '深色' : '浅色') + '（点击切换）';
  }
}

function cycleTheme() {
  const mode = currentThemeMode();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length];
  localStorage.setItem('pv-theme', next);
  applyTheme(next);
  toast('主题：' + (next === 'system' ? '跟随系统' : next === 'dark' ? '深色' : '浅色'));
}

// ---------------- 加载 / 保存 ----------------
async function loadVault(silent) {
  try {
    const r = await api('/api/vault');
    vault = normalizeVault(r.vault);
    if (r.source === 'github') {
      setSyncState('已连接 GitHub', 'ok');
      baseVault = vaultClone(vault);      // 记下基线，后续写入靠它做三方合并
    } else if (r.source === 'local-fallback') setSyncState('本地缓存（GitHub 异常）', 'warn');
    else setSyncState('未配置 GitHub', 'warn');
    renderAll();
    if (!silent) {
      if (r.warning) toast(r.warning, true);
      else if (r.source === 'github') toast('已从 GitHub 拉取最新数据');
    }
  } catch (e) {
    toast('加载失败: ' + e.message, true);
  }
}

function normalizeVault(v) {
  v = v && typeof v === 'object' ? v : {};
  v.prompts = Array.isArray(v.prompts) ? v.prompts : [];
  v.agents = Array.isArray(v.agents) ? v.agents : [];
  v.orchestrations = Array.isArray(v.orchestrations) ? v.orchestrations : [];
  return v;
}

// ---------------- 写入前的三方合并 ----------------
// 背景：A、B 同时打开页面，各自新增 —— 后保存的人手里是「打开时那份」旧快照，
// 直接整份 PUT 上去会把先保存的人的内容抹掉（真机 e2e 复现过，是静默丢数据）。
// 所以每次写入前先取远端最新，与本地做三方合并，再写合并结果。
const vaultClone = (v) => JSON.parse(JSON.stringify(normalizeVault(v)));

/** 稳定标识：优先 id，退化为标题/名称 */
function itemKeyOf(x, i) {
  return String((x && (x.id || x.title || x.name)) || '#' + i);
}

/**
 * 合并同一类集合（prompts / agents / orchestrations 各调一次）。
 *   base   上次与远端一致的快照
 *   local  本机当前
 *   remote 远端最新
 * 规则：
 *   远端有、本地没有 → 基线也没有则是他人新增，保留；基线有则本地删除过，尊重删除
 *   本地有、远端没有 → 基线也没有则是本地新增，保留；基线有则远端删除过，尊重删除
 *   两边都有         → 只有一边改过就用改过的那边；两边都改过用本地并把冲突计数 +1
 */
function mergeKind(baseArr, localArr, remoteArr) {
  const bm = new Map(baseArr.map((x, i) => [itemKeyOf(x, i), x]));
  const lm = new Map(localArr.map((x, i) => [itemKeyOf(x, i), x]));
  const rm = new Map(remoteArr.map((x, i) => [itemKeyOf(x, i), x]));
  const out = [];
  let conflicts = 0;

  // 先按远端顺序走，保持云端既有排列
  for (const [id, rv] of rm) {
    if (!lm.has(id)) { if (!bm.has(id)) out.push(rv); continue; }
    const lv = lm.get(id), bv = bm.get(id);
    const lChanged = !bm.has(id) || JSON.stringify(lv) !== JSON.stringify(bv);
    const rChanged = !bm.has(id) || JSON.stringify(rv) !== JSON.stringify(bv);
    if (lChanged && rChanged) conflicts++;
    out.push(!lChanged && rChanged ? rv : lv);
  }
  // 再把本地新增的追加在后面
  for (const [id, lv] of lm) {
    if (!rm.has(id) && !bm.has(id)) out.push(lv);
  }
  return { out, conflicts };
}

function mergeVault(base, local, remote) {
  const B = normalizeVault(base), L = normalizeVault(local), R = normalizeVault(remote);
  const p = mergeKind(B.prompts, L.prompts, R.prompts);
  const a = mergeKind(B.agents, L.agents, R.agents);
  const o = mergeKind(B.orchestrations, L.orchestrations, R.orchestrations);
  return {
    version: 2,
    prompts: p.out,
    agents: a.out,
    orchestrations: o.out,
    conflicts: p.conflicts + a.conflicts + o.conflicts,
  };
}

async function saveVault(message) {
  try {
    const r = await api('/api/vault', { method: 'POST', body: { vault, message } });
    if (r.saved === 'github') {
      setSyncState('已同步 GitHub', 'ok');
      // 合并可能把别人新增的内容带了回来 → 必须重渲染，否则界面和云端不一致
      if (r.broughtIn) renderAll();
      if (r.conflicts) toast(`已同步（${r.conflicts} 处同时被改，保留本机版本）`);
      else if (r.broughtIn) toast('已同步到 GitHub，并带回了别人的新内容');
      else toast('已同步到 GitHub');
    } else {
      setSyncState('仅保存本地', 'warn');
      toast(r.warning || r.message || '已保存到本地', r.warning ? true : false);
    }
    return r;                       // 调用方可据此决定收尾提示（例如捕捉页要报告生成了几条）
  } catch (e) {
    toast('保存失败: ' + e.message, true);
    return null;
  }
}

// ---------------- 捕捉：粘贴 / 拖拽 → 提示词 + Agent + 编排 ----------------

const CAP_MAX_EDGE = 1024;      // 截图长边上限：原图动辄几 MB，塞进 JSON 会让每次同步都很重
const CAP_MAX_IMAGES = 6;
let capImages = [];             // [{ id, name, dataUrl, w, h, srcW, srcH }]
let capResult = null;           // 最近一次生成结果（保存前）
let capBusy = false;

function setCapStatus(text, cls) {
  const el = $('#cap_status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'settings-status' + (cls ? ' ' + cls : '');
}

function capMeta() {
  const el = $('#cap_meta');
  if (!el) return;
  const box = $('#cap_text');
  const n = box ? (box.value || '').trim().length : 0;
  el.textContent = n + ' 字 · ' + capImages.length + ' 张图';
}

/** LLM 三项齐全才算「配好了」，缺一项就安静走离线 */
function llmReady() {
  const c = cfgDefaults();
  return !!(c.llmBase && c.llmKey && c.llmModel);
}

/**
 * 把图片压到长边 ≤ CAP_MAX_EDGE 的 JPEG。
 * PNG 透明区域转 JPEG 会发黑，所以先铺白底。
 */
function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w0 = img.naturalWidth || img.width;
      const h0 = img.naturalHeight || img.height;
      const scale = Math.min(1, CAP_MAX_EDGE / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: cv.toDataURL('image/jpeg', 0.82), w, h, srcW: w0, srcH: h0 });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
}

async function capAddFiles(files) {
  const list = Array.from(files || []).filter((f) => /^image\//.test(f.type || ''));
  if (!list.length) return;
  const room = CAP_MAX_IMAGES - capImages.length;
  if (room <= 0) return toast('最多同时放 ' + CAP_MAX_IMAGES + ' 张图', true);
  for (const f of list.slice(0, room)) {
    try {
      const d = await downscaleImage(f);
      capImages.push(Object.assign({ id: uid(), name: f.name || '截图' }, d));
    } catch (e) {
      toast('图片处理失败：' + e.message, true);
    }
  }
  renderCapThumbs();
}

function renderCapThumbs() {
  const wrap = $('#cap_thumbs');
  if (!wrap) return;
  wrap.classList.toggle('hidden', capImages.length === 0);
  wrap.innerHTML = capImages.map((im) => `
    <figure class="cap-thumb">
      <img src="${im.dataUrl}" alt="${escapeHtml(im.name)}" />
      <button class="cap-thumb-x" data-capdel="${im.id}" title="移除这张">✕</button>
      <figcaption>${im.w}×${im.h}${im.srcW > im.w ? ' · 已压缩' : ''}</figcaption>
    </figure>`).join('');
  capMeta();
}

/** 把文字插入光标处（而不是粗暴覆盖），这样「先打字再粘一段」也顺手 */
function capInsertText(text) {
  const box = $('#cap_text');
  if (!box) return;
  const s = box.selectionStart == null ? box.value.length : box.selectionStart;
  const e = box.selectionEnd == null ? s : box.selectionEnd;
  const glue = box.value && !/\n$/.test(box.value.slice(0, s)) ? '\n' : '';
  const ins = glue + text;
  box.value = box.value.slice(0, s) + ins + box.value.slice(e);
  box.selectionStart = box.selectionEnd = s + ins.length;
  capMeta();
}

/**
 * 整个页面上按 Ctrl/⌘+V 都能收：粘图直接进缩略图，粘文字进输入框。
 * 只在捕捉视图激活、且结果弹窗未打开时接管，避免干扰别处粘贴。
 */
function capOnPaste(ev) {
  if (currentView !== 'capture') return;
  const modal = $('#capModal');
  if (modal && !modal.classList.contains('hidden')) return;
  const dt = ev.clipboardData;
  if (!dt) return;

  const imgs = Array.from(dt.items || [])
    .filter((it) => it.kind === 'file' && /^image\//.test(it.type || ''))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (imgs.length) {
    ev.preventDefault();
    capAddFiles(imgs);
    toast('已加入 ' + imgs.length + ' 张图');
    return;
  }

  // 焦点已经在输入框里：交给浏览器默认插入，不要重复处理
  if (ev.target === $('#cap_text')) return;
  const text = dt.getData('text/plain');
  if (text) { ev.preventDefault(); capInsertText(text); }
}

function bindCapDrop() {
  const zone = $('#capDrop');
  if (!zone) return;
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((n) => zone.addEventListener(n, (e) => { stop(e); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((n) => zone.addEventListener(n, (e) => { stop(e); zone.classList.remove('over'); }));
  zone.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) return capAddFiles(files);
    const text = e.dataTransfer && e.dataTransfer.getData('text/plain');
    if (text) capInsertText(text);
  });
}

// ---- Agent 模板库 ----
// 角色分工参考 AutoGen 的 Assistant/UserProxy 协作、SWE-agent 的「定位→修复→验证」、
// OpenHands 的「规划→执行→复盘」。phase：1 规划 / 2 执行 / 3 把关，用于排出合理链路。
const CAP_AGENT_LIB = [
  {
    key: 'planner', phase: 1, name: '规划者', role: '需求拆解与方案设计',
    model: 'gpt-4o', temperature: 0.3, tags: ['规划', '拆解'],
    description: '把模糊需求拆成可独立验证的步骤，明确边界与验收标准。',
    hits: ['规划', '方案', '设计', '架构', '拆解', '步骤', '流程', '计划', '怎么做', '如何实现', 'plan', 'design'],
    sys: [
      '你是任务规划专家。接到需求后：',
      '1) 用自己的话复述目标与边界，明确指出其中含糊或互相矛盾之处；',
      '2) 拆成 3~7 个可独立验收的步骤，标明依赖顺序；',
      '3) 每步写清「输入 / 产出 / 验收标准」；',
      '4) 单独列出风险点与必须由人确认的决策。',
      '只输出规划，不要写实现细节或代码。',
    ].join('\n'),
  },
  {
    key: 'researcher', phase: 2, name: '检索员', role: '资料搜集与事实核对',
    model: 'gpt-4o', temperature: 0.2, tags: ['检索', '调研'],
    description: '围绕任务搜集必要背景资料，标注来源与不确定性。',
    hits: ['检索', '搜集', '调研', '资料', '文献', '查一下', '对比', '竞品', '市场', 'research', 'survey'],
    sys: [
      '你是资料调研员。要求：',
      '1) 先列出「要回答这个问题，必须知道哪几件事」；',
      '2) 逐条给出你掌握的信息，并标注来源类型（官方文档 / 论文 / 行业实践 / 推测）；',
      '3) 明确区分「确定的事实」与「你的推断」，推断必须写出依据；',
      '4) 找不到可靠信息的，直接说「未找到」，不要编造。',
    ].join('\n'),
  },
  {
    key: 'analyst', phase: 2, name: '分析师', role: '数据分析与洞察提炼',
    model: 'gpt-4o', temperature: 0.3, tags: ['分析', '数据'],
    description: '从数据中提炼结论，给出量化依据与置信度。',
    hits: ['分析', '数据', '指标', '统计', '趋势', '报表', '洞察', '估值', '财报', 'analysis', 'metric'],
    sys: [
      '你是数据分析师。要求：',
      '1) 先说清数据口径与样本范围，指出缺失的关键字段；',
      '2) 给出分析结论，每条结论后附支撑数据；',
      '3) 对每个结论标注置信度（高/中/低）及可能推翻它的条件；',
      '4) 不要用「显著」「大幅」这类无量化依据的词。',
    ].join('\n'),
  },
  {
    key: 'coder', phase: 2, name: '开发工程师', role: '编码实现与调试',
    model: 'gpt-4o', temperature: 0.2, tags: ['编程', '实现'],
    description: '按规划实现代码，附带可运行的验证方式。',
    hits: ['代码', '函数', '接口', '实现', '开发', '重构', '报错', 'bug', '脚本', '数据库', '部署', 'api', 'python', 'javascript', 'sql'],
    sys: [
      '你是资深开发工程师。要求：',
      '1) 先说明改动思路与影响范围，再给代码；',
      '2) 代码需可直接运行，关键处写注释解释「为什么」而非「做了什么」；',
      '3) 说明边界情况与错误处理，不要吞掉异常；',
      '4) 最后给出验证步骤（怎么跑、预期看到什么）。',
    ].join('\n'),
  },
  {
    key: 'writer', phase: 2, name: '写作助手', role: '内容撰写与改写',
    model: 'gpt-4o', temperature: 0.7, tags: ['写作', '文案'],
    description: '按目标读者与用途撰写或改写内容。',
    hits: ['写', '文案', '文章', '标题', '润色', '总结', '摘要', '报告', '邮件', '故事', '演讲稿', '朋友圈', '报告', 'write', 'draft'],
    sys: [
      '你是中文写作顾问。要求：',
      '1) 动笔前先确定读者是谁、看完要做什么，一句话说明；',
      '2) 结构清晰，每段一个意思，不用空洞的排比和套话；',
      '3) 用具体事实和数字代替形容词；',
      '4) 交付完整成稿，不要只给提纲；需要保留的地方用【】标出待确认信息。',
    ].join('\n'),
  },
  {
    key: 'translator', phase: 2, name: '翻译', role: '跨语言转换与本地化',
    model: 'gpt-4o', temperature: 0.3, tags: ['翻译', '本地化'],
    description: '按目标语言习惯翻译，而非逐字直译。',
    hits: ['翻译', '中译英', '英译中', '本地化', 'translate', 'localization'],
    sys: [
      '你是专业译者。要求：',
      '1) 先判断文本类型（技术文档 / 营销文案 / 日常对话），据此选择语气；',
      '2) 按目标语言表达习惯重写，不逐字直译；',
      '3) 专业术语给出译名并保留原文；',
      '4) 歧义处给出两种译法并说明差异。',
    ].join('\n'),
  },
  {
    key: 'reviewer', phase: 3, name: '审查者', role: '质量把关与风险指出',
    model: 'gpt-4o', temperature: 0.2, tags: ['审查', '质控'],
    description: '挑毛病：找出错误、遗漏与风险，不做无原则的夸奖。',
    hits: ['审查', '检查', '评审', '核对', '校对', '质量', '风险', '合规', 'review', 'audit', 'check'],
    sys: [
      '你是严格的质量审查者。要求：',
      '1) 按「事实错误 / 逻辑漏洞 / 遗漏信息 / 表述歧义」分类列出问题；',
      '2) 每条问题给出具体位置、为什么是问题、建议怎么改；',
      '3) 没发现问题时明确说「未发现」，并说明你按什么标准检查的；',
      '4) 不要为了让对方高兴而给无关紧要的赞美。',
    ].join('\n'),
  },
  {
    key: 'tester', phase: 3, name: '测试员', role: '用例设计与边界验证',
    model: 'gpt-4o', temperature: 0.2, tags: ['测试', '验证'],
    description: '设计能真正跑出问题的测试用例，重点覆盖边界与异常。',
    hits: ['测试', '用例', '验证', '边界', '异常', '回归', 'test', 'case', 'qa'],
    sys: [
      '你是测试工程师。要求：',
      '1) 列出正常路径用例，以及边界值、空值、超长、并发等异常用例；',
      '2) 每条用例写明：前置条件 / 操作步骤 / 预期结果；',
      '3) 标出哪些是「必须通过才能上线」的阻断项；',
      '4) 明确指出这段实现里你最怀疑会出问题的位置。',
    ].join('\n'),
  },
];

const CAP_CATEGORIES = [
  { name: '编程开发', keys: ['代码', '函数', '接口', '报错', '重构', '编程', '开发', '数据库', '部署', 'api', 'python', 'javascript', 'sql', 'bug'] },
  { name: '写作', keys: ['写', '文案', '文章', '标题', '润色', '总结', '摘要', '报告', '邮件', '故事'] },
  { name: '数据分析', keys: ['分析', '数据', '指标', '统计', '趋势', '估值', '财报', '洞察'] },
  { name: '设计', keys: ['设计', '界面', '交互', '配色', '原型', '视觉', 'ui', 'ux'] },
  { name: '运维', keys: ['运维', '服务器', '监控', '日志', 'docker', 'k8s', 'ci', '发布'] },
  { name: '学习', keys: ['学习', '课程', '笔记', '讲解', '入门', '原理', '教程'] },
];

const CAP_STOPWORDS = /^(the|and|for|with|you|are|this|that|from|have|will|can|not|use|all|any|but|our|your|its|it|is|to|of|in|on|by|as|at|be|or|an|a|if|do|so|we|my|me|no|up|out|new|one|two|how|what|why|when|which|who|please|make|write|give|need|want)$/;

function capGuessTitle(text) {
  const first = (text.split(/\r?\n/).find((l) => l.trim().length > 0) || '').trim();
  let t = first
    .replace(/^#+\s*/, '')
    .replace(/^[「『【\[(（]/, '')
    .replace(/[」』】\])）]$/, '')
    .replace(/[。！？!?.,，、:：;；]+$/, '')
    .trim();
  if (/^(请|帮我|麻烦|你|我们)/.test(t) && t.length > 24) {
    // 「请你帮我写一个…」这类开头不适合做标题，截到第一个动作词之后
    const m = t.match(/^(?:请|帮我|麻烦)?[^，,。]{0,14}[，,]?\s*(.{2,22})/);
    if (m && m[1]) t = m[1].trim();
  }
  if (t.length > 30) t = t.slice(0, 30) + '…';
  return t || '未命名提示词';
}

function capGuessCategory(text) {
  let best = '', bestScore = 0;
  for (const c of CAP_CATEGORIES) {
    const s = c.keys.reduce((n, k) => n + (text.includes(k) ? 1 : 0), 0);
    if (s > bestScore) { best = c.name; bestScore = s; }
  }
  return best || '通用';
}

function capGuessTags(text) {
  const zhPool = ['提示词', '编程', '写作', '数据分析', '设计', '翻译', '总结', '审查', '规划', '学习', '自动化', '产品', '运营', '汇报', '效率'];
  const zh = zhPool.filter((t) => text.includes(t));
  const en = Array.from(new Set(
    (text.match(/[A-Za-z][A-Za-z0-9+#-]{2,}/g) || [])
      .map((s) => s.toLowerCase())
      .filter((s) => !CAP_STOPWORDS.test(s))
  )).slice(0, 4);
  const out = [...zh.slice(0, 4), ...en];
  return out.slice(0, 6);
}

const capByKey = (k) => CAP_AGENT_LIB.find((t) => t.key === k);

// 分类 → 优先用哪个角色当「执行者」。只命中规划类时靠它补出执行环节。
const CAP_EXEC_BY_CAT = {
  '编程开发': 'coder', '运维': 'coder',
  '写作': 'writer', '设计': 'writer', '学习': 'writer',
  '数据分析': 'analyst',
};

/**
 * 按命中强度挑 1~3 个 Agent，并按 phase 排成「规划 → 执行 → 把关」。
 * 无论命中什么，链路的结构必须完整：不能缺执行环节，也不能缺把关环节 ——
 * 一条没人检查的流水线价值有限，用户要的正是「谁在什么时候检查什么」。
 */
function capPickAgents(text, category) {
  const scored = CAP_AGENT_LIB
    .map((t) => ({ t, score: t.hits.reduce((n, k) => n + (text.includes(k) ? (k.length >= 2 ? 2 : 1) : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  let picked = scored.slice(0, 3).map((x) => x.t);
  if (!picked.length) picked = ['planner', 'writer', 'reviewer'].map(capByKey);

  const exec = capByKey(CAP_EXEC_BY_CAT[category] || 'writer');
  // 只命中规划类 → 补执行者，否则链路空转
  if (picked.length === 1 && picked[0].phase === 1) picked.push(exec);
  // 缺把关环节 → 补上；已经满 3 个就挤掉相关性最低的那个
  if (!picked.some((x) => x.phase === 3)) {
    if (picked.length >= 3) picked = picked.slice(0, 2);
    picked.push(capByKey('reviewer'));
  }
  // 反过来：只有规划和把关也不行，中间得有人干活
  if (!picked.some((x) => x.phase === 2) && picked.length < 3) picked.push(exec);

  return picked.slice().sort((a, b) => a.phase - b.phase);
}

/** 清洗素材：去掉首尾空白和连续空行，但保留换行结构 */
function capCleanText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 离线启发式生成：不依赖任何 API。
 * 正文不改写（离线做不了高质量改写，硬编造反而更差），只做清洗与结构化提取；
 * 想要「提炼版正文」就在设置里配 LLM Key。
 */
function offlineGenerate(text) {
  const clean = capCleanText(text);
  const title = capGuessTitle(clean);
  const category = capGuessCategory(clean);
  const agents = capPickAgents(clean, category);
  const tasks = {
    planner: '拆解目标与步骤，输出可验收的执行计划',
    researcher: '补齐完成任务所需的背景资料与事实',
    analyst: '分析数据并给出带依据的结论',
    coder: '按计划实现代码并给出验证方式',
    writer: '按目标读者撰写成稿',
    translator: '按目标语言习惯完成转换',
    reviewer: '审查产出，列出问题与修改建议',
    tester: '设计用例覆盖边界与异常，标出阻断项',
  };
  return {
    mode: 'offline',
    note: '离线生成：不改写正文，只做结构化提取；配 LLM Key 可得到提炼版正文',
    prompt: {
      title,
      category,
      tags: capGuessTags(clean),
      content: clean,
    },
    agents: agents.map((a) => ({
      name: a.name, role: a.role, description: a.description,
      systemPrompt: a.sys, model: a.model, temperature: a.temperature, tags: a.tags.slice(),
    })),
    orchestration: {
      name: title.replace(/…$/, '') + ' · 执行链路',
      description: '把「' + title + '」拆成 ' + agents.length + ' 个 Agent 依次执行。',
      steps: agents.map((a, i) => ({ agentIndex: i, task: tasks[a.key] || a.role })),
    },
  };
}

/** 从 LLM 回复里抠出 JSON —— 模型常常会裹一层 ```json 或者前后加一句话 */
function capParseLLMJson(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try {
    const o = JSON.parse(s);
    // 模型偶尔回个裸 null / 数字，这类也不当结果
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    // 没按 JSON 回就返回 null（而不是抛错）：调用方据此给一句人话再回退离线，
    // 否则用户看到的会是 "Unexpected token 好 ..." 这种原始报错。
    return null;
  }
}

/** 规范化 LLM 结果：任何缺失字段都补成能用的形态，别让弹窗渲染炸掉 */
function capNormalizeLLM(raw, fallbackText) {
  // 先归一成对象：解析失败时 raw 是 null，这里若不强转，下面的 o.orchestration 会直接抛
  // TypeError，把「回退离线」变成一条内部报错。
  const o = raw && typeof raw === 'object' ? raw : {};
  const p = o.prompt && typeof o.prompt === 'object' ? o.prompt : {};
  // 规范形状是 { prompt:{…}, agents:[…], orchestration:{…} }，但有的模型会把 prompt 里的
  // 字段平铺到顶层。两种都认 —— 否则 title/content 会静默回落到离线猜测，把模型写好的
  // 正文整段丢掉（这是真踩过的坑，不是防御性冗余）。
  const pick = (k) => {
    const v = p[k];
    if (v !== undefined && v !== null && v !== '') return v;
    return o ? o[k] : undefined;
  };
  const agents = (Array.isArray(o && o.agents) ? o.agents : [])
    .filter((a) => a && (a.name || a.systemPrompt))
    .slice(0, 3)
    .map((a) => ({
      name: String(a.name || '未命名 Agent'),
      role: String(a.role || ''),
      description: String(a.description || ''),
      systemPrompt: String(a.systemPrompt || ''),
      model: String(a.model || ''),
      temperature: Number.isFinite(Number(a.temperature)) ? Number(a.temperature) : 0.3,
      tags: Array.isArray(a.tags) ? a.tags.map(String).slice(0, 6) : [],
    }));

  const off = offlineGenerate(fallbackText);
  const useAgents = agents.length ? agents : off.agents;

  let steps = (o && o.orchestration && Array.isArray(o.orchestration.steps) ? o.orchestration.steps : [])
    .map((s) => ({ agentIndex: Number(s && s.agentIndex), task: String((s && s.task) || '') }))
    .filter((s) => Number.isInteger(s.agentIndex) && s.agentIndex >= 0 && s.agentIndex < useAgents.length);
  if (!steps.length) steps = useAgents.map((a, i) => ({ agentIndex: i, task: a.role || '' }));

  const llmTags = pick('tags');
  return {
    mode: 'llm',
    note: '',
    prompt: {
      title: String(pick('title') || off.prompt.title),
      category: String(pick('category') || off.prompt.category),
      tags: Array.isArray(llmTags) && llmTags.length ? llmTags.map(String).slice(0, 8) : off.prompt.tags,
      content: String(pick('content') || fallbackText || '').trim() || off.prompt.content,
    },
    agents: useAgents,
    orchestration: {
      name: String((o.orchestration && o.orchestration.name) || (off.orchestration.name)),
      description: String((o.orchestration && o.orchestration.description) || off.orchestration.description),
      steps,
    },
  };
}

async function llmGenerate(text, images) {
  const c = cfgDefaults();
  const sys = [
    '你是提示词工程与多 Agent 编排专家。用户会给你一段素材（可能还有截图）。',
    '请把素材整理成一条规范、可直接使用的提示词，并设计完成它所需的多 Agent 编排。',
    '',
    '只输出一个 JSON 对象，不要解释、不要 markdown 代码块。字段：',
    '{',
    '  "prompt": { "title": "简短标题（≤20 字）",',
    '              "category": "分类，如 编程开发/写作/数据分析/设计/运维/学习",',
    '              "tags": ["3~6 个标签"],',
    '              "content": "可直接使用的完整提示词正文" },',
    '  "agents": [{"name":"","role":"","description":"","systemPrompt":"","model":"","temperature":0.3,"tags":[]}],',
    '  "orchestration": {"name":"","description":"","steps":[{"agentIndex":0,"task":"这一步做什么"}]}',
    '}',
    '',
    '硬性要求：',
    '1) agents 1~3 个，按实际执行顺序排列：第一个负责规划，最后一个负责审查；不要凑数。',
    '2) 每个 systemPrompt 必须具体到可直接投喂，写清角色、约束、输出格式，不要空话。',
    '3) steps 的 agentIndex 是 agents 数组下标；每一步的 task 写清该 Agent 在这条链路里具体做什么。',
    '4) content 是给最终使用者复制粘贴的完整提示词，不要写「见上文」这类引用。',
  ].join('\n');

  const userContent = (images && images.length)
    ? [
        { type: 'text', text: text || '（只提供了截图，请依据截图内容理解需求并生成。）' },
        ...images.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } })),
      ]
    : (text || '');

  const r = await fetch(c.llmBase + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.llmKey },
    body: JSON.stringify({
      model: c.llmModel,
      temperature: 0.4,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }],
    }),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + raw.slice(0, 160));
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { throw new Error('返回不是 JSON'); }
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  const content = msg && msg.content;
  if (!content) throw new Error('模型返回为空');
  const parsed = capParseLLMJson(content);
  if (!parsed) throw new Error('模型返回的不是 JSON');
  return capNormalizeLLM(parsed, text);
}

async function captureGenerate() {
  if (capBusy) return;
  const text = (($('#cap_text') || {}).value || '').trim();
  if (!text && !capImages.length) return toast('先粘贴一些文字或截图', true);

  capBusy = true;
  const btn = $('#cap_genBtn');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '⏳ 生成中…';
  setCapStatus('');

  try {
    const mode = capMode();
    const wantLLM = mode === 'auto' && llmReady();
    let res;
    if (wantLLM) {
      setCapStatus('正在调用大模型…');
      try {
        res = await llmGenerate(text, capImages);
      } catch (e) {
        res = offlineGenerate(text);
        res.note = '大模型调用失败，已回退离线生成（' + e.message + '）';
        setCapStatus('大模型调用失败，已回退离线生成', 'warn');
      }
    } else {
      res = offlineGenerate(text);
      if (mode === 'auto') setCapStatus('未配置 LLM Key，已走离线生成（可在设置里填）', 'warn');
    }
    capResult = res;
    renderCapResult();
    $('#capModal').classList.remove('hidden');
  } finally {
    capBusy = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}

function renderCapResult() {
  const box = $('#capResult');
  if (!box) return;
  const r = capResult;
  if (!r) { box.innerHTML = ''; return; }
  const badge = r.mode === 'llm' ? '🪄 大模型生成' : '⚙ 离线生成';
  box.innerHTML = [
    '<p class="hint">' + badge + (r.note ? ' · ' + escapeHtml(r.note) : '') + '</p>',

    '<h4 class="cap-h">📝 提示词</h4>',
    '<div class="cap-block">',
    '  <div class="cap-kv"><b>' + escapeHtml(r.prompt.title) + '</b></div>',
    '  <div class="cap-kv">分类：' + escapeHtml(r.prompt.category || '未分类') + '</div>',
    '  <div class="cap-kv">标签：' + ((r.prompt.tags || []).map((t) => '<span class="tag">' + escapeHtml(t) + '</span>').join(' ') || '—') + '</div>',
    '  <pre class="cap-pre">' + escapeHtml(r.prompt.content) + '</pre>',
    '</div>',

    '<h4 class="cap-h">🤖 Agent（' + r.agents.length + '）</h4>',
    r.agents.map((a, i) => [
      '<div class="cap-block">',
      '  <div class="cap-kv"><b>' + (i + 1) + '. ' + escapeHtml(a.name) + '</b>' + (a.role ? ' · ' + escapeHtml(a.role) : '') + '</div>',
      '  <div class="cap-kv cap-dim">模型 ' + escapeHtml(a.model || '—') + ' · 温度 ' + escapeHtml(String(a.temperature)) + '</div>',
      a.description ? '  <div class="cap-kv cap-dim">' + escapeHtml(a.description) + '</div>' : '',
      '  <pre class="cap-pre">' + escapeHtml(a.systemPrompt) + '</pre>',
      '</div>',
    ].join('')).join(''),

    '<h4 class="cap-h">🔗 编排链路</h4>',
    '<div class="cap-block">',
    '  <div class="cap-kv"><b>' + escapeHtml(r.orchestration.name) + '</b></div>',
    r.orchestration.description ? '  <div class="cap-kv cap-dim">' + escapeHtml(r.orchestration.description) + '</div>' : '',
    '  <div class="chain">',
    (r.orchestration.steps || []).map((s, i) => [
      i > 0 ? '    <div class="chain-arrow">↓</div>' : '',
      '    <div class="chain-step">',
      '      <span class="chain-idx">' + (i + 1) + '</span>',
      '      <span class="chain-agent">' + escapeHtml(r.agents[s.agentIndex] ? r.agents[s.agentIndex].name : '—') + '</span>',
      '      <span class="chain-task">' + escapeHtml(s.task || '') + '</span>',
      '    </div>',
    ].join('')).join(''),
    '  </div>',
    '</div>',
  ].join('\n');
}

/** 把生成结果整体落库：1 提示词 + N Agent + 1 编排，一次同步 */
async function saveCapResult() {
  const r = capResult;
  if (!r) return;
  const now = Date.now();
  const agentCount = r.agents.length;

  vault.prompts.unshift({
    id: uid(), title: r.prompt.title, content: r.prompt.content,
    category: r.prompt.category, tags: (r.prompt.tags || []).slice(),
    createdAt: now, updatedAt: now,
  });

  const idMap = [];
  r.agents.forEach((a) => {
    const id = uid();
    idMap.push(id);
    vault.agents.unshift({
      id, name: a.name, role: a.role, description: a.description,
      systemPrompt: a.systemPrompt, model: a.model, temperature: a.temperature,
      tags: (a.tags || []).slice(), createdAt: now, updatedAt: now,
    });
  });

  vault.orchestrations.unshift({
    id: uid(), name: r.orchestration.name, description: r.orchestration.description,
    steps: (r.orchestration.steps || [])
      .filter((s) => idMap[s.agentIndex])
      .map((s) => ({ agentId: idMap[s.agentIndex], task: s.task })),
    createdAt: now, updatedAt: now,
  });

  closeModal('capModal');
  renderAll();
  switchView('prompts');
  capResult = null;
  // 先等同步走完：saveVault 自己的提示会被随后这条完整说明覆盖，
  // 所以顺序不能反，否则用户只看到「已同步」而不知道到底生成了几样东西。
  const res = await saveVault('从捕捉生成');
  toast('已生成 1 条提示词、' + agentCount + ' 个 Agent、1 条编排'
    + (res && res.saved === 'github' ? '，已同步到云端' : '（仅存本机）'));
}

function capCopyAll() {
  const r = capResult;
  if (!r) return;
  const L = [];
  L.push('# 提示词：' + r.prompt.title);
  L.push('分类：' + (r.prompt.category || '未分类'));
  L.push('标签：' + (r.prompt.tags || []).join(', '));
  L.push('');
  L.push(r.prompt.content);
  r.agents.forEach((a, i) => {
    L.push('');
    L.push('---');
    L.push('# Agent ' + (i + 1) + '：' + a.name + (a.role ? '（' + a.role + '）' : ''));
    L.push('模型：' + (a.model || '—') + ' / 温度：' + a.temperature);
    L.push('');
    L.push(a.systemPrompt);
  });
  L.push('');
  L.push('---');
  L.push('# 编排：' + r.orchestration.name);
  (r.orchestration.steps || []).forEach((s, i) => {
    const nm = r.agents[s.agentIndex] ? r.agents[s.agentIndex].name : '—';
    L.push((i + 1) + '. [' + nm + '] ' + (s.task || ''));
  });
  copyText(L.join('\n'), '已复制提示词 + Agent + 编排');
}

function capClear() {
  const box = $('#cap_text');
  if (box) box.value = '';
  capImages = [];
  renderCapThumbs();
  setCapStatus('');
}

function capMode() {
  const el = $('#cap_mode');
  return el ? el.value : 'auto';
}

function bindCapture() {
  const paste = $('#cap_text');
  if (paste) paste.addEventListener('input', capMeta);
  const fileBtn = $('#cap_fileBtn');
  const file = $('#cap_file');
  if (fileBtn && file) {
    fileBtn.addEventListener('click', () => file.click());
    file.addEventListener('change', () => { capAddFiles(file.files); file.value = ''; });
  }
  const clear = $('#cap_clearBtn');
  if (clear) clear.addEventListener('click', capClear);
  const gen = $('#cap_genBtn');
  if (gen) gen.addEventListener('click', captureGenerate);
  const save = $('#capSaveBtn');
  if (save) save.addEventListener('click', saveCapResult);
  const copy = $('#capCopyBtn');
  if (copy) copy.addEventListener('click', capCopyAll);

  // 缩略图上的删除按钮（事件委托，缩略图是动态渲染的）
  const thumbs = $('#cap_thumbs');
  if (thumbs) {
    thumbs.addEventListener('click', (ev) => {
      const id = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-capdel');
      if (!id) return;
      capImages = capImages.filter((x) => x.id !== id);
      renderCapThumbs();
    });
  }

  bindCapDrop();
  document.addEventListener('paste', capOnPaste);
  capMeta();
}

// ---------------- 视图切换 ----------------
function switchView(view) {
  currentView = view;
  $$('.vtab').forEach((b) => b.classList.toggle('active', b.getAttribute('data-view') === view));
  ['capture', 'prompts', 'agents', 'orchestrations'].forEach((v) => {
    const el = $('#view-' + v);
    if (el) el.classList.toggle('hidden', v !== view);
  });
}

function renderAll() {
  renderTagFilter();
  renderPrompts();
  renderAgents();
  renderOrchestrations();
}

// ---------------- 提示词 ----------------
function allTags() {
  const set = new Set();
  vault.prompts.forEach((p) => (p.tags || []).forEach((t) => set.add(t)));
  return Array.from(set).sort();
}

function renderTagFilter() {
  const wrap = $('#tagFilter');
  const tags = allTags();
  if (!tags.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML =
    `<span class="tag-pill ${activeTag ? '' : 'active'}" data-tag="">全部</span>` +
    tags.map((t) => `<span class="tag-pill ${activeTag === t ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('');
}

function visiblePrompts() {
  const q = searchPrompts.toLowerCase();
  return vault.prompts.filter((p) => {
    if (activeTag && !(p.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    return (
      (p.title || '').toLowerCase().includes(q) ||
      (p.content || '').toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q) ||
      (p.tags || []).join(' ').toLowerCase().includes(q)
    );
  });
}

function renderPrompts() {
  const list = visiblePrompts();
  const grid = $('#promptGrid');
  grid.innerHTML = list.map((p) => `
    <article class="card">
      <div class="card-head">
        <div style="flex:1">
          <h3 class="card-title">${escapeHtml(p.title || '未命名')}</h3>
          <p class="card-sub">${escapeHtml(p.category || '未分类')} · ${new Date(p.updatedAt || p.createdAt || Date.now()).toLocaleDateString()}</p>
        </div>
      </div>
      <div class="card-body">${escapeHtml(p.content || '')}</div>
      <div class="card-tags">${(p.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      <div class="card-foot">
        <button class="btn sm" data-pcopy="${p.id}">复制</button>
        <button class="btn sm" data-pedit="${p.id}">编辑</button>
        <button class="btn sm" data-pdel="${p.id}">删除</button>
      </div>
    </article>`).join('');
  $('#promptEmpty').classList.toggle('hidden', list.length > 0);
}

function openPromptModal(id) {
  editingPromptId = id || null;
  const p = id ? vault.prompts.find((x) => x.id === id) : null;
  $('#promptModalTitle').textContent = p ? '编辑提示词' : '新建提示词';
  $('#p_title').value = p ? p.title || '' : '';
  $('#p_category').value = p ? p.category || '' : '';
  $('#p_tags').value = p ? (p.tags || []).join(', ') : '';
  $('#p_content').value = p ? p.content || '' : '';
  $('#promptModal').classList.remove('hidden');
  setTimeout(() => $('#p_title').focus(), 60);
}

function submitPrompt() {
  const title = $('#p_title').value.trim();
  const content = $('#p_content').value.trim();
  if (!title && !content) return toast('标题和内容至少填一个', true);
  const now = Date.now();
  if (editingPromptId) {
    const p = vault.prompts.find((x) => x.id === editingPromptId);
    Object.assign(p, {
      title: title || '未命名',
      content,
      category: $('#p_category').value.trim(),
      tags: parseTags($('#p_tags').value),
      updatedAt: now,
    });
  } else {
    vault.prompts.unshift({
      id: uid(),
      title: title || '未命名',
      content,
      category: $('#p_category').value.trim(),
      tags: parseTags($('#p_tags').value),
      createdAt: now,
      updatedAt: now,
    });
  }
  closeModal('promptModal');
  renderPrompts();
  renderTagFilter();
  saveVault(editingPromptId ? '更新提示词' : '新增提示词');
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || '已复制到剪贴板');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(okMsg || '已复制到剪贴板'); }
    catch (e2) { toast('复制失败，请手动选择', true); }
    document.body.removeChild(ta);
  }
}

// ---------------- Agents ----------------
function visibleAgents() {
  const q = searchAgents.toLowerCase();
  if (!q) return vault.agents;
  return vault.agents.filter((a) =>
    (a.name || '').toLowerCase().includes(q) ||
    (a.role || '').toLowerCase().includes(q) ||
    (a.description || '').toLowerCase().includes(q) ||
    (a.tags || []).join(' ').toLowerCase().includes(q)
  );
}

function renderAgents() {
  const list = visibleAgents();
  const grid = $('#agentGrid');
  grid.innerHTML = list.map((a) => `
    <article class="card ${selectedAgents.has(a.id) ? 'selected' : ''}">
      <div class="card-head">
        <input type="checkbox" class="card-check" data-acheck="${a.id}" ${selectedAgents.has(a.id) ? 'checked' : ''} />
        <div style="flex:1">
          <h3 class="card-title">${escapeHtml(a.name || '未命名 Agent')}</h3>
          <p class="card-sub">${escapeHtml(a.role || '未设置角色')}${a.model ? ' · ' + escapeHtml(a.model) : ''}</p>
        </div>
      </div>
      ${a.description ? `<p class="card-sub" style="margin-bottom:8px">${escapeHtml(a.description)}</p>` : ''}
      <div class="card-body">${escapeHtml(a.systemPrompt || '')}</div>
      <div class="card-tags">${(a.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      <div class="card-foot">
        <button class="btn sm" data-acopy="${a.id}">复制</button>
        <button class="btn sm" data-aedit="${a.id}">编辑</button>
        <button class="btn sm" data-adel="${a.id}">删除</button>
      </div>
    </article>`).join('');
  $('#agentEmpty').classList.toggle('hidden', list.length > 0);
  // 清理已删除 agent 的选中态
  const ids = new Set(vault.agents.map((a) => a.id));
  selectedAgents.forEach((id) => { if (!ids.has(id)) selectedAgents.delete(id); });
  renderSelBar();
}

function renderSelBar() {
  const bar = $('#selBar');
  const n = selectedAgents.size;
  bar.classList.toggle('hidden', n === 0);
  $('#selCount').textContent = String(n);
}

/**
 * 只把选中态同步到已渲染的卡片上，不重建 grid。
 * 勾选时整体重渲染会丢滚动位置、打断卡片过渡动画，且是 O(n) DOM 重建。
 */
function syncAgentSelection() {
  $$('#agentGrid [data-acheck]').forEach((chk) => {
    const on = selectedAgents.has(chk.getAttribute('data-acheck'));
    chk.checked = on;
    const card = chk.closest('.card');
    if (card) card.classList.toggle('selected', on);
  });
  renderSelBar();
}

function openAgentModal(id) {
  editingAgentId = id || null;
  const a = id ? vault.agents.find((x) => x.id === id) : null;
  $('#agentModalTitle').textContent = a ? '编辑 Agent' : '新建 Agent';
  $('#a_name').value = a ? a.name || '' : '';
  $('#a_role').value = a ? a.role || '' : '';
  $('#a_model').value = a ? a.model || '' : '';
  $('#a_tags').value = a ? (a.tags || []).join(', ') : '';
  $('#a_desc').value = a ? a.description || '' : '';
  $('#a_system').value = a ? a.systemPrompt || '' : '';
  $('#agentModal').classList.remove('hidden');
  setTimeout(() => $('#a_name').focus(), 60);
}

function submitAgent() {
  const name = $('#a_name').value.trim();
  if (!name) return toast('请填写 Agent 名称', true);
  const now = Date.now();
  if (editingAgentId) {
    const a = vault.agents.find((x) => x.id === editingAgentId);
    Object.assign(a, {
      name,
      role: $('#a_role').value.trim(),
      model: $('#a_model').value.trim(),
      tags: parseTags($('#a_tags').value),
      description: $('#a_desc').value.trim(),
      systemPrompt: $('#a_system').value.trim(),
      updatedAt: now,
    });
  } else {
    vault.agents.unshift({
      id: uid(),
      name,
      role: $('#a_role').value.trim(),
      model: $('#a_model').value.trim(),
      tags: parseTags($('#a_tags').value),
      description: $('#a_desc').value.trim(),
      systemPrompt: $('#a_system').value.trim(),
      createdAt: now,
      updatedAt: now,
    });
  }
  closeModal('agentModal');
  renderAgents();
  saveVault(editingAgentId ? '更新 Agent' : '新增 Agent');
}

// ---------------- 编排 ----------------
function agentName(id) {
  const a = vault.agents.find((x) => x.id === id);
  return a ? a.name : '（已删除的 Agent）';
}

function renderOrchestrations() {
  const grid = $('#orchGrid');
  grid.innerHTML = vault.orchestrations.map((o) => `
    <article class="card">
      <div class="card-head">
        <div style="flex:1">
          <h3 class="card-title">${escapeHtml(o.name || '未命名编排')}</h3>
          <p class="card-sub">${escapeHtml(o.description || '')} · ${(o.steps || []).length} 步</p>
        </div>
      </div>
      <div class="chain">
        ${(o.steps || []).map((s, i) => `
          ${i > 0 ? '<div class="chain-arrow">↓</div>' : ''}
          <div class="chain-step">
            <span class="chain-idx">${i + 1}</span>
            <span class="chain-agent">${escapeHtml(agentName(s.agentId))}</span>
            <span class="chain-task">${escapeHtml(s.task || '')}</span>
          </div>`).join('')}
      </div>
      <div class="card-foot">
        <button class="btn sm" data-oskill="${o.id}">📦 Skill 包</button>
        <button class="btn sm" data-ocopy="${o.id}">复制</button>
        <button class="btn sm" data-oedit="${o.id}">编辑</button>
        <button class="btn sm" data-odel="${o.id}">删除</button>
      </div>
    </article>`).join('');
  $('#orchEmpty').classList.toggle('hidden', vault.orchestrations.length > 0);
}

function openOrchModal(id) {
  editingOrchId = id || null;
  const o = id ? vault.orchestrations.find((x) => x.id === id) : null;
  $('#orchModalTitle').textContent = o ? '编辑编排' : '新建编排';
  $('#o_name').value = o ? o.name || '' : '';
  $('#o_desc').value = o ? o.description || '' : '';
  $('#o_steps').dataset.steps = JSON.stringify(o ? o.steps || [] : []);
  renderSteps();
  $('#orchModal').classList.remove('hidden');
  setTimeout(() => $('#o_name').focus(), 60);
}

function getSteps() {
  try { return JSON.parse($('#o_steps').dataset.steps || '[]'); } catch (e) { return []; }
}
function setSteps(steps) { $('#o_steps').dataset.steps = JSON.stringify(steps); }

function renderSteps() {
  const steps = getSteps();
  const opts = (sel) => vault.agents.map((a) =>
    `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
  $('#o_steps').innerHTML = steps.length
    ? steps.map((s, i) => `
      <div class="step-row">
        <span class="step-idx">${i + 1}</span>
        <select class="input" data-sidx="${i}">
          <option value="">— 选择 Agent —</option>
          ${opts(s.agentId)}
        </select>
        <input class="input" type="text" data-tidx="${i}" value="${escapeHtml(s.task || '')}" placeholder="这一步要做什么" />
        <button class="step-del" data-sdel="${i}" title="删除该步骤">✕</button>
      </div>`).join('')
    : '<p class="hint">还没有步骤，点下方「+ 添加步骤」开始搭建链路。</p>';
}

function submitOrch() {
  const name = $('#o_name').value.trim();
  if (!name) return toast('请填写编排名称', true);
  const steps = getSteps().filter((s) => s.agentId);
  if (!steps.length) return toast('至少添加一个有效步骤', true);
  const now = Date.now();
  if (editingOrchId) {
    const o = vault.orchestrations.find((x) => x.id === editingOrchId);
    Object.assign(o, { name, description: $('#o_desc').value.trim(), steps, updatedAt: now });
  } else {
    vault.orchestrations.unshift({
      id: uid(), name, description: $('#o_desc').value.trim(), steps, createdAt: now, updatedAt: now,
    });
  }
  closeModal('orchModal');
  renderOrchestrations();
  saveVault(editingOrchId ? '更新编排' : '新增编排');
}

// ---------------- 多选导出（含编排链路） ----------------
function selectedAgentList() {
  return vault.agents.filter((a) => selectedAgents.has(a.id));
}

/** 与所选 Agent 相关的编排（只要有一个步骤命中即算） */
function relatedOrchestrations(agentIds) {
  const set = new Set(agentIds);
  return vault.orchestrations.filter((o) => (o.steps || []).some((s) => set.has(s.agentId)));
}

function assembleAgentsText() {
  const agents = selectedAgentList();
  const orchs = relatedOrchestrations(agents.map((a) => a.id));
  const L = [];
  L.push('='.repeat(60));
  L.push('PromptVault · Agent 导出');
  L.push('导出时间: ' + new Date().toLocaleString());
  L.push(`包含 Agent: ${agents.length} 个 | 关联编排: ${orchs.length} 条`);
  L.push('='.repeat(60));
  L.push('');
  agents.forEach((a, i) => {
    L.push('-'.repeat(60));
    L.push(`【Agent ${i + 1}】${a.name}`);
    L.push('-'.repeat(60));
    if (a.role) L.push('角色: ' + a.role);
    if (a.model) L.push('模型: ' + a.model);
    if (a.description) L.push('职责: ' + a.description);
    if ((a.tags || []).length) L.push('标签: ' + a.tags.join(', '));
    L.push('');
    L.push('[系统提示词]');
    L.push(a.systemPrompt || '(未填写)');
    L.push('');
  });
  if (orchs.length) {
    L.push('='.repeat(60));
    L.push('关联编排链路');
    L.push('='.repeat(60));
    orchs.forEach((o, i) => {
      L.push('');
      L.push(`【编排 ${i + 1}】${o.name}${o.description ? ' — ' + o.description : ''}`);
      (o.steps || []).forEach((s, j) => {
        const mark = selectedAgents.has(s.agentId) ? '★ ' : '  ';
        L.push(`  ${j + 1}. ${mark}${agentName(s.agentId)}${s.task ? ' —— ' + s.task : ''}`);
      });
    });
    L.push('');
    L.push('（★ 表示该步骤的 Agent 在本次导出范围内）');
  }
  return L.join('\n');
}

function buildAgentsJson() {
  const agents = selectedAgentList();
  const orchs = relatedOrchestrations(agents.map((a) => a.id));
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    agents: agents.map((a) => ({
      id: a.id, name: a.name, role: a.role || '', model: a.model || '',
      description: a.description || '', tags: a.tags || [], systemPrompt: a.systemPrompt || '',
    })),
    orchestrations: orchs.map((o) => ({
      id: o.id, name: o.name, description: o.description || '',
      steps: (o.steps || []).map((s, i) => ({
        index: i + 1, agentId: s.agentId, agent: agentName(s.agentId),
        task: s.task || '', selected: selectedAgents.has(s.agentId),
      })),
    })),
  };
}

/** 可直接喂给 OpenAI 兼容 API 的 messages 结构 */
function buildAgentsApiJson() {
  const agents = selectedAgentList();
  const orchs = relatedOrchestrations(agents.map((a) => a.id));
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const orchestrations = orchs.map((o) => {
    const messages = [];
    const emitted = new Set();
    (o.steps || []).forEach((s) => {
      const a = agentMap.get(s.agentId) || vault.agents.find((x) => x.id === s.agentId);
      if (a && !emitted.has(a.id) && a.systemPrompt) {
        messages.push({ role: 'system', name: a.name, content: a.systemPrompt });
        emitted.add(a.id);
      }
      if (s.task) messages.push({ role: 'user', name: a ? a.name : 'unknown', content: s.task });
    });
    return {
      name: o.name,
      description: o.description || '',
      steps: (o.steps || []).map((s, i) => ({
        index: i + 1, agent: agentName(s.agentId), task: s.task || '',
        selected: selectedAgents.has(s.agentId),
      })),
      messages,
    };
  });

  return {
    model: agents[0] && agents[0].model ? agents[0].model : 'gpt-4o',
    exportedAt: new Date().toISOString(),
    agents: agents.map((a) => ({
      name: a.name, role: a.role || '', model: a.model || '',
      tags: a.tags || [], systemPrompt: a.systemPrompt || '',
      systemMessage: { role: 'system', content: a.systemPrompt || '' },
    })),
    orchestrations,
  };
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSelected(format) {
  if (!selectedAgents.size) return toast('请先选择 Agent', true);
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'copy') return copyText(assembleAgentsText(), `已复制 ${selectedAgents.size} 个 Agent`);
  if (format === 'txt') { download(`agents-${stamp}.txt`, assembleAgentsText()); toast('已导出 TXT'); }
  if (format === 'json') { download(`agents-${stamp}.json`, JSON.stringify(buildAgentsJson(), null, 2), 'application/json'); toast('已导出 JSON'); }
  if (format === 'api') { download(`agents-api-${stamp}.json`, JSON.stringify(buildAgentsApiJson(), null, 2), 'application/json'); toast('已导出 API JSON（含编排 messages）'); }
}

// ---------------- Skill 包导出（对齐 skill-creator 规范） ----------------
let skillScope = { agents: [], orchestrations: [] };
let skillPreviewTimer = null;

function slugifyAscii(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 把编排链路引用到但未选中的 Agent 一并纳入，保证技能包自包含 */
function completeAgents(agents, orchs) {
  const map = new Map(agents.map((a) => [a.id, a]));
  orchs.forEach((o) => (o.steps || []).forEach((s) => {
    if (!map.has(s.agentId)) {
      const a = vault.agents.find((x) => x.id === s.agentId);
      if (a) map.set(a.id, a);
    }
  }));
  return Array.from(map.values());
}

function openSkillModal(agents, orchestrations, suggestedName) {
  const full = completeAgents(agents, orchestrations);
  skillScope = { agents: full, orchestrations };
  const base = suggestedName || (orchestrations[0] && orchestrations[0].name) ||
    (full[0] && full[0].name) || '';
  let slug = slugifyAscii(base) || slugifyAscii(full.map((a) => a.name).join(' '));
  // 中文编排/角色名会被 slug 清空：回退到内容稳定哈希，
  // 保证「同一条编排每次导出同名、不同编排不重名」（skill 规范只允许 a-z0-9-）
  if (!slug) slug = 'magent-' + PV.shortHash(base + '|' + full.map((a) => a.name).join(','));
  if (slug.length > 64) slug = slug.slice(0, 64).replace(/-+$/, '');
  $('#sk_name').value = slug;
  $('#sk_desc').value = (orchestrations[0] && orchestrations[0].description) ||
    ('多 Agent 协作编排：' + full.map((a) => a.name).join(' → '));
  $('#sk_files').innerHTML = '';
  $('#skillModal').classList.remove('hidden');
  refreshSkillPreview();
  setTimeout(() => $('#sk_name').focus(), 60);
}

async function refreshSkillPreview() {
  clearTimeout(skillPreviewTimer);
  skillPreviewTimer = setTimeout(async () => {
    const st = $('#sk_summary');
    try {
      const r = await api('/api/export/skill', {
        method: 'POST',
        body: {
          skillName: $('#sk_name').value.trim(),
          description: $('#sk_desc').value.trim(),
          agents: skillScope.agents,
          orchestrations: skillScope.orchestrations,
          dryRun: true,
        },
      });
      if (r.agentCount === 0) {
        st.textContent = `⚠️ 合法包名「${r.name}」，但本次没有匹配到任何 Agent —— 该编排引用的 Agent 可能已被删除，包内将只有 SKILL.md 与 references/。`;
        st.className = 'settings-status err';
      } else {
        st.textContent = `✅ 合法包名「${r.name}」· ${r.agentCount} 个 Agent · ${r.orchestrationCount} 条编排 · ${r.files.length} 个文件`;
        st.className = 'settings-status ok';
      }
      $('#sk_files').innerHTML = r.files.map((f) =>
        `<div class="file-line"><span class="file-path">${escapeHtml(f.name)}</span><span class="file-size">${(f.bytes / 1024).toFixed(1)} KB</span></div>`).join('');
    } catch (e) {
      st.textContent = '❌ ' + e.message;
      st.className = 'settings-status err';
      $('#sk_files').innerHTML = '';
    }
  }, 240);
}

async function submitSkill() {
  if (!skillScope.agents.length && !skillScope.orchestrations.length) return toast('没有可打包的内容', true);
  const btn = $('#skSaveBtn');
  btn.disabled = true;
  try {
    const built = localExportSkill({
      skillName: $('#sk_name').value.trim(),
      description: $('#sk_desc').value.trim(),
      agents: skillScope.agents,
      orchestrations: skillScope.orchestrations,
    });
    const bytes = await PV.makeZip(built.entries);
    const fname = built.name + '.skill';
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出 ' + fname);
    closeModal('skillModal');
  } catch (e) {
    toast('打包失败: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 设置 ----------------
async function openSettings() {
  try {
    const c = await api('/api/config');
    $('#s_token').value = '';
    $('#s_apiBase').value = c.apiBase || '';
    $('#s_accessCode').value = '';
    $('#s_accessCode').placeholder = c.hasAccessCode ? '已保存（留空则不变）' : '留空 = 代理未设访问码';
    if (c.isProxy) {
      // 代理模式：owner/repo/文件名/分支由 Worker 决定，本地不让改，免得和钉死的仓库对不上
      $('#s_token').placeholder = '走代理中，无需 Token';
      $('#s_owner').value = c.owner || '';
      $('#s_repo').value = c.repo || '';
      $('#s_file').value = c.file || '';
      $('#s_branch').value = c.branch || '';
    } else {
      $('#s_token').placeholder = c.hasToken ? `已保存 ${c.tokenMasked}（留空则不变）` : 'ghp_…';
      $('#s_owner').value = c.owner || '';
      $('#s_repo').value = c.repo || '';
      $('#s_file').value = c.file || 'prompts.json';
      $('#s_branch').value = c.branch || 'main';
    }
    ['s_owner', 's_repo', 's_file', 's_branch'].forEach((id) => { $('#' + id).disabled = !!c.isProxy; });
    $('#s_private').checked = c.private !== false;
    // LLM 配置是纯前端项（不参与凭据通道），Key 只回显「已保存」不回明文
    const lc = cfgDefaults();
    $('#s_llmBase').value = lc.llmBase;
    $('#s_llmModel').value = lc.llmModel;
    $('#s_llmKey').value = '';
    $('#s_llmKey').placeholder = lc.llmKey ? '已保存（留空则不变）' : '留空 = 只用离线生成';
    setSettingsStatus('');
  } catch (e) { /* ignore */ }
  $('#settingsModal').classList.remove('hidden');
}

async function submitSettings() {
  const apiBase = $('#s_apiBase').value.trim();
  const body = {
    apiBase,
    accessCode: $('#s_accessCode').value.trim(),
    token: $('#s_token').value.trim(),
    owner: apiBase ? '' : $('#s_owner').value.trim(),
    repo: apiBase ? '' : $('#s_repo').value.trim(),
    file: apiBase ? '' : $('#s_file').value.trim(),
    branch: apiBase ? '' : $('#s_branch').value.trim(),
    private: $('#s_private').checked,
    llmBase: $('#s_llmBase').value.trim(),
    llmKey: $('#s_llmKey').value.trim(),
    llmModel: $('#s_llmModel').value.trim(),
  };
  if (!body.repo && !apiBase) return toast('请填写仓库名（或填代理地址）', true);
  setSettingsStatus(apiBase ? '正在通过代理校验…' : '正在校验并创建/连接仓库…');
  $('#settingsSaveBtn').disabled = true;
  try {
    const r = await api('/api/config', { method: 'POST', body });
    setSettingsStatus(`✅ 已连接 ${r.repo}${r.proxy ? '（代理模式，浏览器不含凭据）' : ''}${r.created ? '（已新建仓库）' : ''}`, 'ok');
    toast(r.proxy ? '已通过代理连接' : 'GitHub 已配置');
    await loadVault(true);
    setTimeout(() => closeModal('settingsModal'), 500);
  } catch (e) {
    setSettingsStatus('❌ ' + e.message, 'err');
  } finally {
    $('#settingsSaveBtn').disabled = false;
  }
}

/** 生成并复制「一键链接」：存书签、或发给同组的人，打开一次即可用 */
async function showAutoLink() {
  const link = buildAutoLink();
  if (!link) return toast('请先保存配置，再生成链接', true);
  await copyText(link, '一键链接已复制');
  setSettingsStatus(
    isProxy(cfgDefaults())
      ? '✅ 代理模式：这条链接里只有代理地址和访问码，不含 GitHub Token。直接发给同组的人即可。'
      : '⚠️ 这条链接等价于你的 Token：只给可信的人，勿公开、勿贴进公开场合。',
    isProxy(cfgDefaults()) ? 'ok' : 'warn'
  );
}

async function testConnection() {
  setSettingsStatus('正在测试…');
  try {
    const r = await api('/api/github/test', { method: 'POST', body: {} });
    setSettingsStatus(
      `✅ ${r.user} / ${r.repo} · 数据文件${r.fileExists ? '已存在' : '将在首次保存时创建'} · 提示词${r.counts.prompts} Agents${r.counts.agents} 编排${r.counts.orchestrations}`,
      'ok'
    );
  } catch (e) {
    setSettingsStatus('❌ ' + e.message, 'err');
  }
}

/** 清除本机浏览器的 Token 与缓存（公共电脑上离开前使用） */
function clearCredentials() {
  if (!window.confirm('将清除本机浏览器中保存的 GitHub Token 与离线缓存。\n仓库里的数据不受影响，之后需重新填写 Token 才能同步。\n\n确定清除吗？')) return;
  localStorage.removeItem(CFG_KEY);
  localStorage.removeItem(CACHE_KEY);
  vault = { version: 2, prompts: [], agents: [], orchestrations: [] };
  renderAll();
  setSyncState('未配置 GitHub', 'warn');
  $('#s_token').value = '';
  $('#s_owner').value = '';
  $('#s_repo').value = '';
  setSettingsStatus('已清除本机凭据与缓存。', 'ok');
  toast('本机凭据已清除');
}

// ---------------- 弹窗控制 ----------------
function closeModal(id) { $('#' + id).classList.add('hidden'); }

// ---------------- 事件绑定 ----------------
function bind() {
  // 主题
  $('#themeBtn').addEventListener('click', cycleTheme);

  // 捕捉页（粘贴 / 拖拽 / 生成）
  bindCapture();

  // 视图切换
  $('#viewTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.vtab');
    if (b) switchView(b.getAttribute('data-view'));
  });

  // 同步 / 设置
  $('#syncBtn').addEventListener('click', () => loadVault(false));
  // 手动上传入口：新增/编辑本身会自动上传，这里是「自动上传失败后重试」和「强制对齐云端」的出口。
  // 走同一个 saveVault，所以多人共用时同样会先合并再写，不会覆盖别人的内容。
  $('#pushBtn').addEventListener('click', () => saveVault('手动上传'));
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsSaveBtn').addEventListener('click', submitSettings);
  $('#s_testBtn').addEventListener('click', testConnection);
  $('#s_linkBtn').addEventListener('click', showAutoLink);
  $('#s_clearBtn').addEventListener('click', clearCredentials);

  // 搜索
  $('#pSearch').addEventListener('input', (e) => { searchPrompts = e.target.value; renderPrompts(); });
  $('#aSearch').addEventListener('input', (e) => { searchAgents = e.target.value; renderAgents(); });

  // 标签筛选
  $('#tagFilter').addEventListener('click', (e) => {
    const p = e.target.closest('.tag-pill');
    if (!p) return;
    activeTag = p.getAttribute('data-tag') || null;
    renderTagFilter();
    renderPrompts();
  });

  // 新建
  $('#newPromptBtn').addEventListener('click', () => openPromptModal());
  $('#newAgentBtn').addEventListener('click', () => openAgentModal());
  $('#newOrchBtn').addEventListener('click', () => openOrchModal());
  $('#promptSaveBtn').addEventListener('click', submitPrompt);
  $('#agentSaveBtn').addEventListener('click', submitAgent);
  $('#orchSaveBtn').addEventListener('click', submitOrch);

  // 提示词卡片操作
  $('#promptGrid').addEventListener('click', (e) => {
    const c = e.target.closest('[data-pcopy]');
    const ed = e.target.closest('[data-pedit]');
    const dl = e.target.closest('[data-pdel]');
    if (c) { const p = vault.prompts.find((x) => x.id === c.getAttribute('data-pcopy')); return copyText(p.content || '', '提示词已复制'); }
    if (ed) return openPromptModal(ed.getAttribute('data-pedit'));
    if (dl) {
      const id = dl.getAttribute('data-pdel');
      vault.prompts = vault.prompts.filter((x) => x.id !== id);
      renderPrompts(); renderTagFilter(); saveVault('删除提示词');
    }
  });

  // Agents 卡片操作 + 多选
  $('#agentGrid').addEventListener('click', (e) => {
    const chk = e.target.closest('[data-acheck]');
    const c = e.target.closest('[data-acopy]');
    const ed = e.target.closest('[data-aedit]');
    const dl = e.target.closest('[data-adel]');
    if (chk) {
      const id = chk.getAttribute('data-acheck');
      if (selectedAgents.has(id)) selectedAgents.delete(id); else selectedAgents.add(id);
      return syncAgentSelection();
    }
    if (c) { const a = vault.agents.find((x) => x.id === c.getAttribute('data-acopy')); return copyText(a.systemPrompt || '', '系统提示词已复制'); }
    if (ed) return openAgentModal(ed.getAttribute('data-aedit'));
    if (dl) {
      const id = dl.getAttribute('data-adel');
      vault.agents = vault.agents.filter((x) => x.id !== id);
      selectedAgents.delete(id);
      renderAgents();
      saveVault('删除 Agent');
    }
  });

  // 多选工具条
  $('#selAllBtn').addEventListener('click', () => { visibleAgents().forEach((a) => selectedAgents.add(a.id)); syncAgentSelection(); });
  $('#selClearBtn').addEventListener('click', () => { selectedAgents.clear(); syncAgentSelection(); });
  $('#selCopyBtn').addEventListener('click', () => exportSelected('copy'));
  $('#selTxtBtn').addEventListener('click', () => exportSelected('txt'));
  $('#selJsonBtn').addEventListener('click', () => exportSelected('json'));
  $('#selApiBtn').addEventListener('click', () => exportSelected('api'));
  $('#selSkillBtn').addEventListener('click', () => {
    const agents = selectedAgentList();
    if (!agents.length) return toast('请先选择 Agent', true);
    const orchs = relatedOrchestrations(agents.map((a) => a.id));
    openSkillModal(agents, orchs);
  });

  // Skill 打包弹窗
  $('#skSaveBtn').addEventListener('click', submitSkill);
  $('#sk_name').addEventListener('input', refreshSkillPreview);
  $('#sk_desc').addEventListener('input', refreshSkillPreview);

  // 编排卡片操作
  $('#orchGrid').addEventListener('click', (e) => {
    const sk = e.target.closest('[data-oskill]');
    const c = e.target.closest('[data-ocopy]');
    const ed = e.target.closest('[data-oedit]');
    const dl = e.target.closest('[data-odel]');
    if (sk) {
      const o = vault.orchestrations.find((x) => x.id === sk.getAttribute('data-oskill'));
      if (!o) return;
      const involved = vault.agents.filter((a) => (o.steps || []).some((s) => s.agentId === a.id));
      return openSkillModal(involved, [o]);
    }
    if (c) {
      const o = vault.orchestrations.find((x) => x.id === c.getAttribute('data-ocopy'));
      const txt = `${o.name}\n${o.description || ''}\n\n` +
        (o.steps || []).map((s, i) => `${i + 1}. ${agentName(s.agentId)}${s.task ? ' —— ' + s.task : ''}`).join('\n');
      return copyText(txt, '编排链路已复制');
    }
    if (ed) return openOrchModal(ed.getAttribute('data-oedit'));
    if (dl) {
      const id = dl.getAttribute('data-odel');
      vault.orchestrations = vault.orchestrations.filter((x) => x.id !== id);
      renderOrchestrations();
      saveVault('删除编排');
    }
  });

  // 编排步骤编辑器
  $('#addStepBtn').addEventListener('click', () => {
    const steps = getSteps();
    steps.push({ agentId: '', task: '' });
    setSteps(steps);
    renderSteps();
  });
  $('#o_steps').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-sidx]');
    if (sel) { const steps = getSteps(); steps[+sel.getAttribute('data-sidx')].agentId = sel.value; setSteps(steps); }
  });
  $('#o_steps').addEventListener('input', (e) => {
    const inp = e.target.closest('[data-tidx]');
    if (inp) { const steps = getSteps(); steps[+inp.getAttribute('data-tidx')].task = inp.value; setSteps(steps); }
  });
  $('#o_steps').addEventListener('click', (e) => {
    const del = e.target.closest('[data-sdel]');
    if (del) { const steps = getSteps(); steps.splice(+del.getAttribute('data-sdel'), 1); setSteps(steps); renderSteps(); }
  });

  // 弹窗关闭
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.getAttribute('data-close'))));
  $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal').forEach((m) => m.classList.add('hidden'));
  });
}

// ---------------- 启动 ----------------
function injectSyncState() {
  const wrap = document.querySelector('.topbar-right');
  const span = document.createElement('span');
  span.id = 'syncState';
  span.className = 'sync-state';
  wrap.insertBefore(span, wrap.firstChild);
}

function boot() {
  injectSyncState();
  applyTheme(currentThemeMode());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentThemeMode() === 'system') applyTheme('system');
  });
  bind();
  firstRun(applyTokenLink());   // 先吃「免填写链接」里的配置，再决定是否弹首次引导
  // 边界情况：若本页已打开，再粘贴「免填写链接」只会产生片段变化，
  // 浏览器不会重新加载文档，boot() 也就不会再跑一次 —— 必须额外监听 hashchange，
  // 否则用户会以为链接没生效（这是真机验证时踩到的坑）。
  window.addEventListener('hashchange', async () => {
    if (!readTokenLink()) return;      // 无关片段（视图锚点等）不处理
    applyTokenLink();
    closeModal('settingsModal');       // 若正处于「请填写 Token」引导态，配置已完成就该收起来
    toast('已通过专属链接自动完成配置');
    await loadVault(true);
  });
}

/** 首次使用引导：loadVault 是异步的，必须等它写完状态再覆盖，否则提示会被冲掉 */
async function firstRun(injected) {
  if (isConfigured(cfgDefaults())) {
    if (injected) toast('已通过专属链接自动完成配置');
    await loadVault(true);
    return;
  }
  await loadVault(true);           // 无配置时只会读本地缓存；返回后不再改 syncState
  setSyncState('首次使用 · 请先配置', 'warn');
  await openSettings();            // openSettings 内部会清空 settingsStatus，必须等它结束
  setSettingsStatus(
    '两种用法：① 填 GitHub Token + 仓库名（Token 只存本机浏览器，不上传任何服务器）；' +
    '② 填「代理地址」——Token 由服务端代持，你什么都不用填，几个人共用就选这个。' +
    '若你已有一条「一键链接」，直接打开即可跳过这一步。'
  );
}

function setSettingsStatus(text, cls) {
  const st = $('#settingsStatus');
  if (!st) return;
  st.textContent = text || '';
  st.className = 'settings-status' + (cls ? ' ' + cls : '');
}

document.addEventListener('DOMContentLoaded', boot);
