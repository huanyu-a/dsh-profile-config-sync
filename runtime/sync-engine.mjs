// 跨平台同步引擎 —— 用 Node 实现「抓取 / 铺开 / 比对」，取代 6 个 PowerShell 脚本。
//
// 为什么重写成 Node 而不是继续用 PowerShell：
//   - DSH 客户端**必带 Node**（resources/runtime/.../node），插件宿主本身就是 Node；
//   - PowerShell 在 macOS/Linux 上要用户额外装 pwsh，且脚本里 %SystemRoot%、
//     注册表、盘符、Compress-Archive 全是 Windows 独有；
//   - 会话 zstd 多帧改写（fix-session-cwd.mjs）本来就是 Node，直接复用。
//
// 边界（诚实说明）：
//   - 本引擎覆盖 capture / apply / status 三个动作的**核心**：
//     目录结构、占位符归一、文件比对、备份快照、路径展开。
//   - Windows 专属动作（junction 修复、孤儿链接清理、pnpm 安装）不在本引擎里：
//     它们在 PowerShell 版里保留，Node 版在非 Windows 上是空操作。
//   - 两版并存：Windows 存量用户继续用 .ps1，新平台用 .mjs，同一套仓库格式。

import { spawnSync } from 'node:child_process'
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, lstatSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  IS_WIN, SEP, appRootCandidates, appRootLayout, clientExecutable, dshHome as resolveDshHome,
  defaultWorkspaceHome, findGit, hostNodeExe, isAppRoot, isDir, isFile, platformFamily,
  readAppVersion as platformAppVersion, readElectronVersion as platformElectronVersion,
} from './platform.mjs'
import { buildContract, checkContract, contractPath, contractText, readContract } from './contract.mjs'
import { listMachines, localMachineInfo, writeMachineInfo } from './machines.mjs'
import {
  downloadRepo, isSecureUrl, normalizeWebdav, testConnection, uploadRepo, webdavActive,
  PRIVATE_KEY_BODY_RE, SSH_KEY_NAME_RE,
} from './webdav.mjs'
import { applyConversations, captureConversations, conversationPendingRoots, resolveGuardScript } from './conversations.mjs'
import { extraSkipReason, listPluginDataSlots, readExtraConfig } from './extra-rules.mjs'

/** 占位符：仓库里存这些，落地时展开成本机路径。 */
export const TOKENS = {
  APP_ROOT: '{{APP_ROOT}}',
  DSH_HOME: '{{DSH_HOME}}',
  WORKSPACE_HOME: '{{WORKSPACE_HOME}}',
  ROOT: (key) => `{{ROOT:${key}}}`,
}

/** 文本文件按内容比对时，先去掉行尾差异（避免 CRLF/LF 制造假变更）。 */
const TEXT_EXTS = new Set(['.json', '.jsonc', '.md', '.yml', '.yaml', '.txt', '.js', '.mjs', '.cjs', '.ts', '.css', '.html', '.xml', '.toml', '.ini', '.cfg', '.conf', '.sh', '.ps1'])

/** 二进制扩展名：一律字节保真，绝不做文本替换。 */
const BINARY_EXTS = new Set([
  '.tgz', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp',
  '.exe', '.dll', '.wasm', '.pdf', '.dat', '.woff', '.woff2', '.ttf', '.otf',
  '.zstd', '.db', '.sqlite', '.node', '.bin',
])

/** 目录遍历时跳过：这些要么已分组同步，要么是缓存/运行时。 */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.cache', '__pycache__', '.venv', 'backups',
  'update-staging', 'electron', 'dsh-runtimes', 'logs',
])

export function isBinaryName(name) {
  return BINARY_EXTS.has(extname(name).toLowerCase())
}

export function isTextName(name) {
  return TEXT_EXTS.has(extname(name).toLowerCase())
}

/**
 * 递归列目录。返回相对 base 的路径（用 / 分隔，跨平台一致）。
 *
 * 与其它工具的区别：这里**主动跳过** SKIP_DIRS，因为同步语义上
 * 这些目录要么有专门分组，要么不该进仓库。
 */
export function walk(base, opts = {}) {
  const out = []
  const maxDepth = Number(opts.maxDepth) || 32
  const visit = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        if (opts.skipDir && opts.skipDir(e.name)) continue
        visit(full, depth + 1)
      } else if (e.isFile()) {
        // Windows 上 junction 的 Dirent.isDirectory() 是 false（实测），
        // 所以链接要单独判：链接一律不当普通文件收。
        if (e.isSymbolicLink && e.isSymbolicLink()) continue
        out.push({ full, rel: toRepoPath(relative(base, full)) })
      }
    }
  }
  visit(base, 0)
  return out
}

/** 把本机路径转成仓库里的写法：一律正斜杠（避开 JSON 转义与跨平台分隔符）。 */
export function toRepoPath(p) {
  return String(p).split(sep).join('/').replace(/\/+/g, '/')
}

/** 仓库写法 → 本机路径。 */
export function fromRepoPath(p) {
  return String(p).split('/').join(sep)
}

/** 同步内容勾选：与 PowerShell 侧 dsh-sync-common.ps1 的 Get-SyncScope 同语义。
 *
 * 必需组（profile）永远算开启：关掉它会让另一台 apply 直接报错，不是「少同步一点」。
 * 文件缺失 / 解析失败一律按「全勾」处理（与 PS 的 fallback 一致），不能让坏 JSON 变成「什么都不同步」。
 */
export const SYNC_REQUIRED_GROUPS = ['profile']

/**
 * 本机根集合：与 PowerShell 侧 Get-SyncRoots 同语义。
 *
 * <DshHome>/config-sync-roots.json 是用户确认过的值，优先；没有才用探测/传参值。
 * custom 里补一个 userHome —— 有些配置把工作区建在 ~/Documents/deepseek-harness 下，
 * 那个路径既不在安装目录也不在 .dsh / 工作区根里，不归一就会把老机器的用户名带过去。
 */
export function readSyncRoots(dshHome, detected = {}) {
  const out = {
    appRoot: String(detected.appRoot || ''),
    dshHome: String(detected.dshHome || dshHome || ''),
    workspaceHome: String(detected.workspaceHome || ''),
    custom: {},
  }
  if (!dshHome) {
    try { out.custom.userHome = homedir() } catch { /* 取不到就不加 */ }
    return out
  }
  const file = join(dshHome, 'config-sync-roots.json')
  let saved = null
  try { saved = JSON.parse(readFileSync(file, 'utf8')) } catch { saved = null }
  if (saved && typeof saved === 'object') {
    if (typeof saved.appRoot === 'string' && saved.appRoot) out.appRoot = saved.appRoot
    if (typeof saved.dshHome === 'string' && saved.dshHome) out.dshHome = saved.dshHome
    if (typeof saved.workspaceHome === 'string' && saved.workspaceHome) out.workspaceHome = saved.workspaceHome
    if (saved.custom && typeof saved.custom === 'object') {
      for (const [k, v] of Object.entries(saved.custom)) {
        if (k && typeof v === 'string' && v) out.custom[k] = v
      }
    }
  }
  if (!out.custom.userHome) {
    try { out.custom.userHome = homedir() } catch { /* 取不到就不加 */ }
  }
  return out
}

export function readSyncScope(dshHome) {
  const fallback = { deleteCloud: false, groups: {} }
  if (!dshHome) return fallback
  const file = join(dshHome, 'config-sync-scope.json')
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return fallback }
  if (!raw || !raw.trim()) return fallback
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return fallback
    return {
      deleteCloud: obj.deleteCloud === true,
      groups: obj.groups && typeof obj.groups === 'object' ? obj.groups : {},
    }
  } catch { return fallback }
}

function scopeGroupEnabled(scope, group) {
  if (SYNC_REQUIRED_GROUPS.includes(group)) return true
  const g = scope && scope.groups ? scope.groups[group] : null
  if (!g || typeof g !== 'object') return true
  return g.enabled !== false
}

function scopeItemEnabled(scope, group, item) {
  if (SYNC_REQUIRED_GROUPS.includes(group)) return true
  if (!scopeGroupEnabled(scope, group)) return false
  const g = scope && scope.groups ? scope.groups[group] : null
  if (!g || typeof g !== 'object') return true
  if (!Array.isArray(g.excluded)) return true
  return !g.excluded.includes(item)
}

/** 整组被跳过时：只有显式打开 deleteCloud 才删仓库里那份。 */
function skipScopedGroup(scope, repoRoot, group, skipped) {
  skipped.push(`${group}: 未勾选同步`)
  if (!scope || scope.deleteCloud !== true) return
  const target = join(repoRoot, fromRepoPath(group))
  try { if (existsSync(target)) { clearDir(target); skipped.push(`${group}: 已按「删除云端副本」移除`) } } catch { /* 删不掉不影响其余 */ }
}

/** 本机路径列表 → 归一化的根集合（capture 用）。 */
export function collectRoots({ appRoot, dshHome, workspaceHome }) {
  return {
    appRoot: appRoot ? resolve(appRoot) : '',
    dshHome: dshHome ? resolve(dshHome) : '',
    workspaceHome: workspaceHome ? resolve(workspaceHome) : '',
    custom: {},
  }
}

/** 文本里同样的路径可能有 4 种写法（原样 / JSON 双反斜杠 / 正斜杠 / JSON 转义斜杠）。 */
function pathVariants(p) {
  if (!p) return []
  const bs = String.fromCharCode(92)
  return [...new Set([
    p,
    p.split(bs).join(bs + bs),
    p.split(bs).join('/'),
    p.split(bs).join(bs + '/'),
  ])].filter(Boolean)
}

/**
 * 本机路径 → 占位符（capture 写仓库前调用）。
 *
 * 关键：按根长度**降序**替换。工作区根常在各客户端安装目录之下，
 * 先换长的才不会把短根替换进已经展开的文本里造成错位。
 */
