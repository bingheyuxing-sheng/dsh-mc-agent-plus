/**
 * 自检：**世界登记表**（`src/worlds.mjs`）—— 记忆「按世界分」时"哪个世界"由它说了算。
 *
 * 起因（用户 2026-10-26）：「在 mc 设置里添加选项，可选按世界存记忆还是按会话存记忆」
 *   + 「因为如果是 dhcp 地址有可能会变」。
 * ⇒ 世界不能用地址当身份（DHCP 一续租就分裂），得有一张**可编辑的「地址 → 世界」对应表**。
 *
 * 验的是：
 *   ① 地址 key 规则（远程按 host[:port]、本地按存档名、未连接给空串）；
 *   ② 世界名 → 目录名的 Windows 坑（非法字符 / 结尾点与空格 / 开头点 / 空名 / 超长）；
 *   ③ 登记表读写：新建 / 按地址认领 / 目录去重 / 改名迁移目录 / 目标已存在时不迁 / 删登记不删目录；
 *   ④ `memoryScope` 三态归一（含老键 `memoryPerSession` 兜底、垃圾值不炸）；
 *   ⑤ 静态：`index.js` 的记忆根真的按三态分支（防止以后被人改回"只有一个开关"）。
 *
 * 🔴 纯逻辑，不起宿主、不连游戏：
 *      node tools/check-worlds.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorldRegistry, WORLDS_FILE, WORLDS_DIR, UNCONNECTED_KEY, addrKeyOf, isLanHost, isLocalHost, isOwnHost, normalizeHost, safeWorldDir, worldNameFromMotd } from '../src/worlds.mjs'
import { memoryScopeOf } from '../src/config.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + extra : '')) }
}
const section = (t) => console.log('\n' + t)
const TMP = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); TMP.push(d); return d }
const rd = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

/* ─────────────── ① 地址 key ─────────────── */
section('① addrKeyOf：远程按 host[:port]，本地按存档名，未连接给空串')
{
  ok(addrKeyOf({ host: 'mc.example.com', port: 25565 }) === 'mc.example.com', '默认端口不带端口')
  ok(addrKeyOf({ host: 'mc.example.com', port: 25566 }) === 'mc.example.com:25566', '非默认端口要带上')
  ok(addrKeyOf({ host: 'MC.Example.COM', port: 25565 }) === 'mc.example.com', '主机名归一成小写（大小写不该分裂世界）')
  ok(addrKeyOf({ host: ' 1.2.3.4 ', port: 25565 }) === '1.2.3.4', '去掉首尾空白')
  ok(addrKeyOf({ host: 'localhost', port: 25565 }, { localName: '我的存档' }) === 'local:我的存档', '本地服 + 存档名 → 按存档名')
  ok(addrKeyOf({ host: '127.0.0.1', port: 25566 }) === 'localhost:25566', '本地服没填存档名 → localhost:端口')
  ok(addrKeyOf({ host: '127.0.0.1', port: 25566 }, { localName: '   ' }) === 'localhost:25566', '存档名只有空白 = 没填')
  ok(addrKeyOf(null) === '' && addrKeyOf({}) === '', '没连接 → 空串（调用方据此落 _unconnected）')
  ok(addrKeyOf({ host: '[::1]', port: 25565 }) === 'localhost:25565', 'IPv6 回环方括号要剥掉')
  ok(isLocalHost('localhost') && isLocalHost('127.0.0.1') && isLocalHost('0.0.0.0') && isLocalHost('::1'), '本地地址都认')
  ok(!isLocalHost('mc.example.com') && !isLocalHost('192.168.1.7'), '远程地址不算本地')
  ok(normalizeHost('[::1]') === '::1', 'normalizeHost 去方括号')

  /* 🔴 用户 2026-10-26 实测：「现在我用的是局域网的 192.168.1.4:25565 联机，但是还是按服务器存」
   *    ⇒ 局域网地址必须跟本机一样走"存档名"，不能拿会变的 IP 当世界标识。 */
  ok(addrKeyOf({ host: '192.168.1.4', port: 25565 }, { localName: '123' }) === 'local:123',
    '局域网 + 存档名 → 按存档名（用户实测这条）')
  ok(addrKeyOf({ host: '192.168.1.104', port: 25565 }, { localName: '123' }) === 'local:123',
    'DHCP 换了 IP 也还是同一个世界')
  ok(addrKeyOf({ host: '10.0.0.5', port: 25566 }, { localName: '存档A' }) === 'local:存档A', '10.x 私有段同样按存档名')
  ok(addrKeyOf({ host: '172.20.1.9', port: 25565 }, { localName: 'x' }) === 'local:x', '172.16-31 私有段同样')
  ok(addrKeyOf({ host: '192.168.1.4', port: 25565 }) === '192.168.1.4',
    '局域网没填存档名 → 用地址（至少不跟别的世界混）')
  ok(addrKeyOf({ host: '8.8.8.8', port: 25565 }, { localName: '123' }) === '8.8.8.8', '公网 IP 仍按地址（存档名只管自己的服）')
  ok(addrKeyOf({ host: 'mc.example.com', port: 25565 }, { localName: '123' }) === 'mc.example.com', '域名仍按地址')
  ok(isLanHost('192.168.1.4') && isLanHost('10.1.2.3') && isLanHost('172.16.0.1')
    && isLanHost('172.31.255.255') && isLanHost('169.254.1.1'), '私有 / 链路本地 IPv4 都算局域网')
  ok(!isLanHost('172.32.0.1') && !isLanHost('8.8.8.8') && !isLanHost('mc.example.com') && !isLanHost('192.169.1.1'),
    '公网与私有段边界外不算局域网')
  ok(isLanHost('fd00::1') && isLanHost('fe80::1'), 'IPv6 ULA / 链路本地算局域网')
  ok(isOwnHost('localhost') && isOwnHost('192.168.1.4') && !isOwnHost('mc.example.com'), 'isOwnHost = 本机 or 局域网')
}

