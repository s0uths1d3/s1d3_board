#!/usr/bin/env node
/**
 * S1d3 Board 开放 API · 发送端测试脚本（零依赖，Node 18+）
 * 文档：.docs/island-api.md —— 独立发送端：向灵动岛 API 推送显示请求并校验响应。
 * （接收端/事件流/生命周期演示见 webhook-test.mjs）
 *
 * 用法：
 *   node scripts/island-send.mjs "部署完成" success
 *   node scripts/island-send.mjs "编译中 50%" info --title CI --duration 60000
 *   node scripts/island-send.mjs --sweep            # 五种 kind 各推一条
 *   node scripts/island-send.mjs --count 5          # 连推 5 条（观察单例队列顶掉行为）
 *   node scripts/island-send.mjs --errors           # 错误码验证：非法请求应返回对应 4xx
 *
 * 通用参数：
 *   --port 12935     应用灵动岛 API 端口
 *   --token xxx      Bearer token（应用配置了 token 时必须）
 */

const argv = process.argv.slice(2);
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  } else {
    rest.push(argv[i]);
  }
}

const API_PORT = Number(flags.port ?? 12935);
const TOKEN = flags.token ? String(flags.token) : '';
const BASE = `http://127.0.0.1:${API_PORT}`;
const KINDS = ['info', 'success', 'error', 'copy', 'paste'];

const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);
const headers = () => {
  const h = { 'Content-Type': 'application/json' };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
};

/** 推送一条；返回 { status, body }（204 无 body） */
async function show(payload) {
  const res = await fetch(`${BASE}/api/island/show`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload),
  });
  const body = res.status === 204 ? '' : await res.text();
  return { status: res.status, body };
}

/** 原始请求（用于错误码验证：可发非法 body/method） */
async function raw(path, { method = 'POST', body, headers: extra = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...headers(), ...extra }, body });
  const text = res.status === 204 ? '' : await res.text();
  return { status: res.status, body: text };
}

async function healthCheck() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    const body = await res.json();
    log(`health: HTTP ${res.status}`, JSON.stringify(body));
    if (!body.ok) throw new Error('ok=false');
    return true;
  } catch (e) {
    console.error(`健康检查失败（应用未开启灵动岛 API？端口 ${API_PORT}）: ${e.message}`);
    return false;
  }
}

// ---------- 正常推送 ----------
async function push(text, kind = 'info') {
  const payload = {
    text,
    kind: KINDS.includes(kind) ? kind : 'info',
    ...(flags.title ? { title: String(flags.title) } : {}),
    ...(flags.duration !== undefined ? { duration: Number(flags.duration) || 0 } : {}),
  };
  const { status, body } = await show(payload);
  log(`推送 [${payload.kind}]${payload.title ? ` (${payload.title})` : ''} "${payload.text}" → HTTP ${status}${status === 204 ? ' ✓' : ` ✗ ${body}`}`);
  return status === 204;
}

// 五种 kind 各推一条（观察图标/标签差异）
async function sweep() {
  let pass = 0;
  for (const kind of KINDS) {
    if (await push(`kind=${kind} 的测试消息`, kind)) pass++;
    await new Promise((r) => setTimeout(r, 1200));
  }
  log(`sweep 完成: ${pass}/${KINDS.length} 条受理成功`);
}

// 连推多条（延迟合并/顶掉行为：中间条目可能被丢弃，属文档 §8 预期）
async function burst(count) {
  let accepted = 0;
  for (let i = 1; i <= count; i++) {
    const { status } = await show({ text: `连推 ${i}/${count}`, kind: 'info', title: '压测', duration: 0 });
    if (status === 204) accepted++;
    await new Promise((r) => setTimeout(r, 200));
  }
  log(`连推完成: HTTP 204 x${accepted}/${count}（岛仅显示最后一条为预期行为）`);
}

// ---------- 错误码验证（文档 §10） ----------
async function errorSweep() {
  const cases = [
    { name: 'invalid_json  → 400', run: () => raw('/api/island/show', { body: '{not-json', headers: { 'Content-Type': 'application/json' } }), expect: 400 },
    { name: 'empty_text     → 400', run: () => show({ text: '', kind: 'info' }), expect: 400 },
    { name: 'text_too_long  → 422', run: () => show({ text: '字'.repeat(2001), kind: 'info' }), expect: 422 },
    { name: 'invalid_kind   → 422', run: () => show({ text: 'x', kind: 'banana' }), expect: 422 },
    { name: 'not_found      → 404', run: () => raw('/api/nope', { body: '{}' }), expect: 404 },
    { name: 'method_not_allowed → 405', run: () => raw('/api/health', { method: 'POST', body: '{}' }), expect: 405 },
    ...(TOKEN ? [{ name: 'unauthorized   → 401', run: () => fetch(`${BASE}/api/island/show`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' }, body: '{"text":"x"}' }).then(async (r) => ({ status: r.status, body: await r.text() })), expect: 401 }] : []),
  ];

  let pass = 0;
  for (const c of cases) {
    try {
      const { status, body } = await c.run();
      const ok = status === c.expect;
      let code = '';
      try { code = JSON.parse(body)?.error?.code ?? ''; } catch { /* 204 等 */ }
      log(`${ok ? '✓' : '✗'} ${c.name}  实际 HTTP ${status} ${code && `(${code})`}`);
      if (ok) pass++;
    } catch (e) {
      log(`✗ ${c.name}  异常: ${e.message}`);
    }
  }
  log(`错误码验证: ${pass}/${cases.length} 通过`);
}

// ---------- 入口 ----------
const mode = flags.errors ? 'errors' : flags.sweep ? 'sweep' : flags.count ? 'burst' : 'push';
const text = rest[0] ?? '来自发送端测试脚本的消息';
const kind = rest[1] ?? 'info';

(async () => {
  if (!(await healthCheck())) process.exit(1);
  if (mode === 'push') {
    const ok = await push(text, kind);
    log(ok ? '灵动岛应已弹出；如需观察 Webhook/SSE 出站，请配合 webhook-test.mjs 使用' : '推送失败，见上方响应');
  } else if (mode === 'sweep') await sweep();
  else if (mode === 'burst') await burst(Number(flags.count) || 5);
  else if (mode === 'errors') await errorSweep();
})();
