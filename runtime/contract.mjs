// 宿主版本契约（profile/host-contract.json）的读写与跨端校验。
//
// 这份文件回答一个问题：**仓库里这份配置是给哪个客户端写的？**
//
// 上游只写 appVersion + electronVersion，判定「版本相同就能铺」。
// 跨端后不够：Windows 的 profile 里可能写着 Windows 专属的本地插件、
// macOS 上 `link:` 目标根本不存在。所以契约需要多记三样：
//
//   appVersion        客户端版本（原有，保留）
//   electronVersion   Electron 版本（原有，保留）
//   platforms         该配置被哪些平台验证过（新增，数组）
//   platformFamily    产出这份契约的平台族（windows / posix）
//   os / arch         产出机器的操作系统 / 架构
//
// 兼容性铁律：**旧契约没有新字段时，一律按「兼容」处理**，
// 绝不让新插件在旧仓库上拒绝拉取。新字段只用于「提示」与「决定剔除哪些 bundle」。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 契约文件在仓库里的位置（相对仓库根）。 */
export const CONTRACT_REL = 'profile/host-contract.json'

/** 契约文件路径。 */
export function contractPath(repoRoot) {
  return join(repoRoot, 'profile', 'host-contract.json')
}

/** 读契约。不存在或坏掉返回 null（调用方据此跳过校验，而不是拒绝同步）。 */
export function readContract(repoRoot) {
  try {
    const p = contractPath(repoRoot)
    if (!existsSync(p)) return null
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    if (!doc || typeof doc !== 'object') return null
    return {
      appVersion: typeof doc.appVersion === 'string' ? doc.appVersion : '',
      electronVersion: typeof doc.electronVersion === 'string' ? doc.electronVersion : '',
      // 新字段：一律宽容读取，缺失就是空
      platforms: Array.isArray(doc.platforms) ? doc.platforms.map(String).filter(Boolean) : [],
      platformFamily: typeof doc.platformFamily === 'string' ? doc.platformFamily : '',
      os: typeof doc.os === 'string' ? doc.os : '',
      arch: typeof doc.arch === 'string' ? doc.arch : '',
      // 未知字段原样保留，避免写回时丢掉别人加的东西
      raw: doc,
    }
  } catch {
    return null
  }
}

/**
 * 把「本机实测事实」合成一份契约。
 *
 * preserveExisting：若仓库里已有契约，保留它已有的 platforms 并集，
 * 只补本机平台 —— 这样契约记录的是「被哪些平台验证过」，
 * 而不是「最后是谁推的」。这正是跨端要的形态：A 机推、B 机推、
 * 契约里两个平台都在，谁拉都不被误判。
 */
export function buildContract(local, repoRoot) {
  const existing = repoRoot ? readContract(repoRoot) : null
  const platforms = new Set()
  if (existing && existing.platforms.length) {
    for (const p of existing.platforms) platforms.add(p)
  }
  if (local && local.os) platforms.add(String(local.os))

  // appVersion / electronVersion 的更新规则沿用上游：
  // 已存在且与本机不同 → 保持不变（避免较旧那台 capture 一次就把契约拉低）。
  const existingVersion = existing ? existing.appVersion : ''
  const localVersion = local ? String(local.dshVersion || '') : ''
  const appVersion = existingVersion || localVersion

  return {
    appVersion,
    electronVersion: existing && existing.electronVersion
      ? existing.electronVersion
      : String((local && local.electronVersion) || ''),
    platforms: [...platforms].sort(),
    platformFamily: String((local && local.osFamily) || (existing && existing.platformFamily) || ''),
    os: String((local && local.os) || (existing && existing.os) || ''),
    arch: String((local && local.arch) || (existing && existing.arch) || ''),
  }
}

/** 契约的序列化文本（LF、无 BOM、字段顺序稳定，便于比较是否变化）。 */
export function contractText(contract) {
  const body = {
    appVersion: contract.appVersion || '',
    electronVersion: contract.electronVersion || '',
    platforms: contract.platforms || [],
    platformFamily: contract.platformFamily || '',
    os: contract.os || '',
    arch: contract.arch || '',
  }
  return JSON.stringify(body, null, 2).replace(/\r\n/g, '\n') + '\n'
}

/**
 * 判断本机能否直接铺这份契约。
 *
 * 返回 { level, reason, dropExperimental, crossPlatform }
 *   level: ok | warn | block
 *   block 只在「主版本不同」时出现（0.2.x 的 profile 铺到 0.3.x 会起不来）；
 *   跨端本身**不是** block —— Windows 推、macOS 拉是支持的用法。
 */
export function checkContract(contract, local) {
  const c = contract || {}
  const l = local || {}
  if (!c.appVersion) {
    return { level: 'ok', reason: 'no-contract', dropExperimental: false, crossPlatform: false }
  }
  const localVersion = String(l.dshVersion || '')
  if (localVersion && localVersion !== c.appVersion) {
    const mine = majorOf(localVersion)
    const theirs = majorOf(c.appVersion)
    if (mine && theirs && mine !== theirs) {
      return {
        level: 'block',
        reason: `major-version-mismatch:${localVersion}!=${c.appVersion}`,
        dropExperimental: true,
        crossPlatform: false,
      }
    }
    // 同主版本、不同号：允许，但剔除实验性 bundle（沿用上游 -AllowVersionDrift 语义）
    return {
      level: 'warn',
      reason: `version-drift:${localVersion}!=${c.appVersion}`,
      dropExperimental: true,
      crossPlatform: false,
    }
  }
  // 版本一致：再看平台。平台不同不算问题，但要告知「这份配置来自别的平台」，
  // 面板据此提示「首次铺开后建议重启一次让 pnpm 重装原生模块」。
  const crossPlatform = Boolean(
    l.os && c.os && String(l.os) !== String(c.os),
  )
  if (crossPlatform) {
    return {
      level: 'ok',
      reason: `cross-platform:${c.os}->${l.os}`,
      dropExperimental: false,
      crossPlatform: true,
    }
  }
  return { level: 'ok', reason: '', dropExperimental: false, crossPlatform: false }
}

/** 主版本号（0.2.2-rc.5 → 0.2）。解析失败返回空串。 */
export function majorOf(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)/)
  return m ? `${m[1]}.${m[2]}` : ''
}

/**
 * 契约里是否声明了某个平台。
 * 旧契约 platforms 为空 → 视为「任何平台都认」（不做限制）。
 */
export function contractSupportsPlatform(contract, os) {
  const c = contract || {}
  if (!c.platforms || c.platforms.length === 0) return true
  return c.platforms.includes(String(os))
}