export function toTokenText(text, roots) {
  if (!text) return text
  roots = roots || {}
  const items = []
  if (roots.appRoot && roots.appRoot.length >= 3) items.push({ token: TOKENS.APP_ROOT, value: roots.appRoot })
  if (roots.workspaceHome && roots.workspaceHome.length >= 5) items.push({ token: TOKENS.WORKSPACE_HOME, value: roots.workspaceHome })
  if (roots.dshHome && roots.dshHome.length >= 5) items.push({ token: TOKENS.DSH_HOME, value: roots.dshHome })
  for (const [k, v] of Object.entries(roots.custom || {})) {
    if (k && v && String(v).length >= 3) items.push({ token: TOKENS.ROOT(k), value: String(v) })
  }
  items.sort((a, b) => b.value.length - a.value.length)
  let out = text
  for (const it of items) {
    for (const v of pathVariants(it.value)) out = out.split(v).join(it.token)
  }
  // 占位符后面的分隔符统一成正斜杠
  out = out.replace(/(\{\{(?:APP_ROOT|DSH_HOME|WORKSPACE_HOME|ROOT:[^{}\s]+)\}\})((?:\\\\|\\|\/)[^"\s,;:}{\[\]]*)/g,
    (_m, token, rest) => token + rest.split(String.fromCharCode(92)).join('/'))
  return out
}

/** 占位符 → 本机路径（apply 落地前调用）。 */
export function expandTokenText(text, roots) {
  if (!text) return text
  roots = roots || {}
  const fwd = (p) => (p ? toRepoPath(p) : '')
  let out = text
    .split(TOKENS.APP_ROOT).join(fwd(roots.appRoot))
    .split(TOKENS.WORKSPACE_HOME).join(fwd(roots.workspaceHome))
    .split(TOKENS.DSH_HOME).join(fwd(roots.dshHome))
  for (const [k, v] of Object.entries(roots.custom || {})) {
    if (k && v) out = out.split(TOKENS.ROOT(k)).join(fwd(String(v)))
  }
  return out
}

/** 文本里还残留哪些没配值的占位符（apply 用它决定「跳过并记 pending」）。 */
export function missingTokens(text) {
  const found = new Set()
  // 名字放宽到「除花括号/空白之外任意字符」：用户的自选根 key 可能是中文（{{ROOT:资料}}），
  // 只认 ASCII 会让这种占位符既不被识别、也不被跳过，最终把字面量写进目标机配置。
  const re = /\{\{(APP_ROOT|DSH_HOME|WORKSPACE_HOME|ROOT:[^{}\s]+)\}\}/g
  let m
  while ((m = re.exec(String(text))) !== null) found.add(m[0])
  return [...found]
}

/** 文件内容哈希。文本按去 CRLF 后的内容算，二进制按原始字节算。 */
export function fileHash(path) {
  const name = basename(path)
  if (isBinaryName(name)) {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  const raw = readFileSync(path, 'utf8')
  return createHash('sha256').update(raw.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

/** 目录的「内容指纹」：相对路径 + 每个文件的大小/mtime，用于快速判断有无变化。 */
export function treeFingerprint(dir) {
  const files = walk(dir)
  const parts = files.map((f) => {
    let st
    try { st = statSync(f.full) } catch { st = null }
    return `${f.rel}|${st ? st.size : 0}|${st ? Math.floor(st.mtimeMs) : 0}`
  })
  parts.sort()
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex')
}

/**
 * 递归复制，边拷边把文本文件里的本机根换成占位符。
 * 二进制文件字节保真（不走文本读入）。
 */
/** 浏览器剖面 / 凭据库（与 webdav.mjs 的 BLOCKED_PROFILE_SEGMENTS 保持一致）。 */
const BLOCKED_ENGINE_SEGMENTS = new Set([
  'browser-profiles', 'user data', 'login data', 'login data for account',
  'cookies', 'cookies-journal', 'web data', 'web data-journal', 'secure preferences',
  'local state', 'history', 'history-journal', 'top sites', 'current session', 'current tabs',
])
const PRIVATE_FILE_NAMES = new Set([
  'config-sync-gh.json', 'config-sync-feedback-outbox.json', 'dsh-config-sync.json',
  'config-sync-state.json', 'config-sync-roots.json', 'config-sync-scope.json',
  'config-sync-extra.json', 'sync-notices.json', '.credentials.yaml', '.env', 'dsh-ssh-master.key',
])
const GH_TOKEN_RE = /gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/
function hasSecretLeak(name, text) {
  const leaf = String(name || '').toLowerCase()
  if (PRIVATE_FILE_NAMES.has(leaf) || leaf.startsWith('.env.') || /\.(pem|key|p12|pfx)$/.test(leaf)) return true
  // 0.6.49：裸名私钥（ssh-keygen 默认产物 id_ed25519 / id_rsa / *.ppk）原来拦不住 ——
  // 既没有 .key 后缀也不在名单里。判据与 webdav.mjs 共用同一份正则，避免两边漂移。
  if (SSH_KEY_NAME_RE.test(leaf)) return true
  if (String(name || '').split('/').some((seg) => BLOCKED_ENGINE_SEGMENTS.has(String(seg).toLowerCase()))) return true
  if (typeof text === 'string' && text) {
    if (GH_TOKEN_RE.test(text)) return true
    // 改名/塞进别处的私钥：认 PEM / PuTTY 私钥头（与 webdav.mjs 共用）
    if (PRIVATE_KEY_BODY_RE.test(text)) return true
    for (const envName of ['DSH_CONFIG_SYNC_GH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
      const val = String(process.env[envName] || '').trim()
      if (val.length >= 12 && text.includes(val)) return true
    }
  }
  return false
}

/** 大文件只抽头尾嗅探：令牌一般落在配置头部或日志尾部，读整个 100MB 进内存不值得。 */
const SECRET_SAMPLE_BYTES = 512 * 1024
function readSampleLation(path, size) {
  if (size <= 2 * 1024 * 1024) return readFileSync(path).toString('latin1')
  const fd = openSync(path, 'r')
  try {
    const headLen = Math.min(SECRET_SAMPLE_BYTES, size)
    const head = Buffer.alloc(headLen)
    let read = readSync(fd, head, 0, headLen, 0)
    const tailStart = Math.max(0, size - SECRET_SAMPLE_BYTES)
    const tailLen = Math.min(SECRET_SAMPLE_BYTES, size - tailStart)
    const tail = Buffer.alloc(tailLen)
    const read2 = readSync(fd, tail, 0, tailLen, tailStart)
    return head.subarray(0, read).toString('latin1') + tail.subarray(0, read2).toString('latin1')
  } finally {
    closeSync(fd)
  }
}

/**
 * 是否含令牌/凭据 —— **不看扩展名**。
 * 旧实现只对 TEXT_EXTS 里的扩展名做内容扫描，其余一律当二进制直拷：无扩展名的脚本、
 * .npmrc、netrc、deploy-config 里的 ghp_ 令牌就这样进了仓库，随后被 git 推到远端。
 * 用 latin1 解码（码位 = 字节），二进制文件里的 ASCII 令牌同样能命中。
 */
function fileLooksSecret(path, size) {
  try { return hasSecretLeak('', readSampleLation(path, size)) } catch { return false }
}

export function copyWithTokens(src, dst, roots) {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true })
    let files = 0, bytes = 0
    for (const e of readdirSync(src, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue
      if (e.isSymbolicLink && e.isSymbolicLink()) continue
      // 计数必须累加：旧实现目录分支返回 {files:0}，skills/presets 这两个唯一的目录源
      // 永远报「0 个文件 / 0 字节，变更 0 项」，而文件其实被整份重写了。
      const r = copyWithTokens(join(src, e.name), join(dst, e.name), roots)
      files += r.files
      bytes += r.bytes
    }
    return { files, bytes }
  }
  if (!isFile(src)) return { files: 0, bytes: 0 }
  const name = basename(src)
  if (hasSecretLeak(name, '')) return { files: 0, bytes: 0 }
  if (fileLooksSecret(src, st.size)) return { files: 0, bytes: 0 }
  const binary = isBinaryName(name) || !isTextName(name)
  mkdirSync(dirname(dst), { recursive: true })
  if (binary) {
    // 内容一致就别重写：否则每次 capture 都刷一遍 mtime，还谎报「本轮改了 N 个文件」
    try { if (existsSync(dst) && fileHash(src) === fileHash(dst)) return { files: 0, bytes: 0 } } catch { /* 比不了就照写 */ }
    copyFileSync(src, dst)
    return { files: 1, bytes: st.size }
  }
  const text = readFileSync(src, 'utf8')
  const out = toTokenText(text, roots).replace(/\r\n/g, '\n')
  // 文本按「归一化后的内容」比对（占位符化 + LF），相同就不写。0.6.49 之前无条件写：
  // 于是 profile/package.json 这类文件每次 capture 都报「有改动」，面板与提交都被噪声污染。
  try { if (existsSync(dst) && readFileSync(dst, 'utf8') === out) return { files: 0, bytes: 0 } } catch { /* 比不了就照写 */ }
  writeFileSync(dst, out, 'utf8')
  return { files: 1, bytes: Buffer.byteLength(out, 'utf8') }
}

/** 反向：仓库 → 本机，把占位符展开。 */
export function copyWithExpand(src, dst, roots) {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true })
    let files = 0, bytes = 0
    const skipped = []
    for (const e of readdirSync(src, { withFileTypes: true })) {
      const r = copyWithExpand(join(src, e.name), join(dst, e.name), roots)
      files += r.files
      bytes += r.bytes
      if (Array.isArray(r.skipped) && r.skipped.length > 0) {
        // 只有目录子项才加前缀：文件子项自己已经把文件名写进 skipped 了，
        // 再拼一次就成了 "sub/a.md/a.md: …"（旧版这个前缀把路径拼重）。
        const dirChild = typeof e.isDirectory === 'function' && e.isDirectory()
        skipped.push(...r.skipped.map((s) => (dirChild ? `${e.name}/${s}` : s)))
      }
    }
    return { files, bytes, skipped }
  }
  if (!isFile(src)) return { files: 0, bytes: 0 }
  mkdirSync(dirname(dst), { recursive: true })
  const name = basename(src)
  if (isBinaryName(name) || !isTextName(name)) {
    copyFileSync(src, dst)
    return { files: 1, bytes: st.size }
  }
  const text = readFileSync(src, 'utf8')
  // 占位符还没配值就跳过：把 {{ROOT:work}} 字面量写进本机配置，插件读到会当成真实路径，
  // 报错比不写更难查（apply.ps1 里同一条不变式）。旧实现只在「单文件」分支做这个检查，
  // skills/ presets/ 这类目录源整棵直写，同一份内容作为文件被跳过、作为目录却被写坏。
  // 先展开、再看还剩哪些占位符（与 apply.ps1 的 Expand-TokenText → Get-MissingTokens 同序）。
  // 反过来判（先看文本里有没有占位符）会把能展开的正常文件也跳过 —— 实测 profile 快照里的
  // {{DSH_HOME}} 明明是能换的，却被当成「待确认路径」整份跳过，还原完 profile 里少文件。
  const out = expandTokenText(text, roots)
  const miss = missingTokens(out)
  if (miss.length > 0) return { files: 0, bytes: 0, skipped: [`${name}: 待确认路径 ${miss.join(', ')}`] }
  writeFileSync(dst, out, 'utf8')
  return { files: 1, bytes: Buffer.byteLength(out, 'utf8') }
}

/** 递归删除目录内容（保留目录本身）。失败静默：清理不该让同步失败。 */
export function clearDir(dir) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    try {
      if (e.isDirectory()) rmSync(full, { recursive: true, force: true })
      else rmSync(full, { force: true })
    } catch { /* 占用中的文件留给下一次 */ }
  }
}

