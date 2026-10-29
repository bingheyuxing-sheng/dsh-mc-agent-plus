#!/usr/bin/env node
/**
 * 「点了连接就自己开」的离线自检（2026-10-29 用户定）。
 *
 * 两件事：
 *   ① `src/local-server.mjs` —— 地址是本机 + 端口没开 ⇒ 拉起 `<工作区>/server/start-server.bat`，
 *      等端口就绪；远程服一律不碰；找不到脚本/被关掉/等超时都如实说。
 *   ② `src/serverhistory.mjs` —— 历史里**只收真地址**（实机混进过整句注入提示词）。
 *
 * 不真起服务端、不连外网：spawn 与端口探测全部注入假实现。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

const M = await import(new URL('../src/local-server.mjs', import.meta.url))
const {
  parseAddress, isLocalHost, findStartScript, probePort, ensureLocalServer,
  DEFAULT_PORT, START_SCRIPT_NAMES,
} = M
const H = await import(new URL('../src/serverhistory.mjs', import.meta.url))
const { ServerHistory, isPlausibleAddress, SERVERS_FILE } = H

/* ═══════════ ① 地址解析 ═══════════ */
section('① 地址解析：host[:port] / [::1]:port / 拆不出来的整句')

ok(parseAddress('127.0.0.1:25565').host === '127.0.0.1' && parseAddress('127.0.0.1:25565').port === 25565, 'host:port')
ok(parseAddress('example.com').port === DEFAULT_PORT, `不带端口 ⇒ ${DEFAULT_PORT}`)
const v6 = parseAddress('[::1]:25566')
ok(v6.host === '::1' && v6.port === 25566, '[::1]:25566 拆得开')
const junk = parseAddress('[system] Connect to the Minecraft server at 127.0.0.1:25565 using the account X')
ok(junk.host === null, '整句提示词拆不出来（host:null）')
ok(parseAddress('').host === null && parseAddress('   ').host === null, '空串 ⇒ host:null')

/* ═══════════ ② 本机判定 ═══════════ */
section('② 本机判定（只有本机才自动开服）')

ok(isLocalHost('127.0.0.1') && isLocalHost('127.9.9.9'), '127.x.x.x 都是本机')
ok(isLocalHost('localhost') && isLocalHost('::1') && isLocalHost('0.0.0.0'), 'localhost / ::1 / 0.0.0.0')
ok(!isLocalHost('example.com') && !isLocalHost('8.8.8.8'), '外网/域名不算本机')
ok(!isLocalHost('127.0.0.1:25565'), '带端口的字符串不当 host 判（先 parseAddress）')
ok(isLocalHost('192.168.1.50', new Set(['192.168.1.50'])), '本机网卡 IP 算本机（注入的网卡集合）')

/* ═══════════ ③ 找启动脚本 ═══════════ */
section('③ 找启动脚本：只认 <工作区>/server/…')

const dir = mkdtempSync(join(tmpdir(), 'local-server-'))
const ws = join(dir, 'ws')
mkdirSync(join(ws, 'server'), { recursive: true })
ok(findStartScript(ws) === null, '目录在但没脚本 ⇒ null（不猜）')
const bat = join(ws, 'server', START_SCRIPT_NAMES[0])
writeFileSync(bat, '@echo off\n', 'utf8')
ok(findStartScript(ws) === bat, `找到 ${START_SCRIPT_NAMES[0]}`)
ok(findStartScript('') === null && findStartScript(null) === null, '没工作区 ⇒ null')

/* ═══════════ ④ 真实端口探测 ═══════════ */
section('④ probePort：真 socket（本地临时端口）')

const srv = createServer((s) => s.end())
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port
ok(await probePort('127.0.0.1', port, { timeoutMs: 500 }) === true, '有人监听 ⇒ true')
await new Promise((r) => srv.close(r))
ok(await probePort('127.0.0.1', port, { timeoutMs: 500 }) === false, '关掉后 ⇒ false')

/* ═══════════ ⑤ ensureLocalServer 各分支 ═══════════ */
section('⑤ ensureLocalServer：远程不碰 / 已在跑 / 关掉 / 没脚本 / 拉起来 / 超时')

let spawnCount = 0
const spawnRec = { file: null, opts: null }
const fakeSpawn = (file, args, opts) => {
  spawnCount++
  spawnRec.file = file
  spawnRec.opts = opts
  return { on: () => {}, unref: () => {} }
}

const remote = await ensureLocalServer({ address: 'mc.example.com:25565', workspace: ws, spawnFn: fakeSpawn, probe: async () => false })
ok(remote.local === false && spawnCount === 0, '远程服一律不碰（不 spawn）')

const running = await ensureLocalServer({
  address: '127.0.0.1:25565', workspace: ws, spawnFn: fakeSpawn, probe: async () => true,
})
ok(running.local === true && running.alreadyRunning === true && spawnCount === 0, '端口已在听 ⇒ 直接过、不 spawn')

