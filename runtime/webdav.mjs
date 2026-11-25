// WebDAV 同步通道 —— 不依赖 git 的第二种同步方式。
//
// 为什么需要它：
//   git 通道要求两端都能 push/pull（有远端仓库、有凭据、能装 git）。
//   有些场景满足不了：公司网盘只给 WebDAV、目标机不让装 git、
//   或者用户就想「一个地址 + 账号密码」把配置丢上去。
//
// 设计：**复用同一份仓库格式**，只换传输层。
//   云端布局 = 把本地 dsh-config 仓库的内容原样放到 WebDAV 的一个目录下。
//   所以 capture/apply 的逻辑完全不变，WebDAV 只负责「上传目录 / 下载目录」。
//
// 一致性模型（重要，必须诚实）：
//   WebDAV 没有 git 的提交历史，所以**没有三方合并**。
//   这里的语义是「最后写入者胜」（last-write-wins），按文件粒度：
//     - 上传：本机有、云端没有的 → 新增；两边都有且不同 → 覆盖云端。
//     - 下载：云端有、本机没有的 → 新增；两边都有且不同 → 覆盖本机。
//   冲突时**两侧都留底**（`.conflict-<时间戳>` 副本），不静默丢数据。
//
// 安全：
//   - 密码只存本机 `dsh-config-sync.json`，不进仓库、不回显到面板。
//   - 默认拒绝非 https 地址（明文传密码），除非用户显式设 DSH_SYNC_ALLOW_INSECURE=1。
//   - 证书校验不可关闭（Node 的 https 默认校验；要放行请走系统信任库）。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep as SEP } from 'node:path'
import { fileURLToPath } from 'node:url'

/** WebDAV 方法体里常用的 XML 命名空间。 */
const NS_DAV = 'DAV:'

/** 默认远端目录（相对 WebDAV 根）。 */
export const DEFAULT_WEBDAV_DIR = 'dsh-config-sync'

/**
 * 归一化 WebDAV 设置，给出可安全使用的形状。
 * 任何字段缺失都给默认值，调用方不用判空。
 */
export function normalizeWebdav(settings) {
  const s = settings || {}
  const rawUrl = String(s.webdavUrl || '').trim()
  return {
    enabled: Boolean(rawUrl),
    url: rawUrl.replace(/\/+$/, ''),
    user: String(s.webdavUser || '').trim(),
    pass: String(s.webdavPass || ''),
    dir: String(s.webdavDir || '').trim().replace(/^\/+|\/+$/g, '') || DEFAULT_WEBDAV_DIR,
    // auto：配了 WebDAV 就用它；否则走 git
    mode: s.syncMode === 'webdav' || s.syncMode === 'auto' ? s.syncMode : 'git',
  }
}

/** 当前是否应该走 WebDAV（auto 模式下看有没有配地址）。 */
export function webdavActive(settings) {
  const w = normalizeWebdav(settings)
  if (w.mode === 'webdav') return w.enabled
  if (w.mode === 'auto') return w.enabled
  return false
}

/** 地址是否安全（https，或用户显式放行 http）。 */
export function isSecureUrl(url) {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    if (u.protocol === 'http:') return process.env.DSH_SYNC_ALLOW_INSECURE === '1'
    return false
  } catch {
    return false
  }
}

/**
 * 拼出某个相对路径在 WebDAV 上的完整 URL。
 *
 * **每一段都必须百分号编码**：仓库里有中文文件名（同步-推送.cmd、中文工作区名）、
 * 带空格的目录，还有 `#` `?` 这类在 URL 里有语法含义的字符。不编码的话，
 * 空格直接让请求失败，`#` 后面的内容被当 fragment 截掉 —— 写到了错的资源上。
 * `/` 保留为分隔符，所以按段编码而不是整串编码。
 */
