#!/usr/bin/env node
/**
 * S1d3 Board 开放 API 测试程序（零依赖，Node 18+）
 * 文档：.docs/island-api.md
 *
 * 三种角色：
 *   node scripts/webhook-test.mjs                     # Webhook 接收端（默认 127.0.0.1:9911/webhook，含 HMAC 验签）
 *   node scripts/webhook-test.mjs send "文本" [kind]  # 入站：推送一条灵动岛显示请求
 *   node scripts/webhook-test.mjs sse                 # 出站：订阅 SSE 全量事件流
 *   node scripts/webhook-test.mjs demo [--rounds 3]   # 演示：模拟构建工具的完整灵动岛生命周期（软接管用法）
 *
 * 通用参数（可组合）：
 *   --port 12935        应用灵动岛 API 端口（send/sse 用）
 *   --token xxx         应用配置的 Bearer token（有则带）
 *   --listen 9911       接收端监听端口（serve 用）
 *   --secret test-secret 期望的签名密钥（serve 验签 / send 无关）
 *
 * 典型联调流程：
 *   1) node scripts/webhook-test.mjs --secret test-secret
 *   2) 应用设置 → 灵动岛 API → Webhook 出站推送：添加 http://127.0.0.1:9911/webhook，密钥填 test-secret，开启并测试
 *   3) 在应用里复制任意内容 / 触发待办提醒 → 本程序打印事件 + 验签结果
 */

import http from 'node:http';
import crypto from 'node:crypto';

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  } else {
    rest.push(argv[i]);
  }
}

const API_PORT = Number(flags.port ?? 12935);
const TOKEN = flags.token ? String(flags.token) : '';
const SECRET = flags.secret ? String(flags.secret) : '';
const LISTEN_PORT = Number(flags.listen ?? 9911);
const API_BASE = `http://127.0.0.1:${API_PORT}`;

const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);

// ---------- 角色 1：Webhook 接收端 ----------
function serve() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const event = req.headers['x-s1d3-event'] ?? '(missing)';
      const sig = req.headers['x-s1d3-signature'];

      // HMAC-SHA256 验签：以原始 body 计算（文档 §7.3）
      let verify = '未配置密钥，跳过验签';
      if (SECRET) {
        if (!sig) {
          verify = 'FAIL: 缺少 X-S1d3-Signature';
        } else {
          const expect = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
          const a = Buffer.from(sig, 'hex');
          const b = Buffer.from(expect, 'hex');
          verify =
            a.length === b.length && crypto.timingSafeEqual(a, b)
              ? 'OK'
              : `FAIL: got=${sig} want=${expect}`;
        }
      }

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { parseError: true, raw };
      }

      log('--- 收到 Webhook ---');
      log(`  X-S1d3-Event   : ${event}`);
      log(`  签名验证       : ${verify}`);
      log(`  kind           : ${payload.kind}`);
      log(`  title          : ${payload.title}`);
      log(`  text           : ${payload.text}`);
      log(`  duration / ts  : ${payload.duration} / ${payload.ts}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  server.listen(LISTEN_PORT, '127.0.0.1', () => {
    log(`Webhook 接收端已启动: http://127.0.0.1:${LISTEN_PORT}/webhook`);
    log(`期望签名密钥       : ${SECRET || '(未配置，不验签)'}`);
    log('');
    log('下一步：');
    log(`  1. 应用设置 → 灵动岛 API → Webhook 出站推送`);
    log(`  2. 添加目标: http://127.0.0.1:${LISTEN_PORT}/webhook  密钥: ${SECRET || '(空)'}`);
    log('  3. 开启推送，点「测试」或在应用里复制任意内容');
    log('  4. 按 Ctrl+C 退出');
  });
}

