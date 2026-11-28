// 「插件数据」/「额外路径」两组的判定规则 —— Host 面板与 Node 引擎共用同一份。
//
// 为什么要挪出来
//   这两组的规则（单文件上限 / 排除通配 / 跳过的目录 / 安全必需项）原先只写在 index.js 里，
//   于是 macOS / Linux 的引擎（runtime/sync-engine.mjs）压根不知道这些规则，也就没法抓这两组。
//   规则一旦两份实现，迟早走样（0.6.15 就出过一次：JS 侧漏了 browser-profiles，
//   面板把几千个文件的 mtime 算成「待推送」，而 capture 根本不会抓它们）。
//   所以规则只认这个文件，engine 与 index.js 都从这里 import。

import { readdirSync as readdirSyncImpl, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const EXTRA_CONFIG_NAME = 'config-sync-extra.json'
/** GitHub 单文件硬上限 100MB，超过必被拒收，所以配置里调多大都按这个封顶。 */
export const EXTRA_HARD_MAX_BYTES = 104857600
export const EXTRA_DEFAULT_SKIP_DIRS = [
  'profiles', 'skills', '.agent-presets', 'storages', 'sessions', 'attachments', 'logs', 'backups',
  'update-staging', 'electron', 'dsh-runtimes', 'dsh-market', '.dsh-plugin-market', 'dsh-session-manager',
  'browser-profiles', 'im', 'node_modules',
]
export const EXTRA_DEFAULT_EXCLUDE = [
  '*.db', '*.db-*', '*.db3', '*.sqlite', '*.sqlite3', '*.sqlite-*', '*.db-shm', '*.db-wal',
  '*.node', '*.exe', '*.dll', '*.asar', '*.pak', '*.bin', '*.iso', '*.img',
  '*.zip', '*.7z', '*.rar', '*.tar', '*.gz', '*.tgz', '*.mp4', '*.mkv', '*.avi',
  '*.log', '*.log.*', '*.tmp', '*.bak', '*.bak-*', '*.old', '*.orig', '*.swp',
  '*.env', '.env*', 'config-sync-gh.json', 'config-sync-feedback-outbox.json', 'dsh-config-sync.json', 'dsh-ssh-master.key',
  'api-key', '*.pem', '*.key', '*.p12', '*.pfx', '*.crt',
  '*cache*', '*token*', '*secret*', '*credential*', '*password*', '*vault*',
  'browser-profiles', 'User Data', 'Login Data', 'Cookies', 'Web Data', 'Local State',
  'node_modules', '.git', '.cache', '__pycache__', '.venv',
]

/**
 * 安全必需项：用户自己的 config-sync-extra.json 不允许把它们去掉。
 * 与 runtime/dsh-sync-common.ps1 的 $SyncExtraMandatorySkipDirs / $SyncExtraMandatoryExcludes 同一份名单。
 *
 * 起因（实测）：exclude / skipDirs 是「整份替换」语义，用户早先存下的旧快照会让新加的
 * browser-profiles 规则整条失效 —— 那目录里有几千个文件、268MB，含密码库与登录态。
 */
export const EXTRA_MANDATORY_SKIP_DIRS = ['browser-profiles']
export const EXTRA_MANDATORY_EXCLUDES = ['browser-profiles', 'User Data', 'Login Data', 'Cookies', 'Web Data', 'Local State']

export function extraConfigPath(dshHome) { return join(dshHome, EXTRA_CONFIG_NAME) }

export function wildcardToRegex(pat) {
  const esc = String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, 'i')
}

export function topUpExtraMandatory(cfg) {
  if (!cfg || !cfg.pluginData) return { skipDirs: [], exclude: [] }
  const addedSkip = EXTRA_MANDATORY_SKIP_DIRS.filter((x) => !(cfg.pluginData.skipDirs || []).includes(x))
  const addedExcl = EXTRA_MANDATORY_EXCLUDES.filter((x) => !(cfg.pluginData.exclude || []).includes(x))
  if (addedSkip.length) cfg.pluginData.skipDirs = [...(cfg.pluginData.skipDirs || []), ...addedSkip]
  if (addedExcl.length) cfg.pluginData.exclude = [...(cfg.pluginData.exclude || []), ...addedExcl]
  return { skipDirs: addedSkip, exclude: addedExcl }
}