/** 两个目录的内容是否一致（按相对路径 + 文本去 CRLF 后的哈希）。 */
export function diffTrees(a, b) {
  const fa = new Map(walk(a).map((f) => [f.rel, f]))
  const fb = new Map(walk(b).map((f) => [f.rel, f]))
  const added = [], removed = [], changed = []
  for (const [rel] of fb) if (!fa.has(rel)) added.push(rel)
  for (const [rel] of fa) if (!fb.has(rel)) removed.push(rel)
  for (const [rel, f] of fa) {
    const g = fb.get(rel)
    if (!g) continue
    let same
    try {
      const sa = statSync(f.full), sb = statSync(g.full)
      same = sa.size === sb.size && fileHash(f.full) === fileHash(g.full)
    } catch { same = false }
    if (!same) changed.push(rel)
  }
  return { added, removed, changed, same: added.length === 0 && removed.length === 0 && changed.length === 0 }
}

/**
 * 本机客户端版本。
 *
 * 三种形态都要认（实测打包版三种都不在预期位置）：
 *   1. 解包版：resources/app/package.json
 *   2. 打包版：Electron 把 app.asar 当目录挂载 → resources/app.asar/dsh/package.json
 *      （**只有 Electron 主进程里才成立**；普通 node 里 statSync 会失败）
 *   3. 打包版兜底：直接按 asar 二进制头读 dsh/package.json
 *      —— 插件宿主虽然跑在 Electron 里，但某些调用路径（子进程、外部 node）
 *      拿不到 asar 挂载，必须有这条不依赖挂载的实现。
 */
export function readAppVersion(appRoot) {
  if (!appRoot) return ''
  // 0.6.49：resources 的位置随平台变（macOS 在 <root>/Contents/Resources），
  // 统一交给 platform.mjs —— 原来这里写死 <root>/resources，macOS 上恒为空，
  // 于是契约里的 appVersion 一直空着、版本校验形同虚设。
  return platformAppVersion(appRoot)
}

/** 直接从 asar 二进制里取 dsh/package.json 的 version（不依赖 asar 挂载）。 */
function readAsarPackageVersion(asarPath) {
  let fd = null
  try {
    if (!existsSync(asarPath)) return ''
    fd = openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    const jsonLen = head.readUInt32LE(12)
    if (jsonLen < 2 || jsonLen > 64 * 1024 * 1024) return ''
    const json = Buffer.alloc(jsonLen)
    readSync(fd, json, 0, jsonLen, 16)
    const header = JSON.parse(json.toString('utf8'))
    const entry = header?.files?.dsh?.files?.['package.json']
      || header?.files?.['package.json']
    if (!entry || entry.size == null || entry.offset == null) return ''
    const body = Buffer.alloc(Number(entry.size))
    readSync(fd, body, 0, Number(entry.size), 8 + headerSize + Number(entry.offset))
    const pkg = JSON.parse(body.toString('utf8'))
    return pkg && pkg.version ? String(pkg.version) : ''
  } catch {
    return ''
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* 忽略 */ } }
  }
}

/** Electron 版本（客户端根下的 version 文件；macOS 走 .app 内 Framework 的 Info.plist）。 */
export function readElectronVersion(appRoot) {
  return platformElectronVersion(appRoot)
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeJsonSafe(path, doc) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(doc, null, 2).replace(/\r\n/g, '\n') + '\n', 'utf8')
}

/**
 * 缓存的 Node 探测结果。
 *
 * 为什么要缓存：status 每次调用都要跑 walk + 探测，而 `hostNodeExe` /
 * `findGit` 会遍历盘符与 PATH 做 stat。实测 27 个盘符候选 × 2 个函数，
 * 每次调用几秒；面板打开、每 2 分钟复查都会触发，不缓存会拖垮 status。
 * 探测结果在本进程内不会变（客户端不换安装目录），所以缓存是安全的。
 */
let probeCache = null
let probeCacheKey = ''

/** 本地 .dsh 根目录（跨平台）。 */
export function localDshHome() {
  return resolveDshHome()
}

/** 探测本机环境（capture / status 都要用）。带进程内缓存。 */
/** 契约判定要的 local 文档（与 probeLocal 同源，单独命名避免循环调用）。 */
function createProbeLocal(opts) {
  const l = probeLocal(opts)
  return { appVersion: l.dshVersion, dshVersion: l.dshVersion, os: l.os }
}

export function probeLocal({ dshHome, appRoot, workspaceHome } = {}) {
  const home = dshHome || localDshHome()
  const ws = workspaceHome || defaultWorkspaceHome()
  const key = [home, appRoot || '', ws].join('|')
  if (probeCache && probeCacheKey === key) return probeCache
  const root = appRoot || appRootCandidates().find((p) => isAppRoot(p)) || ''
  const git = findGit()
  const node = hostNodeExe(root)
  probeCacheKey = key
  probeCache = {
    dshHome: home,
    appRoot: root,
    workspaceHome: ws,
    dshVersion: readAppVersion(root),
    electronVersion: readElectronVersion(root),
    os: process.platform,
    osFamily: platformFamily(),
    arch: process.arch,
    hostname: (() => { try { return hostname() } catch { return '' } })(),
    clientExe: clientExecutable(root),
    git,
    node,
    hasGit: Boolean(git),
    hasNode: Boolean(node),
  }
  return probeCache
}

/**
 * 抓取（本机 → 仓库）。
 *
 * 只负责「把本机的东西按仓库布局写出来」，不做 git 操作 ——
 * 与 PowerShell 版一致（sync.ps1 负责 git，这里负责内容）。
 *
 * 返回 { ok, changed:[], files, bytes, errors:[] }。
 */
/**
 * 一个「槽」（插件数据槽 / 额外路径目录）的镜像：按规则过滤 → 拷进仓库 → 删掉本机已经不存在的。
 *
 * 规则用的是 runtime/extra-rules.mjs（与面板、与 PowerShell 同一份）：
 * 单文件上限、排除通配、凭据（名字 + 内容）、符号链接不跟。
 */
function mirrorSlotInto({ srcRoot, dstRoot, cfg, roots, label }) {
  const out = { files: 0, bytes: 0, changed: [], errors: [], notes: [] }
  const wanted = new Map()
  for (const f of walk(srcRoot)) {
    let st
    try { st = statSync(f.full) } catch { continue }
    const why = extraSkipReason(f.rel, st.size, cfg)
    if (why === 'too-big') { out.notes.push(`${label}/${f.rel}: 超过单文件上限，未进仓库`); continue }
    if (why) continue
    if (isSecretFile(f.full, f.rel)) { out.notes.push(`${label}/${f.rel}: 像是凭据文件，已跳过`); continue }
    wanted.set(f.rel, { full: f.full, size: st.size })
  }
  for (const [rel, info] of wanted) {
    const dst = join(dstRoot, ...rel.split('/'))
    try {
      mkdirSync(dirname(dst), { recursive: true })
      // copyWithTokens 自己会按「归一化后的内容」比对，相同就不写并返回 files:0
      const w = copyWithTokens(info.full, dst, roots)
      if (w.files > 0) {
        out.files += w.files
        out.bytes += w.bytes
        out.changed.push(`${label}/${rel}`)
      }
    } catch (e) {
      out.errors.push(`${label}/${rel}: ${(e && e.message) || e}`)
    }
  }
  // 镜像删除：本机已经没有的，仓库里也删（否则换机会把删掉的文件铺回来）
  for (const f of walk(dstRoot)) {
    if (wanted.has(f.rel)) continue
    try {
      rmSync(f.full, { force: true })
      out.changed.push(`${label}/${f.rel}（删除）`)
    } catch (e) {
      out.errors.push(`删除 ${label}/${f.rel} 失败：${(e && e.message) || e}`)
    }
  }
  return out
}

/** 名字或内容像凭据（PEM / PuTTY 私钥、SSH 私钥文件名）→ 不进仓库。 */
function isSecretFile(full, rel) {
  const name = String(rel || '').split('/').pop() || ''
  if (SSH_KEY_NAME_RE.test(name)) return true
  if (isBinaryName(name)) return false
  try {
    const fd = openSync(full, 'r')
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, 4096, 0)
    closeSync(fd)
    return PRIVATE_KEY_BODY_RE.test(buf.subarray(0, n).toString('utf8'))
  } catch { return false }
}

/** 插件数据组（<DshHome> 一级目录，跳过规则里的系统目录与隐藏目录）。 */
function capturePluginData({ repoRoot, dshHome, cfg, scope, roots }) {
  const dstRoot = join(repoRoot, 'plugin-data')
  const result = { files: 0, bytes: 0, changed: [], errors: [], notes: [] }
  if (!cfg || cfg.pluginData.enabled === false) {
    result.notes.push('插件数据：已在 config-sync-extra.json 里关闭（pluginData.enabled=false），跳过')
    return result
  }
  mkdirSync(dstRoot, { recursive: true })
  const slots = []
  for (const slot of listPluginDataSlots(dshHome, cfg)) {
    if (!scopeItemEnabled(scope, 'plugin-data', slot.id)) { result.notes.push(`插件数据 ${slot.id}: 未勾选`); continue }
    const r = mirrorSlotInto({ srcRoot: slot.src, dstRoot: join(dstRoot, slot.id), cfg, roots, label: `plugin-data/${slot.id}` })
    result.files += r.files
    result.bytes += r.bytes
    result.changed.push(...r.changed)
    result.errors.push(...r.errors)
    result.notes.push(...r.notes)
    slots.push({ id: slot.id, src: toTokenText(slot.src, roots) })
  }
  // manifest 不写时间戳：写了每次抓取都会产生假改动
  const text = JSON.stringify({ version: 1, slots }, null, 2)
  const mp = join(dstRoot, 'manifest.json')
  let before = ''
  try { before = readFileSync(mp, 'utf8') } catch { /* 没有就写 */ }
  if (before !== text) {
    writeFileSync(mp, text, 'utf8')
    result.changed.push('plugin-data/manifest.json')
  }
  return result
}