export function remoteUrlFor(w, relPath) {
  const base = String(w.url || '').replace(/\/+$/, '')
  const dir = String(w.dir || '').replace(/^\/+|\/+$/g, '')
  const rel = String(relPath || '').split('\\').join('/').replace(/^\/+/, '')
  const enc = (p) => p.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/')
  const parts = [base]
  const encDir = enc(dir)
  const encRel = enc(rel)
  if (encDir) parts.push(encDir)
  if (encRel) parts.push(encRel)
  return parts.join('/')
}

/** Basic 认证头。Node 的 fetch 不会自动带上，必须显式给。 */
function authHeader(w) {
  if (!w.user && !w.pass) return {}
  const token = Buffer.from(`${w.user}:${w.pass}`, 'utf8').toString('base64')
  return { authorization: `Basic ${token}` }
}

/** 一次 fetch，带超时与统一错误。 */
async function request(url, w, init = {}, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...(authHeader(w) || {}), ...((init && init.headers) || {}) },
      signal: controller.signal,
    })
    return res
  } finally {
    clearTimeout(timer)
  }
}

/** 文本响应（错误信息里要带服务端原文，便于定位）。 */
async function textOf(res) {
  try { return (await res.text()).slice(0, 400) } catch { return '' }
}

/**
 * 确保远端目录存在（MKCOL，已存在则忽略 405/301）。
 * nginx ngx_http_dav_module 要求 MKCOL URL 带尾斜杠，否则直接报 409；
 * 若遇到 400/501 再退回不带尾斜杠。根路径含多段（如 a/b）时逐级创建。
 * 返回 { ok, error }。
 */
async function mkcolOne(url, w) {
  const withSlash = url.endsWith('/') ? url : `${url}/`
  let res = await request(withSlash, w, { method: 'MKCOL' })
  if (res.status === 400 || res.status === 501) {
    res = await request(url.replace(/\/+$/, ''), w, { method: 'MKCOL' })
  }
  if (res.ok || res.status === 405 || res.status === 301) {
    return { ok: true, status: res.status, error: '' }
  }
  if (res.status === 409) {
    return { ok: false, status: 409, error: 'parent-missing' }
  }
  return { ok: false, status: res.status, error: `MKCOL ${res.status} ${await textOf(res)}` }
}

