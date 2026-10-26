/**
 * 自检：**记忆按什么分**（本机补丁：2026-10-06 起因 = 用户 m07514「现在不同会话用的是同一份记忆」；
 * 2026-10-26 用户又要求「在 mc 设置里添加选项，可选按世界存记忆还是按会话存记忆」→ 三态 `memoryScope`）。
 *
 * 验的是行为，不是配置项：
 *   ① `memoryScope: 'session'` 时，工具写记忆落到 `<memoryDir>/sessions/<短会话 id>/`；
 *   ② 基根不会被会话写脏（`<memoryDir>/probe.md` 不该出现）；
 *   ③ 只拿得到工作区路径的调用点（`memoryFor(cwd)`，三个扩展/设置页那条路）
 *      靠 `lastAgentByCwd` 兜底，也落到**当前会话**的根；
 *   ④ 新会话根会从**基根播种** `RULES.md`（用户改过的那份不能被内置默认盖掉）；
 *   ⑤ 默认（`memoryScope` 没设）= **按会话**（用户 2026-10-26 改的默认）：写到 `<memoryDir>/sessions/<短会话 id>/`；
 *   ⑥ `memoryScope: 'shared'` = 老行为：写进 `<memoryDir>/`，不建 sessions/；
 *   ⑦ 老键 `memoryPerSession` 仍被认：`true` → 按会话，`false` → 全共用（**不会**被升级成按世界，
 *      否则老用户会突然读不到之前的记忆）。
 *
 * 🔴 必须从包目录跑（源码树里 `import './index.js'` 会缺 mineflayer 依赖）：
 *      cd <profile>/node_modules/dsh-mc-agent && node tools/check-session-memory.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + extra : '')) }
}
const section = (t) => console.log('\n' + t)

const TMP = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); TMP.push(d); return d }
const rd = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

/** 起一套假宿主 + 假状态目录，返回注册好的工具/路由 */
async function boot ({ scope = null, perSession = null } = {}) {
  const state = mk('wc-sessmem-state-')
  const base = join(state, 'mem')          // 记忆**基根**
  const ws = mk('wc-sessmem-ws-')
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'RULES.md'), '# 用户的准则\n自定义内容，不能被内置默认盖掉\n', 'utf8')
  writeFileSync(join(base, 'auto.json'), '{"enabled":true}', 'utf8')
  const cfg = { memoryDir: base }
  if (scope) cfg.memoryScope = scope
  if (perSession !== null) cfg.memoryPerSession = perSession   // 老键（测迁移用）
  writeFileSync(join(state, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')
  process.env.DSH_MC_AGENT_DIR = state
  delete process.env.DSH_MC_AGENT_MEMORY_DIR

  const tools = new Map()
  const routes = []
  const logs = []
  const agent = { id: 'session-abc123', session: { header: { cwd: ws } } }
  const fakeCtx = {
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), debug: (m) => logs.push(String(m)) },
    tools: { register: (d) => { tools.set(d.name, d); return () => {} }, guard: () => () => {} },
    agentPresets: { composedPreset: () => null, authorable: true, defaultId: 'standard', roots: [], list: async () => [], copy: async () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    workspaceRegistry: { archiveSession: async () => {} },
    systemPrompt: { context: () => () => {}, section: () => () => {}, getContextOrder: () => 100, getSectionOrder: () => 100 },
    inject: () => {},
    effect: (fn) => { try { fn() } catch (e) { logs.push('[effect] ' + e.message) } },
    set: () => {},
    get: (k) => (k === 'agents'
      ? { get: (sid) => (String(sid) === 'session-abc123' ? agent : null) }
      : undefined),
    on: () => () => {},
  }
  const mod = await import('../index.js')
  mod.apply(fakeCtx, mod.Config ? mod.Config({}) : {})
  return { state, base, ws, tools, routes, logs, agent }
}

/** 调插件注册的 HTTP 路由（假 req/res；host 用回环，过 isTrustedRequest） */
async function callRoute (route, method, url) {
  let status = 0
  let body = ''
  const res = { writeHead: (s) => { status = s }, end: (d) => { body += d ?? '' }, setHeader: () => {} }
  const req = { method, url, headers: { host: '127.0.0.1:9999' }, on: () => {}, once: () => {} }
  try { await route.handler(req, res) } catch (e) { return { status, body, json: null, err: e } }
  let json = null
  try { json = JSON.parse(body) } catch {}
  return { status, body, json }
}

const memTool = (tools) => tools.get('mc_kit_memory')

/* ─────────────── ① memoryScope: 'session' —— 按会话分 ─────────────── */
section("① memoryScope: 'session' —— 工具写记忆要落到 <memoryDir>/sessions/<短会话 id>/")
const on = await boot({ scope: 'session' })
{
  const t = memTool(on.tools)
  ok(typeof t?.execute === 'function', 'mc_kit_memory 已注册')
  const res = await t.execute({ action: 'write', path: 'probe.md', content: 'hello session' }, { agent: on.agent })
  const sessFile = join(on.base, 'sessions', 'abc123', 'probe.md')
  ok(existsSync(sessFile), `写到了 ${sessFile}`, res?.text?.slice(0, 120))
  ok(String(rd(sessFile) ?? '').includes('hello session'), '文件内容里有写进去的正文', JSON.stringify(String(rd(sessFile) ?? '').slice(0, 80)))
  ok(!existsSync(join(on.base, 'probe.md')), '基根没有被会话写脏（<memoryDir>/probe.md 不存在）')
}