// ---------- 入站推送底层 ----------
async function show(payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${API_BASE}/api/island/show`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (res.status !== 204) {
    console.error(`show 失败: HTTP ${res.status}`, await res.text());
    return false;
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 角色 4：demo——模拟第三方工具的灵动岛生命周期（软接管） ----------
/**
 * 模拟一个构建工具如何把灵动岛当作自己的输出通道：
 *   开始(info 短驻) → 编译中(info 长驻 60s，进度刷新重推) → 结果(success/error)
 * 另演示中断事件抢占：进行中插入一条 error 告警，观察岛被顶掉（文档 §8 单例队列）。
 */
async function demo() {
  const rounds = Number(flags.rounds ?? 3);
  log(`健康检查 ${API_BASE}/api/health ...`);
  try {
    const health = await fetch(`${API_BASE}/api/health`);
    log(`health: HTTP ${health.status}`, JSON.stringify(await health.json()));
  } catch (e) {
    console.error(`应用未开启灵动岛 API？（端口 ${API_PORT}）`, e.message);
    process.exit(1);
  }

  for (let n = 1; n <= rounds; n++) {
    log(`=== 第 ${n}/${rounds} 轮构建 ===`);
    await show({ text: `构建 #${n} 开始`, kind: 'info', title: 'CI', duration: 3000 });
    await sleep(2500);

    // 长驻「进行中」：软接管（duration 60s），进度变化时重推刷新（文档 §6.5）
    for (const pct of [30, 60, 90]) {
      await show({ text: `编译中 ${pct}%`, kind: 'info', title: 'CI', duration: 60000 });
      await sleep(1500);
    }

    // 中断事件抢占演示：单例队列下新事件立即顶掉长驻显示（§8）
    if (n === 2) {
      log('（插入一条告警，观察岛被顶掉）');
      await show({ text: '磁盘空间不足 5%', kind: 'error', title: '系统', duration: 5000 });
      await sleep(3000);
    }

    const ok = n !== rounds; // 最后一轮模拟失败
    await show({
      text: ok ? `构建 #${n} 成功，耗时 ${n * 3}s` : `构建 #${n} 失败：2 个测试用例未通过`,
      kind: ok ? 'success' : 'error',
      title: 'CI',
      duration: ok ? 4000 : 8000,
    });
    log(`结果岛: ${ok ? 'success' : 'error'}`);
    await sleep(3000);
  }
  log('demo 结束');
}

// ---------- 角色 2：入站推送 ----------
async function send() {
  const text = rest[1] ?? '来自测试程序的消息';
  const kind = rest[2] ?? 'info';
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  try {
    const health = await fetch(`${API_BASE}/api/health`);
    const healthBody = await health.json();
    log(`health: HTTP ${health.status}`, JSON.stringify(healthBody));
  } catch (e) {
    console.error(`health 失败（应用未开启灵动岛 API？端口 ${API_PORT}）:`, e.message);
    process.exit(1);
  }

  const ok = await show({ text, kind, title: '测试', duration: 5000 });
  if (ok) log('show: HTTP 204（已受理）');
  else console.error('show 失败');
  log('灵动岛应已弹出；开启接收端（node scripts/webhook-test.mjs）可同时观察 Webhook 投递');
}

// ---------- 角色 3：SSE 订阅 ----------
async function sse() {
  const headers = {};
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  log(`订阅 ${API_BASE}/api/events ...`);
  const res = await fetch(`${API_BASE}/api/events`, { headers });
  if (!res.ok) {
    console.error(`订阅失败: HTTP ${res.status}`, await res.text());
    process.exit(1);
  }
  log('已连接，等待事件（Ctrl+C 退出）…');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue; // 心跳为注释行 ": ping"
      try {
        const ev = JSON.parse(dataLine.slice(6));
        log(`SSE [${ev.kind}]${ev.title ? ` (${ev.title})` : ''} ${ev.text}`);
      } catch {
        log('SSE 原始帧:', frame);
      }
    }
  }
}

// ---------- 入口 ----------
const mode = rest[0] ?? 'serve';
if (mode === 'serve') serve();
else if (mode === 'send') send().catch((e) => console.error(e));
else if (mode === 'sse') sse().catch((e) => console.error(e));
else if (mode === 'demo') demo().catch((e) => console.error(e));
else {
  console.error(`未知模式: ${mode}（可用: serve / send / sse / demo）`);
  process.exit(1);
}
