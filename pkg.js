/* ============================================================
   PromptVault 纯前端工具集
   - ZIP 打包（浏览器内置 CompressionStream，无第三方依赖）
   - Skill 包构建（对齐 skill-creator 规范）
   浏览器中挂到 window.PV；Node 中 module.exports（便于单元测试）
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PV = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- CRC32 ----------
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function concat(list) {
    let total = 0;
    for (const x of list) total += x.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const x of list) { out.set(x, off); off += x.length; }
    return out;
  }

  function toBytes(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s));
    return new Uint8Array(Buffer.from(String(s), 'utf8')); // Node 兜底
  }

  function dosDateTime(d) {
    return {
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    };
  }

  /** 默认压缩器：浏览器原生 deflate-raw；不可用则返回 null（退化为仅存储） */
  async function defaultDeflate(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
      return null;
    }
  }

  /**
   * 生成标准 ZIP。
   * @param {Array<{name:string,data:string|Uint8Array}>} entries
   * @param {Function|null} [deflateFn] 自定义压缩器（测试用；传 null 强制不压缩）
   * @returns {Promise<Uint8Array>}
   */
  async function makeZip(entries, deflateFn) {
    const deflate = deflateFn === undefined ? defaultDeflate : deflateFn;
    const { date, time } = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const nameBytes = toBytes(e.name);
      const raw = e.data instanceof Uint8Array ? e.data : toBytes(String(e.data));
      let payload = raw;
      let method = 0;
      if (deflate) {
        const c = await deflate(raw);
        if (c && c.length < raw.length) { payload = c; method = 8; }
      }
      const crc = crc32(raw);
      const flag = 0x0800; // UTF-8 文件名

      const lh = new Uint8Array(30);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, flag, true);
      lv.setUint16(8, method, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, payload.length, true);
      lv.setUint32(22, raw.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      parts.push(lh, nameBytes, payload);

      const ch = new Uint8Array(46);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, flag, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, payload.length, true);
      cv.setUint32(24, raw.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.push(ch, nameBytes);

      offset += lh.length + nameBytes.length + payload.length;
    }

    const centralBytes = concat(central);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralBytes.length, true);
    ev.setUint32(16, offset, true);

    return concat([...parts, centralBytes, eocd]);
  }

  // ---------- Skill 包构建 ----------
  function slugifyAscii(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** 稳定短哈希（FNV-1a 32bit）：给非 ASCII 名称生成可复现的回退名 */
  function shortHash(s) {
    let h = 0x811c9dc5;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function kebabName(raw, fallback) {
    let n = slugifyAscii(raw) || slugifyAscii(fallback);
    // 中文等非 ASCII 名称会被 slug 清空：回退到稳定短哈希，
    // 保证「同一编排每次导出同名、不同编排互不相同」。
    // 纯 ASCII 名称命中前两个分支，行为完全不变。
    if (!n) n = 'skill-' + shortHash(String(raw || '') + '|' + String(fallback || ''));
    if (n.length > 64) n = n.slice(0, 64).replace(/-+$/, '');
    return n;
  }

  function safeDescription(raw) {
    let s = String(raw || '').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) s = '多 Agent 协作编排技能包：按预定链路调用多个角色完成复杂任务。';
    if (s.length > 1024) s = s.slice(0, 1021) + '...';
    return s;
  }

  function asciiFileSlug(name, role) {
    return slugifyAscii(name) || slugifyAscii(role) || 'agent';
  }

  function codeFence(text) {
    return String(text || '').includes('```') ? '````' : '```';
  }

  const AGENT_PARAMS = ['temperature', 'maxTokens', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'stop', 'seed'];

  function normalizeAgent(a) {
    a = a && typeof a === 'object' ? a : {};
    const out = {
      id: String(a.id || ''),
      name: String(a.name || '未命名 Agent'),
      role: String(a.role || ''),
      model: String(a.model || ''),
      description: String(a.description || ''),
      tags: Array.isArray(a.tags) ? a.tags.map(String) : [],
      systemPrompt: String(a.systemPrompt || ''),
    };
    const params = {};
    AGENT_PARAMS.forEach((k) => {
      if (a[k] !== undefined && a[k] !== null && a[k] !== '') params[k] = a[k];
    });
    if (Object.keys(params).length) out.params = params;
    return out;
  }

  /** 构建 .skill 包内的全部文件（返回 [{name, data}]） */
  function buildSkillEntries(input) {
    const name = input.name;
    const description = input.description;
    const agents = (input.agents || []).map(normalizeAgent);
    const orchestrations = input.orchestrations || [];    const folder = name;
    const entries = [];

    const agentFiles = new Map();
    agents.forEach((a, i) => {
      const file = `agents/${i + 1}-${asciiFileSlug(a.name, a.role)}.md`;
      agentFiles.set(a.id, file);
      const L = [];
      L.push(`# ${a.name}`);
      L.push('');
      L.push(a.description || a.role || '');
      L.push('');
      L.push('## Role');
      L.push('');
      L.push(a.role || '（未指定）');
      if (a.model) { L.push(''); L.push('## 推荐模型'); L.push(''); L.push(a.model); }
      if (a.params && Object.keys(a.params).length) {
        L.push(''); L.push('## 生成参数'); L.push('');
        Object.keys(a.params).forEach((k) => {
          const v = a.params[k];
          L.push(`- **${k}**：${Array.isArray(v) ? v.join(', ') : String(v)}`);
        });
      }
      if (a.tags.length) { L.push(''); L.push('## 标签'); L.push(''); L.push(a.tags.join(', ')); }
      L.push('');
      L.push('## System Prompt');
      L.push('');
      const fence = codeFence(a.systemPrompt);
      L.push(fence);
      L.push(a.systemPrompt || '（未填写）');
      L.push(fence);
      const usedIn = orchestrations.filter((o) => (o.steps || []).some((s) => s.agentId === a.id));
      if (usedIn.length) {
        L.push('');
        L.push('## 参与的编排步骤');
        L.push('');
        usedIn.forEach((o) => {
          (o.steps || []).forEach((s, j) => {
            if (s.agentId !== a.id) return;
            L.push(`- **${o.name}** 步骤 ${j + 1}：${s.task || '（无任务描述）'}`);
          });
        });
      }
      L.push('');
      entries.push({ name: `${folder}/${file}`, data: L.join('\n') });
    });

    const fileOf = (id) => {
      const f = agentFiles.get(id);
      return f ? '`' + f + '`' : null;
    };

    const title = (orchestrations[0] && orchestrations[0].name) || (agents[0] && agents[0].name) || 'Agent 编排';
    const S = [];
    S.push('---');
    S.push('name: ' + name);
    S.push('description: ' + description);
    S.push('---');
    S.push('');
    S.push('# ' + title);
    S.push('');
    if (orchestrations[0] && orchestrations[0].description) {
      S.push(orchestrations[0].description);
      S.push('');
    }
    S.push(`本技能包由 PromptVault 导出，包含 **${agents.length}** 个 Agent 角色定义与 **${orchestrations.length}** 条编排链路。`);
    S.push('');
    S.push('## 何时使用');
    S.push('');
    S.push(`当用户提出需要「${title}」这类任务时使用本技能：它会按预定链路依次调用下列角色，每个角色各司其职。`);
    S.push('');
    S.push('## 参与角色');
    S.push('');
    S.push('执行前按需读取 `agents/` 下对应的角色文件，不要一次性全部加载。');
    S.push('');
    S.push('| Agent | 角色 | 定义文件 |');
    S.push('| --- | --- | --- |');
    agents.forEach((a) => {
      S.push(`| ${a.name} | ${(a.role || '—').replace(/\|/g, '\\|')} | ${fileOf(a.id) || '—'} |`);
    });
    S.push('');
    S.push('## 执行流程');
    S.push('');
    if (!orchestrations.length) {
      S.push('（本包未包含编排链路，请单独参考各 Agent 定义。）');
      S.push('');
    }
    orchestrations.forEach((o, oi) => {
      if (orchestrations.length > 1) { S.push(`### 编排 ${oi + 1}：${o.name}`); S.push(''); }
      (o.steps || []).forEach((s, j) => {
        const a = agents.find((x) => x.id === s.agentId);
        S.push(`#### 步骤 ${j + 1} · ${a ? a.name : '未知 Agent'}`);
        S.push('');
        if (a) S.push(`- **角色定义**：${fileOf(a.id)}`);
        S.push(`- **任务**：${s.task || '（无任务描述）'}`);
        if (a && a.systemPrompt) {
          S.push('- **系统提示词**：');
          S.push('');
          const fence = codeFence(a.systemPrompt);
          S.push(fence);
          S.push(a.systemPrompt);
          S.push(fence);
        }
        S.push('');
      });
    });
    S.push('## 参考文件');
    S.push('');
    S.push('- `references/orchestration.json` — 编排链路的结构化数据（含每个步骤的 Agent 与任务）');
    S.push('- `references/agents.json` — 全部 Agent 的完整定义');
    S.push('- `references/api-messages.json` — 可直接投喂 OpenAI 兼容 API 的 messages 结构');
    S.push('');
    entries.push({ name: `${folder}/SKILL.md`, data: S.join('\n') });

    const nowIso = new Date().toISOString();
    entries.push({
      name: `${folder}/references/orchestration.json`,
      data: JSON.stringify({ version: 1, exportedAt: nowIso, orchestrations }, null, 2),
    });
    entries.push({
      name: `${folder}/references/agents.json`,
      data: JSON.stringify({ version: 1, exportedAt: nowIso, agents }, null, 2),
    });

    const apiMessages = orchestrations.map((o) => {
      const messages = [];
      const emitted = new Set();
      (o.steps || []).forEach((s) => {
        const a = agents.find((x) => x.id === s.agentId);
        if (a && !emitted.has(a.id) && a.systemPrompt) {
          messages.push({ role: 'system', name: a.name, content: a.systemPrompt });
          emitted.add(a.id);
        }
        if (s.task) messages.push({ role: 'user', name: a ? a.name : 'unknown', content: s.task });
      });
      return { name: o.name, description: o.description || '', messages };
    });
    entries.push({
      name: `${folder}/references/api-messages.json`,
      data: JSON.stringify(apiMessages, null, 2),
    });

    return entries;
  }

  return {
    crc32, concat, makeZip, defaultDeflate,
    slugifyAscii, kebabName, safeDescription, asciiFileSlug, codeFence,
    shortHash, normalizeAgent, buildSkillEntries,
  };
});
