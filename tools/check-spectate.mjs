#!/usr/bin/env node
/**
 * check-spectate.mjs —— 围观页 + 公屏播报（C1/C2，2026-10-29）
 *
 * 钉死这几件事：
 *   ① startSpectate 立刻写出自己的 `<名字>.json`，team.html 里有自己的名字；
 *   ② 两个假 bot 写同一目录 ⇒ team.html 两个名字都有；
 *   ③ stop() 删掉自己的 json，team.html 里不再出现这个名字；
 *   ④ 目录里躺着坏 JSON 也不崩、照样渲染；
 *   ⑤ wireBroadcasts：death 报一次、冷却期内第二次不报；taskDone 报出 goal；
 *      同 taskId 60 秒内去重；unwire 之后彻底安静。
 *
 * 用法：node tools/check-spectate.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const { startSpectate, wireBroadcasts } = await import(new URL('../src/spectate.mjs', import.meta.url))

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

/** 假 McBot：只给 spectate 用到的公开面（bot.bot / position / tasks.current / on / off） */
function mkFakeBot (name, over = {}) {
  const emitter = new EventEmitter()
  const bot = {
    bot: { username: name, health: 18, food: 17, game: { gameMode: 'survival' } },
    position: { x: 10.4, y: 64, z: -20.6 },
    tasks: { current: () => ({ taskId: 't-1', goal: '挖 16 个原木', progress: { done: 3, total: 16 } }) },
    ...over,
  }
  bot.on = emitter.on.bind(emitter)
  bot.off = emitter.off.bind(emitter)
  bot.emit = emitter.emit.bind(emitter)
  return bot
}

// ── 1. 单个 bot：立即写自己的 json + team.html 里有名字 ──────────────────────
section('1. 单个 bot 立即上报')
{
  const dir = mkdtempSync(join(tmpdir(), 'spectate-a-'))
  const stop = startSpectate(mkFakeBot('Alpha'), { dir })
  const me = join(dir, 'Alpha.json')
  ok(existsSync(me), '第一张快照立即写出（不等一个间隔）')
  const snap = JSON.parse(readFileSync(me, 'utf8'))
  ok(snap.name === 'Alpha' && snap.pos?.x === 10 && snap.pos?.z === -21, '快照带名字和取整后的坐标', JSON.stringify(snap.pos))
  ok(snap.task?.goal === '挖 16 个原木' && snap.task?.done === 3 && snap.task?.total === 16, '快照带当前任务 goal/done/total')
  const html = readFileSync(join(dir, 'team.html'), 'utf8')
  ok(html.includes('Alpha'), 'team.html 里有自己的名字')
  ok(html.includes('http-equiv="refresh"'), '页面带 10 秒自动刷新')
  ok(html.includes('离线/失联'), '页面带离线/失联标注')
  stop()
  rmSync(dir, { recursive: true, force: true })
}

// ── 2. 两个 bot：team.html 两个名字都有 ───────────────────────────────────────
section('2. 两个 bot 同目录')
{
  const dir = mkdtempSync(join(tmpdir(), 'spectate-b-'))
  const stopA = startSpectate(mkFakeBot('Alpha'), { dir })
  const stopB = startSpectate(mkFakeBot('Bravo'), { dir })
  const html = readFileSync(join(dir, 'team.html'), 'utf8')
  ok(html.includes('Alpha') && html.includes('Bravo'), 'team.html 同时列出两个 bot')
  stopA()
  /* 3 的素材：A 已 stop，目录留着给下一节用 stopB */
  // ── 3. stop() 后：自己的 json 没了，team.html 里也没了 ──────────────────────
  section('3. stop() 退场')
  ok(!existsSync(join(dir, 'Alpha.json')), 'stop() 删掉了自己的 json')
  const html2 = readFileSync(join(dir, 'team.html'), 'utf8')
  ok(!html2.includes('Alpha'), 'stop() 重渲染后 team.html 里不再有 Alpha')
  ok(html2.includes('Bravo'), '还在的 bot 不受影响')
  stopB()
  rmSync(dir, { recursive: true, force: true })
}

// ── 4. 目录里有坏 JSON：不崩，照样渲染 ────────────────────────────────────────
section('4. 坏 JSON 不炸')
{
  const dir = mkdtempSync(join(tmpdir(), 'spectate-c-'))
  writeFileSync(join(dir, 'broken.json'), '{ 写到一半')
  let stop = null, threw = null
  try { stop = startSpectate(mkFakeBot('Carol'), { dir }) } catch (e) { threw = e }
  ok(threw === null, '坏快照不抛', String(threw))
  const html = readFileSync(join(dir, 'team.html'), 'utf8')
  ok(html.includes('Carol') && !html.includes('broken'), '坏文件被跳过，好快照照常上页')
  stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── 5. wireBroadcasts：死亡冷却 / 任务去重 / unwire ───────────────────────────
section('5. 公屏播报')
{
  const bot = mkFakeBot('Delta')
  const said = []
  const unwire = wireBroadcasts(bot, { say: (t) => said.push(t), cooldownMs: 60_000 })
  bot.emit('death', { position: { x: 1.6, y: 64, z: -2.4 } })
  ok(said.length === 1 && said[0] === '我死了 @ 2,64,-2（等下重生回来）', '死亡报一次、坐标取整', said[0])
  bot.emit('death', { position: null })
  ok(said.length === 1, '冷却期内第二次死亡不报')
  bot.emit('taskDone', { task: { taskId: 't-9', goal: '挖 16 个原木', progress: { done: 16, total: 16 } } })
  ok(said.length === 2 && said[1].includes('挖 16 个原木') && said[1].includes('16/16'), '任务完成报 goal + 进度', said[1])
  bot.emit('taskDone', { task: { taskId: 't-9', goal: '挖 16 个原木', progress: { done: 16, total: 16 } } })
  ok(said.length === 2, '同 taskId 60 秒内去重')
  bot.emit('taskDone', { task: { goal: '无 id 任务' } })
  ok(said.length === 3 && said[2].includes('无 id 任务'), '缺字段也兜得住（progress 缺席）', said[2])
  unwire()
  bot.emit('death', { position: null })
  bot.emit('taskDone', { task: { taskId: 't-10', goal: 'x', progress: {} } })
  ok(said.length === 3, 'unwire 之后彻底安静')

  /* say 抛异常也不能炸事件流 */
  const bot2 = mkFakeBot('Echo')
  let threw = null
  const unwire2 = wireBroadcasts(bot2, { say: () => { throw new Error('发不出去') } })
  try { bot2.emit('death', { position: null }) } catch (e) { threw = e }
  ok(threw === null, 'say 抛了也不往外传', String(threw))
  unwire2()
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
