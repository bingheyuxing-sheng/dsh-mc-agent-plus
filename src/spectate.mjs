/* ============================================================================
 * 围观页 + 公屏播报（C1 / C2，2026-10-29）
 * ----------------------------------------------------------------------------
 * 5 个 AI 会话各跑一个 bot、共享同一台本地服。用户要：
 *   C1  一页看全：每个 bot 定时把快照写进共享目录 `<dir>/<名字>.json`，
 *       谁写谁顺手重渲染一份自包含的 `team.html`（深色、卡片、10 秒自刷新）；
 *       目录就是 `D:\mc\.dsh-mc-agent\.express\` 这类"既能 HTTP 又能 file:// 打开"的地方。
 *   C2  死了 / 任务做完了自动在公屏说一声（死亡有冷却，任务按 taskId 60s 去重）。
 *
 * 规矩：
 *   · 只摸 `bot` 的公开面（`bot.bot` / `bot.position` / `bot.tasks.current()`），
 *     离线时 `bot.bot` 是 null —— 拿不到用户名就默默跳过，绝不往定时器里抛异常；
 *   · 多进程同时写同一目录：各自的 `<名字>.json` 互不干扰，`team.html` 后写覆盖先写
 *     （last-writer-wins 可接受）；读到半截 / 坏 JSON 就跳过那个文件，不崩；
 *   · 所有写盘都是「先写 tmp 再 rename」的原子替换（同 task-runner.mjs 的套路），
 *     读者永远不会看到写了一半的文件。
 * ============================================================================ */
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 快照超过 5 分钟没更新就标「离线/失联」 */
export const STALE_MS = 5 * 60_000
/** 同一 taskId 的完成播报去重窗口 */
export const TASK_DONE_DEDUP_MS = 60_000

/* ── 内部小工具 ─────────────────────────────────────────────────────────────── */

/** 原子写：tmp + rename，任何一步失败都只进 log，不抛 */
function atomicWrite (file, text, log) {
  try {
    const tmp = file + '.tmp'
    writeFileSync(tmp, text)
    renameSync(tmp, file)
    return true
  } catch (e) {
    try { log(`围观页写盘失败 ${file}：${e?.message ?? e}`) } catch {}
    return false
  }
}

/** 拍一张自己的快照；拿不到用户名返回 null（调用方跳过本次） */
function snapshotOf (bot) {
  const name = bot?.bot?.username
  if (!name) return null
  const p = bot?.position
  const pos = p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null
  let task = null
  try {
    /* 🔴 2026-10-29 `tasks.current()` 允许抛（任务栈初始化时序问题），这里兜住；
     *    返回形状也不钉死，只挑 goal / progress.{done,total} 三个能看懂的字段。 */
    const t = bot?.tasks?.current?.()
    if (t) task = { goal: String(t.goal ?? ''), done: t.progress?.done ?? null, total: t.progress?.total ?? null }
  } catch { /* 任务栈没好就当没任务 */ }
  return {
    name,
    pos,
    health: bot?.bot?.health ?? null,
    food: bot?.bot?.food ?? null,
    gameMode: bot?.bot?.game?.gameMode ?? null,
    task,
    at: Date.now(),
  }
}

