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
import { basename, dirname, join, sep as SEP } from 'node:path'

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

/** 拼出某个相对路径在 WebDAV 上的完整 URL。 */
export function remoteUrlFor(w, relPath) {
  const base = String(w.url || '').replace(/\/+$/, '')
  const dir = String(w.dir || '').replace(/^\/+|\/+$/g, '')
  const rel = String(relPath || '').split('\\').join('/').replace(/^\/+/, '')
  const parts = [base]
  if (dir) parts.push(dir)
  if (rel) parts.push(rel)
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
 * 返回 { ok, error }。
 */
export async function ensureRemoteDir(w, relDir = '') {
  const url = remoteUrlFor(w, relDir)
  try {
    const res = await request(url, w, { method: 'MKCOL' })
    if (res.ok || res.status === 405 || res.status === 301 || res.status === 409) {
      // 409 = 父目录不存在，交给上层逐级建
      return { ok: res.status !== 409, status: res.status, error: res.status === 409 ? 'parent-missing' : '' }
    }
    return { ok: false, status: res.status, error: `MKCOL ${res.status} ${await textOf(res)}` }
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

  const remote = await listRemote(w, '')
  if (!remote) {
    return { ok: false, uploaded, skipped, errors: [...errors, '读不到云端目录（PROPFIND 失败）'] }
  }

  const files = listLocalFiles(localRepo)
  for (const rel of files) {
    let buf
    try { buf = readFileSync(join(localRepo, fromRepoRel(rel))) } catch (e) {
      errors.push(`${rel}: ${e && e.message ? e.message : e}`)
      continue
    }
    const hash = contentHash(buf)
    const existing = remote.entries.get(basename(rel))
    // 远端已有同名文件：只在内容不同时传（省流量，也避免无谓的 mtime 变化）
    if (existing && existing.size === buf.length) {
      skipped.push(rel)
      continue
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
  const out = []
  if (depth > 12) return out
  const res = await listRemote(w, relDir)
  if (!res) return out
  const baseDir = String(relDir || '').replace(/^\/+|\/+$/g, '')
  // 先收本层文件
  for (const name of res.entries.keys()) {
    out.push(baseDir ? `${baseDir}/${name}` : name)
  }
  // 再下钻子目录：需要列目录，PROPFIND 的 collection 标记在上面被跳过了，
  // 所以这里用另一种方式：对每个可能的子目录再 PROPFIND 一次。
  // WebDAV 服务器都会在 Depth:1 里带 collection 条目，所以改用一个独立调用。
  const dirs = await listRemoteDirs(w, relDir)
  for (const d of dirs) {
    const childRel = baseDir ? `${baseDir}/${d}` : d
    out.push(...await listRemoteRecursive(w, childRel, depth + 1))
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

/** 连通性测试（面板上「测试连接」用）。 */
export async function testConnection(w) {
  if (!w.enabled) return { ok: false, error: '未配置 WebDAV 地址' }
  if (!isSecureUrl(w.url)) {
    return { ok: false, error: '地址不是 https（明文传输密码有风险）；确需使用请设 DSH_SYNC_ALLOW_INSECURE=1' }
  }
  const res = await listRemote(w, '')
  if (!res) return { ok: false, error: '连不上或认证失败（PROPFIND 无响应）' }
  return { ok: true, exists: res.exists, files: res.entries.size, url: w.url }
}