const disabled = await ensureLocalServer({
  address: '127.0.0.1:25565', workspace: ws, autoStart: false, spawnFn: fakeSpawn, probe: async () => false,
})
ok(disabled.disabled === true && /自动启动被关掉/.test(disabled.note ?? '') && spawnCount === 0, 'autoStart:false ⇒ 只提示')

const noScript = await ensureLocalServer({
  address: '127.0.0.1:25565', workspace: join(dir, 'empty-ws'), spawnFn: fakeSpawn, probe: async () => false,
})
ok(noScript.noScript === true && /没找到启动脚本/.test(noScript.note ?? '') && spawnCount === 0, '没脚本 ⇒ 提示手动开、不瞎起')

/* 拉起来：前两次探不到、第三次探到（1 秒一轮 ⇒ 约 2 秒） */
let probes = 0
const started = await ensureLocalServer({
  address: '127.0.0.1:25565', workspace: ws, spawnFn: fakeSpawn, waitSec: 8,
  probe: async () => { probes++; return probes >= 3 },
})
ok(started.local === true && started.started === true && started.timedOut !== true, '拉起后等到端口就绪 ⇒ started')
ok(spawnCount === 1 && String(spawnRec.file).endsWith(START_SCRIPT_NAMES[0]), 'spawn 的就是那个脚本')
ok(spawnRec.opts?.stdio === 'ignore' && spawnRec.opts?.windowsHide === true, 'stdio:ignore + windowsHide（不弹窗、不拖住插件）')
/* 🔴 2026-10-29 实机：Windows 下 detached+shell 拉 bat 会静默失败 ⇒ Windows 必须不 detached（细节见模块注释） */
ok(spawnRec.opts?.detached === (process.platform !== 'win32'), `detached 只在非 Windows 上开（当前 ${process.platform}）`, `detached=${spawnRec.opts?.detached}`)
ok(spawnRec.opts?.cwd === join(ws, 'server'), 'cwd = 脚本所在目录（脚本里用的是相对路径）')

const timedOut = await ensureLocalServer({
  address: '127.0.0.1:25565', workspace: ws, spawnFn: fakeSpawn, waitSec: 0, probe: async () => false,
})
ok(timedOut.timedOut === true && /mc_events \{waitSec:25\}/.test(timedOut.note ?? ''), '等超时 ⇒ 如实说 + 告诉 AI 怎么重试')

/* 连点两下：同一个 host:port 只 spawn 一次 */
spawnCount = 0
let slowProbes = 0
const slowProbe = async () => { slowProbes++; return slowProbes > 4 }
const both = await Promise.all([
  ensureLocalServer({ address: '127.0.0.1:25565', workspace: ws, spawnFn: fakeSpawn, waitSec: 3, probe: slowProbe }),
  ensureLocalServer({ address: '127.0.0.1:25565', workspace: ws, spawnFn: fakeSpawn, waitSec: 3, probe: slowProbe }),
])
ok(spawnCount === 1, '连点两下只 spawn 一次', `spawn=${spawnCount}`)
ok(both.every((r) => r.local === true && r.timedOut !== true), '两次调用都能等到就绪')

/* ═══════════ ⑥ 历史只收真地址 ═══════════ */
section('⑥ 服务器历史：只收真地址（实机混进过整句提示词）')

ok(isPlausibleAddress('127.0.0.1:25565') && isPlausibleAddress('example.com') && isPlausibleAddress('[::1]:25566'),
  '正常地址通过')
ok(!isPlausibleAddress('[system] Connect to the Minecraft server at 127.0.0.1:25565 using the account X'),
  '整句提示词被拒（含空格）')
ok(!isPlausibleAddress('127.0.0.125565'), '端口 6 位（断行拼错）被拒')
ok(!isPlausibleAddress('') && !isPlausibleAddress('a'.repeat(300)), '空串 / 超长被拒')

const hdir = join(dir, 'state')
mkdirSync(hdir, { recursive: true })
writeFileSync(join(hdir, SERVERS_FILE), JSON.stringify({
  version: 1,
  recent: ['127.0.0.1:25565', '[system] Connect to the Minecraft server at 127.0.0.1:25565 using the account X', '127.0.0.125565'],
}), 'utf8')
const hist = new ServerHistory({ dir: hdir })
ok(hist.list().length === 1 && hist.list()[0] === '127.0.0.1:25565', '读盘时清掉脏条目（只留真地址）', hist.list().join(','))
ok(JSON.parse(readFileSync(join(hdir, SERVERS_FILE), 'utf8')).recent.length === 1, '清完立刻落盘（不是只在内存里）')
hist.record('[system] Connect to the Minecraft server at 127.0.0.1:25565')
ok(hist.list().length === 1, 'record 也拒脏地址（键盘粘错不会污染历史）')
hist.record('mc.example.com:25566')
ok(hist.list()[0] === 'mc.example.com:25566', '正常地址照记')

rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