/** 读规则文件；缺文件 / 坏 JSON 都退回默认（不让整页读不出来）。 */
export function readExtraConfig(dshHome) {
  const cfg = {
    version: 1,
    pluginData: {
      enabled: true,
      maxFileBytes: EXTRA_HARD_MAX_BYTES,
      exclude: [...EXTRA_DEFAULT_EXCLUDE],
      skipDirs: [...EXTRA_DEFAULT_SKIP_DIRS],
    },
    extra: { enabled: true, paths: [] },
  }
  const p = extraConfigPath(dshHome)
  let raw = ''
  try { raw = readFileSync(p, 'utf8') } catch { return cfg }
  try {
    const j = JSON.parse(raw)
    const pd = j && j.pluginData
    if (pd) {
      if (pd.enabled === false) cfg.pluginData.enabled = false
      const n = Number(pd.maxFileBytes)
      if (Number.isFinite(n) && n > 0) cfg.pluginData.maxFileBytes = Math.min(Math.floor(n), EXTRA_HARD_MAX_BYTES)
      // 排除名单整份替换：用户在面板里删掉一条就真的不再排除
      if (Array.isArray(pd.exclude)) cfg.pluginData.exclude = pd.exclude.filter((x) => typeof x === 'string' && x)
      if (Array.isArray(pd.skipDirs)) cfg.pluginData.skipDirs = pd.skipDirs.filter((x) => typeof x === 'string' && x)
    }
    const ex = j && j.extra
    if (ex) {
      if (ex.enabled === false) cfg.extra.enabled = false
      if (Array.isArray(ex.paths)) {
        cfg.extra.paths = ex.paths
          .filter((x) => x && typeof x.id === 'string' && typeof x.src === 'string' && x.id && x.src)
          .map((x) => ({ id: x.id, src: x.src, label: typeof x.label === 'string' && x.label ? x.label : x.id }))
      }
    }
  } catch { /* 坏了就按默认规则走 */ }
  const added = topUpExtraMandatory(cfg)
  if (added.skipDirs.length || added.exclude.length) {
    cfg.pluginData.missingMandatory = { skipDirs: added.skipDirs, exclude: added.exclude }
  }
  return cfg
}

/** 返回跳过原因（'' = 允许同步），与 runtime/dsh-sync-common.ps1 的 Test-SyncExtraSkip 判定一致。 */
export function extraSkipReason(relName, size, cfg) {
  const max = Math.min(cfg.pluginData.maxFileBytes || EXTRA_HARD_MAX_BYTES, EXTRA_HARD_MAX_BYTES)
  if (size > max) return 'too-big'
  if (!relName) return ''
  const parts = String(relName).split(/[\\/]+/).filter((x) => x)
  const name = parts.length ? parts[parts.length - 1] : relName
  for (const pat of cfg.pluginData.exclude || []) {
    const re = wildcardToRegex(pat)
    if (re.test(name)) return 'excluded'
    for (const seg of parts) if (re.test(seg)) return 'excluded'
  }
  return ''
}

/**
 * 插件数据槽：`<DshHome>` 的一级目录（跳过系统/已覆盖目录与隐藏目录）。
 * 与 dsh-sync-common.ps1 的 Get-PluginDataSlots 同一份语义，只是不带统计（引擎不需要）。
 */
export function listPluginDataSlots(dshHome, cfg) {
  const skip = new Set((cfg && cfg.pluginData && cfg.pluginData.skipDirs) || [])
  let entries = []
  try { entries = readdirSync2(dshHome) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (skip.has(e.name)) continue
    if (e.name.startsWith('.')) continue
    out.push({ id: e.name, src: join(dshHome, e.name) })
  }
  return out
}

function readdirSync2(dir) { return readdirSyncImpl(dir, { withFileTypes: true }) }