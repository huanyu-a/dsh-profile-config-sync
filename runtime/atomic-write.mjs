/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 *
 * 为什么需要：面板保存设置（config-sync-extra.json / dsh-config-sync.json）时，
 * capture / sync 可能正在读同一份文件。直接 writeFileSync 会让读者看到「写了一半」的内容 ——
 * 实测 reader 会读到空串或截断 JSON，capture 于是走「解析失败，按默认规则处理」，
 * 用户这次的勾选/排除规则被静默忽略。
 *
 * Windows 注意：目标文件可能正被别的进程以只读方式打开，rename 偶发 EPERM/EBUSY，
 * 所以带短重试；实在换不掉才退回直写（并清理临时文件），保证不会留下垃圾。
 */
import { chmodSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 兜底忙等 */ }
  }
}

export function writeFileAtomicSync(file, text, opts = {}) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  // 权限：显式 mode 优先；否则沿用原文件（rename 会带走权限位，不沿用就等于放宽权限）
  let wantMode = opts.mode
  if (!wantMode) {
    try { wantMode = statSync(file).mode & 0o777 } catch { wantMode = 0 }
  }
  writeFileSync(tmp, text, wantMode ? { encoding: 'utf8', mode: wantMode } : 'utf8')
  if (wantMode) {
    // writeFileSync 的 mode 会被 umask 削一刀；这里显式补回，保证 0600 真的是 0600
    try { chmodSync(tmp, wantMode) } catch { }
  }
  for (let i = 0; i < 25; i++) {
    try {
      renameSync(tmp, file)
      return true
    } catch (e) {
      const code = e && e.code
      if (i === 24 || (code && !['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(code))) break
      sleepSync(8 * (i + 1))
    }
  }
  try {
    // 退回直写：读者可能仍会看到半截，但至少内容正确、且不留临时文件
    writeFileSync(file, text, 'utf8')
    return false
  } finally {
    try { unlinkSync(tmp) } catch { }
  }
}

export function writeJsonAtomicSync(file, obj, { pretty = true, trailingNewline = true, mode } = {}) {
  const body = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)
  return writeFileAtomicSync(file, trailingNewline ? `${body}\n` : body, mode ? { mode } : {})
}