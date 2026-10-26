// -*- coding: utf-8 -*-
/**
 * dsh-mc-agent / worlds.mjs —— 世界登记表：记忆「按世界分」时，**哪个世界**由它说了算
 * ============================================================================
 * 用户 2026-10-26 的要求（MC 设置里加选项）：
 *   「可选按世界存记忆还是按会话存记忆」+「本地按世界存档，服务器按服务器地址」
 *   +「因为如果是 dhcp 地址有可能会变」。
 *
 * 为什么不能直接拿地址当世界标识：DHCP 一续租地址就变了，同一个世界会被当成两个，
 * 记忆**静默分裂**。所以这里做一张**登记表**（`<插件状态目录>/worlds.json`）：
 *
 *   { "version": 1,
 *     "worlds": [
 *       { "id": "w-1a2b3c4d", "name": "我的生存服", "dir": "我的生存服",
 *         "aliases": ["mc.example.com", "192.168.1.7:25565"], "local": false,
 *         "createdAt": "…", "updatedAt": "…" } ] }
 *
 *   · **aliases** 是这个世界的所有已知地址 —— DHCP 换了地址，把新地址挂到同一个 id 上即可
 *     （「MC设置 → 记忆」页里能改，不用搬文件夹）；
 *   · **dir** 是记忆根下的真实子目录名（`<记忆根>/worlds/<dir>/`）。改名会顺手迁移目录，
 *     迁不动就保留旧目录并记一行日志（宁可名字不一致，也不能把记忆弄丢）。
 *
 * 地址 key 规则（`addrKeyOf`）：
 *   · 远程：`host`（端口是默认 25565 时不带端口），如 `mc.example.com` / `1.2.3.4:25566`；
 *   · 本机 / 局域网（localhost / 127.0.0.1 / 0.0.0.0 / ::1 / 192.168.x / 10.x / 172.16-31.x / IPv6 ULA）：
 *     **按存档名**（用户手动填的 `localWorldName`），key 形如 `local:我的存档`；没填名字就退回
 *     `localhost:<端口>`（本机）或 `<ip>:<端口>`（局域网）。
 *     🔴 服务器不广播 `level-name`，插件拿不到真实存档名 —— 只能让用户填，见 `pluginConfig.localWorldName`。
 *     🔴 局域网 IP 也走这条路（用户 2026-10-26 实测反馈）：自己开服给朋友玩，入口是 DHCP 会变的 IP，
 *        拿 IP 当世界标识就会"换个 IP 记忆全丢"。
 *
 * 本模块**只做数据**（读写 json + 目录名计算 + 改名迁移），不碰记忆内容、不 import 任何宿主东西，
 * 所以能直接单测（tools/check-worlds.mjs）。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 登记表文件名（放在插件状态目录里，和 config.json / accounts.json 同级） */
export const WORLDS_FILE = 'worlds.json'
/** 还没连服务器时用的世界目录名（不是登记条目，只是落点） */
export const UNCONNECTED_KEY = '_unconnected'
/** MC 默认端口：等于它时地址 key 不带端口（`mc.example.com` 而不是 `mc.example.com:25565`） */
const DEFAULT_PORT = 25565
/** 记忆根下放世界子目录的那一层 */
export const WORLDS_DIR = 'worlds'

/** 归一化主机名：小写、去方括号（IPv6）、去空白 —— 只用于**比较**，不用于连接 */
export function normalizeHost (host) {
  let h = String(host ?? '').trim().toLowerCase()
  if (!h) return ''
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  return h
}

/** 是不是本地地址（这些地址的"世界"按**存档名**分，不按地址分） */
export function isLocalHost (host) {
  const h = normalizeHost(host)
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '::'
}

/**
 * 是不是**局域网**地址（私有网段 / 链路本地）。
 * 🔴 用户 2026-10-26 实测：「现在我用的是局域网的 192.168.1.4:25565 联机，但是还是按服务器存」
 *    —— 自己开服给朋友玩，入口是一个**会变的局域网 IP**（DHCP），跟公网服务器是两回事：
 *    局域网地址同样应该按**存档名**认，不能拿 IP 当世界标识。
 *    判据只认标准私有段（RFC1918 / IPv6 ULA / 链路本地），公网 IP 与域名一律当"远程服务器"。
 */
export function isLanHost (host) {
  const h = normalizeHost(host)
  if (!h) return false
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 10) return true                       // 10.0.0.0/8
    if (a === 192 && b === 168) return true         // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 169 && b === 254) return true         // 169.254.0.0/16（链路本地）
    return false
  }
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true   // IPv6 ULA fc00::/7
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true    // IPv6 链路本地 fe80::/10
  return false
}

/** 「自己的服」= 本机 或 局域网（这两种都按存档名认世界；公网服务器按地址认） */
export function isOwnHost (host) {
  return isLocalHost(host) || isLanHost(host)
}

