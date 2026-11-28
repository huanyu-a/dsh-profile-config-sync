// 「插件数据」/「额外路径」两组的判定规则 —— Host 面板与 Node 引擎共用同一份。
//
// 为什么要挪出来
//   这两组的规则（单文件上限 / 排除通配 / 跳过的目录 / 安全必需项）原先只写在 index.js 里，
//   于是 macOS / Linux 的引擎（runtime/sync-engine.mjs）压根不知道这些规则，也就没法抓这两组。
//   规则一旦两份实现，迟早走样（0.6.15 就出过一次：JS 侧漏了 browser-profiles，
//   面板把几千个文件的 mtime 算成「待推送」，而 capture 根本不会抓它们）。
//   所以规则只认这个文件，engine 与 index.js 都从这里 import。

import { closeSync, openSync, readdirSync as readdirSyncImpl, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const EXTRA_CONFIG_NAME = 'config-sync-extra.json'
/** GitHub 单文件硬上限 100MB，超过必被拒收，所以配置里调多大都按这个封顶。 */
export const EXTRA_HARD_MAX_BYTES = 104857600
export const EXTRA_DEFAULT_SKIP_DIRS = [
  'profiles', 'skills', '.agent-presets', 'storages', 'sessions', 'attachments', 'logs', 'backups',
  'update-staging', 'electron', 'dsh-runtimes', 'dsh-market', '.dsh-plugin-market', 'dsh-session-manager',
  'browser-profiles', 'im', 'node_modules',
  // 插件自己产出的暂存目录不能当成「插件数据」再传上去：
  // profile-from-cloud / prompt-from-cloud 是跨平台移植时摊出来的对照件，
  // local-plugins-restore 是解包出来的本地插件副本 —— 传上去既没用又会来回翻倍。
  'profile-from-cloud', 'prompt-from-cloud', 'local-plugins-restore',
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
/**
 * 无论用户配置里怎么写都必须跳过的目录：这些是**插件自己的暂存产物**，
 * 不是别人家的插件数据。传上去再拉下来只会来回翻倍，还会把移植对照件当配置铺回去。
 * （老的 config-sync-extra.json 已经把旧默认名单抄进去了，topUp 不会补新项，所以这里硬拦。）
 */
export const PLUGIN_DATA_HARD_SKIP = new Set([
  'profile-from-cloud', 'prompt-from-cloud', 'local-plugins-restore',
  'browser-profiles', 'user data', 'User Data',
])

export function listPluginDataSlots(dshHome, cfg) {
  const skip = new Set((cfg && cfg.pluginData && cfg.pluginData.skipDirs) || [])
  let entries = []
  try { entries = readdirSync2(dshHome) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (skip.has(e.name)) continue
    if (PLUGIN_DATA_HARD_SKIP.has(e.name)) continue
    if (e.name.startsWith('.')) continue
    out.push({ id: e.name, src: join(dshHome, e.name) })
  }
  return out
}

function readdirSync2(dir) { return readdirSyncImpl(dir, { withFileTypes: true }) }
/**
 * 凭据 / 私有文件的判定 —— 与 PowerShell 的 Test-PrivateSecretFileName + Test-SyncExtraSecret 对齐。
 *
 * 两道门：
 *   1) 名字（自家私有 json / .env / *.pem / *.key / *.p12 / *.pfx / SSH 私钥名）；
 *   2) 内容嗅探（GitHub 令牌前缀 + accessToken / apiKey / password 这类字段名）——
 *      名字看不出来的才算「嗅探」，但漏了它就把登录态搬进仓库了。
 *
 * 读不出来的文件一律当凭据（旧实现「读不了就放行」，超长路径 / 独占 / 权限不足的文件会静默进仓库）。
 */
export const PRIVATE_FILE_NAMES = [
  'config-sync-gh.json', 'config-sync-feedback-outbox.json', 'dsh-config-sync.json',
  'config-sync-state.json', 'config-sync-roots.json', 'config-sync-scope.json',
  'config-sync-delete-cloud.json', 'config-sync-extra.json', 'sync-notices.json',
  '.credentials.yaml', '.env', 'dsh-ssh-master.key',
]

const PRIVATE_NAME_PATTERNS = [/\.env\..*$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /^(id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|identity|.*\.ppk)$/i]

/** 内容里的凭据标记（小写匹配；GitHub 令牌按正则单独判） */
const SECRET_MARKERS = [
  '"accesstoken"', '"refreshtoken"', '"idtoken"', '"apikey"', '"api_key"',
  '"clientsecret"', '"privatekey"', '"password"', '"webdavpass"', '"updatetoken"',
  'authorization: bearer', 'github_token=', 'gh_token=',
]

const GITHUB_TOKEN_RE = /gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/
const PEM_HEAD_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|PuTTY-User-Key-File-[0-9]/

/**
 * 源码类文件不做「字段名」扫描（那道门是给配置/数据文件用的）。
 *
 * 实测踩到的坑：本地源码插件这一组按目录打包时，插件自己的 `dsh-sync-common.ps1`
 * （里面定义了一张名为 "$SyncExtraSecretMarkers" 的名单，字面量就含 "password" / "apikey"）、
 * `runtime/extra-rules.mjs`、`tools/selftest.mjs` 全被判成凭据文件跳过 —— 打出来的 zip 缺关键文件，
 * 对方机器解出来是个装不上的插件。真实令牌（GitHub 前缀）和私钥头仍然一律拦，那道门不看扩展名。
 */
const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.less',
  '.html', '.md', '.ps1', '.psm1', '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.bat', '.cmd', '.sql', '.proto',
])