/** 额外路径组（用户在面板里自己填的文件 / 目录）。 */
function captureExtraPaths({ repoRoot, dshHome, cfg, scope, roots }) {
  const dstRoot = join(repoRoot, 'extra')
  const result = { files: 0, bytes: 0, changed: [], errors: [], notes: [] }
  if (!cfg || cfg.extra.enabled === false) {
    result.notes.push('额外路径：已在 config-sync-extra.json 里关闭（extra.enabled=false），跳过')
    return result
  }
  const paths = (cfg.extra && cfg.extra.paths) || []
  if (!paths.length) { result.notes.push('额外路径：没有登记任何路径'); return result }
  mkdirSync(dstRoot, { recursive: true })
  for (const p of paths) {
    if (!scopeItemEnabled(scope, 'extra', p.id)) { result.notes.push(`额外路径 ${p.id}: 未勾选`); continue }
    if (!existsSync(p.src)) { result.notes.push(`额外路径本机不存在，跳过：${p.src}`); continue }
    const isDir = isDir2(p.src)
    const label = `extra/${p.id}`
    if (!toTokenText(p.src, roots).includes('{{')) {
      result.notes.push(`额外路径不在已知根下（换机可能对不上）：${p.src}`)
    }
    if (isDir) {
      const r = mirrorSlotInto({ srcRoot: p.src, dstRoot: join(dstRoot, p.id), cfg, roots, label })
      result.files += r.files
      result.bytes += r.bytes
      result.changed.push(...r.changed)
      result.errors.push(...r.errors)
      result.notes.push(...r.notes)
    } else {
      if (isSecretFile(p.src, basename(p.src))) { result.notes.push(`额外路径 ${p.id}: 像凭据文件，已跳过`); continue }
      const ext = p.src.includes('.') ? p.src.slice(p.src.lastIndexOf('.')) : ''
      const dst = join(dstRoot, `${p.id}${ext}`)
      try {
        const st = statSync(p.src)
        const same = existsSync(dst) && fileHash(p.src) === fileHash(dst)
        if (!same) {
          mkdirSync(dirname(dst), { recursive: true })
          copyWithTokens(p.src, dst, roots)
          result.files += 1
          result.bytes += st.size
          result.changed.push(`${label}${ext}`)
        }
      } catch (e) {
        result.errors.push(`${label}: ${(e && e.message) || e}`)
      }
    }
  }
  return result
}

function isDir2(p) { try { return statSync(p).isDirectory() } catch { return false } }

export function capture({ repoRoot, dshHome, appRoot, workspaceHome, profileName = 'desktop' } = {}) {
  const local = probeLocal({ dshHome, appRoot, workspaceHome })
  // 用「用户确认过的根」（config-sync-roots.json）：自选目录必须变成 {{ROOT:x}}，
  // 否则会把本机绝对路径原样带进仓库，换机后对方文件指向一个不存在的目录。
  const roots = readSyncRoots(local.dshHome, local)
  const changed = []
  const errors = []
  let files = 0, bytes = 0

  const copy = (src, dstRel) => {
    try {
      if (!existsSync(src)) return
      const dst = join(repoRoot, fromRepoPath(dstRel))
      const r = isDir(src)
        ? copyWithTokens(src, dst, roots)
        : copyWithTokens(src, dst, roots)
      files += r.files
      bytes += r.bytes
      if (r.files > 0) changed.push(dstRel)
    } catch (e) {
      errors.push(`${dstRel}: ${e && e.message ? e.message : e}`)
    }
  }

  // 0) 同步内容勾选（与 PS 侧同语义）：没勾的组不抓，被排除的单项不抓。
  const scope = readSyncScope(local.dshHome)
  const skippedByScope = []
  const gated = (group) => !scopeGroupEnabled(scope, group)
  const gatedItem = (group, item) => !scopeItemEnabled(scope, group, item)

  // 1) profile：本机 profile 目录（必需组，钉死开启）
  const profileDir = join(local.dshHome, 'profiles', profileName)
  if (isDir(profileDir)) {
    copy(join(profileDir, 'package.json'), 'profile/package.json')
    copy(join(profileDir, 'cordis.patch.yml'), 'profile/cordis.patch.yml')
    copy(join(profileDir, 'package-lock.json'), 'profile/package-lock.json')
    copy(join(profileDir, 'pnpm-lock.yaml'), 'profile/pnpm-lock.yaml')
  }

  // 1.5) 执行体：把 Node 引擎写进仓库根（Windows 版一直这么干，POSIX 之前漏了）
  try {
    const wrote = ensureRepoRunner(repoRoot)
    for (const name of wrote) changed.push(name)
  } catch (e) {
    errors.push(`runner: ${e && e.message ? e.message : e}`)
  }

  // 2) 契约：记下本机实测版本 + 平台
  try {
    if (local.dshVersion) {
      const existing = readContract(repoRoot)
      const merged = buildContract({
        dshVersion: existing ? existing.appVersion : local.dshVersion,
        electronVersion: local.electronVersion,
        os: local.os, osFamily: local.osFamily, arch: local.arch,
      }, repoRoot)
      const text = contractText(merged)
      const p = contractPath(repoRoot)
      let before = ''
      try { before = readFileSync(p, 'utf8') } catch { /* 没有就写 */ }
      if (before !== text) {
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, text, 'utf8')
        changed.push('profile/host-contract.json')
      }
    }
  } catch (e) {
    errors.push(`host-contract: ${e && e.message ? e.message : e}`)
  }

  // 3) 提示词 / 技能 / 预设（逐组、逐项按勾选门控）
  if (gated('prompt')) skipScopedGroup(scope, repoRoot, 'prompt', skippedByScope)
  else {
    if (gatedItem('prompt', 'AGENTS.md')) skippedByScope.push('prompt/AGENTS.md: 未勾选')
    else copy(join(local.dshHome, 'AGENTS.md'), 'prompt/AGENTS.md')
    if (gatedItem('prompt', 'prompt-inject.md')) skippedByScope.push('prompt/prompt-inject.md: 未勾选')
    else copy(join(local.dshHome, 'prompt-inject.md'), 'prompt/prompt-inject.md')
  }
  if (gated('skills')) skipScopedGroup(scope, repoRoot, 'skills', skippedByScope)
  else copy(join(local.dshHome, 'skills'), 'skills')
  if (gated('presets')) skipScopedGroup(scope, repoRoot, 'presets', skippedByScope)
  else copy(join(local.dshHome, '.agent-presets'), 'presets')

  // 3.5) 会话记录（0.6.49 起 Node 引擎也做，见 runtime/conversations.mjs）：
  //      四块数据字节保真 + 仓库稳定目录名（--ws-<id>--）+ session-index.json；
  //      会话日志走 seq 护栏，避免两台机器各 append 一段后互相覆盖出 seq gap。
  if (gated('conversations')) skipScopedGroup(scope, repoRoot, 'conversations', skippedByScope)
  else {
    try {
      const conv = captureConversations({
        repoRoot,
        dshHome: local.dshHome,
        scope: scope.groups && typeof scope.groups === 'object' ? scope.groups.conversations : null,
      })
      files += conv.files
      bytes += conv.bytes
      changed.push(...conv.changed)
      errors.push(...conv.errors)
      for (const n of conv.notes) skippedByScope.push(`conversations: ${n}`)
    } catch (e) {
      errors.push(`conversations: ${(e && e.message) || e}`)
    }
  }

  // 3.6) 插件数据 / 额外路径（规则与面板、PowerShell 共用 runtime/extra-rules.mjs）
  try {
    const extraCfg = readExtraConfig(local.dshHome)
    if (gated('plugin-data')) skipScopedGroup(scope, repoRoot, 'plugin-data', skippedByScope)
    else {
      const r = capturePluginData({ repoRoot, dshHome: local.dshHome, cfg: extraCfg, scope, roots })
      files += r.files
      bytes += r.bytes
      changed.push(...r.changed)
      errors.push(...r.errors)
      for (const n of r.notes) skippedByScope.push(`plugin-data: ${n}`)
    }
    if (gated('extra')) skipScopedGroup(scope, repoRoot, 'extra', skippedByScope)
    else {
      const r = captureExtraPaths({ repoRoot, dshHome: local.dshHome, cfg: extraCfg, scope, roots })
      files += r.files
      bytes += r.bytes
      changed.push(...r.changed)
      errors.push(...r.errors)
      for (const n of r.notes) skippedByScope.push(`extra: ${n}`)
    }
  } catch (e) {
    errors.push(`plugin-data/extra: ${(e && e.message) || e}`)
  }

  // 4) 本机身份（不是配置，是元数据）：让别的机器知道「这份配置来自哪」
  try {
    writeMachineInfo(repoRoot, localMachineInfo({
      dshVersion: local.dshVersion,
      appRoot: local.appRoot,
      dshHome: local.dshHome,
      workspaceHome: local.workspaceHome,
      lastSyncAt: new Date().toISOString(),
      lastMode: 'capture',
    }))
  } catch { /* 元数据写失败不影响同步 */ }

  return { ok: errors.length === 0, changed: [...new Set(changed)].sort(), files, bytes, errors, local, skipped: skippedByScope }
}

/**
 * 铺开（仓库 → 本机）。
 *
 * 关键顺序：先备份当前状态，再写；写之前检查目标是否被占用。
 *
 * dryRun=true 时**一个字节都不写**（审核修正：旧实现先复制再判 dryRun）。
 * 被覆盖的本机文件留底到 <DshHome>/backups/apply-<时间戳>/，路径结构与原位置一致。
 */
let applyBackupDir = ''

/**
 * 覆盖前留底。只备份「将被覆盖且内容不同」的本机文件；内容相同的不重复拷。
 * src 是目录时逐文件比对。备份失败不阻断同步，但要记进 errors（否则是静默丢底）。
 */
function backupBeforeWrite(src, dst, dshHome, errorsRef) {
  try {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
    const ensureDir = () => {
      if (applyBackupDir) return applyBackupDir
      applyBackupDir = join(dshHome, 'backups', `apply-${stamp}`)
      mkdirSync(applyBackupDir, { recursive: true })
      return applyBackupDir
    }
    const one = (s, d) => {
      if (!existsSync(d) || !isFile(d)) return
      let same = false
      try { same = fileHash(s) === fileHash(d) } catch { same = false }
      if (same) return
      const rel = relative(dshHome, d)
      const target = join(ensureDir(), rel.startsWith('..') ? join('outside', basename(d)) : rel)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(d, target)
    }
    if (isDir(src)) {
      for (const f of walk(src)) one(f.full, join(dst, fromRepoPath(f.rel)))
    } else {
      one(src, dst)
    }
  } catch (e) {
    if (errorsRef) errorsRef.push(`备份失败（文件仍会被覆盖）：${e && e.message ? e.message : e}`)
  }
}

