// -*- coding: utf-8 -*-
/**
 * dsh-mc-agent / serverhistory.mjs —— 「连接到MC」弹窗的**服务器地址历史**（全局）
 * ============================================================================
 * 用户在弹窗里**手动**连过的服务器地址（**只存地址字符串**，不存账户、不存凭据）。
 * 落盘：`<状态目录>/servers.json`（= `$DSH_HOME/dsh-mc-agent/servers.json`）—— **全局**，不按工作区。
 *
 * 规矩：
 *   · 只记"在本弹窗里点「连接」"的地址；**局域网探测到的直连不记**（调用方负责别调 `record`）；
 *   · 去重、最近优先、封顶 {@link MAX_SERVERS} 条；
 *   · 读宽容（坏文件按空跑、绝不抛）、写克制（失败只记 `lastError`）。
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** 文件名（与 accounts.json / config.json 同在状态目录根级） */
export const SERVERS_FILE = 'servers.json'
/** 封顶条数 */
export const MAX_SERVERS = 20

/**
 * 像不像一个服务器地址（`host` / `host:port` / `[::1]:port`）。
 * 🔴 2026-10-29 实机：历史里真出现过
 *    `[system] Connect to the Minecraft server at 127.0.0.1:25565 using the account …`
 *    （整句注入提示词被粘进地址框点了「连接」），以及 `127.0.0.125565` 这种断行拼错的。
 *    这些"地址"点一下就填进输入框、还会被本机判定逻辑当成本机 —— 一律不收，读盘时也清掉。
 */
export function isPlausibleAddress (address) {
  const a = String(address ?? '').trim()
  if (!a || a.length > 260) return false
  if (/[\s()（）【】<>"'`,;]/.test(a)) return false
  if (/^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/.test(a)) return true
  if (!/^[A-Za-z0-9._-]+(?::\d{1,5})?$/.test(a)) return false
  /* 纯数字+点 = 当成 IPv4 就必须**是** IPv4：`127.0.0.125565`（端口粘到 IP 后面）不是地址 */
  const host = a.replace(/:\d{1,5}$/, '')
  if (!/^[\d.]+$/.test(host)) return true
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every((n) => Number(n) <= 255)
}

export class ServerHistory {
  /** @param {{dir:string, log?:(msg:string)=>void}} opts dir = 状态目录（`$DSH_HOME/dsh-mc-agent`；自检里是临时目录） */
  constructor ({ dir, log } = {}) {
    this.dir = dir
    /* 🔴 2026-10-26 审计：原来 record() 里写的是 `this.logger?.warn?.(...)`，可这个类**从来没有**
     *   logger 字段（构造参数里没它、也没人往里塞）⇒ 那行永远静默，"存不下"用户完全看不见。
     *   现在改成构造时传一个 log 函数（index.js 传 logLine）。 */
    this.log = typeof log === 'function' ? log : null
    this.file = join(dir, SERVERS_FILE)
    this.data = { version: 1, recent: [] }
    this.lastError = null
    this._loadFailed = false
    this._loadError = null
    this.load()
  }

  load () {
    try {
      if (!existsSync(this.file)) { this.data = { version: 1, recent: [] }; return }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      const raw = Array.isArray(parsed?.recent)
        ? parsed.recent.map((x) => String(x ?? '').trim()).filter(Boolean)
        : []
      /* 🔴 2026-10-29：不是地址的一律不收（见 `isPlausibleAddress`）；读盘时顺手清一遍旧脏数据 */
      const recent = raw.filter((a) => isPlausibleAddress(a))
      this.cleaned = raw.length - recent.length
      this.data = { version: 1, recent }
      if (this.cleaned > 0) this.save()   // 清掉脏条目后立刻落盘（写失败只记 lastError，不影响读）
    } catch (e) {
      this.data = { version: 1, recent: [] }
      this.lastError = `服务器历史读取失败（已按空跑）：${e.message}`
      /* 🟡 2026-10-15 审计（报告 E 第 9 条）：`lastError` 全仓无人读 ⇒ 读失败静默按空跑。
       *   另开一对只读访问器给 UI 用（见 `loadFailed` / `loadError`）。 */
      this._loadFailed = true
      this._loadError = this.lastError
    }
  }

  save () {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      /* 🟡 2026-10-15 审计（报告 E 第 9 条）：原来直接 `writeFileSync` —— 写一半断电/被杀就留下
       *   半个 JSON（下次启动就是"读失败"，历史全空）。与 `src/wsconfig.mjs:112-116` 统一成
       *   先写临时文件再 rename（同分区上原子）。 */
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
      renameSync(tmp, this.file)
      return true
    } catch (e) {
      this.lastError = `服务器历史写入失败：${e.message}`
      this._report(this.lastError)
      return false
    }
  }

  /** 内部：失败上报（没有上报口就静默） */
  _report (msg) {
    if (!this.log) return
    try { this.log(msg) } catch { /* 上报失败无所谓 */ }
  }

  /** 最近优先的地址列表（副本） */
  list () { return this.data.recent.slice() }

  /** 读失败过没有（`load()` 里按空跑时的原因）—— UI 用它提示"历史可能丢了" */
  get loadFailed () { return Boolean(this._loadFailed) }
  get loadError () { return this._loadError ?? null }

  /** 记一条（去重、最近优先、封顶）。空串/不像地址的忽略。返回最新列表。 */
  record (address) {
    const addr = String(address ?? '').trim()
    if (!addr || !isPlausibleAddress(addr)) return this.list()
    this.data.recent = [addr, ...this.data.recent.filter((a) => a !== addr)].slice(0, MAX_SERVERS)
    /* 存不下时 save() 内部会 _report（2026-10-26 审计：原来这里调 this.logger?.warn?，而 logger 从没被赋值） */
    this.save()
    return this.list()
  }

  /** 删一条（没这条就原样）。返回最新列表。 */
  remove (address) {
    const addr = String(address ?? '').trim()
    this.data.recent = this.data.recent.filter((a) => a !== addr)
    this.save()
    return this.list()
  }
}
