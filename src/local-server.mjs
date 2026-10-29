// -*- coding: utf-8 -*-
/**
 * dsh-mc-agent / local-server.mjs —— 本机服务端「点了连接就自己开」
 * ============================================================================
 * 2026-10-29 用户定：在「连接到MC」弹窗里点「连接」时，如果地址是**本机**
 * （`127.x.x.x` / `localhost` / `::1` / 本机网卡 IP），而这个端口还没人监听 ——
 * 插件**自己把本地服务端拉起来**，等端口就绪再让 AI 去 `mc_connect`。
 * 以前：连本机却忘了开服 ⇒ mc_connect 直接 ECONNREFUSED，AI 只能干瞪眼。
 *
 * 边界：
 *   · 只碰**本机**地址；远程服一律不碰（返回 `{ local:false }`，调用方照旧）。
 *   · 启动脚本**可配**（`localServerScript`）；不配就找 `<工作区>/server/start-server.bat`
 *     （或 `.sh` / `start.bat` / `start.sh`）—— 找不到就如实说"没找到，请手动开"，绝不猜。
 *   · 脚本自己得是幂等的（本项目的 `start-server.bat` 已经会先查 25565 再决定要不要起 java）。
 *   · 子进程 `detached + unref + stdio:'ignore'`：插件重启/退出不会把服务端带走。
 *   · 同一个 `host:port` 只允许一次在飞的启动（连点两下不会起两个 java）。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { connect } from 'node:net'

/** 默认端口（地址里没写端口时） */
export const DEFAULT_PORT = 25565
/** HTTP 侧最多等多久（秒）：再久前端会以为卡死，剩下的交给 AI 自己重试 */
export const DEFAULT_WAIT_SEC = 25
/** 启动脚本候选（在工作区 `server\` 目录下按顺序找） */
export const START_SCRIPT_NAMES = ['start-server.bat', 'start-server.sh', 'start.bat', 'start.sh']

/**
 * 拆地址：`host` / `host:port` / `[::1]:port`。
 * 🔴 拆不出来（含空格、括号、整句提示词……）就回 `host:null` —— 历史里真的有过
 *    `[system] Connect to the Minecraft server at 127.0.0.1:25565 …` 这种被误存的"地址"。
 */
export function parseAddress (address) {
  const raw = String(address ?? '').trim()
  if (!raw) return { host: null, port: DEFAULT_PORT, raw }
  const m = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d{1,5}))?$/.exec(raw)
  if (!m) return { host: null, port: DEFAULT_PORT, raw }
  const host = String(m[1] ?? m[2] ?? '').trim()
  if (!host) return { host: null, port: DEFAULT_PORT, raw }
  return { host, port: m[3] ? Number(m[3]) : DEFAULT_PORT, raw }
}

let _localIps = { at: 0, set: new Set() }
/** 本机网卡上的地址集合（30 秒缓存；`networkInterfaces()` 不便宜，别每次点连接都扫） */
export function localIpSet (now = Date.now()) {
  if (now - _localIps.at < 30_000) return _localIps.set
  const set = new Set()
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const it of list ?? []) if (it?.address) set.add(String(it.address))
    }
  } catch { /* 读不到网卡就当只有回环 */ }
  _localIps = { at: now, set }
  return set
}

/** 是不是"本机"：回环 / localhost / 0.0.0.0 / 本机网卡 IP（含 IPv6 回环） */
export function isLocalHost (host, ips = localIpSet()) {
  const h = String(host ?? '').trim().toLowerCase()
  if (!h) return false
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true
  /* 只认**纯 IPv4**：`127.0.0.1:25565` 这种带端口的原始串不算 host（先过 parseAddress） */
  if (/^127\.(\d{1,3}\.){2}\d{1,3}$/.test(h)) return true
  return ips.has(h)
}

/** TCP 探一下端口有没有人听（true = 已经在跑） */
export function probePort (host, port, { timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const target = host === 'localhost' ? '127.0.0.1' : host
    let socket = null
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      try { socket?.destroy() } catch { /* 关不掉无所谓 */ }
      resolve(ok)
    }
    try {
      socket = connect({ host: target, port })
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    } catch { done(false) }
  })
}

/** 在工作区的 `server\` 目录里找启动脚本；找不到回 null（不猜别的路径） */
export function findStartScript (workspace) {
  const ws = String(workspace ?? '').trim()
  if (!ws) return null
  const dir = join(ws, 'server')
  for (const name of START_SCRIPT_NAMES) {
    const p = join(dir, name)
    try { if (existsSync(p)) return p } catch { /* 无权读就继续试下一个 */ }
  }
  return null
}

