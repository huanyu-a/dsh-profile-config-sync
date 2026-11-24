// 客户端身份层 —— 回答「同步云端时要不要按客户端分备份」。
//
// 结论：**不分叉仓库，只在仓库里为每台机器留一份身份记录**。
//
// 为什么不按客户端分仓库/分支：
//   - `profile/package.json`、`settings/*.json`、`skills/`、`presets/`、`prompt/AGENTS.md`
//     是**用户意图**，与 OS 无关。分叉后改一个插件要改 N 份，必然漂移。
//   - `conversations/`、`workspace/` 是**同一份历史**。分叉等于让用户失去跨机会话。
//   - 真正因平台而异的只有两样：`link:` 目标与会话 cwd —— 它们在仓库里已经是
//     `{{APP_ROOT}}` / `{{DSH_HOME}}` / `{{WORKSPACE_HOME}}` 占位符，
//     拉取时按本机根展开，天然跨端。分叉的收益是 0。
//
// 所以这里做的是「身份登记」而非「内容分叉」：
//   仓库里 `machines/<id>.json` 记录每台机器的平台/版本/本机根/最后同步时间。
//   用途有三：
//     1. 拉取时判断「这份配置来自哪个平台」→ 版本漂移与实验性 bundle 的判据；
//     2. 面板显示「上次同步来自哪台机器、什么系统」；
//     3. 冲突与覆盖提示里说清「本机 vs 云端（来自 <machine>）」。
//
// 兼容性：旧仓库没有 `machines/` 也能跑（首次推送时生成）。读取一律宽容：
// 读不到、解析失败、字段缺失都返回 null，绝不阻塞同步。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { hostname, platform, release, arch } from 'node:os'
import { join } from 'node:path'
import { IS_MAC, IS_WIN, platformFamily, platformLabel } from './platform.mjs'

/** 仓库里存身份的目录（相对仓库根）。 */
export const MACHINES_DIR = 'machines'

/**
 * 生成本机机器 ID。
 *
 * 不随机：同机重启必须得到同一个 id（否则每次推送都新建一份，清单会爆炸）。
 * 组成：平台族 + 主机名 + 用户名 hash 的短码。
 * 用 hash 而非明文用户名：机器 id 会进仓库，用户名算半敏感信息。
 */
export function machineId() {
  const os = platformFamily()
  const host = String(hostname() || 'unknown').trim() || 'unknown'
  let user = ''
  try { user = String(process.env.USER || process.env.USERNAME || '').trim() } catch { /* 忽略 */ }
  // 主机名里常有空格/点（macOS 的 "xxx's MacBook"），清洗成路径安全的短名
  const safeHost = host.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'host'
  if (!user) return `${os}-${safeHost}`
  // 极轻量的确定性 hash（不需要 crypto，避免 id 里出现 +/= 等需转义字符）
  let h = 0
  for (let i = 0; i < user.length; i++) h = ((h << 5) - h + user.charCodeAt(i)) | 0
  const tag = Math.abs(h).toString(36).slice(0, 4).padStart(4, '0')
  return `${os}-${safeHost}-${tag}`
}

/**
 * 本机的完整身份记录（写入 machines/<id>.json）。
 *
 * 刻意**不记**的东西：仓库路径、远端地址、SSH 私钥路径 —— 那些是本机私有设置，
 * 已经在本机 `dsh-config-sync.json` 里，进仓库等于泄露本机目录结构。
 */
export function localMachineInfo(extra = {}) {
  return {
    id: machineId(),
    // 平台标识与 process.platform 一致，便于脚本判断
    os: platform(),
    osLabel: platformLabel(),
    osFamily: platformFamily(),
    osRelease: (() => { try { return release() } catch { return '' } })(),
    arch: (() => { try { return arch() } catch { return '' } })(),
    hostname: (() => { try { return hostname() } catch { return '' } })(),
    // 与 profile/package.json 无关的本机事实，用于「这份配置能不能直接铺到本机」判断
    dshVersion: extra.dshVersion || '',
    appRoot: extra.appRoot || '',
    dshHome: extra.dshHome || '',
    workspaceHome: extra.workspaceHome || '',
    // 最后一次动作与时间：面板要显示「上次同步来自哪台」
    lastSyncAt: extra.lastSyncAt || '',
    lastMode: extra.lastMode || '',
    // 推上去的配置里包含哪些组（本机勾选的结果快照，仅作参考，不是权威）
    pluginCount: extra.pluginCount || 0,
    updatedAt: new Date().toISOString(),
  }
}

/** machines 目录路径。 */
export function machinesDir(repoRoot) {
  return join(repoRoot, MACHINES_DIR)
}

