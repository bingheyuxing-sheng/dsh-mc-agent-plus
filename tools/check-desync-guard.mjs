#!/usr/bin/env node
/**
 * check-desync-guard.mjs —— 方块状态失步自愈（优化清单① 2026-10-26，P0）
 *
 * 钉死这几件事：
 *   ① 2 分钟窗口内攒满 3 次"本地 vs 服务端对不上" ⇒ 自动 `connect{force:true}` 重连一次；
 *   ② 公屏报备（去时一句、回来一句"失步已重连"），回来把没做完的任务写进台账让 AI 续做；
 *   ③ 自愈有冷却（防"重连→还是失步→再重连"死循环）；离线 / 正在重连 / 正在连接时不动连接；
 *   ④ `mining.mjs` 三处失步判决（复原 / desync / localRestored）和 `place.mjs` 两处
 *      （放置被拒 / 复核不过）都接上了 `noteDesync`。
 *
 * 用法：node tools/check-desync-guard.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const {
  noteDesync, healDesync, desyncHealNote,
  DESYNC_WINDOW_MS, DESYNC_TRIGGER, DESYNC_HEAL_COOLDOWN_MS,
} = await import(new URL('../src/desync-guard.mjs', import.meta.url))

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 假 McBot：只给 desync-guard 用到的公开面 */
function mkSelf (over = {}) {
  const calls = { connect: [], say: [], note: [], log: [] }
  const self = {
    online: true, stopped: false, connecting: null, reconnecting: false, reconnectPending: false,
    _connectOpts: { host: '127.0.0.1', port: 25565, subserver: '', version: false, auth: { mode: 'offline', name: 'X' } },
    connect: async (o) => { calls.connect.push(o); return true },
    chatSay: (t) => { calls.say.push(t) },
    log: (m) => { calls.log.push(m) },
    emit: () => {},
    tasks: { current: () => ({ taskId: 't-1', status: 'running' }), note: (id, txt) => { calls.note.push([id, txt]) } },
    ...over,
  }
  return { self, calls }
}

// ── 1. 常量与形状 ────────────────────────────────────────────────────────────
section('1. 判据常量')
ok(DESYNC_WINDOW_MS === 120_000, '窗口 2 分钟', String(DESYNC_WINDOW_MS))
ok(DESYNC_TRIGGER === 3, '攒满 3 次触发', String(DESYNC_TRIGGER))
ok(DESYNC_HEAL_COOLDOWN_MS >= 60_000, '自愈有冷却（至少一分钟）', String(DESYNC_HEAL_COOLDOWN_MS))

// ── 2. 攒满 3 次 ⇒ 自动 force 重连 + 公屏报备 + 任务续做 ─────────────────────
section('2. 攒满即自愈')
{
  const { self, calls } = mkSelf()
  ok(noteDesync(self, 'a').healing === false, '第 1 次不触发')
  ok(noteDesync(self, 'b').healing === false, '第 2 次不触发')
  const h = noteDesync(self, 'c')
  ok(h.healing === true, '🔴 第 3 次（2 分钟内）触发自愈', JSON.stringify(h))
  await sleep(50)
  ok(calls.connect.length === 1 && calls.connect[0].force === true, '走的是 connect{force:true}（带记下的真参数）', JSON.stringify(calls.connect[0] ?? null))
  ok(calls.connect[0]?.host === '127.0.0.1', '重连用的是 _connectOpts 里的地址，不是空参', String(calls.connect[0]?.host))
  ok(calls.say.some((s) => /失步.*自动重连/.test(s)), '去时公屏报备（不让队友以为掉线了）', JSON.stringify(calls.say))
  ok(calls.say.some((s) => /失步已重连/.test(s)), '🔴 回来后公屏说"失步已重连"（清单原话）', JSON.stringify(calls.say))
  ok(calls.note.length === 1 && /resume/.test(calls.note[0][1]), '被打断的任务写进台账、让 AI 先 resume 续做（不从头重做）', JSON.stringify(calls.note))
  ok(desyncHealNote(h).includes('自动 force 重连'), '触发时的文案带"自动 force 重连"', desyncHealNote(h).slice(0, 40))
  ok(desyncHealNote({ healing: false }) === '', '没触发时文案是空串（不污染 note）')
}

