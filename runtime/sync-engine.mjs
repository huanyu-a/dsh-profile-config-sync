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
  readSync, renameSync, rmSync, statSync, writeFileSync, lstatSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  IS_WIN, SEP, appRootCandidates, clientExecutable, dshHome as resolveDshHome,
  defaultWorkspaceHome, findGit, hostNodeExe, isAppRoot, isDir, isFile, platformFamily,
} from './platform.mjs'
import { buildContract, contractPath, contractText, readContract } from './contract.mjs'
import { listMachines, localMachineInfo, writeMachineInfo } from './machines.mjs'
import { downloadRepo, isSecureUrl, normalizeWebdav, testConnection, uploadRepo, webdavActive } from './webdav.mjs'

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
  out = out.replace(/(\{\{(?:APP_ROOT|DSH_HOME|WORKSPACE_HOME|ROOT:[A-Za-z0-9_.-]+)\}\})((?:\\\\|\\|\/)[^"\s,;:}{\[\]]*)/g,
    (_m, token, rest) => token + rest.split(String.fromCharCode(92)).join('/'))
  return out
}

/** 占位符 → 本机路径（apply 落地前调用）。 */
export function expandTokenText(text, roots) {
  if (!text) return text
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
  const re = /\{\{(APP_ROOT|DSH_HOME|WORKSPACE_HOME|ROOT:[A-Za-z0-9_.-]+)\}\}/g
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
export function copyWithTokens(src, dst, roots) {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true })
    for (const e of readdirSync(src, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue
      if (e.isSymbolicLink && e.isSymbolicLink()) continue
      copyWithTokens(join(src, e.name), join(dst, e.name), roots)
    }
    return { files: 0, bytes: 0 }
  }
  if (!isFile(src)) return { files: 0, bytes: 0 }
  mkdirSync(dirname(dst), { recursive: true })
  const name = basename(src)
  if (isBinaryName(name) || !isTextName(name)) {
    copyFileSync(src, dst)
    return { files: 1, bytes: st.size }
  }
  const text = readFileSync(src, 'utf8')
  const out = toTokenText(text, roots).replace(/\r\n/g, '\n')
  writeFileSync(dst, out, 'utf8')
  return { files: 1, bytes: Buffer.byteLength(out, 'utf8') }
}

/** 反向：仓库 → 本机，把占位符展开。 */
export function copyWithExpand(src, dst, roots) {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true })
    for (const e of readdirSync(src, { withFileTypes: true })) {
      copyWithExpand(join(src, e.name), join(dst, e.name), roots)
    }
    return { files: 0, bytes: 0 }
  }
  if (!isFile(src)) return { files: 0, bytes: 0 }
  mkdirSync(dirname(dst), { recursive: true })
  const name = basename(src)
  if (isBinaryName(name) || !isTextName(name)) {
    copyFileSync(src, dst)
    return { files: 1, bytes: st.size }
  }
  const text = readFileSync(src, 'utf8')
  const out = expandTokenText(text, roots)
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
  const plain = readJsonSafe(join(appRoot, 'resources', 'app', 'package.json'))
  if (plain && plain.version) return String(plain.version)
  const asarPkg = readJsonSafe(join(appRoot, 'resources', 'app.asar', 'dsh', 'package.json'))
  if (asarPkg && asarPkg.version) return String(asarPkg.version)
  return readAsarPackageVersion(join(appRoot, 'resources', 'app.asar'))
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