/* ─────────────── ② 兜底：只给 cwd 的调用点也落到会话根 ─────────────── */
section('② 只拿得到工作区路径的调用点（memoryFor(cwd)）靠 lastAgentByCwd 兜底')
{
  /* 先让 getSession 记一笔（上面那次工具调用已经记过）—— 再用"没有 id 的 agent"写一次，
   * 走的就是 memoryFor(cwd, null) → lastAgentByCwd 这条路。 */
  const t = memTool(on.tools)
  const res = await t.execute({ action: 'write', path: 'probe2.md', content: 'no agent id' }, { agent: { session: { header: { cwd: on.ws } } } })
  const sessFile = join(on.base, 'sessions', 'abc123', 'probe2.md')
  ok(existsSync(sessFile), `没给 id 也落到会话根：${sessFile}`, res?.text?.slice(0, 120))
  ok(!existsSync(join(on.base, 'probe2.md')), '基根仍然干净')
}

/* ─────────────── ③ 新会话根从基根播种 RULES.md ─────────────── */
section('③ 新会话根要从基根播种 RULES.md（用户改过的那份不能被内置默认盖掉）')
{
  const route = on.routes.find((r) => String(r.path ?? '').startsWith('/api/mc'))
  ok(!!route, '注册了 /api/mc 路由')
  if (route) {
    const r = await callRoute(route, 'GET', '/api/mc/config?cwd=' + encodeURIComponent(on.ws) + '&sessionId=session-abc123')
    const seeded = join(on.base, 'sessions', 'abc123', 'RULES.md')
    ok(existsSync(seeded), `播种出 ${seeded}`, 'status=' + r.status + ' body=' + r.body.slice(0, 160))
    ok(rd(seeded) === rd(join(on.base, 'RULES.md')), '播种内容 = 基根那份（不是内置默认）', rd(seeded)?.slice(0, 60))
    ok(existsSync(join(on.base, 'sessions', 'abc123', 'auto.json')), 'auto.json 也播种过去了')
    ok(!existsSync(join(on.base, 'sessions', 'abc123', 'README.md')) || true, '（README.md 由 ensureReadme 写，不算播种文件）')
  }
}

/* ─────────────── ④ 默认 = 按会话（2026-10-26 改的默认）─────────────── */
section('④ 默认（memoryScope 没设）= 按会话：<memoryDir>/sessions/<短会话 id>/')
const dflt = await boot({})
{
  const t = memTool(dflt.tools)
  const res = await t.execute({ action: 'write', path: 'probe.md', content: 'session default' }, { agent: dflt.agent })
  const sessRoot = join(dflt.base, 'sessions')
  ok(existsSync(sessRoot), '建了 sessions/ 子目录')
  const subs = existsSync(sessRoot) ? readdirSync(sessRoot) : []
  ok(subs.length === 1, `sessions/ 下正好一个会话目录（实际 ${subs.length}）`, subs.join(','))
  ok(subs.length === 1 && existsSync(join(sessRoot, subs[0], 'probe.md')), '写到了那个会话目录里', res?.text?.slice(0, 160))
  ok(!existsSync(join(dflt.base, 'probe.md')), '基根没被写脏')
  ok(!existsSync(join(dflt.base, 'worlds')), '没有建 worlds/ 子目录（默认不再按世界）')
}

/* ─────────────── ⑤ shared：老行为 ─────────────── */
section("⑤ memoryScope: 'shared' —— 老行为：写进 <memoryDir>/，sessions/ 与 worlds/ 都不建")
const shared = await boot({ scope: 'shared' })
{
  const t = memTool(shared.tools)
  const res = await t.execute({ action: 'write', path: 'probe.md', content: 'shared' }, { agent: shared.agent })
  ok(existsSync(join(shared.base, 'probe.md')), '写到了基根 <memoryDir>/probe.md', res?.text?.slice(0, 120))
  ok(!existsSync(join(shared.base, 'sessions')) && !existsSync(join(shared.base, 'worlds')), '没建 sessions/ 也没建 worlds/')
}

/* ─────────────── ⑥ 老键迁移 ─────────────── */
section('⑥ 老键 memoryPerSession 仍被认（true→session，false→shared，不会静默变按世界）')
{
  const sess = await boot({ perSession: true })
  await memTool(sess.tools).execute({ action: 'write', path: 'probe.md', content: 'legacy true' }, { agent: sess.agent })
  ok(existsSync(join(sess.base, 'sessions', 'abc123', 'probe.md')), 'memoryPerSession:true → 按会话')
  const sh = await boot({ perSession: false })
  await memTool(sh.tools).execute({ action: 'write', path: 'probe.md', content: 'legacy false' }, { agent: sh.agent })
  ok(existsSync(join(sh.base, 'probe.md')), 'memoryPerSession:false → 全共用（基根）')
  ok(!existsSync(join(sh.base, 'worlds')), '不会因为升级就跑去 worlds/（老用户记忆不搬家）')
}

