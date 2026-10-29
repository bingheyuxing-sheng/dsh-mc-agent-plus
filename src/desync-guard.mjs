// desync-guard.mjs —— 失步自愈（2 分钟攒 3 次 local-vs-server 不一致 ⇒ 自动 force 重连）
// 移植自 local-0.4.3 分支（2f73fcd），配合 mining.mjs / place.mjs 的失步埋点使用。
// 设计要点：
// - noteDesync 只记账 + 判定，fire-and-forget 触发 healDesync，绝不拖住调用方；
// - 重连冷却 10 分钟，避免反复重连刷屏；
// - 重连后把当前任务记回台账（mc_task resume 复核续做），别从头重做。

export const DESYNC_WINDOW_MS = 120_000
export const DESYNC_TRIGGER = 3
export const DESYNC_HEAL_COOLDOWN_MS = 10 * 60_000

// 注：这里只输出提示文本，不在工具 note 里直接输出工具
export function desyncHealNote (heal = null) {
  return heal?.healing
    ? '　🩹 2 分钟内方块状态已经对不上 3 次 —— **我已自动 force 重连**（公屏会报"失步已重连"）；'
      + '重连回来后先 `mc_task {action:"resume"}` 复核续做被打断的活，别从头重做。'
    : ''
}

export function noteDesync (self, reason = '') {
  const now = Date.now()
  const arr = (self._desyncAt = (self._desyncAt ?? []).filter((t) => now - t < DESYNC_WINDOW_MS))
  arr.push(now)
  if (arr.length < DESYNC_TRIGGER) return { count: arr.length, healing: false }
  self._desyncAt = []
  if (self._desyncHealAt && now - self._desyncHealAt < DESYNC_HEAL_COOLDOWN_MS) {
    try { self.log(`⚠️ 失步又攒满 ${DESYNC_TRIGGER} 次（${reason}），但自愈重连还在冷却…`) } catch {}
    return { count: arr.length, healing: false, cooling: true }
  }
  if (self.stopped || !self.online || self.reconnecting || self.reconnectPending || self.connecting) {
    return { count: arr.length, healing: false }
  }
  self._desyncHealAt = now
  // fire-and-forget：自愈失败也不拖住调用方
  healDesync(self, reason).catch((e) => { try { self.log('失步自愈重连没成功：' + (e?.message ?? e)) } catch {} })
  return { count: arr.length, healing: true }
}

export async function healDesync (self, reason = '') {
  try { self.chatSay('检测到方块状态失步（本地和服务端对不上），自动重连同步一下，几秒就好') } catch {}
  try { self.log(`🩹 失步自愈：2 分钟内攒满 ${DESYNC_TRIGGER} 次 local-vs-server 不一致（${reason}）—— force 重连`) } catch {}
  await self.connect({ ...(self._connectOpts ?? {}), force: true })
  try { self.chatSay('失步已重连，世界状态重新同步了') } catch {}
  try {
    const t = self.tasks?.current?.()
    if (t && !['done', 'cancelled'].includes(t.status)) {
      self.tasks.note(t.taskId, '失步自愈重连回来了：方块状态已重新同步，先 mc_task {action:"resume"} 复核再接着干（别从头重做）')
    }
  } catch {}
  try { self.emit('desync-heal', { reason, at: Date.now() }) } catch {}
  return { reconnected: true }
}
