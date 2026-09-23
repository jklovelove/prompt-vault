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
  const vault = normalizeVault(body.vault);
  writeCache(vault);
  const c = cfgDefaults();
  if (!isConfigured(c)) {
    return { ok: true, saved: 'local', message: '未配置 GitHub，仅保存在浏览器本地' };
  }
  try {
    const remote = await ghReadFile();
    const r = await ghWriteFile(vault, remote.sha, body.message);
    return { ok: true, saved: 'github', sha: r.content && r.content.sha, commit: r.commit && r.commit.sha };
  } catch (e) {
    return { ok: false, saved: 'local', warning: 'GitHub 写入失败，已保存到浏览器本地: ' + e.message };
  }
}

function localConfigGet() {
  const c = cfgDefaults();
  return {
    configured: isConfigured(c), owner: c.owner, repo: c.repo, file: c.file,
    branch: c.branch, private: c.private, hasToken: !!c.token, tokenMasked: maskToken(c.token),
    isProxy: isProxy(c), apiBase: c.apiBase, hasAccessCode: !!c.accessCode,
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
    if (r.source === 'github') setSyncState('已连接 GitHub', 'ok');
    else if (r.source === 'local-fallback') setSyncState('本地缓存（GitHub 异常）', 'warn');
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

async function saveVault(message) {
  try {
    const r = await api('/api/vault', { method: 'POST', body: { vault, message } });
    if (r.saved === 'github') {
      setSyncState('已同步 GitHub', 'ok');
      toast('已同步到 GitHub');
    } else {
      setSyncState('仅保存本地', 'warn');
      toast(r.warning || r.message || '已保存到本地', r.warning ? true : false);
    }
  } catch (e) {
    toast('保存失败: ' + e.message, true);
  }
}

// ---------------- 视图切换 ----------------
function switchView(view) {
  currentView = view;
  $$('.vtab').forEach((b) => b.classList.toggle('active', b.getAttribute('data-view') === view));
  ['prompts', 'agents', 'orchestrations'].forEach((v) => {
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

  // 视图切换
  $('#viewTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.vtab');
    if (b) switchView(b.getAttribute('data-view'));
  });

  // 同步 / 设置
  $('#syncBtn').addEventListener('click', () => loadVault(false));
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