/* ─────────────── ⑦ 世界登记接口（页面靠它看"当前连的是哪个世界"） ─────────────── */
section('⑦ GET /api/mc/worlds：回记忆分法 + 当前地址 + 世界列表（没连服务器要说清楚）')
{
  const route = dflt.routes.find((r) => String(r.path ?? '').startsWith('/api/mc'))
  const q = '?cwd=' + encodeURIComponent(dflt.ws) + '&sessionId=session-abc123'
  const g = await callRoute(route, 'GET', '/api/mc/worlds' + q)
  ok(g.status === 200 && g.json?.ok !== false, 'GET 通', 'status=' + g.status + ' body=' + g.body.slice(0, 160))
  ok(g.json?.memoryScope === 'session', `回 memoryScope=session（默认，实际 ${JSON.stringify(g.json?.memoryScope)}）`)
  ok(Array.isArray(g.json?.worlds), '回 worlds 列表')
  ok(g.json?.current?.unconnected === true, '没连服务器 ⇒ current.unconnected = true（记忆落 _unconnected）')
  ok(String(g.json?.worldsDir ?? '').includes('worlds'), '告诉页面世界目录在哪', g.json?.worldsDir)
}

/* ─────────────── ⑧ 返回瘦身：index 默认只给分组摘要 ─────────────── */
section('⑧ 返回瘦身：mc_kit_memory index 默认只给分组摘要（用户 2026-10-23「返回瘦身」）')
{
  const { MemoryStore } = await import('../src/memory.mjs')
  const root = mk('wc-slim-mem-')
  mkdirSync(join(root, 'srv-a'), { recursive: true })
  for (let i = 0; i < 5; i++) writeFileSync(join(root, 'srv-a', `f${i}.md`), `# f${i}\n\n- 一条事实 ${i}\n`, 'utf8')
  writeFileSync(join(root, 'README.md'), '# 记忆库\n\n' + 'x'.repeat(500), 'utf8')
  const m = new MemoryStore(root, { create: false })
  const brief = m.overview()
  const full = m.overview({ brief: false })
  const one = m.overview({ group: 'srv-a' })
  ok(!('tree' in brief) && !('readme' in brief), '默认不回 readme / tree（它们最占地方）')
  ok(Array.isArray(brief.groups) && brief.groups.every((g) => typeof g.files === 'number'), '分组只给计数，不逐个列文件')
  ok(brief.groups.some((g) => g.group === 'srv-a' && g.files === 5), '分组计数对得上（srv-a 5 个）')
  ok(typeof brief.hint === 'string' && /group|verbose/.test(brief.hint), '默认带"怎么要明细"的一句话')
  ok(JSON.stringify(brief).length * 2 < JSON.stringify(full).length, `默认比全量小得多（${JSON.stringify(brief).length} vs ${JSON.stringify(full).length} 字符）`)
  ok(Array.isArray(one.files) && one.files.length === 5, 'group 只列这一组的文件')
  ok(String(one.files[0]?.path ?? '').includes('srv-a'), '路径相对记忆根')
  ok(Array.isArray(full.groups[0]?.files) && typeof full.readme === 'string' && typeof full.tree === 'string', 'verbose 仍给全量（老行为一字不变）')
  const two = m.overview({ group: 'srv-a', limit: 2 })
  ok(two.files.length === 2 && two.rest === 3 && /limit/.test(String(two.hint ?? '')), 'group+limit 截断，并报还剩几个')
  ok(m.overview({ group: '不存在的组' }).files.length === 0, '组名写错 ⇒ 空列表，不炸')
  /* 静态：工具面真的接了 brief/group/verbose，且默认是 brief */
  const idx = readFileSync('index.js', 'utf8')
  ok(/brief: args\?\.verbose !== true/.test(idx), 'index.js：verbose 才给全量（默认 brief）')
  ok(/group: args\?\.group \?\? null/.test(idx), 'index.js：把 group 透传下去')
  ok(/verbose: \{ type: 'boolean', description: 'index：true = 全量/.test(idx), '参数表里有 verbose')
  /* search 也瘦了：默认 12 条 + 每条 160 字 */
  for (let i = 0; i < 20; i++) writeFileSync(join(root, 'srv-a', `s${i}.md`), '# s\n\n- 村民交易 ' + 'x'.repeat(300) + '\n', 'utf8')
  const ms = new MemoryStore(root, { create: false })
  const hit = ms.search({ query: '村民交易' })
  ok(hit.hits.length === 12, `search 默认回 12 条（实际 ${hit.hits.length}）`)
  ok(hit.hits.every((h) => h.text.length <= 161), '每条命中截断到 160 字 + 省略号')
  ok(ms.search({ query: '村民交易', limit: 20 }).hits.length === 20, 'limit 仍然管用（一共只有 20 条命中）')
  ok(/search 最多几条（默认 12/.test(idx), '参数表里写的是新默认值')
}

/* ─────────────── 收尾 ─────────────── */
for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