// ── 3. 冷却 / 离线 / 正在重连：只计数，不动连接 ──────────────────────────────
section('3. 不该重连的时候绝不重连')
{
  const { self, calls } = mkSelf()
  noteDesync(self, 'x'); noteDesync(self, 'y'); noteDesync(self, 'z')
  await sleep(30)
  ok(calls.connect.length === 1, '先正常自愈一次')
  noteDesync(self, 'x'); noteDesync(self, 'y')
  const third = noteDesync(self, 'z')
  ok(third.healing === false && third.cooling === true, '🔴 冷却期内再攒满 ⇒ 不重连（防死循环）', JSON.stringify(third))
  await sleep(20)
  ok(calls.connect.length === 1, '冷却期内确实没再连', String(calls.connect.length))

  const off = mkSelf({ online: false })
  noteDesync(off.self, 'a'); noteDesync(off.self, 'b')
  ok(noteDesync(off.self, 'c').healing === false && off.calls.connect.length === 0, '离线 ⇒ 不重连')

  const rec = mkSelf({ reconnecting: true })
  noteDesync(rec.self, 'a'); noteDesync(rec.self, 'b')
  ok(noteDesync(rec.self, 'c').healing === false && rec.calls.connect.length === 0, '正在自动重连 ⇒ 不插一脚')

  const stop = mkSelf({ stopped: true })
  noteDesync(stop.self, 'a'); noteDesync(stop.self, 'b')
  ok(noteDesync(stop.self, 'c').healing === false, '用户让下线了 ⇒ 不擅自回去')
}

// ── 4. 重连失败：如实记日志，不炸调用方 ──────────────────────────────────────
section('4. 重连失败也不抛')
{
  const { self, calls } = mkSelf({ connect: async () => { throw new Error('连不上') } })
  let threw = null
  try { noteDesync(self, 'a'); noteDesync(self, 'b'); noteDesync(self, 'c') } catch (e) { threw = e }
  await sleep(50)
  ok(threw === null, 'noteDesync 本身永不抛（fire-and-forget）', String(threw))
  ok(calls.log.some((l) => /失步自愈重连没成功/.test(l)), '失败记进日志', JSON.stringify(calls.log))
  const h = await healDesync({ ...mkSelf().self, connect: async () => true }, 'unit')
  ok(h?.reconnected === true, 'healDesync 成功时回 {reconnected:true}')
}

// ── 5. 接线：检测点都计数 ────────────────────────────────────────────────────
section('5. 接线（mining 三处 + place 两处）')
{
  const mining = readFileSync(fileURLToPath(new URL('../src/mining.mjs', import.meta.url)), 'utf8')
  const place = readFileSync(fileURLToPath(new URL('../src/place.mjs', import.meta.url)), 'utf8')
  ok(/import \{ noteDesync, desyncHealNote \} from '\.\/desync-guard\.mjs'/.test(mining), 'mining.mjs 引了 noteDesync')
  ok((mining.match(/noteDesync\(self, /g) ?? []).length >= 3, 'mining 三处判决（复原 / desync / 本地回滚）都计数', String((mining.match(/noteDesync\(self, /g) ?? []).length))
  ok((place.match(/noteDesync\(self, /g) ?? []).length >= 2, 'place 两处（被拒 / 复核不过）都计数', String((place.match(/noteDesync\(self, /g) ?? []).length))
  ok(/desyncHeal: true/.test(mining), '触发时结果里带 desyncHeal:true（模型看得见）')
  const guard = readFileSync(fileURLToPath(new URL('../src/desync-guard.mjs', import.meta.url)), 'utf8')
  ok(!guard.includes("from './core.mjs'"), '不反向 import core.mjs（拆分规矩第 8 条）')
  ok(/force: true/.test(guard), '自愈走的是 force 重连（不是空操作的重进）')
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