export function looksPrivateName(relOrPath) {
  const leaf = String(relOrPath || '').split(/[\\/]/).pop() || ''
  if (!leaf) return false
  const lower = leaf.toLowerCase()
  if (PRIVATE_FILE_NAMES.includes(lower)) return true
  return PRIVATE_NAME_PATTERNS.some((re) => re.test(leaf))
}

/** 读一段样本：≤2 MB 整份，更大的取头尾各 512 KB（令牌常落在头部或日志尾部）。 */
function sampleBytes(full) {
  const st = statSync(full)
  const len = st.size
  if (len <= 2100000) return readFileSync(full)
  const chunk = 512 * 1024
  const head = Buffer.alloc(Math.min(chunk, len))
  const tail = Buffer.alloc(Math.min(chunk, len - Math.max(0, len - chunk)))
  const fd = openSync(full, 'r')
  try {
    const headRead = readSync(fd, head, 0, head.length, 0)
    readSync(fd, tail, 0, tail.length, Math.max(0, len - chunk))
    return Buffer.concat([head.subarray(0, headRead), tail])
  } finally { closeSync(fd) }
}

export function looksSecretFile(full, relOrPath) {
  if (looksPrivateName(relOrPath || full)) return true
  try {
    const buf = sampleBytes(full)
    // latin1（码位 = 字节）：二进制里的 ASCII 令牌照样命中，也不会因非法 UTF-8 抛错
    const raw = buf.toString('latin1')
    // 显式豁免：文件里写了 dsh-sync-allow-secret 说明里面的令牌是**测试夹具**（本仓库的 selftest 就是），
    // 由作者自己担这个责任；真实令牌不会自带这行。
    if (/dsh-sync-allow-secret/i.test(raw)) return false
    if (GITHUB_TOKEN_RE.test(raw)) return true
    if (PEM_HEAD_RE.test(raw)) return true
    const leaf = String(relOrPath || full).split(/[\\/]/).pop() || ''
    const ext = leaf.includes('.') ? leaf.slice(leaf.lastIndexOf('.')).toLowerCase() : ''
    if (CODE_EXTS.has(ext)) return false
    const lower = raw.toLowerCase()
    return SECRET_MARKERS.some((m) => lower.includes(m))
  } catch {
    // 读不了 = 判不了 → 宁可跳过（调用方会记进未同步清单）
    return true
  }
}