/* ─────────────── ② 目录名安全 ─────────────── */
section('② safeWorldDir：Windows 的坑一个都别踩')
{
  ok(safeWorldDir('我的生存服') === '我的生存服', '中文照用')
  ok(!/[\\/:*?"<>|]/.test(safeWorldDir('a/b\\c:d*e?f"g<h>i|j')), '非法字符被换掉')
  ok(safeWorldDir('世界.') === '世界', '结尾的点去掉（Windows 建不出）')
  ok(safeWorldDir('世界  ') === '世界', '结尾空格去掉')
  ok(!safeWorldDir('..隐藏').startsWith('.'), '开头的点去掉（别变隐藏目录）')
  ok(safeWorldDir('') === 'world' && safeWorldDir(null) === 'world', '空名给个兜底名')
  ok(safeWorldDir('x'.repeat(200)).length <= 48, '超长截断（≤48）')
  ok(safeWorldDir('a\nb') === 'ab', '控制字符去掉')
}

/* ─────────────── ③ 登记表 ─────────────── */
section('③ WorldRegistry：新建 / 认领 / 去重 / 改名迁移 / 删除')
{
  const state = mk('wc-worlds-state-')
  const base = join(state, 'mem')
  mkdirSync(base, { recursive: true })
  const file = join(state, WORLDS_FILE)
  const reg = new WorldRegistry(file)

  const a = reg.ensure({ addr: 'mc.example.com', name: 'mc.example.com' })
  ok(!!a?.id && a.dir === 'mc.example.com', '第一次连接自动登记一个世界', JSON.stringify(a))
  ok(reg.byAddr('mc.example.com')?.id === a.id, '按地址能认回来')
  ok(reg.byAddr('1.2.3.4') === null, '没登记过的地址认不出来（返回 null）')

  /* DHCP 换地址：把新地址挂到同一个世界 */
  reg.link('192.168.1.7:25565', a.id)
  ok(reg.byAddr('192.168.1.7:25565')?.id === a.id, 'DHCP 换了地址，link 之后还是同一个世界')
  ok(reg.list().length === 1, '还是只有一个世界（没有分裂）')

  /* 一个地址只能属于一个世界 */
  const b = reg.ensure({ addr: 'mc2.example.com', name: 'mc2.example.com' })
  reg.link('192.168.1.7:25565', b.id)
  ok(reg.byAddr('192.168.1.7:25565')?.id === b.id, '同一个地址指到新世界后，从旧世界摘掉了')
  ok(!reg.get(a.id).aliases.includes('192.168.1.7:25565'), '旧世界不再持有这个地址')

  /* 目录名去重（两个世界同名也不能共用一个目录） */
  const c = reg.create({ name: 'mc2.example.com' })
  ok(c.dir !== b.dir, `同名世界目录自动去重（${b.dir} vs ${c.dir}）`)
  ok(reg.create({ name: '空岛服' }).dir === '空岛服', 'create 的世界还没地址（等着 link）')
  ok(reg.get(c.id).aliases.length === 0, '新建的世界 alias 为空')

  /* 改名：目录要跟着迁 */
  const dirOld = join(base, WORLDS_DIR, a.dir)
  mkdirSync(dirOld, { recursive: true })
  writeFileSync(join(dirOld, 'world.md'), '# 老世界\n', 'utf8')
  const r = reg.rename(a.id, '我的生存服', { base })
  ok(r.entry.name === '我的生存服', '名字改了')
  ok(!!r.moved, '目录跟着迁了', JSON.stringify(r.moved))
  ok(existsSync(join(base, WORLDS_DIR, r.entry.dir, 'world.md')), '记忆文件跟着到了新目录（没丢）')
  ok(!existsSync(dirOld), '旧目录没了')

  /* 目标目录已存在 → 不迁，只改名（宁可名字不一致，也不能把两份记忆搅在一起）
   * 造法：'我的生存服' 已被 a 占着 ⇒ 去重后目标是 '我的生存服-2'，提前把这个目录建出来。 */
  const d = reg.create({ name: '占位' })
  mkdirSync(join(base, WORLDS_DIR, d.dir), { recursive: true })
  mkdirSync(join(base, WORLDS_DIR, '我的生存服-2'), { recursive: true })
  const r2 = reg.rename(d.id, '我的生存服', { base })
  ok(r2.moved === null && r2.entry.dir === d.dir, '目标目录已存在时不迁（dir 保持原样）', JSON.stringify({ moved: r2.moved, dir: r2.entry.dir }))
  ok(existsSync(join(base, WORLDS_DIR, d.dir)), '原目录照旧在（记忆没被搬走）')

  /* 删登记：默认只删登记，目录留在盘上 */
  const e = reg.create({ name: '要删的' })
  const eDir = join(base, WORLDS_DIR, e.dir)
  mkdirSync(eDir, { recursive: true })
  writeFileSync(join(eDir, 'tasks.md'), '# 任务\n', 'utf8')
  reg.remove(e.id, { base })
  ok(reg.get(e.id) === null, '登记条目删掉了')
  ok(existsSync(join(eDir, 'tasks.md')), '默认**不**删记忆目录（用户还能自己捞）')

  /* purge:true 才连目录一起删 */
  const f = reg.create({ name: '彻底删的' })
  const fDir = join(base, WORLDS_DIR, f.dir)
  mkdirSync(fDir, { recursive: true })
  reg.remove(f.id, { base, purge: true })
  ok(!existsSync(fDir), 'purge:true 才删目录')

  /* 落盘 + 重读一致（进程重启后记忆还能认回同一个世界） */
  const reg2 = new WorldRegistry(file)
  ok(reg2.byAddr('mc.example.com')?.name === '我的生存服', '写进文件了，重新加载还在', JSON.stringify(reg2.list().map((w) => w.name)))
  ok(JSON.parse(rd(file) ?? '{}').version === 1, '文件带 version')

  /* 视图：matchesCurrent 告诉页面"当前连的是不是它" */
  const v = reg2.viewOf(reg2.byAddr('mc.example.com'), { addr: 'mc.example.com' })
  ok(v.matchesCurrent === true && Array.isArray(v.aliases), 'viewOf 标出当前连接是不是这个世界')

  /* 坏文件不能把记忆带崩：读不出来就按空表继续 */
  const bad = join(state, 'bad-worlds.json')
  writeFileSync(bad, '{ 这不是 json', 'utf8')
  const reg3 = new WorldRegistry(bad)
  ok(Array.isArray(reg3.list()) && reg3.list().length === 0, '登记表坏了 → 按空表继续（不抛）')
  ok(typeof reg3.loadError === 'string', 'loadError 留给页面提示')
}

/* ─────────────── ④ memoryScope 三态 ─────────────── */
section('④ memoryScopeOf：三态归一 + 老键兜底 + 垃圾值不炸')
{
  ok(memoryScopeOf('world') === 'world' && memoryScopeOf('session') === 'session' && memoryScopeOf('shared') === 'shared', '三个合法值原样返回')
  ok(memoryScopeOf('  WORLD  ') === 'world', '大小写 / 空白都能容忍')
  ok(memoryScopeOf(undefined) === 'session', '没设 = 按会话（默认值，2026-10-26 用户要求改的）')
  ok(memoryScopeOf('瞎写的') === 'session', '垃圾值退回默认（按会话），不炸')
  ok(memoryScopeOf(undefined, { perSession: true }) === 'session', '老键 memoryPerSession:true → 按会话')
  ok(memoryScopeOf(undefined, { perSession: false }) === 'shared', '老键 memoryPerSession:false → 全共用（老用户记忆不搬家）')
  ok(memoryScopeOf('shared', { perSession: true }) === 'shared', '新键优先（老键只在新键缺失时兜底）')
  ok(UNCONNECTED_KEY === '_unconnected' && WORLDS_DIR === 'worlds', '落点常量没被乱改')
}

/* ─────────────── ⑤ 静态：index.js 真的按三态分支 ─────────────── */
section('⑤ 静态：记忆根按 memoryScope 三态分支（别被人改回"只有一个开关"）')
{
  const idx = readFileSync('index.js', 'utf8')
  ok(/if \(scope === 'shared'\) return base/.test(idx), 'shared → 直接给基根')
  ok(/if \(scope === 'session'\) return id \? join\(base, 'sessions'/.test(idx), 'session → sessions/<短会话 id>')
  ok(/join\(base, WORLDS_DIR, w\.dir\)/.test(idx), 'world → worlds/<世界目录>')
  ok(/join\(base, WORLDS_DIR, UNCONNECTED_KEY\)/.test(idx), '没连接 → worlds/_unconnected')
  ok(/const worldOfSession = /.test(idx), '有 worldOfSession（按连接信息认世界）')
  ok(/path === '\/api\/mc\/worlds'/.test(idx), '有 /api/mc/worlds 接口（页面要能改地址→世界）')
  const cfg = readFileSync('src/config.mjs', 'utf8')
  ok(/memoryScope: 'session'/.test(cfg), 'DEFAULT_CONFIG 里 memoryScope 默认 session（2026-10-26 改的）')
  ok(cfg.includes("top === 'memoryScope'"), 'validate 认 memoryScope')
  ok(cfg.includes("top === 'localWorldName'"), 'validate 认 localWorldName')
}

/* ─────────────── ⑥ MOTD 认世界（用户 2026-10-26：「界面那行 Bluezi - test」） ─────────────── */
section('⑥ MOTD 里认世界名（`<玩家名> - <世界名>`，只取后半段）')
{
  ok(worldNameFromMotd('Bluezi - test') === 'test', '`Bluezi - test` → test')
  ok(worldNameFromMotd('Bluezi - 123') === '123', '`Bluezi - 123` → 123（同一地址换存档）')
  ok(worldNameFromMotd('§aBluezi §7- §ftest') === 'test', '颜色码先剥掉再认')
  ok(worldNameFromMotd('Bluezi - test\n') === 'test', '换行不影响')
  ok(worldNameFromMotd('欢迎来到我的服') === '', '没有 ` - ` ⇒ 空串（专用服 MOTD 不乱认）')
  ok(worldNameFromMotd(' - test') === '', '前半段空 ⇒ 空串')
  ok(worldNameFromMotd('') === '' && worldNameFromMotd(null) === '', '空 / null ⇒ 空串')
  ok(worldNameFromMotd('A - b - c') === 'b - c', '只在**第一个** ` - ` 处切（世界名自己带 ` - ` 也不丢）')
  ok(worldNameFromMotd('A - ' + 'x'.repeat(65)) === '', '后半段过长（>64）⇒ 空串，别拿它当目录名')

  const dir = mkdtempSync(join(tmpdir(), 'mcmotd-'))
  TMP.push(dir)
  const reg = new WorldRegistry(join(dir, WORLDS_FILE))
  ok(reg.motdWorld('192.168.1.104', 25565) === '', '没学过 ⇒ 空串')
  reg.setMotdWorld('192.168.1.104', 25565, 'test')
  ok(reg.motdWorld('192.168.1.104', 25565) === 'test', '学过就能查到')
  ok(reg.motdWorld('192.168.1.104', '25565') === 'test', '端口给字符串也认')
  ok(reg.motdWorld('192.168.1.104', undefined) === 'test', '端口缺省按 25565')
  ok(reg.motdWorld('192.168.1.104', 25566) === '', '换了端口就不是同一个地址')
  ok(reg.motdWorld('192.168.1.105', 25565) === '', '换了 IP 也不是')
  reg.setMotdWorld('192.168.1.104', 25565, '')
  ok(reg.motdWorld('192.168.1.104', 25565) === '', '传空 = 清掉旧缓存（别拿旧世界名硬套）')
  ok(reg.setMotdWorld('', 25565, 'x') === undefined && reg.motdWorld('', 25565) === '', '地址空 ⇒ 什么也不做')
  ok(!existsSync(join(dir, 'motd.json')), 'MOTD 缓存只在内存，不落盘')

  const idx = readFileSync('index.js', 'utf8')
  ok(/const learnWorldFromMotd = async/.test(idx), 'index.js 有 learnWorldFromMotd')
  ok(/worlds\.motdWorld\(host, conn\?\.port\) \|\| pluginConfig\.localWorldName/.test(idx),
    'worldOfSession：MOTD 认出来的世界名**优先于**手填的存档名')
  ok(/await learnWorldFromMotd\(sess\)/.test(idx), 'mc_connect 里真的调了（且赶在 attachChatLog 之前）')
  ok(idx.indexOf('await learnWorldFromMotd(sess)') < idx.indexOf('const chatLogRoot = attachChatLog'),
    '顺序对：先认世界，再算聊天记录落点')
  ok(/if \(!host \|\| !isOwnHost\(host\)\) return ''/.test(idx), '专用服不认 MOTD（只认自己开的服）')

  /* ensure 得认「空壳世界」：手工新建的 test 一旦被 MOTD 认到，要接上而不是另建 test-2 */
  const d2 = mkdtempSync(join(tmpdir(), 'mcensure-'))
  TMP.push(d2)
  const reg2 = new WorldRegistry(join(d2, WORLDS_FILE))
  const shell = reg2.create({ name: 'test', local: true })
  const got = reg2.ensure({ addr: 'local:test', name: 'test', local: true })
  ok(got.id === shell.id, '同名空壳世界被接上地址（不会另建 test-2）')
  ok(got.aliases.includes('local:test'), '地址挂上了')
  ok(reg2.list().length === 1, '没多出重复条目')
  ok(reg2.ensure({ addr: 'local:test', name: 'test', local: true }).id === shell.id, '再进一次还是同一个')
  ok(reg2.ensure({ addr: 'local:test', name: '改过的名字', local: true }).name === 'test',
    '已经挂上地址后，名字以用户改过的为准（不被 MOTD 覆盖）')
  const other = reg2.ensure({ addr: 'local:another', name: 'test', local: true })
  ok(other.id !== shell.id && other.dir === 'test-2',
    '两台服都叫 test：地址不同就是两个世界，目录自动避让')

  const d3 = mkdtempSync(join(tmpdir(), 'mcensure2-'))
  TMP.push(d3)
  const reg3 = new WorldRegistry(join(d3, WORLDS_FILE))
  const remote = reg3.ensure({ addr: 'mc.example.com', name: 'test', local: false })
  const lanShell = reg3.create({ name: 'test', local: true })
  const lan = reg3.ensure({ addr: 'local:test', name: 'test', local: true })
  ok(remote.id !== lan.id && lan.id === lanShell.id, '远程同名世界不会被本地空壳抢走（local 标记也要对上）')
}

/* ─────────────── 收尾 ─────────────── */
for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
