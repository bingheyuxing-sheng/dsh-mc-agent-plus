#!/usr/bin/env node
/**
 * check-brief.mjs —— 模型可见结果渲染层（`src/brief.mjs`）的回归检查
 *
 * 2026-10-29（用户给的输出规范）：执行结果与验证逻辑不动，只在传给模型时生成摘要。
 * 这里钉的是"摘要不能把关键信息省掉"：
 *   ① 成功 ⇒ 去掉现场快照（around / entities …）与诊断中间量；
 *   ② 失败 / 部分完成 ⇒ 诊断一律保留（blockedAhead / hint / remaining / reason）；
 *   ③ 多行流水超上限 ⇒ 折叠明细，但**失败与进度行一条都不许丢**；
 *   ④ 未确认（既不是成功也不是失败）不许被当成成功。
 */
import { briefOf, briefText, briefValue, BRIEF_MAX_LINES } from '../src/brief.mjs'

let pass = 0
let fail = 0
function ok (cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const json = (x) => JSON.stringify(x)

console.log('== ① 成功结果：删现场与诊断 ==')
{
  const v = {
    arrived: true,
    moved: 8.2,
    blockedAhead: { x: 1, y: 64, z: 2, name: 'stone' },
    around: [{ name: 'sheep', dist: 3 }],
    entities: [{ name: 'zombie', dist: 6 }],
    planTried: ['stepUp', 'carve'],
  }
  const out = JSON.parse(briefOf(v, { json }))
  ok(out.arrived === true && out.moved === 8.2, '结果字段原样保留（arrived / moved）', json(out))
  ok(!('around' in out) && !('entities' in out), '成功时不再重复报周围实体')
  ok(!('blockedAhead' in out) && !('planTried' in out), '成功时不再带诊断中间量')
}

console.log('== ② 失败 / 部分完成：诊断全留 ==')
{
  const v = {
    arrived: false,
    reason: 'stuck',
    remaining: 4,
    moved: 1.2,
    hint: '前面那格是台阶，头顶被堵着',
    blockedAhead: { x: 1, y: 64, z: 2, name: 'stone', cell: 'head' },
    around: [{ name: 'zombie', dist: 2 }],
  }
  const out = JSON.parse(briefOf(v, { json }))
  ok(out.reason === 'stuck' && out.remaining === 4, '失败时 reason / remaining 保留')
  ok(typeof out.hint === 'string' && out.hint.length > 0, '失败时 hint（下一步提示）保留')
  ok(out.blockedAhead?.name === 'stone', '失败时 blockedAhead（为什么走不过去）保留')
  ok(Array.isArray(out.around), '失败时现场快照保留（用来解释"被谁挡着/谁在打我"）')
}

console.log('== ③ 未确认 ≠ 成功 ==')
{
  const v = { confirmed: null, placed: 'stone', pending: true, around: [{ name: 'cow' }], blockedBy: 'dirt' }
  const out = JSON.parse(briefOf(v, { json }))
  ok(Array.isArray(out.around) && out.blockedBy === 'dirt', '既不是成功也不是失败 ⇒ 不动（不许当成功删诊断）')
}

console.log('== ④ 多行流水折叠：坏消息不丢 ==')
{
  const lines = ['挖掉 coal_ore @ (1,64,2)', '挖掉 coal_ore @ (2,64,2)', '挖掉 coal_ore @ (3,64,2)',
    '挖掉 coal_ore @ (4,64,2)', '挖掉 coal_ore @ (5,64,2)', '挖掉 coal_ore @ (6,64,2)',
    '⛔ 卡在 (7,64,2)：要去的 (7,65,2) 脚位是 stone', '够不着 iron_ore @ (9,64,2)',
    '—— 这一轮的 10 秒用完了（挖到 6/8），还有 2 个没挖：再叫一次 mc_dig 接着挖']
  const out = briefText(lines.join('\n'))
  const got = out.split('\n')
  ok(got.length <= BRIEF_MAX_LINES, `折叠后不超过 ${BRIEF_MAX_LINES} 行`, `实际 ${got.length} 行`)
  ok(/⛔ 卡在/.test(out), '失败原因行保留')
  ok(/够不着/.test(out), '够不着那行保留')
  ok(/时间|用完了|还剩|还有/.test(out), '进度 / 剩余行保留')
  ok(/明细省略/.test(out), '折叠处明说省略了多少条')
  ok(out.length < lines.join('\n').length, '折叠后确实更短', `${out.length} < ${lines.join('\n').length}`)
}

console.log('== ⑤ 短文本原样 ==')
{
  const s = '到了 (10,64,5)，这一轮没挪'
  ok(briefText(s) === s, '不超过上限的文本一个字都不动')
  const v2 = { text: s }
  ok(briefOf(v2, { json }) === s, '有 text 且很短 ⇒ 原样输出 text')
}

console.log('== ⑥ 直接值是字符串 / null ==')
{
  ok(briefOf('挖到 3 个', { json }) === '挖到 3 个', '字符串按文本处理')
  ok(briefOf(null, { json }) === '', 'null 给空串（不打印 "null"）')
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