/** Electron 版本（客户端根下的 version 文件）。 */
export function readElectronVersion(appRoot) {
  if (!appRoot) return ''
  try {
    const v = readFileSync(join(appRoot, 'version'), 'utf8').trim()
    return v || ''
  } catch { return '' }
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
export function capture({ repoRoot, dshHome, appRoot, workspaceHome, profileName = 'desktop' } = {}) {
  const local = probeLocal({ dshHome, appRoot, workspaceHome })
  const roots = collectRoots(local)
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

  // 1) profile：本机 profile 目录
  const profileDir = join(local.dshHome, 'profiles', profileName)
  if (isDir(profileDir)) {
    copy(join(profileDir, 'package.json'), 'profile/package.json')
    copy(join(profileDir, 'cordis.patch.yml'), 'profile/cordis.patch.yml')
    copy(join(profileDir, 'package-lock.json'), 'profile/package-lock.json')
    copy(join(profileDir, 'pnpm-lock.yaml'), 'profile/pnpm-lock.yaml')
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

  // 3) 提示词 / 技能 / 预设
  copy(join(local.dshHome, 'AGENTS.md'), 'prompt/AGENTS.md')
  copy(join(local.dshHome, 'prompt-inject.md'), 'prompt/prompt-inject.md')
  copy(join(local.dshHome, 'skills'), 'skills')
  copy(join(local.dshHome, '.agent-presets'), 'presets')

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

  return { ok: errors.length === 0, changed: [...new Set(changed)].sort(), files, bytes, errors, local }
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
  const roots = collectRoots(local)
  const written = [], skipped = [], errors = []
  let files = 0, bytes = 0
  applyBackupDir = ''

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
      // 这一步必须在复制**之前**做：目录级复制会连带把带占位符的文件写出去。
      if (!isDir(src) && isTextName(src) && !isBinaryName(src)) {
        const miss = missingTokens(readFileSync(src, 'utf8'))
        if (miss.length > 0) { skipped.push(`${srcRel}: 待确认路径 ${miss.join(', ')}`); return }
      }
      // 覆盖前留底：被覆盖的本机文件先拷到 backups/apply-<时间戳>/，与 PowerShell 版语义一致。
      // 不留底 = 用户没推送的本地改动被静默清掉，且无处可寻。
      backupBeforeWrite(src, dst, local.dshHome, errors)
      const r = isDir(src) ? copyWithExpand(src, dst, roots) : copyWithExpand(src, dst, roots)
      files += r.files
      bytes += r.bytes
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
  pull('prompt/AGENTS.md', join(local.dshHome, 'AGENTS.md'))
  pull('prompt/prompt-inject.md', join(local.dshHome, 'prompt-inject.md'))
  pull('skills', join(local.dshHome, 'skills'))
  pull('presets', join(local.dshHome, '.agent-presets'))

  return { ok: errors.length === 0, written, skipped, errors, files, bytes, local, backupDir: applyBackupDir }
}

/**
 * 只读体检（面板 status 路由用）。
 * 不做任何写操作，可以安全地在客户端运行时调用。
 */
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

/** 命令行主流程。返回进程退出码。 */
export async function runCli(argv) {
  const [cmd, ...rest] = argv
  const a = parseArgs(rest)
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
      const r = apply({ repoRoot, dshHome, appRoot, workspaceHome, profileName })
      for (const wItem of r.written) console.log(`  > ${wItem}`)
      for (const s of r.skipped) console.log(`  - 跳过 ${s}`)
      for (const e of r.errors) console.error(`  [!] ${e}`)
      if (r.backupDir) console.log(`  被覆盖的本机文件已留底：${r.backupDir}`)
      console.log(`apply 完成：写入 ${r.written.length} 项 / ${r.files} 个文件，跳过 ${r.skipped.length} 项`)
      return r.ok ? 0 : 1
    }
    if (cmd === 'restore') {
      // POSIX 版还原：从仓库里的快照目录拷回 profile。
      // 快照布局与 PowerShell 版一致（backups/config-<时间戳>/profile/...）。
      const snapDir = a.BackupDir || a.backupDir || ''
      if (!snapDir) {
        console.error('restore 需要 -BackupDir <快照目录>')
        return 2
      }
      if (!existsSync(snapDir)) {
        console.error(`快照目录不存在：${snapDir}`)
        return 2
      }
      const profileDir = join(dshHome, 'profiles', profileName)
      const src = join(snapDir, 'profile')
      if (!existsSync(src)) {
        console.error(`快照里没有 profile/：${snapDir}`)
        return 2
      }
      const restoreBackupRoot = join(dshHome, 'backups', `restore-before-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}`)
      mkdirSync(profileDir, { recursive: true })
      // 还原同样是"覆盖本机"：先把当前 profile 留底，否则还原错了没有回头路。
      for (const f of walk(profileDir)) {
        const target = join(restoreBackupRoot, fromRepoPath(f.rel))
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(f.full, target)
      }
      // 根必须用探测值（appRoot 可能为空串）——否则 {{APP_ROOT}} 会被展开成空，写出坏路径
      copyWithExpand(src, profileDir, collectRoots(probeLocal({ dshHome, appRoot, workspaceHome })))
      console.log(`已从 ${snapDir} 还原 profile → ${profileDir}`)
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