/** 某台机器的身份文件路径。 */
export function machineFile(repoRoot, id) {
  return join(machinesDir(repoRoot), `${sanitizeId(id)}.json`)
}

/**
 * 机器 id 落盘前清洗：只允许字母数字 . _ -，
 * 防止 id 里出现路径分隔符或 `..` 把写入引到仓库外。
 */
export function sanitizeId(id) {
  const s = String(id || '').trim()
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '').replace(/\.{2,}/g, '.')
  return cleaned.slice(0, 96) || 'unknown'
}

/**
 * 写本机身份。任何失败都不抛 —— 身份只是元数据，
 * 写不进去不该让整次推送失败（同步本体不依赖它）。
 *
 * 返回 { ok, path, error }。
 */
export function writeMachineInfo(repoRoot, info) {
  try {
    const dir = machinesDir(repoRoot)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const id = sanitizeId(info && info.id)
    const payload = { ...info, id }
    const text = JSON.stringify(payload, null, 2).replace(/\n/g, '\n') + '\n'
    const path = machineFile(repoRoot, id)
    writeFileSync(path, text, 'utf8')
    return { ok: true, path, id }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

/**
 * 读某台机器的身份。不存在或坏掉返回 null。
 */
export function readMachineInfo(repoRoot, id) {
  try {
    const p = machineFile(repoRoot, id)
    if (!existsSync(p)) return null
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    return (doc && typeof doc === 'object') ? doc : null
  } catch {
    return null
  }
}

/**
 * 列出仓库里所有已登记的机器身份，按最后同步时间倒序。
 *
 * 读不动的文件直接跳过（一台机器的坏记录不能让整个列表不可用）。
 */
export function listMachines(repoRoot) {
  const out = []
  let names = []
  try {
    names = readdirSync(machinesDir(repoRoot))
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const info = readMachineInfo(repoRoot, name.slice(0, -5))
    if (!info) continue
    out.push({
      id: info.id || name.slice(0, -5),
      os: info.os || '',
      osLabel: info.osLabel || info.os || '',
      osFamily: info.osFamily || '',
      arch: info.arch || '',
      hostname: info.hostname || '',
      dshVersion: info.dshVersion || '',
      lastSyncAt: info.lastSyncAt || '',
      lastMode: info.lastMode || '',
      updatedAt: info.updatedAt || '',
      pluginCount: Number(info.pluginCount) || 0,
    })
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return out
}

/**
 * 判断某台机器（默认本机）与「仓库里的版本契约」是否兼容。
 *
 * 跨端不是错误：Windows 推、macOS 拉是支持的用法。真正要拦的只有两种：
 *   - 宿主大版本不同（0.2.x vs 0.3.x）→ bundle 清单可能不兼容；
 *   - 实验性 bundle 在目标平台不存在 → 拉取时按契约剔除。
 *
 * 返回 { compatible, reason, level }，level: ok | warn | block。
 */
export function checkMachineCompatibility(machine, contract) {
  const m = machine || {}
  const c = contract || {}
  if (!c.appVersion) {
    return { compatible: true, level: 'ok', reason: 'no-contract' }
  }
  if (m.dshVersion && c.appVersion && m.dshVersion !== c.appVersion) {
    const mine = majorOf(m.dshVersion)
    const theirs = majorOf(c.appVersion)
    if (mine && theirs && mine !== theirs) {
      return {
        compatible: false,
        level: 'block',
        reason: `major-version-mismatch:${m.dshVersion}!=${c.appVersion}`,
      }
    }
    return {
      compatible: true,
      level: 'warn',
      reason: `version-drift:${m.dshVersion}!=${c.appVersion}`,
    }
  }
  // 平台不同不算问题（正是跨端要支持的），只在提示里说明
  if (m.os && c.os && m.os !== c.os) {
    return { compatible: true, level: 'ok', reason: 'cross-platform' }
  }
  return { compatible: true, level: 'ok', reason: '' }
}

/** 取主版本号（0.2.2-rc.5 → 0.2）。解析失败返回空串。 */
export function majorOf(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)/)
  return m ? `${m[1]}.${m[2]}` : ''
}

/**
 * 本机身份摘要（给面板显示用）。
 * 面板不该看到一堆裸字段，所以这里收成一个短对象。
 */
export function localMachineSummary(extra) {
  const info = localMachineInfo(extra)
  return {
    id: info.id,
    label: `${info.osLabel}${info.arch ? ` · ${info.arch}` : ''}`,
    os: info.os,
    osFamily: info.osFamily,
    arch: info.arch,
    dshVersion: info.dshVersion,
    isWindows: IS_WIN,
    isMac: IS_MAC,
  }
}