/**
 * 从 MOTD 里认出**世界名**（用户 2026-10-26 发现的路子）。
 *
 * MC「对局域网开放」时，MOTD 固定是 `<玩家名> - <世界名>`（界面上那行 `Bluezi - test`，
 * 实测 ping 192.168.1.104:25565 就是这串）—— 后半段正是存档名，**服务器名称不该影响世界名**，
 * 所以只取 ` - ` **后面**那段。专用服的 MOTD 是服主随手写的，调用方要先过 `isOwnHost` 再用它。
 *
 * @param {string} motd 原始 MOTD（可能带 `§a` 这类颜色码、换行）
 * @returns {string} 世界名；认不出来返回空串
 */
export function worldNameFromMotd (motd) {
  const s = String(motd ?? '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
  if (!s) return ''
  const i = s.indexOf(' - ')
  if (i <= 0) return ''            // 没有分隔符 / 前半段是空的 ⇒ 不是这个格式
  const name = s.slice(i + 3).trim()
  if (!name || name.length > 64) return ''
  return name
}

/**
 * 连接信息 → 地址 key（登记表里 aliases 用的那个字符串）。
 * @param {{host?: string, port?: number|string}|null} conn `bot.connectionView()` 那种形态
 * @param {{localName?: string}} [opts] 存档名（用户填的；空 = 本机用 `localhost:<端口>`、局域网用 `<ip>:<端口>`）
 * @returns {string} 空串 = 拿不到地址（未连接）
 */
export function addrKeyOf (conn, { localName = '' } = {}) {
  const host = normalizeHost(conn?.host)
  if (!host) return ''
  const port = Number(conn?.port) || DEFAULT_PORT
  if (isOwnHost(host)) {
    const nm = String(localName ?? '').trim()
    // 有存档名 ⇒ 与地址无关（DHCP 换了 IP 也还是同一个世界）
    if (nm) return `local:${nm}`
    // 没填名字：本机退到 localhost，局域网就用地址（至少不会跟别的世界混）
    return isLocalHost(host) ? `localhost:${port}` : (port === DEFAULT_PORT ? host : `${host}:${port}`)
  }
  return port === DEFAULT_PORT ? host : `${host}:${port}`
}

/**
 * 世界名 → 能当目录名的安全字符串（中英文/数字/`._-`/空格可用）。
 * 🔴 Windows 的坑一个都别踩：非法字符、结尾的点与空格、开头的点（隐藏目录）。
 */
export function safeWorldDir (name) {
  const s = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
  return (s || 'world').slice(0, 48)
}

/** 世界 id（`w-` + 8 位十六进制） */
function newWorldId () {
  return 'w-' + randomBytes(4).toString('hex')
}

function nowIso () { return new Date().toISOString() }

/**
 * 世界登记表。
 *
 * 所有方法**永不抛**（读写失败只记一行日志并退回内存里的数据）：记忆是插件的本职，
 * 一张辅助表坏掉不能把 `mc_kit_memory` 一起带崩。
 */
export class WorldRegistry {
  /**
   * @param {string} file `worlds.json` 的绝对路径
   * @param {{log?: (msg: string) => void}} [opts]
   */
  constructor (file, { log = null } = {}) {
    this.file = file
    this.log = typeof log === 'function' ? log : null
    /** @type {{version: number, worlds: Array<object>}|null} */
    this.data = null
    /** 上次读盘是不是失败了（GUI 想提示时用） */
    this.loadError = null
    /**
     * 地址 → 从 MOTD 认出来的世界名（**只在内存里**，不落盘）。
     * 进服时 ping 一次写进来（`<host>:<端口>` 为键），`worldOfSession` 每次现查 ——
     * 同一个地址换了存档（MOTD 变了），下一次进服就会刷新，不需要重启。
     */
    this._motd = new Map()
  }

  /* ───────────── MOTD 认世界（内存缓存） ───────────── */

  /** 地址 key（`<host>:<端口>`）：只用于 MOTD 缓存的比对 */
  static motdKey (host, port) {
    const h = normalizeHost(host)
    if (!h) return ''
    return `${h}:${Number(port) || DEFAULT_PORT}`
  }

  /** 记下「这个地址的 MOTD 说是哪个世界」；名字空 = 清掉（比如退回到读不到 MOTD 的服） */
  setMotdWorld (host, port, name) {
    const k = WorldRegistry.motdKey(host, port)
    if (!k) return
    const nm = String(name ?? '').trim()
    if (nm) this._motd.set(k, nm)
    else this._motd.delete(k)
  }

  /** 这个地址上次认出来的世界名；没认出来返回空串 */
  motdWorld (host, port) {
    const k = WorldRegistry.motdKey(host, port)
    return k ? (this._motd.get(k) ?? '') : ''
  }

  /* ───────────── 读写 ───────────── */

  load () {
    if (this.data) return this.data
    let parsed = null
    try {
      if (existsSync(this.file)) parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (e) {
      this.loadError = e?.message ?? String(e)
      this.log?.(`世界登记表读不出来（按空表继续）：${this.loadError}`)
    }
    const list = Array.isArray(parsed?.worlds) ? parsed.worlds : []
    const worlds = []
    for (const w of list) {
      const id = String(w?.id ?? '').trim()
      const name = String(w?.name ?? '').trim()
      if (!id || !name) continue
      const aliases = Array.isArray(w?.aliases) ? w.aliases.map((a) => String(a ?? '').trim()).filter(Boolean) : []
      const dir = String(w?.dir ?? '').trim() || safeWorldDir(name)
      worlds.push({
        id,
        name,
        dir,
        aliases: [...new Set(aliases)],
        local: w?.local === true,
        createdAt: typeof w?.createdAt === 'string' ? w.createdAt : null,
        updatedAt: typeof w?.updatedAt === 'string' ? w.updatedAt : null,
      })
    }
    this.data = { version: 1, worlds }
    return this.data
  }

  save () {
    const d = this.load()
    try {
      const dir = dirname(this.file)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const tmp = `${this.file}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ version: 1, worlds: d.worlds }, null, 2) + '\n', 'utf8')
      if (existsSync(this.file)) { try { copyFileSync(this.file, `${this.file}.bak`) } catch { /* 备份失败不影响主流程 */ } }
      renameSync(tmp, this.file)
      this.loadError = null
      return true
    } catch (e) {
      this.log?.(`世界登记表写不进去（本次改动只在内存里生效）：${e?.message ?? e}`)
      return false
    }
  }

  /* ───────────── 查询 ───────────── */

  /** 全部世界（按名字排） */
  list () {
    return [...this.load().worlds].sort((a, b) => a.name.localeCompare(b.name))
  }

  get (id) {
    const key = String(id ?? '').trim()
    return this.load().worlds.find((w) => w.id === key) ?? null
  }

  /** 按地址 key 找世界（DHCP 换地址后这里是"认不认得出来"的关键） */
  byAddr (addr) {
    const key = String(addr ?? '').trim()
    if (!key) return null
    return this.load().worlds.find((w) => w.aliases.includes(key)) ?? null
  }

  /** 目录名去重：同一个记忆根下不能有两个世界共用一个目录 */
  uniqueDir (name, excludeId = null) {
    const base = safeWorldDir(name)
    const used = new Set(this.load().worlds.filter((w) => w.id !== excludeId).map((w) => w.dir))
    if (!used.has(base)) return base
    for (let i = 2; i < 1000; i++) {
      const cand = `${base}-${i}`
      if (!used.has(cand)) return cand
    }
    return `${base}-${Date.now().toString(36)}`
  }

  /* ───────────── 写入 ───────────── */

  /**
   * 找到或新建这个世界（连接成功后调用）。
   * @param {{addr: string, name?: string, local?: boolean}} o
   * @returns {object|null} 世界条目；地址为空时返回 null
   */
  ensure ({ addr, name = '', local = false } = {}) {
    const key = String(addr ?? '').trim()
    if (!key) return null
    const d = this.load()
    const found = d.worlds.find((w) => w.aliases.includes(key))
    if (found) {
      // 同一地址第二次进来：只刷新时间，不改名字（用户可能改过名）
      found.updatedAt = nowIso()
      if (local && found.local !== true) { found.local = true; this.save() }
      return found
    }
    const nm = String(name ?? '').trim()
    /* 名字就是身份（MOTD 认世界时 addr 形如 `local:<世界名>`）：
     * 「MC设置 → 记忆」里手工「新建世界」建的是**还没接地址的空壳**（aliases 为空），
     * 这里把它接上 —— 否则同一个 test 会变成 test 和 test-2 两份，记忆当场分裂。
     * 🔴 只认**空别名**的同名条目：已经有地址的同名世界是另一个世界（两台服都可能叫 test），不能并。 */
    if (nm) {
      const shell = d.worlds.find((w) => w.name === nm && w.aliases.length === 0 && w.local === Boolean(local))
      if (shell) {
        shell.aliases.push(key)
        shell.updatedAt = nowIso()
        this.save()
        return shell
      }
    }
    const entry = {
      id: newWorldId(),
      name: nm || key,
      dir: this.uniqueDir(nm || key),
      aliases: [key],
      local: Boolean(local),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    d.worlds.push(entry)
    this.save()
    return entry
  }

  /**
   * 手工新建一个**还没有地址**的世界（「MC设置 → 记忆」页的「新建世界」）。
   * 之后用 `link(addr, id)` 把地址接上来 —— 这样"先把世界建好、再决定哪个地址算它"也成立。
   */
  create ({ name, local = false } = {}) {
    const nm = String(name ?? '').trim()
    if (!nm) throw new Error('世界名不能为空')
    const d = this.load()
    const entry = {
      id: newWorldId(),
      name: nm,
      dir: this.uniqueDir(nm),
      aliases: [],
      local: Boolean(local),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    d.worlds.push(entry)
    this.save()
    return entry
  }

  /**
   * 改名（顺手把记忆目录迁过去）。
   *
   * 🔴 迁移只做"目录改名"这一件事：目标已存在就**不迁**（免得把两个世界的记忆搅在一起），
   *    迁不动也保留旧目录、只改显示名 —— 名字和目录不一致是小事，丢记忆是大事。
   * @param {string} id
   * @param {string} name 新名字
   * @param {{base?: string}} [opts] `base` = 记忆根（`<base>/worlds/<dir>`）；不给就只改名不迁目录
   */
  rename (id, name, { base = null } = {}) {
    const w = this.get(id)
    if (!w) throw new Error(`没有这个世界：${id}`)
    const nm = String(name ?? '').trim()
    if (!nm) throw new Error('世界名不能为空')
    if (nm === w.name) return { entry: w, moved: null }
    const oldDir = w.dir
    const newDir = this.uniqueDir(nm, w.id)
    let moved = null
    if (base && newDir !== oldDir) {
      const from = join(base, WORLDS_DIR, oldDir)
      const to = join(base, WORLDS_DIR, newDir)
      try {
        if (existsSync(from) && !existsSync(to)) {
          mkdirSync(dirname(to), { recursive: true })
          renameSync(from, to)
          moved = { from: oldDir, to: newDir }
        } else if (existsSync(from) && existsSync(to)) {
          this.log?.(`世界改名：目标目录已存在，记忆留在 "${oldDir}"（显示名改成 "${nm}"）`)
        }
      } catch (e) {
        this.log?.(`世界改名：目录迁移失败，记忆留在 "${oldDir}"（${e?.message ?? e}）`)
      }
    }
    w.name = nm
    if (!moved) { /* 没迁成目录：dir 保持原样，别把记忆指到空目录去 */ } else { w.dir = newDir }
    w.updatedAt = nowIso()
    this.save()
    return { entry: w, moved }
  }

  /** 把某个地址指到一个已有世界（DHCP 换地址 / 手动归并） */
  link (addr, id) {
    const key = String(addr ?? '').trim()
    if (!key) throw new Error('地址不能为空')
    const w = this.get(id)
    if (!w) throw new Error(`没有这个世界：${id}`)
    const d = this.load()
    // 一个地址只能属于一个世界：从别处摘掉
    for (const other of d.worlds) {
      if (other.id !== w.id) other.aliases = other.aliases.filter((a) => a !== key)
    }
    if (!w.aliases.includes(key)) w.aliases.push(key)
    w.updatedAt = nowIso()
    this.save()
    return w
  }

  /** 摘掉一个地址（摘完没地址了也留着世界 —— 记忆还在，别让目录变孤儿） */
  unlink (addr) {
    const key = String(addr ?? '').trim()
    const d = this.load()
    let hit = null
    for (const w of d.worlds) {
      if (!w.aliases.includes(key)) continue
      w.aliases = w.aliases.filter((a) => a !== key)
      w.updatedAt = nowIso()
      hit = w
    }
    if (hit) this.save()
    return hit
  }

  /**
   * 删掉登记条目（`purge:true` 才连记忆目录一起删）。
   * 默认**只删登记**：目录留在盘上，用户还能自己捞。
   */
  remove (id, { base = null, purge = false } = {}) {
    const d = this.load()
    const i = d.worlds.findIndex((w) => w.id === String(id ?? '').trim())
    if (i < 0) throw new Error(`没有这个世界：${id}`)
    const [w] = d.worlds.splice(i, 1)
    this.save()
    if (purge && base) {
      try { rmSync(join(base, WORLDS_DIR, w.dir), { recursive: true, force: true }) } catch (e) {
        this.log?.(`删世界目录失败：${e?.message ?? e}`)
      }
    }
    return w
  }

  /** 给前端/工具看的视图（不含磁盘路径，路径由 index.js 拼） */
  viewOf (w, { addr = null } = {}) {
    if (!w) return null
    return {
      id: w.id,
      name: w.name,
      dir: w.dir,
      aliases: [...w.aliases],
      local: w.local === true,
      // 当前连的地址是不是登记在这个世界名下（DHCP 换了地址时这里是 false）
      matchesCurrent: addr ? w.aliases.includes(String(addr)) : null,
      updatedAt: w.updatedAt,
    }
  }
}
