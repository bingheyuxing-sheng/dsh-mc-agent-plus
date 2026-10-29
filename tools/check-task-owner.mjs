#!/usr/bin/env node
/**
 * 任务属主（owner）与共享任务板的离线自检（2026-10-29）。
 *
 * 背景（chat-log 实证）：五个会话共用记忆根 ⇒ 共用一份 tasks.json，而任务原来没有属主 ——
 * 谁上线都可能把别人的活捡起来（DeepSeek2：「手上这个挖泥土的活是干嘛的来着？」），
 * 而且 `#load` 读一次就缓存，别的会话写的任务永远看不见。
 *
 * 这里钉住：
 *   ① start/auto 落 owner；migrateTask 给旧任务补 owner:null；
 *   ② auto()/resume(null) 只接自己的或无主的；resume(别人的 id) 明确拒绝；
 *   ③ claim/assign/board 协作面；
 *   ④ 两个 TaskRunner 实例共享同一文件时**互相可见**（#load 每次重读）、互不覆盖；
 *   ⑤ finish(ok) 触发 onDone 回调（公屏播报走它）。
 *
 * 不需要 MC、不需要 DSH；假时钟注入，不真等。
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

const { TaskRunner, migrateTask } = await import(new URL('../src/task-runner.mjs', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'task-owner-'))
const file = join(dir, 'tasks.json')

const mkClock = (t0 = 10_000) => { const c = { t: t0 }; c.now = () => c.t; c.advance = (ms) => { c.t += ms; return c.t }; return c }
const clockA = mkClock()
const clockB = mkClock()
/** 两个"会话"：各自一个 TaskRunner，共享同一个文件（模拟五个 bot 共用 tasks.json） */
const A = new TaskRunner({ file, now: clockA.now, log: () => {}, owner: () => 'Alpha' })
const B = new TaskRunner({ file, now: clockB.now, log: () => {}, owner: () => 'Beta' })

/* ═══════════ ① owner 落账 ═══════════ */
section('① owner 落账与迁移')

const t1 = A.start({ kind: 'dig', item: 'stone', total: 16 })
ok(t1.owner === 'Alpha', 'start() 落下属主', `owner=${t1.owner}`)
ok(migrateTask({ taskId: 'x' }).owner === null, 'migrateTask 给旧任务补 owner:null')
ok(migrateTask({ taskId: 'x', owner: 'Beta' }).owner === 'Beta', 'migrateTask 不动已有 owner')

/* ═══════════ ② auto/resume 不抢别人的活 ═══════════ */
section('② auto()/resume() 只接自己的或无主的')

clockB.advance(1000)
const t2 = B.auto({ kind: 'dig', item: 'stone', total: 16 })
ok(t2.taskId !== t1.taskId, '别人有同类型活跃任务时，auto() 新开工而不是接别人的', `${t1.taskId} vs ${t2.taskId}`)
ok(t2.owner === 'Beta', '新开的任务属主是自己')

clockB.advance(1000)
const t2b = B.auto({ kind: 'dig', item: 'stone', total: 16 })
ok(t2b.taskId === t2.taskId, '自己再 auto 同参数 → 续自己的', t2b.taskId)

const rA = A.resume(null, {})
ok(rA.ok && rA.task?.taskId === t1.taskId, 'resume(null) 拿到的是自己的活（哪怕别人的更新更近）', rA.task?.taskId)

const rSteal = A.resume(t2.taskId, {})
ok(!rSteal.ok && /Beta/.test(String(rSteal.reason)), 'resume(别人的 id) 明确拒绝并指名属主', String(rSteal.reason).slice(0, 40))

/* 无主任务：谁 auto 谁认领 */
A.start({ kind: 'dig', item: 'dirt', total: 8 })
const raw = JSON.parse(readFileSync(file, 'utf8'))
const dirtTask = raw.tasks.find((t) => t.params?.item === 'dirt')
dirtTask.owner = null   // 模拟 2026-10-29 之前落盘的无主任务
const { writeFileSync, renameSync } = await import('node:fs')
writeFileSync(file + '.tmp', JSON.stringify(raw, null, 1), 'utf8'); renameSync(file + '.tmp', file)

