/**
 * 自检：**换世界时提示词要重投**（`src/inject.mjs` 的 `reconcileNotices` / `enterWithNotices`）
 *
 * 起因（用户 2026-10-26）：「一个会话连两个世界会怎么样」→ 查出来：同一个会话从 A 世界切到 B 世界，
 * 三条指针（`RULES.md` / 版本提示 / 记忆索引）**一条都不重投** —— 投递台账的指纹只有 `preset|版本`，
 * 不含记忆根。后果：提示里的绝对路径还指着 A 世界，B 世界的记忆索引也拿不到。
 *
 * 验的是：
 *   ① 首次进一个世界 → 投 3 条（RULES 指针 / 版本提示 / 记忆索引）；
 *   ② 同一世界再来一轮 → 一条都不投（幂等，别每轮刷屏）；
 *   ③ **换世界 → 重新投 3 条**（本文件的核心）；
 *   ④ 宿主重启后按会话日志去重：**同一个世界**不重复投；
 *   ⑤ 宿主重启后**换了世界** → 仍要投（只看文件名会误判成"投过"，得靠 anchor 绝对路径区分）；
 *   ⑥ 静态：指纹里带记忆根、三条指针都带 anchor（防止以后被人改回"只看 preset"）。
 *
 * 🔴 纯逻辑，不起宿主、不连游戏：
 *      node tools/check-inject-scope.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInjector } from '../src/inject.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + extra : '')) }
}
const section = (t) => console.log('\n' + t)

const ROOT_A = join('C:', 'mem', 'worlds', '甲')
const ROOT_B = join('C:', 'mem', 'worlds', '乙')

/** 造一个"根可切换"的依赖包：其余 deps 用 Proxy 兜底成空函数（createInjector 只解构、不调用）。 */
const makeDeps = (getRoot) => {
  const lastPresetSeen = new Map()
  const base = {
    DEFAULT_AGENTS_MD: '默认准则',
    MC_PLUS_NOTICE_TEXT: '',
    PLUGIN_VERSION: '9.9.9',
    VERSION_PROMPT_FILE: '版本提示.md',
    agentIdOf: () => 'a1',
    isMcModeAgent: () => true,
    isMcPlusAgent: () => false,
    workspaceOf: () => join('C:', 'ws'),
    workspaceRootFor: () => join('C:', 'ws'),
    noteAgent: () => {},
    wsCfgValues: () => ({ injectWorkspaceAgentsMd: false, injectDshMcAgentAgentsMd: true }),
    memoryBaseFor: () => join('C:', 'mem'),
    memoryRootFor: () => getRoot(),
    memoryFor: () => ({ root: getRoot(), list: () => [], indexText: () => '' }),
    ensureAgentsMdFile: () => {},
    readAgentsMd: () => ({ path: join(getRoot(), 'RULES.md'), source: 'default' }),
    readVersionPrompt: () => ({ path: join(getRoot(), '版本提示.md') }),
    versionPromptSource: () => 'v9.9.9.md',
    versionPromptTitle: () => '版本提示 v9.9.9',
    userMessage: (o) => o,
    lastPresetSeen,
    logLine: () => {},
    logDebug: () => {},
    logOnce: () => {},
  }
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => {}) })
}

const makeAgent = (events = []) => ({
  id: 'a1',
  ctx: {},
  inbox: { nextStep: [] },
  session: { snapshotEvents: () => events },
})

const step = (inj, agent) => {
  const d = inj.enterWithNotices(agent, { kind: 'enter', messages: [] })
  return Array.isArray(d?.messages) ? d.messages : []
}

/* ─────────────── ① ~ ③ 台账按世界记账 ─────────────── */
section('① 首次进世界 → 投 3 条；同世界再来 → 0 条；换世界 → 再投 3 条')
{
  let root = ROOT_A
  const inj = createInjector(makeDeps(() => root))
  const agent = makeAgent()

  const first = step(inj, agent)
  ok(first.length === 3, '首次进 A 世界投 3 条（RULES 指针 / 版本提示 / 记忆索引）', first.length)
  ok(first.some((m) => String(m.content?.[0]?.text ?? '').includes('.dsh-mc-agent/RULES.md')), '其中有 RULES.md 指针')
  ok(first.some((m) => String(m.content?.[0]?.text ?? '').includes(ROOT_A)), '指针里写的是 A 世界的绝对路径')

  ok(step(inj, agent).length === 0, '同一世界再来一轮 → 一条都不投（幂等）')

  root = ROOT_B
  const switched = step(inj, agent)
  ok(switched.length === 3, '🔴 换到 B 世界 → 重新投 3 条（本文件的核心断言）', switched.length)
  ok(switched.some((m) => String(m.content?.[0]?.text ?? '').includes(ROOT_B)), '新指针指向 B 世界')
  ok(!switched.some((m) => String(m.content?.[0]?.text ?? '').includes(ROOT_A)), '不再出现 A 世界的路径')

  root = ROOT_A
  ok(step(inj, agent).length === 3, '切回 A 世界 → 再投一遍（世界来回切都跟着走）')

  ok(step(inj, agent).length === 0, '切回后再来一轮 → 0 条')
}

/* ─────────────── ④ 重启后同世界不重复投 ─────────────── */
section('④ 宿主重启（台账丢了、会话日志还在）：同一个世界不重复投')
{
  let root = ROOT_A
  const inj = createInjector(makeDeps(() => root))
  const warm = makeAgent()
  const sent = step(inj, warm)
  const events = sent.map((m) => ({ type: 'user/message', data: m }))
  ok(events.length === 3, '先造 3 条"已经投过"的会话日志')

  const rebooted = makeAgent(events)
  ok(step(inj, rebooted).length === 0, '重启后同一个世界 → 0 条（读日志认出投过了）')
}

/* ─────────────── ⑤ 重启后换世界仍要投 ─────────────── */
section('⑤ 宿主重启后换了世界 → 仍要投（只看文件名会误判）')
{
  let root = ROOT_A
  const inj = createInjector(makeDeps(() => root))
  const warm = makeAgent()
  const events = step(inj, warm).map((m) => ({ type: 'user/message', data: m }))

  root = ROOT_B
  const rebooted = makeAgent(events)
  const again = step(inj, rebooted)
  ok(again.length === 3, '日志里只有 A 世界的提示、现在在 B → 照投 3 条（anchor 区分开了目录）', again.length)
}

/* ─────────────── ⑥ 静态：别被改回"只看 preset" ─────────────── */
section('⑥ 静态：指纹带记忆根、三条指针都带 anchor')
{
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const src = readFileSync(join(dir, 'src', 'inject.mjs'), 'utf8')
  ok(/const fp = `\$\{preset\}\|\$\{PLUGIN_VERSION\}\|\$\{memoryRootFor\(cwd\)\}`/.test(src),
    '指纹 = preset|版本|记忆根（少了记忆根就会重现"换世界不重投"）')
  ok(src.includes('anchor: cur.path'), 'RULES.md 指针带 anchor（自己的绝对路径）')
  ok(src.includes('anchor: vp.path'), '版本提示指针带 anchor')
  ok(src.includes('anchor: String(memoryFor(cwd).root'), '记忆索引带 anchor（记忆根）')
  ok(src.includes('if (it.anchor && !text.includes(it.anchor)) continue'),
    '去重时 anchor 必须参与判断（只比 rel 会把别的世界的记录算成"投过"）')
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