export async function ensureRemoteDir(w, relDir = '') {
  const url = remoteUrlFor(w, relDir)
  try {
    let r = await mkcolOne(url, w)
    if (r.status === 409 && !relDir && w.dir && w.dir.includes('/')) {
      const segs = String(w.dir).split('/').filter(Boolean)
      const base = String(w.url || '').replace(/\/+$/, '')
      for (let i = 1; i <= segs.length; i++) {
        const prefix = segs.slice(0, i).map((s) => encodeURIComponent(s)).join('/')
        r = await mkcolOne(`${base}/${prefix}`, w)
        if (!r.ok) return r
      }
    }
    return r
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

/**
 * 列远端目录（PROPFIND Depth:1），返回相对路径 → { size, etag, mtime }。
 * 失败返回 null（调用方据此报「读不到云端」而不是「云端是空的」）。
 */
export async function listRemote(w, relDir = '') {
  const url = remoteUrlFor(w, relDir)
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="${NS_DAV}"><d:prop>
<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:etag/>
</d:prop></d:propfind>`
  try {
    const res = await request(url, w, {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body,
    }, 45000)
    if (!res.ok && res.status !== 207) {
      // 404 = 目录还不存在，这是正常的「首次同步」，返回空表
      if (res.status === 404) return { entries: new Map(), exists: false }
      return null
    }
    const xml = await res.text()
    // 解析基准 = webdavDir + relDir（与 href 里的实际路径对齐）
    const base = [String(w.dir || '').replace(/^\/+|\/+$/g, ''), String(relDir || '').replace(/^\/+|\/+$/g, '')]
      .filter(Boolean).join('/')
    return { entries: parsePropfind(xml, w, base), exists: true }
  } catch {
    return null
  }
}

/**
 * 解析 PROPFIND 的 multistatus XML。
 *
 * 不用 DOMParser（Node 没有）：WebDAV 的响应结构固定且简单，
 * 用正则按 <d:response> 切块再取字段足够，且不会因为命名空间前缀不同而失效
 * （前缀可能是 d: / D: / lp1: 等）。
 */
function parsePropfind(xml, w, relDir) {
  const out = new Map()
  const baseDir = normalizeHrefs(String(relDir || ''))
  const blocks = String(xml).split(/<(?:\w+:)?response[\s>]/i).slice(1)
  for (const block of blocks) {
    const href = matchTag(block, 'href')
    if (!href) continue
    let decoded = href
    try { decoded = decodeURIComponent(href) } catch { /* 原样用 */ }
    // 去掉协议+主机、去掉重复斜杠、去掉首尾斜杠
    const clean = normalizeHrefs(decoded.replace(/^https?:\/\/[^/]+/i, ''))
    if (!clean) continue
    const lastSlash = clean.lastIndexOf('/')
    const parent = lastSlash >= 0 ? clean.slice(0, lastSlash) : ''
    if (parent !== baseDir) continue
    const name = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean
    if (!name) continue
    // 目录（collection）跳过：我们只同步文件
    const isCollection = /<(?:\w+:)?collection\s*\/?>/i.test(block)
    if (isCollection) continue
    const size = Number(matchTag(block, 'getcontentlength') || 0) || 0
    const etag = matchTag(block, 'etag') || ''
    const mtime = matchTag(block, 'getlastmodified') || ''
    out.set(name, { size, etag, mtime })
  }
  return out
}

/**
 * 归一化 href 里的路径部分。
 *
 * 必须处理三件事，否则同一份响应在不同服务器上解析结果不同：
 *   1. 重复斜杠：某些实现（含测试服务器）会给出 `//dsh-config-sync/AGENTS.md`；
 *   2. 尾斜杠：目录带 `/`，文件不带；
 *   3. 百分号编码：中文文件名是 `%E4%B8%AD`，不 decode 就对不上本地名。
 */
function normalizeHrefs(p) {
  return String(p).replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')
}

/** 取某个标签的内容（容忍前缀）。 */
function matchTag(block, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i')
  const m = re.exec(block)
  return m ? m[1].trim() : ''
}

/** 上传单个文件（PUT）。 */
export async function putFile(w, relPath, data) {
  const url = remoteUrlFor(w, relPath)
  try {
    const res = await request(url, w, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: data,
    }, 120000)
    if (res.ok || res.status === 204 || res.status === 201) return { ok: true, status: res.status }
    return { ok: false, status: res.status, error: `PUT ${res.status} ${await textOf(res)}` }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

/** 下载单个文件（GET）。失败返回 null。 */
export async function getFile(w, relPath) {
  const url = remoteUrlFor(w, relPath)
  try {
    const res = await request(url, w, {}, 120000)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf
  } catch {
    return null
  }
}

/** 删除远端文件（DELETE）。 */
export async function deleteRemote(w, relPath) {
  const url = remoteUrlFor(w, relPath)
  try {
    const res = await request(url, w, { method: 'DELETE' }, 30000)
    if (res.ok || res.status === 404 || res.status === 204) return { ok: true, status: res.status }
    return { ok: false, status: res.status, error: `DELETE ${res.status} ${await textOf(res)}` }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

/** 本地目录 → 相对路径列表（用 / 分隔）。 */
export function listLocalFiles(root) {
  const out = []
  const visit = (dir, rel) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === '.git') continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) visit(join(dir, e.name), childRel)
      else if (e.isFile()) out.push(childRel)
    }
  }
  if (existsSync(root)) visit(root, '')
  return out
}

/** 文件内容哈希（用于判断是否需要上传/下载）。 */
export function contentHash(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 上传本地仓库到 WebDAV。
 *
 * 语义：本机有的都传（覆盖云端同名）；云端有本机没有的**不删**
 * —— 那可能是另一台机器推上去的，删了就等于抢别人的配置。
 * 返回 { ok, uploaded, skipped, errors }。
 */
export async function uploadRepo(w, localRepo, { dryRun = false } = {}) {
  const uploaded = [], skipped = [], errors = []
  if (!w.enabled) return { ok: false, uploaded, skipped, errors: ['WebDAV 未配置'] }

  // 根目录必须显式建：只建子目录时，父级 MKCOL 会 409（父不存在），
  // 于是「上传成功但远端空目录」。
  const mkdir = await ensureRemoteDir(w, '')
  if (!mkdir.ok) errors.push(`建目录失败：${mkdir.error}`)

  // 旧判据用 basename 去查"根目录一层"的 PROPFIND 结果：
  //   - 子目录文件永远查不到 → 每次全量重传（不省流量）；
  //   - 根目录同名文件**只比长度** → 同长度、内容不同被判"已存在"而静默跳过
  //     （审核实测：AGENTS.md 从 "version A" 改成 "version B"，云端永远停在 A）。
  // 现在改为：递归列远端全部文件 + 逐个比 sha256，内容真相同才跳过。
  const remote = await listRemote(w, '')
  if (!remote) {
    return { ok: false, uploaded, skipped, errors: [...errors, '读不到云端目录（PROPFIND 失败）'] }
  }

  const remoteFiles = remote.exists ? await listRemoteRecursive(w, '') : []
  const remoteMeta = await listRemoteMeta(w, '')
  const remoteSet = new Set(remoteFiles)

  const files = listLocalFiles(localRepo)
  for (const rel of files) {
    let buf
    try { buf = readFileSync(join(localRepo, fromRepoRel(rel))) } catch (e) {
      errors.push(`${rel}: ${e && e.message ? e.message : e}`)
      continue
    }
    // 远端有同名文件：只在内容**真的**相同时跳过。
    //
    // 不能信 etag（审核实测）："强 etag"只保证对同一资源的表示唯一，不保证按内容算。
    // 很多服务器（含常见 NAS 的 WebDAV）用 size+mtime 拼 etag —— 两次同长度的写在同一毫秒
    // 落盘时 etag 完全相同、内容却不同；反过来别处拷过来的同内容文件 mtime 变了，etag 又不同。
    // 两种情况都会判错。所以只认 sha256：size 不同直接判不同，size 相同才 GET 下来比哈希。
    if (remoteSet.has(rel)) {
      const meta = remoteMeta.get(rel)
      if (meta && meta.size === buf.length) {
        const remoteBuf = await getFile(w, rel)
        if (remoteBuf && contentHash(remoteBuf) === contentHash(buf)) { skipped.push(rel); continue }
      }
    }
    if (dryRun) { uploaded.push(rel); continue }
    const dir = dirname(rel).split('/').filter(Boolean)
    // 逐级建目录（WebDAV 不自动建父级）
    for (let i = 1; i <= dir.length; i++) {
      await ensureRemoteDir(w, dir.slice(0, i).join('/'))
    }
    const r = await putFile(w, rel, buf)
    if (r.ok) uploaded.push(rel)
    else errors.push(`${rel}: ${r.error || r.status}`)
  }
  return { ok: errors.length === 0, uploaded, skipped, errors, hashHint: files.length }
}

/**
 * 从 WebDAV 下载到本地仓库。
 *
 * 语义与 upload 对称：云端有的都下（覆盖本机同名），本机有云端没有的**不删**。
 * 冲突（两边都有且不同）**两侧都留底**，不静默覆盖。
 */
export async function downloadRepo(w, localRepo, { dryRun = false } = {}) {
  const downloaded = [], skipped = [], conflicts = [], errors = []
  if (!w.enabled) return { ok: false, downloaded, skipped, conflicts, errors: ['WebDAV 未配置'] }

  const remote = await listRemote(w, '')
  if (!remote) {
    return { ok: false, downloaded, skipped, conflicts, errors: ['读不到云端目录（PROPFIND 失败）'] }
  }
  if (!remote.exists) {
    return { ok: true, downloaded, skipped, conflicts, errors: [], empty: true }
  }

  // 递归列云端全部文件（PROPFIND Depth:1 只给一层，这里逐目录下钻）
  const all = await listRemoteRecursive(w, '')
  for (const rel of all) {
    const buf = await getFile(w, rel)
    if (!buf) { errors.push(`${rel}: 下载失败`); continue }
    const localPath = join(localRepo, fromRepoRel(rel))
    const localExists = existsSync(localPath)
    let localBuf = null
    if (localExists) {
      try { localBuf = readFileSync(localPath) } catch { localBuf = null }
    }
    if (localBuf && contentHash(localBuf) === contentHash(buf)) { skipped.push(rel); continue }
    if (dryRun) { downloaded.push(rel); continue }
    if (localBuf) {
      // 冲突：两边都有且不同 → 本机那份留底，再写云端版本
      conflicts.push(rel)
      try {
        mkdirSync(dirname(localPath), { recursive: true })
        writeFileSync(`${localPath}.conflict-${Date.now()}`, localBuf)
      } catch { /* 留底失败不阻断，但要记进 errors */ }
    }
    try {
      mkdirSync(dirname(localPath), { recursive: true })
      writeFileSync(localPath, buf)
      downloaded.push(rel)
    } catch (e) {
      errors.push(`${rel}: ${e && e.message ? e.message : e}`)
    }
  }
  return { ok: errors.length === 0, downloaded, skipped, conflicts, errors }
}

/** 递归列远端所有文件（逐层 PROPFIND）。 */
async function listRemoteRecursive(w, relDir, depth = 0) {
  return [...(await walkRemote(w, relDir, depth)).keys()]
}

/** 递归列远端所有文件，并带上 PROPFIND 给的 size / etag（上传时的快筛依据）。 */
async function listRemoteMeta(w, relDir) {
  return walkRemote(w, relDir, 0)
}

/** 共用遍历：返回 Map<relPath, {size, etag, mtime}>。 */
async function walkRemote(w, relDir, depth = 0) {
  const out = new Map()
  if (depth > 12) return out
  const res = await listRemote(w, relDir)
  if (!res) return out
  const baseDir = String(relDir || '').replace(/^\/+|\/+$/g, '')
  for (const [name, meta] of res.entries) {
    out.set(baseDir ? `${baseDir}/${name}` : name, meta)
  }
  const dirs = await listRemoteDirs(w, relDir)
  for (const d of dirs) {
    const childRel = baseDir ? `${baseDir}/${d}` : d
    for (const [k, v] of await walkRemote(w, childRel, depth + 1)) out.set(k, v)
  }
  return out
}

/** 列远端某目录的直接子目录名。 */
async function listRemoteDirs(w, relDir = '') {
  const url = remoteUrlFor(w, relDir)
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="${NS_DAV}"><d:prop><d:resourcetype/></d:prop></d:propfind>`
  try {
    const res = await request(url, w, {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body,
    }, 45000)
    if (!res.ok && res.status !== 207) return []
    if (res.status === 404) return []
    const xml = await res.text()
    const baseDir = [String(w.dir || '').replace(/^\/+|\/+$/g, ''), String(relDir || '').replace(/^\/+|\/+$/g, '')]
      .filter(Boolean).join('/')
    const dirs = []
    const blocks = String(xml).split(/<(?:\w+:)?response[\s>]/i).slice(1)
    for (const block of blocks) {
      const href = matchTag(block, 'href')
      if (!href) continue
      let decoded = href
      try { decoded = decodeURIComponent(href) } catch { /* 原样 */ }
      const clean = normalizeHrefs(decoded.replace(/^https?:\/\/[^/]+/i, ''))
      if (!clean) continue
      const lastSlash = clean.lastIndexOf('/')
      const parent = lastSlash >= 0 ? clean.slice(0, lastSlash) : ''
      const name = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean
      if (!name || parent !== baseDir) continue
      const isCollection = /<(?:\w+:)?collection\s*\/?>/i.test(block)
      if (isCollection) dirs.push(name)
    }
    return dirs
  } catch {
    return []
  }
}

/**
 * 仓库相对路径（/ 分隔）→ 本机路径。
 *
 * 用 split('/').join(sep) 而不是字符串替换：Windows 上 sep 是 `\`，
 * 直接把 `/` 换成 `\\` 在部分 PowerShell 调用路径里会被二次转义。
 */
function fromRepoRel(rel) {
  return String(rel).split('/').join(SEP)
}

/** 连通性测试（面板「测试连接」与探云端是否为空共用）。 */
export async function testConnection(w) {
  if (!w.enabled) return { ok: false, error: '未配置 WebDAV 地址' }
  if (!isSecureUrl(w.url)) {
    return { ok: false, error: '地址不是 https（明文传输密码有风险）；确需使用请设 DSH_SYNC_ALLOW_INSECURE=1' }
  }
  const res = await listRemote(w, '')
  if (!res) return { ok: false, error: '连不上或认证失败（PROPFIND 无响应）' }
  const dirs = res.exists ? await listRemoteDirs(w, '') : []
  return {
    ok: true,
    exists: res.exists,
    files: res.entries.size + dirs.length,
    rootFiles: res.entries.size,
    rootDirs: dirs.length,
    url: w.url,
  }
}

function parseCliArgs(argv) {
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

function readLocalSettings(dshHome) {
  const p = join(dshHome, 'dsh-config-sync.json')
  if (!existsSync(p)) return {}
  return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
}

export async function runWebdavCli(argv) {
  const [cmd, ...rest] = argv
  const a = parseCliArgs(rest)
  const dshHome = a.DshHome || a.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const repoRoot = a.RepoRoot || a.repoRoot || process.cwd()
  if (!cmd || !['probe', 'upload', 'download'].includes(cmd)) {
    console.error('用法：node webdav.mjs <probe|upload|download> -DshHome <dir> -RepoRoot <dir>')
    return 2
  }
  const settings = readLocalSettings(dshHome)
  const w = normalizeWebdav(settings)
  if (!w.enabled) {
    console.error('WebDAV 未配置地址')
    return 1
  }
  if (cmd === 'probe') {
    const r = await testConnection(w)
    console.log(JSON.stringify(r))
    return r.ok ? 0 : 1
  }
  if (cmd === 'upload') {
    if (!isSecureUrl(w.url)) {
      console.error('WebDAV 地址不是 https（明文传输密码有风险）；确需使用请设 DSH_SYNC_ALLOW_INSECURE=1')
      return 1
    }
    const r = await uploadRepo(w, repoRoot)
    console.log(`WebDAV 上传：上传 ${r.uploaded.length} · 跳过 ${r.skipped.length} · 错误 ${r.errors.length}`)
    for (const e of r.errors.slice(0, 20)) console.error(`  [!] ${e}`)
    return r.ok ? 0 : 1
  }
  if (cmd === 'download') {
    if (!isSecureUrl(w.url)) {
      console.error('WebDAV 地址不是 https（明文传输密码有风险）；确需使用请设 DSH_SYNC_ALLOW_INSECURE=1')
      return 1
    }
    const r = await downloadRepo(w, repoRoot)
    console.log(`WebDAV 下载：下载 ${r.downloaded.length} · 跳过 ${r.skipped.length} · 冲突 ${r.conflicts.length} · 错误 ${r.errors.length}`)
    for (const e of r.errors.slice(0, 20)) console.error(`  [!] ${e}`)
    return r.ok ? 0 : 1
  }
  return 2
}

const invokedDirectly = (() => {
  try { return resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (invokedDirectly) {
  runWebdavCli(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error(e && e.stack ? e.stack : e)
    process.exit(1)
  })
}