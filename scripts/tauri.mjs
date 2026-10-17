/**
 * tauri CLI 包装：`npm run tauri dev --time YYMMDD` 或 `npm run tauri dev -- --time YYMMDD`
 * 注入测试日期（VITE_TEST_DATE），供 useFestival 按模拟"今天"判定节日主题；
 * 不带 --time 时行为与原 tauri CLI 完全一致，其余子命令（build 等）原样透传。
 *
 * 为什么包装 npm script 的 "tauri"：tauri CLI 本身不认识 --time（clap 未知参数直接报错），
 * 只能在外层剥离后再转发；--time 的值经环境变量进入 nuxt dev 子进程（tauri dev →
 * beforeDevCommand 的 env 继承链），Vite 只把 VITE_ 前缀变量暴露给前端。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const raw = process.argv.slice(2);

// 解析并剥离 --time（两种形式：--time 260401 / --time=260401），其余参数原样保留
let testDate = null;
const rest = [];
for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg === '--time') {
        testDate = raw[++i];
    } else if (arg.startsWith('--time=')) {
        testDate = arg.slice('--time='.length);
    } else {
        rest.push(arg);
    }
}

// npm 吞 flag 兜底：npm run 会把 `--time 260401` 解析成自身配置（npm_config_time）而不传给脚本——
// 值为 260401 时直接用；被拆成布尔 true + 位置参数 260401 时从剩余参数里找裸六位数字
const npmCfg = process.env.npm_config_time;
if (!testDate && npmCfg && /^\d{6}$/.test(npmCfg)) {
    testDate = npmCfg;
} else if (!testDate && npmCfg === 'true') {
    const idx = rest.findIndex((a) => /^\d{6}$/.test(a));
    if (idx >= 0) {
        testDate = rest[idx];
        rest.splice(idx, 1);
    }
}

if (testDate) {
    if (!/^\d{6}$/.test(testDate)) {
        console.error('[tauri.mjs] --time 需要 YYMMDD 六位数字，例如 260401 = 2026-04-01（愚人节绿岛）');
        process.exit(1);
    }
    process.env.VITE_TEST_DATE = testDate;
    console.log(`[tauri.mjs] 测试日期已注入: VITE_TEST_DATE=${testDate}（useFestival 按此判定节日）`);
}

// 原样转发 tauri CLI：stdio 直通（保留交互与颜色），退出码透传。
// 直接以 node 调 CLI 的 JS 入口（bin 指向 ./tauri.js）——不经 shell 转发参数，避开 DEP0190 拼接警告且跨平台一致
const require = createRequire(import.meta.url);
const tauriEntry = require.resolve('@tauri-apps/cli/tauri.js');
const child = spawn(process.execPath, [tauriEntry, ...rest], {
    stdio: 'inherit',
    env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 1));