clockB.advance(1000)
const t3 = B.auto({ kind: 'dig', item: 'dirt', total: 8 })
ok(t3.taskId === dirtTask.taskId && t3.owner === 'Beta', 'auto() 续上无主任务并顺手认领', `owner=${t3.owner}`)

/* ═══════════ ③ claim / assign / board ═══════════ */
section('③ 协作面：claim / assign / board')

const c1 = A.claim(t2.taskId)
ok(c1.ok && c1.task.owner === 'Alpha', 'claim 把别人的活认到自己名下')
const h1 = A.get(t2.taskId).history.at(-1)?.text ?? ''
ok(/认领/.test(h1), 'claim 记了历史', h1.slice(0, 24))

const a1 = A.assign(t1.taskId, 'mimo')
ok(a1.ok && a1.task.owner === 'mimo', 'assign 派活给别人')
const a2 = A.assign(t1.taskId, '   ')
ok(!a2.ok, 'assign 不给 to 会拒')
const c2 = B.claim('t-不存在的')
ok(!c2.ok, 'claim 不存在的任务会拒')

/* 派完活，t1 已经不是 Alpha 的了：Alpha resume(null) 不该再摸到它 */
const dirtA = A.resume(null, {})
ok(!(dirtA.ok && dirtA.task?.taskId === t1.taskId), '派出去的任务不再被自己 resume(null) 摸到')

const board = A.board()
ok(board.length >= 3, 'board 列出全队活跃任务', `${board.length} 件`)
ok(board.every((r) => 'owner' in r && 'taskId' in r && 'goal' in r), 'board 每行都带 owner/taskId/goal')
ok(board.some((r) => r.owner === 'mimo'), 'board 看得见派给 mimo 的活')

/* ═══════════ ④ 跨会话可见、互不覆盖 ═══════════ */
section('④ 共享文件：互相可见、后到者不覆盖先到者')

clockA.advance(1000)
const t4 = A.start({ kind: 'craft', item: 'torch', total: 4 })
const bSees = B.list({ limit: 100 }).map((t) => t.taskId)
ok(bSees.includes(t4.taskId), 'B 立刻看得见 A 刚开工的任务（#load 每次重读）')
clockB.advance(1000)
const t5 = B.start({ kind: 'gather', item: 'oak_log', total: 8 })
const onDisk = JSON.parse(readFileSync(file, 'utf8')).tasks.map((t) => t.taskId)
ok(onDisk.includes(t4.taskId) && onDisk.includes(t5.taskId), 'B 落盘后 A 的任务还在（没拿旧视图盖掉）')

/* ═══════════ ⑤ onDone 回调 ═══════════ */
section('⑤ finish(ok) 触发 onDone（公屏播报走这里）')

let doneGot = null
const C = new TaskRunner({ file: null, now: (() => { let t = 1000; return () => t++ })(), log: () => {}, owner: () => 'Cici', onDone: (task) => { doneGot = task } })
const tc = C.start({ kind: 'dig', item: 'stone', total: 1 })
C.finish(tc.taskId, { ok: true })
ok(doneGot?.taskId === tc.taskId && doneGot?.owner === 'Cici', 'onDone 拿到带属主的 taskBrief', JSON.stringify(doneGot?.goal))
C.start({ kind: 'dig', item: 'dirt', total: 1 })
doneGot = null
C.finish(C.current().taskId, { ok: false })
ok(doneGot === null, '失败收工不触发 onDone')

/* 无主场景（离线脚本）：不拦任何人 */
const D = new TaskRunner({ file: null, now: clockA.now, log: () => {} })
const td = D.start({ kind: 'dig', item: 'stone', total: 2 })
ok(td.owner === null && D.resume(null, {}).ok, '拿不到用户名时退化为旧行为（不拦）')

rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