/** 同一个 host:port 的在飞启动（连点两下不会起两个 java） */
const _inflight = new Map()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 确保本机服务端在线：探端口 → 没开就拉脚本 → 等端口就绪。
 *
 * @param {object} opts
 * @param {string} opts.address   用户点的地址（`127.0.0.1:25565` 之类）
 * @param {string} [opts.workspace] 工作区（找 `<ws>/server/start-server.bat`）
 * @param {string} [opts.script]  显式脚本路径（`localServerScript`；空 = 自动找）
 * @param {boolean} [opts.autoStart=true] false = 只探测、不启动
 * @param {number} [opts.waitSec] 最多等几秒端口就绪
 * @param {(m:string)=>void} [opts.log]
 * @param {Function} [opts.spawnFn] 测试注入
 * @param {Function} [opts.probe]   测试注入
 * @param {Function} [opts.now]
 * @returns {Promise<{local:boolean, alreadyRunning?:boolean, started?:boolean, timedOut?:boolean,
 *   noScript?:boolean, disabled?:boolean, script?:string|null, waitedMs?:number, note?:string}>}
 */
export async function ensureLocalServer ({
  address, workspace = '', script = '', autoStart = true,
  waitSec = DEFAULT_WAIT_SEC, log = () => {}, spawnFn = spawn, probe = probePort, now = Date.now,
} = {}) {
  const { host, port } = parseAddress(address)
  if (!host || !isLocalHost(host)) return { local: false }
  try {
    if (await probe(host, port)) return { local: true, alreadyRunning: true, waitedMs: 0 }
  } catch { /* 探不动就按"没开"处理，接着看脚本 */ }
  if (autoStart === false) {
    return {
      local: true, alreadyRunning: false, disabled: true,
      note: '⚠️ 本机服务端没开，而自动启动被关掉了（localServerAutoStart=false）—— 请用户先自己把服务端开起来，再连。',
    }
  }
  const file = String(script ?? '').trim() || findStartScript(workspace)
  if (!file || !existsSync(file)) {
    return {
      local: true, alreadyRunning: false, noScript: true, script: file || null,
      note: '⚠️ 本机服务端没开，也没找到启动脚本（找的是 <工作区>/server/start-server.bat；'
        + '或在普通会话 mc_admin_config set localServerScript 指定）—— 请用户手动启动服务端，再 mc_connect。',
    }
  }

  const key = `${host}:${port}`
  const t0 = now()
  let started = false
  const pending = _inflight.get(key)
  if (pending) {
    log(`${key} 已在启动中，等它就好（不重复拉）`)
    try { await pending } catch { /* 上一次失败也接着自己探 */ }
  } else {
    let child = null
    const p = (async () => {
      /* 🔴 2026-10-29 实机（Windows 11 + MC 26.1）：
       *    `detached:true + shell:true` 拉 `start-server.bat` **静默失败** —— spawn 正常返回、无报错、
       *    进程也在，但 cmd 根本没执行 bat（java 一直没起、端口一直不开）。逐个对照实测：
       *      · detached:true  + 任意 windowsHide/显式 cmd.exe ⇒ 起不来（30s 端口不动）
       *      · detached:false + stdio:'ignore' + windowsHide ⇒ **5 秒起服**（本机实测）
       *    所以 Windows 上不 detached（只 unref：不拖住插件进程；Windows 父进程退出不会连带杀子进程），
       *    POSIX 仍 detached（那是脱离会话、扛 SIGHUP 的唯一正路）。 */
      const detached = process.platform !== 'win32'
      child = spawnFn(file, [], { shell: true, cwd: dirname(file), detached, stdio: 'ignore', windowsHide: true })
      try { child?.unref?.() } catch { /* unref 不了也无所谓 */ }
      if (child?.on) child.on('error', (e) => log(`启动脚本报错：${e?.message ?? e}`))
      log(`已拉起本地服务端：${file}（detached=${detached}）`)
      started = true
    })()
    _inflight.set(key, p)
    try { await p } catch (e) { log(`拉起失败：${e?.message ?? e}`) } finally {
      /* 只挡"**拉起的这一下**"，不挡"等端口"：拉完就摘（每个调用方各自等就绪） */
      if (_inflight.get(key) === p) _inflight.delete(key)
    }
  }

  /* 等端口就绪：每秒探一次，到点如实说"还没起来"（服务端冷启动通常 20~60 秒） */
  const deadline = t0 + Math.max(0, Number(waitSec) || 0) * 1000
  while (now() < deadline) {
    await sleep(1000)
    try { if (await probe(host, port)) {
      const waitedMs = now() - t0
      log(`${key} 已就绪（等了 ${(waitedMs / 1000).toFixed(0)} 秒）`)
      return { local: true, alreadyRunning: false, started: true, script: file, waitedMs }
    } } catch { /* 探测异常接着等 */ }
  }
  const waitedMs = now() - t0
  log(`${key} 启动后 ${(waitedMs / 1000).toFixed(0)} 秒仍没就绪`)
  return {
    local: true, alreadyRunning: false, started, timedOut: true, script: file, waitedMs,
    note: `⚠️ 本机服务端已由插件拉起（${file}），但 ${Math.round(waitedMs / 1000)} 秒内端口 ${port} 还没就绪 —— `
      + '服务端冷启动通常还要 20~60 秒。先别硬撞：mc_events {waitSec:25} 等一轮，再 mc_connect；'
      + '最多再试两次。还连不上就让用户去看服务端窗口是不是报错了。',
  }
}