/** 读目录里全部 `*.json` 快照；坏的 / 读不出的跳过，不崩 */
function readAllSnapshots (dir) {
  const out = []
  let names = []
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return out }
  for (const f of names) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (j && typeof j.name === 'string') out.push(j)
    } catch { /* 半截文件 / 坏 JSON：跳过 */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** 渲染自包含 team.html（数据内联成 JS 字面量，不 fetch —— file:// 下 fetch 不动） */
function renderTeamHtml (list, genAt) {
  /* 🔴 2026-10-29 内联 JSON 前先转义 `<`，否则快照里万一出现 `</script>` 会把脚本截断 */
  const data = JSON.stringify(list).replace(/</g, '\\u003c')
  const genText = new Date(genAt).toLocaleString('zh-CN', { hour12: false })
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta http-equiv="refresh" content="10">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>机器人围观页</title>
<style>
body{margin:0;padding:16px;background:#14171c;color:#dfe6ee;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}
h1{font-size:18px;margin:0 0 4px}header{color:#8a94a3;font-size:12px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.card{background:#1d232c;border:1px solid #2c3542;border-radius:10px;padding:10px 12px}
.card.off{opacity:.55;border-style:dashed}
.name{font-size:16px;font-weight:600;color:#7fd1ff}
.badge{float:right;font-size:11px;padding:1px 8px;border-radius:8px;background:#233040;color:#9fb3c8}
.off .badge{background:#4a2b2b;color:#ff9c9c}
.row{color:#aeb8c6;font-size:13px;margin-top:3px}
.hp{color:#ff8484}.fd{color:#ffc97a}
.task{margin-top:6px;color:#9fe6a0}
.bar{height:5px;background:#2c3542;border-radius:3px;margin-top:4px;overflow:hidden}
.bar i{display:block;height:100%;background:#4caf7d}
</style></head><body>
<h1>🤖 机器人围观页</h1>
<header>生成于 ${genText} · 每 10 秒自动刷新 · 超过 5 分钟没上报视为离线/失联</header>
<div class="grid" id="g"></div>
<script>
var LIST=${data};
var g=document.getElementById('g');
if(!LIST.length){g.innerHTML='<div class="card">还没有机器人上报</div>'}
for(var b of LIST){
  var c=document.createElement('div');c.className='card'+(b.off?' off':'');
  var pos=b.pos?(b.pos.x+', '+b.pos.y+', '+b.pos.z):'位置未知';
  var hp=b.health==null?'?':Math.round(b.health);
  var fd=b.food==null?'?':Math.round(b.food);
  var t=b.task;
  var tline=t?('任务：'+(t.goal||'（无描述）')+(t.done!=null&&t.total!=null?'（'+t.done+'/'+t.total+'）':'')):'当前没任务';
  var pct=(t&&t.done!=null&&t.total>0)?Math.min(100,Math.round(100*t.done/t.total)):0;
  c.innerHTML='<span class="badge">'+(b.off?'离线/失联':'在线')+'</span>'
    +'<div class="name"></div>'
    +'<div class="row">📍 '+pos+'　'+(b.gameMode||'')+'</div>'
    +'<div class="row"><span class="hp">❤ '+hp+'</span>　<span class="fd">🍗 '+fd+'</span></div>'
    +'<div class="task"></div>'
    +(t&&t.done!=null&&t.total>0?'<div class="bar"><i style="width:'+pct+'%"></i></div>':'');
  c.querySelector('.name').textContent=b.name;
  c.querySelector('.task').textContent=tline;
  g.appendChild(c);
}
</script></body></html>`
}

/** 重渲染一次 team.html（把 STALE_MS 判定折叠成 off 标志写进数据） */
function regenTeamHtml (dir, log) {
  try {
    const now = Date.now()
    const list = readAllSnapshots(dir).map((j) => ({ ...j, off: !(typeof j.at === 'number' && now - j.at < STALE_MS) }))
    atomicWrite(join(dir, 'team.html'), renderTeamHtml(list, now), log)
  } catch (e) {
    try { log(`围观页渲染失败：${e?.message ?? e}`) } catch {}
  }
}

/* ── C1：定时上报 + 重渲染围观页 ─────────────────────────────────────────────── */

/**
 * 启动围观上报。每 `intervalMs`（立即先来一次）：
 *   a) 原子写 `<dir>/<自己的名字>.json`；
 *   b) 读目录里全部快照，重渲染 `<dir>/team.html`。
 * 返回 stop()：清定时器、删自己的快照、最后再渲染一次（让自己从页面上消失）。
 */
export function startSpectate (bot, { dir, intervalMs = 10000, log = () => {} }) {
  try { mkdirSync(dir, { recursive: true }) } catch (e) { try { log(`围观页建目录失败：${e?.message ?? e}`) } catch {} }
  const myFile = () => {
    const name = bot?.bot?.username
    return name ? join(dir, name + '.json') : null
  }
  const tick = () => {
    try {
      const snap = snapshotOf(bot)
      const file = myFile()
      if (snap && file) atomicWrite(file, JSON.stringify(snap), log)
    } catch (e) {
      try { log(`围观页快照失败：${e?.message ?? e}`) } catch {}
    }
    regenTeamHtml(dir, log)
  }
  tick() // 第一张立即写，别让人等一个间隔
  const timer = setInterval(tick, intervalMs)
  if (typeof timer.unref === 'function') timer.unref() // 别拿上报定时器拖住进程退出
  return function stop () {
    try { clearInterval(timer) } catch {}
    try { const f = myFile(); if (f) unlinkSync(f) } catch { /* 删不掉就等它自然过期变灰 */ }
    regenTeamHtml(dir, log)
  }
}

/* ── C2：死亡 / 任务完成的公屏播报 ──────────────────────────────────────────── */

/**
 * 在 `bot`（带 .on/.off）上挂两条监听：
 *   · 'death'（payload {position}，可 null）→ `我死了 @ x,y,z（等下重生回来）`，有冷却；
 *   · 'taskDone'（payload {task:{taskId,goal,progress:{done,total}}}）→
 *     `任务完成：<goal>（<done>/<total>）`，同 taskId 60 秒内只报一次。
 * `say(text)` 可能抛 —— 每次调用都兜住。返回 unwire() 摘掉两条监听。
 */
export function wireBroadcasts (bot, { say, cooldownMs = 60000, log = () => {} }) {
  let lastDeathAt = 0
  const doneSeen = new Map() // taskId → 上次播报时间
  const safeSay = (text) => {
    try { say(text) } catch (e) { try { log(`公屏播报没发出去：${e?.message ?? e}`) } catch {} }
  }
  const onDeath = (payload = {}) => {
    const now = Date.now()
    if (now - lastDeathAt < cooldownMs) return
    lastDeathAt = now
    const p = payload?.position
    const at = p ? ` @ ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : ''
    safeSay(`我死了${at}（等下重生回来）`)
  }
  const onTaskDone = (payload = {}) => {
    const t = payload?.task ?? {}
    const now = Date.now()
    if (t.taskId != null) {
      const prev = doneSeen.get(t.taskId)
      if (prev != null && now - prev < TASK_DONE_DEDUP_MS) return
      doneSeen.set(t.taskId, now)
      /* 顺手清一清旧记录，防 Map 只涨不消 */
      for (const [k, v] of doneSeen) if (now - v >= TASK_DONE_DEDUP_MS) doneSeen.delete(k)
    }
    const goal = t.goal ?? '未命名任务'
    const done = t.progress?.done ?? '?'
    const total = t.progress?.total ?? '?'
    safeSay(`任务完成：${goal}（${done}/${total}）`)
  }
  bot.on('death', onDeath)
  bot.on('taskDone', onTaskDone)
  return function unwire () {
    try { bot.off('death', onDeath) } catch {}
    try { bot.off('taskDone', onTaskDone) } catch {}
  }
}