export function apply({ repoRoot, dshHome, appRoot, workspaceHome, profileName = 'desktop', dryRun = false } = {}) {
  const local = probeLocal({ dshHome, appRoot, workspaceHome })
  // 用「用户确认过的根」（config-sync-roots.json）：自选目录必须变成 {{ROOT:x}}，
  // 否则会把本机绝对路径原样带进仓库，换机后对方文件指向一个不存在的目录。
  const roots = readSyncRoots(local.dshHome, local)
  const written = [], skipped = [], errors = [], conflicts = []
  let files = 0, bytes = 0
  applyBackupDir = ''
  // 同步内容勾选：与 capture 同一套判定，别让「没勾的组」在 apply 侧又被铺回来
  const scope = readSyncScope(local.dshHome)
  const skippedByScope = []

  const pull = (srcRel, dst) => {
    const src = join(repoRoot, fromRepoPath(srcRel))
    if (!existsSync(src)) { skipped.push(`${srcRel}: 仓库里没有`); return }
    try {
      // dryRun 必须在**任何写盘之前**返回。旧写法先 copyWithExpand 再判 dryRun，
      // 于是"dryRun"会把文件真的覆盖掉（审核实测：dryRun=true 后本机 package.json 已变）。
      if (dryRun) {
        const st = statSync(src)
        if (st.isDirectory()) { for (const f of walk(src)) written.push(`${srcRel}/${f.rel}`) } else written.push(srcRel)
        return
      }
      // 文本里若还有没配值的占位符，宁可跳过也不把字面量写进配置。
      // 目录源（skills / presets）由 copyWithExpand 在内部逐个文件判断，这里只管单文件。
      if (!isDir(src) && isTextName(src) && !isBinaryName(src)) {
        const miss = missingTokens(expandTokenText(readFileSync(src, 'utf8'), roots))
        if (miss.length > 0) { skipped.push(`${srcRel}: 待确认路径 ${miss.join(', ')}`); return }
      }
      // 覆盖前留底：被覆盖的本机文件先拷到 backups/apply-<时间戳>/，与 PowerShell 版语义一致。
      // 不留底 = 用户没推送的本地改动被静默清掉，且无处可寻。
      backupBeforeWrite(src, dst, local.dshHome, errors)
      const r = copyWithExpand(src, dst, roots)
      files += r.files
      bytes += r.bytes
      // 目录里被跳过的文件也要报出来，否则报告只写「已铺开 skills」，实际少了一批文件。
      for (const s of r.skipped || []) skipped.push(`${srcRel}/${s}`)
      written.push(srcRel)
    } catch (e) {
      errors.push(`${srcRel}: ${e && e.message ? e.message : e}`)
    }
  }

  const profileDir = join(local.dshHome, 'profiles', profileName)
  if (!isDir(profileDir)) {
    return { ok: false, errors: [`profile 目录不存在：${profileDir}（本机还没跑过这个 profile？）`], written, skipped, files, bytes, local }
  }

  pull('profile/package.json', join(profileDir, 'package.json'))
  pull('profile/cordis.patch.yml', join(profileDir, 'cordis.patch.yml'))
  if (!scopeGroupEnabled(scope, 'prompt')) skippedByScope.push('prompt: 未勾选同步')
  else {
    if (scopeItemEnabled(scope, 'prompt', 'AGENTS.md')) pull('prompt/AGENTS.md', join(local.dshHome, 'AGENTS.md'))
    else skippedByScope.push('prompt/AGENTS.md: 未勾选')
    if (scopeItemEnabled(scope, 'prompt', 'prompt-inject.md')) pull('prompt/prompt-inject.md', join(local.dshHome, 'prompt-inject.md'))
    else skippedByScope.push('prompt/prompt-inject.md: 未勾选')
  }
  if (scopeGroupEnabled(scope, 'skills')) pull('skills', join(local.dshHome, 'skills'))
  else skippedByScope.push('skills: 未勾选同步')
  if (scopeGroupEnabled(scope, 'presets')) pull('presets', join(local.dshHome, '.agent-presets'))
  else skippedByScope.push('presets: 未勾选同步')

  // 会话记录：目录名按本机工作区 ID 重编码，会话日志走 seq 护栏（见 runtime/conversations.mjs）
  if (scopeGroupEnabled(scope, 'conversations')) {
    try {
      const conv = applyConversationsWithGuard({
        repoRoot, dshHome: local.dshHome, backupRoot: applyBackupDir, dryRun,
        scope: scope.groups && typeof scope.groups === 'object' ? scope.groups.conversations : null,
      })
      files += conv.copied
      for (const c of conv.conflicts) conflicts.push(c)
      errors.push(...conv.errors)
      for (const n of conv.notes) skippedByScope.push(`conversations: ${n}`)
    } catch (e) {
      errors.push(`conversations: ${(e && e.message) || e}`)
    }
  } else skippedByScope.push('conversations: 未勾选同步')

  // 插件数据 / 额外路径：按仓库里的 manifest + 本机规则铺回（占位符展开后落到本机路径）
  const extraCfg = readExtraConfig(local.dshHome)
  if (scopeGroupEnabled(scope, 'plugin-data') && extraCfg.pluginData.enabled !== false) {
    const pdRoot = join(repoRoot, 'plugin-data')
    if (existsSync(pdRoot)) {
      let slots = null
      try { slots = JSON.parse(readFileSync(join(pdRoot, 'manifest.json'), 'utf8')).slots } catch { /* 没清单就按目录名猜 */ }
      if (!Array.isArray(slots)) {
        let names = []
        try { names = readdirSync(pdRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { names = [] }
        slots = names.map((id) => ({ id }))
      }
      for (const slot of slots) {
        if (!slot || !slot.id) continue
        if (!scopeItemEnabled(scope, 'plugin-data', slot.id)) { skippedByScope.push(`plugin-data/${slot.id}: 未勾选`); continue }
        const target = slot.src ? expandTokenText(slot.src, roots) : join(local.dshHome, slot.id)
        if (slot.src && missingTokens(target).length) { skipped.push(`plugin-data/${slot.id}: 待确认路径 ${missingTokens(target).join(', ')}`); continue }
        if (target === local.dshHome || target.length <= local.dshHome.length) { skipped.push(`plugin-data/${slot.id}: 目标路径可疑，跳过`); continue }
        pull(`plugin-data/${slot.id}`, target)
      }
    }
  } else if (scopeGroupEnabled(scope, 'plugin-data')) skippedByScope.push('plugin-data: 已在 extra 规则里关闭')
  else skippedByScope.push('plugin-data: 未勾选同步')

  if (scopeGroupEnabled(scope, 'extra') && extraCfg.extra.enabled !== false) {
    const exRoot = join(repoRoot, 'extra')
    if (existsSync(exRoot)) {
      for (const p of (extraCfg.extra.paths || [])) {
        if (!scopeItemEnabled(scope, 'extra', p.id)) { skippedByScope.push(`extra/${p.id}: 未勾选`); continue }
        const dirEntry = join(exRoot, p.id)
        if (isDir(dirEntry)) { pull(`extra/${p.id}`, p.src); continue }
        let fileEntry = ''
        try {
          const hit = readdirSync(exRoot).find((n) => n.startsWith(`${p.id}.`))
          if (hit) fileEntry = hit
        } catch { /* 没有就跳过 */ }
        if (fileEntry) pull(`extra/${fileEntry}`, p.src)
        else skipped.push(`extra/${p.id}: 仓库里没有`)
      }
    }
  } else if (scopeGroupEnabled(scope, 'extra')) skippedByScope.push('extra: 已在 extra 规则里关闭')
  else skippedByScope.push('extra: 未勾选同步')

  return { ok: errors.length === 0, written, skipped, errors, conflicts, files, bytes, local, backupDir: applyBackupDir, skippedByScope }
}

/**
 * 只读体检（面板 status 路由用）。
 * 不做任何写操作，可以安全地在客户端运行时调用。
 */
/**
 * 会话还原 + seq 护栏脚本定位。
 * 顺序：插件自带的 tools/ → 插件上一级的 tools/（仓库工作副本就是这种布局）→
 * 仓库里的 tools/ → 仓库根（老仓库把脚本平铺在根上）。找不到就退回整文件覆盖，
 * 并把这件事记进 notes —— 不静默降级。
 */
function applyConversationsWithGuard(opts) {
  const here = dirname(fileURLToPath(import.meta.url))
  const guardScript = resolveGuardScript([
    // runtime/tools/ 才是发布包里那份（npm 包不含仓库根的 tools/）；其余是仓库工作副本与老仓库布局
    join(here, 'tools', 'session-log-guard.mjs'),
    join(here, '..', 'tools', 'session-log-guard.mjs'),
    opts.repoRoot ? join(opts.repoRoot, 'tools', 'session-log-guard.mjs') : '',
    opts.repoRoot ? join(opts.repoRoot, 'session-log-guard.mjs') : '',
  ])
  return applyConversations({ ...opts, guardScript })
}

export function status({ repoRoot, dshHome, appRoot, workspaceHome } = {}) {
  const local = probeLocal({ dshHome, appRoot, workspaceHome })
  const contract = repoRoot ? readContract(repoRoot) : null
  const machines = repoRoot ? listMachines(repoRoot) : []
  const git = local.git
  const gitState = git && repoRoot ? readGitState(repoRoot, git) : null
  return {
    platform: { os: local.os, osFamily: local.osFamily, arch: local.arch, label: local.os },
    local: {
      dshVersion: local.dshVersion,
      electronVersion: local.electronVersion,
      appRoot: local.appRoot,
      dshHome: local.dshHome,
      workspaceHome: local.workspaceHome,
      clientExe: local.clientExe,
      hasGit: local.hasGit,
      hasNode: local.hasNode,
    },
    contract: contract ? {
      appVersion: contract.appVersion,
      electronVersion: contract.electronVersion,
      platforms: contract.platforms,
      platformFamily: contract.platformFamily,
      os: contract.os,
      arch: contract.arch,
    } : null,
    machines,
    git: gitState,
    warnings: buildWarnings({ local, contract, repoRoot }),
  }
}

/**
 * 跑一条 git 命令（跨平台：macOS / Linux 与 Windows 同一条路径，不依赖 PowerShell）。
 * 之前引擎的 push / pull 完全没有 git 动作 —— 结果是「推送跑了但云端没变化」「拉取跑了但没下载」，
 * 用户在非 Windows 上根本同步不了。这里补上真正的提交与推送。
 */
function gitRun(repoRoot, args, timeoutMs = 300000) {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout: timeoutMs })
  return {
    code: r.status == null ? 1 : r.status,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || '').trim(),
    error: r.error ? String(r.error.message || r.error) : '',
  }
}
/** git 状态（分支 / HEAD / 领先落后 / 工作树脏度）。失败返回 null。 */
function readGitState(repoRoot, git) {
  const run = (args) => {
    const r = spawnSync(git, ['-C', repoRoot, ...args], { encoding: 'utf8', timeout: 15000 })
    return { code: r.status == null ? 1 : r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
  }
  try {
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
    const head = run(['log', '-1', '--oneline'])
    const dirty = run(['status', '--porcelain'])
    const upstream = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    let ahead = null, behind = null
    if (upstream.code === 0 && upstream.out) {
      const a = run(['rev-list', '--count', `${upstream.out}..HEAD`])
      const b = run(['rev-list', '--count', `HEAD..${upstream.out}`])
      if (a.code === 0) ahead = Number(a.out) || 0
      if (b.code === 0) behind = Number(b.out) || 0
    }
    return {
      branch: branch.code === 0 ? branch.out : '',
      head: head.code === 0 ? head.out : '',
      dirty: dirty.code === 0 ? dirty.out.split('\n').filter(Boolean).length : 0,
      ahead, behind,
      ok: true,
    }
  } catch {
    return null
  }
}

/** 把体检结果里的「该提醒人的事」收成人类可读的清单。 */
function buildWarnings({ local, contract, repoRoot }) {
  const out = []
  if (!local.hasGit) out.push({ level: 'warn', code: 'no-git', text: '本机找不到 git（推送/拉取都跑不了）' })
  if (!local.hasNode) out.push({ level: 'warn', code: 'no-node', text: '本机找不到 Node 运行时（会话 cwd 修正会被跳过）' })
  if (contract && contract.appVersion && local.dshVersion && contract.appVersion !== local.dshVersion) {
    out.push({
      level: 'warn',
      code: 'version-drift',
      text: `客户端版本不一致：本机 ${local.dshVersion}，仓库契约 ${contract.appVersion}`,
    })
  }
  // 跨端：这不是错误，是提示。用户第一次在 macOS 上拉 Windows 推的配置会看到这句。
  if (contract && contract.os && contract.os !== local.os) {
    const from = String(contract.os)
    out.push({
      level: 'info',
      code: 'cross-platform',
      text: `这份配置来自 ${from}（本机 ${local.os}）：拉取会按本机路径展开，首次建议重启一次让插件重装原生模块`,
    })
  }
  return out
}

/**
 * 把 Node 执行体写进仓库根（sync-engine.mjs + 它 import 的几个模块）。
 *
 * 为什么必须有：换机拉取的机器要能在**没有插件**的情况下跑 `node sync-engine.mjs`；
 * 更要紧的是宿主用「仓库根有没有 apply.ps1 / sync-engine.mjs」判断这是不是一个可用仓库。
 * 0.6.49 之前 POSIX 的 capture 只写内容、不写执行体 —— 第一次推送成功后，
 * 仓库立刻变成「像仓库但没执行体」，面板报「这个目录里已经有别的东西」并禁掉后续动作，
 * 用户只能重配一遍。Windows 版一直是连脚本一起写进仓库的，这里补齐同一语义。
 */
export function ensureRepoRunner(repoRoot) {
  const here = dirname(fileURLToPath(import.meta.url))
  // 会话记录组的实现也是随仓库走的（另一台机器没有插件副本时靠仓库这份跑 apply）
  const names = ['sync-engine.mjs', 'platform.mjs', 'contract.mjs', 'machines.mjs', 'webdav.mjs', 'conversations.mjs']
  const written = []
  for (const name of names) {
    const src = join(here, name)
    if (!isFile(src)) continue
    const dst = join(repoRoot, name)
    try {
      let same = false
      try { same = existsSync(dst) && fileHash(src) === fileHash(dst) } catch { same = false }
      if (!same) { copyFileSync(src, dst); written.push(name) }
    } catch { /* 写不进去不阻断同步：仓库里已有旧版执行体也能跑 */ }
  }
  return written
}

/**
 * 新机器首次拉取：把空仓库 / 还没上游的仓库跟 origin 对齐。
 *
 * Windows 版的 sync.ps1 有 Initialize-RepoIfNeeded（init + fetch + checkout）兜这件事；
 * Node 引擎之前**没有**，于是第一次 `pull` 在全新目录上必然停在
 * 「快进合并失败：fatal: no such branch: 'main'」，后面 apply 拿空仓库照跑一遍，
 * 结果「拉取成功、什么都没落地」。macOS 上没有第二条路可退，这个洞必须补。
 *
 * 返回 { ok, bootstrapped, branch, error }
 */
function bootstrapRepo(repoRoot) {
  const remotes = gitRun(repoRoot, ['remote'], 60000)
  if (!remotes.out.split(/\r?\n/).includes('origin')) {
    return { ok: false, bootstrapped: false, error: '本机仓库没有 origin：先在面板「云端仓库」里填远端地址并保存，再拉取' }
  }
  // 远端默认分支：ls-remote --symref origin HEAD → "ref: refs/heads/main\tHEAD"
  let branch = ''
  const sym = gitRun(repoRoot, ['ls-remote', '--symref', 'origin', 'HEAD'], 60000)
  const m = /ref:\s+refs\/heads\/([^\s]+)\s+HEAD/.exec(sym.out || '')
  if (m) branch = m[1]
  if (!branch) {
    // 没有 HEAD 指向（空仓库）或老 git：退回 init.defaultBranch 或 main
    const guess = gitRun(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 15000)
    branch = (guess.out || '').replace(/^origin\//, '') || 'main'
  }
  const fetched = gitRun(repoRoot, ['fetch', 'origin', '--prune'], 300000)
  if (fetched.code !== 0) {
    return { ok: false, bootstrapped: false, error: `git fetch 失败：${fetched.err || fetched.error}` }
  }
  const hasCommit = gitRun(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], 15000).code === 0
  const remoteRef = `origin/${branch}`
  const remoteExists = gitRun(repoRoot, ['rev-parse', '--verify', '--quiet', remoteRef], 15000).code === 0
  if (!remoteExists) {
    return { ok: true, bootstrapped: false, branch, error: '' }
  }
  if (!hasCommit) {
    // 全新目录：直接按远端分支建本地分支并 checkout
    const co = gitRun(repoRoot, ['checkout', '-f', '-B', branch, '--track', remoteRef], 120000)
    if (co.code !== 0) {
      const co2 = gitRun(repoRoot, ['checkout', '-f', '-b', branch, remoteRef], 120000)
      if (co2.code !== 0) return { ok: false, bootstrapped: false, error: `git checkout 失败：${co2.err || co2.error || co.err}` }
    }
    return { ok: true, bootstrapped: true, branch, error: '' }
  }
  return { ok: true, bootstrapped: false, branch, error: '' }
}

/** 仓库是否具备同步条件（有 apply.ps1 或 sync-engine 的布局标志）。 */
export function isRepoRoot(dir) {
  if (!dir) return false
  return isFile(join(dir, 'profile', 'package.json')) || isDir(join(dir, 'machines'))
}

/** 便于外部调用者做一次性完整探测。 */
export function probeAll(opts = {}) {
  return probeLocal(opts)
}

/* ============================ 命令行入口 ============================
 * POSIX 脚本（同步-推送.sh / 同步-拉取.sh / 同步-还原.sh）调的就是这里。
 * 参数与 PowerShell 版保持同形，便于两版共用一套仓库与文档：
 *
 *   node sync-engine.mjs push   -RepoRoot <dir> -AppRoot <dir> -DshHome <dir> [-Message "..."]
 *   node sync-engine.mjs pull   -RepoRoot <dir> -AppRoot <dir> -DshHome <dir>
 *   node sync-engine.mjs status -RepoRoot <dir> -DshHome <dir>
 *   node sync-engine.mjs restore -RepoRoot <dir> -DshHome <dir> [-BackupDir <dir>]
 *
 * 直接 `node sync-engine.mjs` 不带子命令时打印用法，便于人工排查。
 */

/** 只认识的参数；打错字时明确提示，而不是静默用默认值跑错目录。 */
function warnUnknownArgs(args, known, usage) {
  const extra = Object.keys(args).filter((k) => !known.includes(k))
  if (!extra.length) return
  console.error(`[!] 未知参数：${extra.map((k) => '-' + k).join(', ')}（已忽略；用法：${usage}）`)
}

/**
 * 确认 repoRoot 自己就是仓库根。
 *
 * git 会从当前目录一路向上找 .git：如果同步仓库被放在另一个仓库的子目录里，
 * 所有 git 操作都会落到**外层仓库**上（实测把用户 home 的 dotfiles 仓库当场撞锁）。
 * 宁可拒绝，也不能替用户改到别的仓库。
 */
function ensureOwnRepo(repoRoot) {
  const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  // 0.6.49（macOS 实测）：/var 与 /tmp 都是指向 /private/var、/private/tmp 的符号链接，
  // `git rev-parse --show-toplevel` 报的是**真实路径**，而用户填/系统给的是符号链接写法 ——
  // 只比字面量会把 /tmp/dsh-config 判成「这个目录不是仓库根」，面板的「立即推送」直接失败。
  // 两边都 realpath 一次再比，任何一边解析失败就退回字面量。
  const real = (s) => { try { return realpathSync(String(s || '')) } catch { return String(s || '') } }
  const sameDir = (a, b) => norm(a) === norm(b) || norm(real(a)) === norm(real(b))
  const top = gitRun(repoRoot, ['rev-parse', '--show-toplevel'], 60000)
  if (top.code !== 0) {
    return { ok: false, error: `这个目录还不是 git 仓库：${repoRoot}（先在面板「云端仓库」里初始化，或换成已有仓库）` }
  }
  const got = String(top.out || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
  if (!got || !sameDir(got, repoRoot)) {
    return {
      ok: false,
      error: `这个目录不是仓库根：git 认到的是 ${got || '(空)'}；请把同步仓库放在独立目录，不要塞在别的仓库里面`,
    }
  }
  return { ok: true, top: got }
}

/** 把 `a=b` / `--a b` / `-a b` 混写的参数解析成对象。 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = String(argv[i])
    if (!tok.startsWith('-')) continue
    const clean = tok.replace(/^-+/, '')
    const eq = clean.indexOf('=')
    if (eq > 0) { out[clean.slice(0, eq)] = clean.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (next !== undefined && !String(next).startsWith('-')) { out[clean] = String(next); i++ }
    else out[clean] = true
  }
  return out
}

function readSyncSettings(dshHome) {
  try {
    const p = join(dshHome, 'dsh-config-sync.json')
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

/** 递归拷贝（不删目标里已有的其它文件），返回写入文件数。 */
function copyTreeCount(from, to) {
  if (!existsSync(from)) return 0
  const st = statSync(from)
  if (!st.isDirectory()) {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    return 1
  }
  let n = 0
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    n += copyTreeCount(join(from, e.name), join(to, e.name))
  }
  return n
}

/** 插件目录：优先 <appRoot>/dsh-config-sync-*，其次 profile/node_modules 里的安装副本。 */
function findPluginTarget({ appRoot, dshHome, profileName }) {
  const cands = []
  if (appRoot && isDir(appRoot)) {
    try {
      for (const e of readdirSync(appRoot, { withFileTypes: true })) {
        if (e.isDirectory() && /^dsh-config-sync/.test(e.name)) cands.push(join(appRoot, e.name))
      }
    } catch { }
  }
  const nm = join(dshHome, 'profiles', profileName || 'desktop', 'node_modules', 'dsh-profile-config-sync')
  if (isDir(nm)) cands.push(nm)
  // 有多个候选时取最新的那份（最近安装/升级的那个）
  cands.sort((x, y) => {
    try { return statSync(y).mtimeMs - statSync(x).mtimeMs } catch { return 0 }
  })
  return cands[0] || ''
}

/**
 * 还原「插件」或「会话」快照（-SnapshotKind plugin / session）。
 * 与 restore.ps1 的两个分支一一对应：
 *   plugin  → 快照内容写回插件目录（半截备份会多一层 <插件目录名>/，取其内容），当前插件先整份留底
 *   session → 快照里的 --xxx-- 目录写回 <dshHome>/sessions，同名目录先留底
 */
function restoreNonProfile({ kind, snapDir, dshHome, appRoot, profileName, stamp, a }) {
  if (kind === 'plugin') {
    const target = String(a.PluginDir || a.pluginDir || '') || findPluginTarget({ appRoot, dshHome, profileName })
    if (!target) {
      console.error('找不到要回滚的插件目录：请传 -PluginDir（例如 <客户端根>/dsh-config-sync-0.1.0）')
      return 2
    }
    let srcRoot = snapDir
    let kids = readdirSync(srcRoot, { withFileTypes: true })
    if (kids.length === 1 && kids[0].isDirectory() && /^dsh-config-sync/.test(kids[0].name)) {
      srcRoot = join(srcRoot, kids[0].name)
      kids = readdirSync(srcRoot, { withFileTypes: true })
      console.log(`备份里只有一层安装目录，取其内容：${srcRoot}`)
    }
    if (!kids.length) {
      console.error(`这份备份里没有任何文件：${snapDir}`)
      return 2
    }
    let ver = 'unknown'
    try { ver = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version || ver } catch { }
    const bk = join(dshHome, 'backups', `plugin-${ver}-${stamp}`)
    console.log(`先把当前插件备份到 ${bk}（回滚错了还能再回滚回来）`)
    copyTreeCount(target, bk)
    let n = 0
    for (const it of kids) n += copyTreeCount(join(srcRoot, it.name), join(target, it.name))
    console.log(`已把插件回滚到 ${snapDir} 的内容（写入 ${n} 个顶层条目 → ${target}）`)
    console.log(`回滚前的插件已备份：${bk}`)
    console.log('重启客户端后生效')
    return 0
  }

  // session
  const dirs = readdirSync(snapDir, { withFileTypes: true }).filter((e) => e.isDirectory())
  if (!dirs.length) {
    console.error(`这份备份里没有会话目录（顶层应为 --xxx-- 目录）：${snapDir}`)
    return 2
  }
  const sessions = join(dshHome, 'sessions')
  const bk = join(dshHome, 'backups', `session-${stamp}`)
  mkdirSync(sessions, { recursive: true })
  mkdirSync(bk, { recursive: true })
  let n = 0
  for (const d of dirs) {
    const existing = join(sessions, d.name)
    if (existsSync(existing)) copyTreeCount(existing, join(bk, d.name))
    copyTreeCount(join(snapDir, d.name), existing)
    n += 1
  }
  console.log(`已把 ${n} 个会话目录写回 ${sessions}；同名目录先前的状态已备份到 ${bk}`)
  console.log('重启客户端后可在这台机器的会话列表里看到还原后的会话')
  return 0
}

/** 命令行主流程。返回进程退出码。 */
export async function runCli(argv) {
  const [cmd, ...rest] = argv
  const a = parseArgs(rest)
  // 打错参数（-BackupDirr / -RepRoot）时明确提示：静默忽略等于按默认目录跑，可能写到别处。
  warnUnknownArgs(a, [
    'RepoRoot', 'repoRoot', 'DshHome', 'dshHome', 'AppRoot', 'appRoot', 'WorkspaceHome', 'workspaceHome',
    'ProfileName', 'profileName', 'Message', 'message', 'BackupDir', 'backupDir',
    'SnapshotKind', 'snapshotKind', 'PluginDir', 'pluginDir', 'Force', 'force',
    'AllowVersionDrift', 'allowVersionDrift',
    // 0.6.49：还原/铺开的「只看不动」开关。面板生成的 POSIX 脚本第一步就调 -DryRun，
    // 不认这个参数会打一行「未知参数」警告，还把 -DryRun 当多余参数忽略 —— 计划变真跑。
    'DryRun', 'dryRun',
  ], 'node sync-engine.mjs <status|push|pull|restore> -RepoRoot <dir> -DshHome <dir>')
  const repoRoot = a.RepoRoot || a.repoRoot || process.cwd()
  const dshHome = a.DshHome || a.dshHome || localDshHome()
  const appRoot = a.AppRoot || a.appRoot || ''
  const workspaceHome = a.WorkspaceHome || a.workspaceHome || ''
  const profileName = a.ProfileName || a.profileName || 'desktop'
  const syncSettings = readSyncSettings(dshHome)
  const useWebdav = webdavActive(syncSettings)
  const w = normalizeWebdav(syncSettings)

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log([
      '用法：node sync-engine.mjs <命令> [参数]',
      '',
      '命令：',
      '  status    只读体检（平台 / 版本 / 契约 / git 状态 / 已登记机器）',
      '  push      本机 → 仓库（capture）',
      '  pull      仓库 → 本机（apply）',
      '  restore   从快照还原本机 profile',
      '',
      '参数：',
      '  -RepoRoot <dir>       仓库目录（默认当前目录）',
      '  -DshHome <dir>        DSH 配置根（默认 $DSH_HOME 或 ~/.dsh）',
      '  -AppRoot <dir>        客户端安装根（留空自动探测）',
      '  -WorkspaceHome <dir>  工作区根（留空用默认）',
      '  -ProfileName <name>   profile 名（默认 desktop）',
      '  -Message <text>       提交说明（仅 push）',
      '  -BackupDir <dir>      还原哪份快照（仅 restore）',
      '  -SnapshotKind <kind>  快照类型 profile|plugin|session（仅 restore，默认 profile）',
      '  -PluginDir <dir>      插件快照回滚到哪个目录（仅 restore -SnapshotKind plugin）',
    ].join('\n'))
    return 0
  }

  try {
    if (cmd === 'status') {
      const st = status({ repoRoot, dshHome, appRoot, workspaceHome, profileName })
      console.log(JSON.stringify(st, null, 2))
      return 0
    }
    if (cmd === 'push') {
      if (useWebdav) {
        if (!isSecureUrl(w.url)) {
          console.error('WebDAV 地址不是 https（明文传输密码有风险）；确需使用请设 DSH_SYNC_ALLOW_INSECURE=1')
          return 1
        }
        const repoReady = existsSync(join(repoRoot, 'profile', 'package.json'))
        if (!repoReady) {
          const probe = await testConnection(w)
          if (!probe.ok) { console.error(`WebDAV 探测失败：${probe.error}`); return 1 }
          if (probe.files > 0) { console.error('云端 WebDAV 已有内容，本机还是空的，请先执行拉取'); return 1 }
          mkdirSync(repoRoot, { recursive: true })
        }
      }
      const r = capture({ repoRoot, dshHome, appRoot, workspaceHome, profileName })
      for (const c of r.changed) console.log(`  + ${c}`)
      for (const e of r.errors) console.error(`  [!] ${e}`)
      console.log(`capture 完成：${r.files} 个文件 / ${r.bytes} 字节，变更 ${r.changed.length} 项`)
      if (!r.ok) return 1
      if (!useWebdav) {
        // git 模式：把 capture 出来的改动提交，再推到 origin。
        // 先确认这个目录就是仓库根：否则 git 会向上找到外层仓库，改到别人的仓库上去。
        const own = ensureOwnRepo(repoRoot)
        if (!own.ok) { console.error(own.error); return 1 }
        const add = gitRun(repoRoot, ['add', '-A'])
        if (add.code !== 0) { console.error(`git add 失败：${add.err || add.error}`); return 1 }
        const dirty = gitRun(repoRoot, ['status', '--porcelain'], 60000)
        if (dirty.code !== 0) { console.error(`git status 失败：${dirty.err || dirty.error}`); return 1 }
        const changed = dirty.out ? dirty.out.split(/\r?\n/).filter(Boolean).length : 0
        if (changed > 0) {
          const msg = String(a.Message || a.message || `sync: capture ${new Date().toISOString().slice(0, 19)} @ ${hostname()}`)
          const commit = gitRun(repoRoot, ['commit', '-m', msg], 60000)
          if (commit.code !== 0) { console.error(`git commit 失败：${commit.err || commit.error}`); return 1 }
          console.log(`已提交 ${changed} 个文件：${msg}`)
        } else {
          console.log('没有变更需要提交')
        }
        const remotes = gitRun(repoRoot, ['remote'], 60000)
        if (!remotes.out.split(/\r?\n/).includes('origin')) {
          console.error('本机仓库没有 origin：先在面板「云端仓库」里填远端地址并保存，再推送')
          return 1
        }
        const hasUpstream = gitRun(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 60000).code === 0
        const pushed = hasUpstream ? gitRun(repoRoot, ['push']) : gitRun(repoRoot, ['push', '-u', 'origin', 'HEAD'])
        if (pushed.code !== 0) {
          console.error(`git push 失败：${pushed.err || pushed.error}`)
          console.error('改动已提交在本地，修好认证/网络后重跑推送即可')
          return 1
        }
        console.log(pushed.err || pushed.out || '已推送')
      }
      if (useWebdav) {
        const up = await uploadRepo(w, repoRoot)
        for (const e of up.errors) console.error(`  [!] ${e}`)
        console.log(`WebDAV 上传：上传 ${up.uploaded.length} · 跳过 ${up.skipped.length} · 错误 ${up.errors.length}`)
        return up.ok ? 0 : 1
      }
      return 0
    }
    if (cmd === 'pull') {
      if (useWebdav) {
        if (!isSecureUrl(w.url)) {
          console.error('WebDAV 地址不是 https（明文传输密码有风险）；确需使用请设 DSH_SYNC_ALLOW_INSECURE=1')
          return 1
        }
        const probe = await testConnection(w)
        if (!probe.ok) { console.error(`WebDAV 探测失败：${probe.error}`); return 1 }
        if (!probe.exists || probe.files <= 0) { console.error('云端 WebDAV 目录里还没有内容，请先在一台机器推送'); return 1 }
        mkdirSync(repoRoot, { recursive: true })
        const dn = await downloadRepo(w, repoRoot)
        for (const e of dn.errors) console.error(`  [!] ${e}`)
        console.log(`WebDAV 下载：下载 ${dn.downloaded.length} · 跳过 ${dn.skipped.length} · 冲突 ${dn.conflicts.length} · 错误 ${dn.errors.length}`)
        if (!dn.ok) return 1
      }
      if (!useWebdav) {
        // git 模式：先把云端拿下来。之前完全没有这一步，等于「拉取」只把**本地仓库**铺到本机，
        // 云端有更新永远拉不下来。
        const own = ensureOwnRepo(repoRoot)
        if (!own.ok) { console.error(own.error); return 1 }
        const remotes = gitRun(repoRoot, ['remote'], 60000)
        if (!remotes.out.split(/\r?\n/).includes('origin')) {
          console.error('本机仓库没有 origin：先在面板「云端仓库」里填远端地址并保存，再拉取')
          return 1
        }
        const boot = bootstrapRepo(repoRoot)
        if (!boot.ok) {
          console.error(boot.error)
          console.error('离线或认证失败时不会用旧仓库覆盖本机，已停下')
          return 1
        }
        if (boot.bootstrapped) {
          console.log(`已把云端仓库拉到本机（分支 ${boot.branch}）`)
        } else {
          const worktree = gitRun(repoRoot, ['status', '--porcelain'], 60000).out
          if (worktree) {
            console.error('[!] 仓库工作区有未提交改动，跳过自动合并（先在仓库里提交或清理，再拉取）')
          } else {
            // 本机有提交但还没上游（例如换机后手工 init 过）：先绑上游再快进
            const hasUpstream = gitRun(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 60000).code === 0
            if (!hasUpstream && boot.branch) {
              const local = gitRun(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], 15000).out || boot.branch
              gitRun(repoRoot, ['branch', '--set-upstream-to', `origin/${boot.branch}`, local], 30000)
            }
            const merged = gitRun(repoRoot, ['merge', '--ff-only', '@{upstream}'], 120000)
            if (merged.code !== 0) {
              console.error(`[!] 快进合并失败：${merged.err || merged.error}（继续用当前本地仓库内容）`)
            } else {
              console.log(merged.out || '仓库已是最新')
            }
          }
        }
      }
      // 宿主版本契约：与 Windows 版语义一致 —— 主版本不同直接拒绝，同主版本不同号只警告。
      const contractDoc = readContract(repoRoot)
      const localDoc = createProbeLocal({ dshHome, appRoot, workspaceHome })
      const verdict = checkContract(contractDoc, localDoc)
      if (verdict.level === 'block' && !(a.AllowVersionDrift || a.allowVersionDrift)) {
        console.error(`宿主版本不一致（${verdict.reason}）：未改动任何文件。先把两台升到同一版，或加 -AllowVersionDrift`)
        return 1
      }
      if (verdict.level === 'warn') {
        console.error(`[!] 宿主版本不一致（${verdict.reason}）：继续同步，但会剔除实验性 bundle`)
      }
      // -DryRun：只打印「会写哪些项」，一个字节都不落盘。Windows 版的还原脚本
      // 先跑一遍 -DryRun 再确认，POSIX 的还原脚本同样需要这一步（见 index.js buildSh）。
      const dryRun = a.DryRun === true || a.dryRun === true
      const r = apply({ repoRoot, dshHome, appRoot, workspaceHome, profileName, dryRun })
      for (const wItem of r.written) console.log(`  > ${wItem}`)
      for (const s of r.skipped) console.log(`  - 跳过 ${s}`)
      for (const e of r.errors) console.error(`  [!] ${e}`)
      if (r.backupDir) console.log(`  被覆盖的本机文件已留底：${r.backupDir}`)
      console.log(`apply 完成：写入 ${r.written.length} 项 / ${r.files} 个文件，跳过 ${r.skipped.length} 项`)
      return r.ok ? 0 : 1
    }
    if (cmd === 'restore') {
      // POSIX 版还原：从仓库里的快照目录拷回 profile / 插件 / 会话。
      // 快照布局与 PowerShell 版一致（backups/config-<时间戳>/profile/...）。
      const snapDir = a.BackupDir || a.backupDir || ''
      // -SnapshotKind：面板生成的还原脚本会带这个参数（profile / plugin / session）。
      // 旧实现完全忽略它 —— 拿插件/会话快照跑 profile 还原，结果要么报「快照里没有 profile/」，
      // 要么（布局碰巧像）把 profile 覆盖成一份插件目录。
      const kind = String(a.SnapshotKind || a.snapshotKind || 'profile').toLowerCase()
      if (!snapDir) {
        console.error('restore 需要 -BackupDir <快照目录>')
        return 2
      }
      // 拼错的快照类型不能静默当 profile：那是「以为在还原插件，实际覆盖了 profile」。
      if (!['profile', 'plugin', 'session'].includes(kind)) {
        console.error(`未知的快照类型：${kind}（可选 profile / plugin / session）`)
        return 2
      }
      if (!existsSync(snapDir)) {
        console.error(`快照目录不存在：${snapDir}`)
        return 2
      }
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
      if (kind === 'plugin' || kind === 'session') {
        return restoreNonProfile({ kind, snapDir, dshHome, appRoot, profileName, stamp, a })
      }
      const profileDir = join(dshHome, 'profiles', profileName)
      // 快照布局有三种，都要认：
      //   <snap>/profile/…            —— 引擎早先的还原约定
      //   <snap>/profiles/<name>/…    —— 引擎 apply 的备份（按 dshHome 相对路径落盘）
      //   <snap>/package.json + …     —— PowerShell apply 的备份（平铺）
      // 只认第一种会让「在另一台机器上还原」直接失败。
      const layoutCandidates = [join(snapDir, 'profile'), join(snapDir, 'profiles', profileName), snapDir]
      const FLAT_MARKERS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml', 'AGENTS.md', 'prompt-inject.md']
      // 第一种：带 profile 目录的布局；第二种：平铺布局 —— 但必须真的含至少一个 profile 文件。
      // 只按「是个目录」就认，会把空目录/指错的目录也当快照：先建一份无用的还原前备份，
      // 再打印「已从 X 还原（写入 0 个文件）」，最后才报失败。
      const src = layoutCandidates.find((d) => existsSync(join(d, 'package.json')))
        || layoutCandidates.find((d) => d === snapDir && FLAT_MARKERS.some((f) => existsSync(join(d, f))))
      if (!src) {
        console.error(`快照里没有可还原的 profile（没找到 profile/ 或平铺的 package.json 等文件）：${snapDir}`)
        return 2
      }
      // -DryRun：只报计划（会覆盖哪些文件、留底到哪），不读不写 ——
      // 与 PowerShell 版 restore.ps1 -DryRun 同语义，给确认框前面那一步用。
      if (a.DryRun === true || a.dryRun === true) {
        const countIn = (dir) => walk(dir).length
        console.log(`[计划] 快照：${snapDir}（${kind}）`)
        console.log(`[计划] 目标：${profileDir}`)
        console.log(`[计划] 将写入 ${countIn(src)} 个文件；当前 profile 有 ${countIn(profileDir)} 个文件会被先留底`)
        console.log(`[计划] 未做任何改动（-DryRun）`)
        return 0
      }
      const restoreBackupRoot = join(dshHome, 'backups', `restore-before-${stamp}`)
      mkdirSync(profileDir, { recursive: true })
      // 还原同样是"覆盖本机"：先把当前 profile 留底，否则还原错了没有回头路。
      for (const f of walk(profileDir)) {
        const target = join(restoreBackupRoot, fromRepoPath(f.rel))
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(f.full, target)
      }
      // 根必须用探测值（appRoot 可能为空串）——否则 {{APP_ROOT}} 会被展开成空，写出坏路径
      if (src === snapDir) {
        // 平铺快照：只还原 profile 的那几个文件，另外 AGENTS.md 属于 dshHome 根。
        const profileFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']
        let restored = 0
        for (const f of profileFiles) {
          const s = join(snapDir, f)
          if (!existsSync(s)) continue
          copyFileSync(s, join(profileDir, f)); restored++
        }
        for (const f of ['AGENTS.md', 'prompt-inject.md']) {
          const s = join(snapDir, f)
          if (!existsSync(s)) continue
          copyFileSync(s, join(dshHome, f)); restored++
        }
        console.log(`已从 ${snapDir} 还原 profile → ${profileDir}（平铺快照，写入 ${restored} 个文件）`)
        console.log(`还原前的 profile 已留底：${restoreBackupRoot}`)
        return restored > 0 ? 0 : 2
      }
      const exp = copyWithExpand(src, profileDir, collectRoots(probeLocal({ dshHome, appRoot, workspaceHome })))
      console.log(`已从 ${snapDir} 还原 profile → ${profileDir}（写入 ${exp.files} 个文件）`)
      for (const s of exp.skipped || []) console.error(`  - 跳过 ${s}`)
      console.log(`还原前的 profile 已留底：${restoreBackupRoot}`)
      return 0
    }
    console.error(`未知命令：${cmd}（用 help 看用法）`)
    return 2
  } catch (e) {
    console.error(`执行失败：${e && e.stack ? e.stack : e}`)
    return 1
  }
}

// 只有被直接执行时才跑 CLI（被 import 时不产生副作用）。
// 判据用 process.argv[1] 与本文件路径比较，兼容符号链接与相对路径调用。
const invokedDirectly = (() => {
  try {
    const self = resolve(process.argv[1] || '')
    return self === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
