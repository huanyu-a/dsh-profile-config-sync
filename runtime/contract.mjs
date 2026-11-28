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

/**
 * 读契约。不存在或坏掉返回 null（调用方据此跳过校验，而不是拒绝同步）。
 *
 * 0.6.49 起契约按平台分开存（`profile/<平台>/host-contract.json`），根目录那份是老客户端写的。
 * 先读本平台分区，没有再回落到根目录 —— 否则 macOS 上读到的是 Windows 那份不完整契约，
 * 面板会误报「契约缺失 / 平台不明」。
 */
export function readContract(repoRoot, platform = '') {
  try {
    const lane = platform ? join(repoRoot, 'profile', String(platform), 'host-contract.json') : ''
    const p = lane && existsSync(lane) ? lane : contractPath(repoRoot)
    if (!existsSync(p)) return null
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    if (!doc || typeof doc !== 'object') return null
    // 老版本（上游 QcWyGm 时期）写的是一份残缺的「手写契约」：只有 appVersion + generatedAt + note，
    // 没有 electronVersion / platforms / platformFamily。那种文件里的 appVersion 常被填成
    // Electron 版本（实测 44.7.0），拿它跟本机 0.2.2-rc.5 比主版本必然「不一致」，
    // 于是 pull 被永久 block。残缺契约一律当「没有契约」：不拦同步，下次推送按现在的结构重写一份。
    const looksComplete = Array.isArray(doc.platforms) || typeof doc.electronVersion === 'string'
    if (!looksComplete) return null
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
 * 取两个版本字符串里较大的一个（只升不降）。
 *
 * 规则：
 *  - 任一侧为空 → 用另一侧；
 *  - 数字点分段逐个比（1.10.0 > 1.9.9），缺省段按 0；
 *  - 带预发布后缀（-rc.1 / -beta）视为**比同版本正式版小**；两侧都是预发布时按字符串比较；
 *  - 完全比不出来（格式异常）→ 保持既有值，不做决定。
 */
function parseVersion(v) {
  const text = String(v || '').trim()
  if (!text) return null
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(text)
  if (!m) return null
  return { nums: m[1].split('.').map((n) => Number(n) || 0), pre: m[2] || '' }
}

function pickHigherVersion(existing, local) {
  if (!existing) return local
  if (!local) return existing
  if (existing === local) return existing
  const a = parseVersion(existing)
  const b = parseVersion(local)
  if (!a || !b) return existing
  const len = Math.max(a.nums.length, b.nums.length)
  for (let i = 0; i < len; i += 1) {
    const x = a.nums[i] || 0
    const y = b.nums[i] || 0
    if (x !== y) return y > x ? local : existing
  }
  // 数字段相同：正式版 > 预发布版
  if (a.pre === b.pre) return existing
  if (!a.pre) return existing
  if (!b.pre) return local
  return b.pre > a.pre ? local : existing
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
  if (local && local.os) {
    // 大小写去重：contract 里可能已有 'windows'（老版本/手工改过），本机是 'Windows'，
    // 直接 add 会让同一个平台在清单里出现两次，跨端判断与面板显示都会看花。
    const os = String(local.os)
    const same = [...platforms].find((p) => String(p).toLowerCase() === os.toLowerCase())
    if (!same) platforms.add(os)
  }

  // appVersion / electronVersion：只升不降。
  // 旧规则是「已存在就不动」，本意是防止较旧那台把契约拉低 —— 但升级较新的那台时同样不动，
  // 于是契约永远停在旧版本号：每次 pull 都报「两端版本不同」，直到有人手工改文件。
  // 现在按版本段比较，取较大的那个；比不出来（预发布后缀、格式异常）时保持原值不动。
  const existingVersion = existing ? existing.appVersion : ''
  const localVersion = local ? String(local.dshVersion || '') : ''
  const appVersion = pickHigherVersion(existingVersion, localVersion)

  const existingElectron = existing ? existing.electronVersion : ''
  const localElectron = local ? String(local.electronVersion || '') : ''

  return {
    appVersion,
    electronVersion: pickHigherVersion(existingElectron, localElectron),
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