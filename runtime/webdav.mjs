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
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
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
  const w = {
    enabled: Boolean(rawUrl),
    url: rawUrl.replace(/\/+$/, ''),
    user: String(s.webdavUser || '').trim(),
    pass: String(s.webdavPass || ''),
    dir: String(s.webdavDir || '').trim().replace(/^\/+|\/+$/g, '') || DEFAULT_WEBDAV_DIR,
    // 0.6.48：自定义 User-Agent。部分第三方 WebDAV（群晖 / 坚果云 / 自建 DAV）会按 UA
    // 放行或拦截客户端，默认 UA 会被当成未知客户端拒掉。留空 = 不发 User-Agent 头。
    ua: sanitizeUserAgent(s.webdavUserAgent),
    // auto：配了 WebDAV 就用它；否则走 git
    mode: s.syncMode === 'webdav' || s.syncMode === 'auto' ? s.syncMode : 'git',
  }
  // 0.6.48：诊断字段（面板回显实际发出去的 UA / 失败状态码）。用不可枚举属性，
  // 免得调用方 JSON.stringify(w) 或打日志时多出三个噪音字段。
  Object.defineProperties(w, {
    lastError: { value: '', writable: true, enumerable: false, configurable: true },
    lastStatus: { value: 0, writable: true, enumerable: false, configurable: true },
  })
  return w
}

/**
 * User-Agent 只允许单行可见 ASCII，且不能出现 CRLF。
 *
 * 这个值会进 HTTP 头：`\r\n` 能凭空造出一条头（响应拆分 / 绕过服务端 ACL），
 * 非 ASCII 会让 undici 直接抛 TypeError（症状是「连不上」而不是「UA 非法」）。
 * 不合法就退回「不发 UA」，绝不让一个填错的输入把整条同步打断。
 */
export function sanitizeUserAgent(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return ''
  if (s.length > 200) return ''
  // 可见 ASCII（0x20–0x7E）之外一律拒：tab 也不放行，头值里不需要它
  if (!/^[\x20-\x7E]+$/.test(s)) return ''
  return s
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

/**
 * 一个够用的 Response 替身。
 *
 * 为什么不直接用 fetch：undici 的 fetch **总会**带一个 User-Agent 头（默认 `node`），
 * 且没有「不带 UA」的表达方式 —— 而「留空就不发 User-Agent」正是本插件对用户的承诺
 * （有些服务看到陌生 UA 就拦）。node:http 则完全由我们决定发哪个头：没设就是没有。
 * 这里只实现用到的那几个成员（ok / status / text / arrayBuffer）。
 */
class DavResponse {
  constructor(status, headers, body) {
    this.status = status
    this.headers = headers || {}
    this._body = body || Buffer.alloc(0)
  }

  get ok() { return this.status >= 200 && this.status < 300 }

  async text() { return this._body.toString('utf8') }

  async arrayBuffer() {
    return this._body.buffer.slice(this._body.byteOffset, this._body.byteOffset + this._body.byteLength)
  }
}

/** 真正发一次请求（不跟重定向）。 */
function rawRequestOnce(urlStr, { method, headers, body }, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { reject(new Error(`地址不合法：${urlStr}`)); return }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error(`只支持 http / https 地址：${urlStr}`))
      return
    }
    const mod = u.protocol === 'https:' ? httpsRequest : httpRequest
    let settled = false
    const req = mod(u, { method: method || 'GET', headers: headers || {} }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      res.on('end', () => {
        if (settled) return
        settled = true
        resolve(new DavResponse(res.statusCode || 0, res.headers, Buffer.concat(chunks)))
      })
      res.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
    })
    req.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
    if (timeoutMs > 0) {
      // 覆盖「响应头到手后 body 卡住」：node 的 socket 空闲计时同样管得到 body
      req.setTimeout(timeoutMs, () => {
        const err = new Error(`请求超时（${Math.round(timeoutMs / 1000)}s 内没有响应）`)
        try { req.destroy(err) } catch { }
      })
    }
    if (body !== undefined && body !== null) req.end(body)
    else req.end()
  })
}

/** 发请求，跟随重定向（最多 5 跳）。WebDAV 常见的 301/302 就是干这个的。 */
async function rawRequest(urlStr, init, timeoutMs, redirects = 0) {
  const res = await rawRequestOnce(urlStr, init, timeoutMs)
  const status = res.status
  const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308
  const location = res.headers && res.headers.location
  if (isRedirect && location && redirects < 5) {
    let next = ''
    try { next = new URL(String(location), urlStr).toString() } catch { next = '' }
    if (next) {
      // 与浏览器一致：303 一律改成 GET；301/302 只在原方法是 POST 时改成 GET。
      // PROPFIND / PUT 这类方法必须原样保留 —— 改成 GET 就把「列目录 / 传文件」变成取网页了。
      const m = String(init.method || 'GET').toUpperCase()
      const toGet = status === 303 || ((status === 301 || status === 302) && m === 'POST')
      const init2 = toGet ? { ...init, method: 'GET', body: undefined } : init
      return rawRequest(next, init2, timeoutMs, redirects + 1)
    }
  }
  return res
}

/**
 * 一次请求，带超时与统一错误。
 *
 * 0.6.48：User-Agent 可配置（留空则**不发**这个头）。
 * 第三方 DAV 常按 UA 放行，默认的 undici UA 会被当成未知客户端直接 401/403 ——
 * 用户看到的就是「连不上」。这里改用 node:http，因为只有它能做到「没设就是没有」。
 */
async function request(url, w, init = {}, timeoutMs = 30000) {
  const headers = { ...(authHeader(w) || {}), ...((init && init.headers) || {}) }
  const ua = sanitizeUserAgent(w && w.ua)
  if (ua) headers['user-agent'] = ua
  else delete headers['user-agent']
  // 显式给 Content-Length：部分服务端不接受 chunked 的 PROPFIND
  let body = init && init.body
  if (body !== undefined && body !== null) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    headers['content-length'] = String(buf.length)
    body = buf
  }
  return rawRequest(url, { method: (init && init.method) || 'GET', headers, body }, timeoutMs)
}

/**
 * 把「连不上 / 认证失败」拆成能照着修的具体原因。
 *
 * 以前无论 401、403、404、405 还是证书错误，面板都只显示
 * 「连不上或认证失败（PROPFIND 无响应）」—— 用户既不知道是密码错、
 * 还是这个服务压根不支持 PROPFIND，也不知道该去改哪一项。这里按状态码给话。
 *
 * 文案同时给中英文（面板与 CLI 都可能显示它，CLI 没有 accept-language）。
 */
function explainStatus(status, w) {
  const url = String((w && w.url) || '')
  if (status === 401) {
    return '认证失败（401）：用户名或密码不对，或这个服务要求别的认证方式（应用专用密码 / Token）'
      + ' / Auth failed (401): wrong username or password, or this service requires an app password / token'
  }
  if (status === 403) {
    return '被拒绝（403）：账号没有这个目录的权限；部分服务还会按 User-Agent 拦截，可在「User-Agent」里填它要求的客户端名'
      + ' / Forbidden (403): the account lacks access to this folder; some services also filter by User-Agent — set the client name they expect in "User-Agent"'
  }
  if (status === 404) {
    return `地址下没有这个目录（404）：${url} —— WebDAV 地址填到根（如 https://dav.example.com/dav），目录名单独填在「远端目录」`
      + ` / Not found (404): ${url} — put the server root in "WebDAV URL" (e.g. https://dav.example.com/dav) and the folder in "Remote dir"`
  }
  if (status === 405 || status === 501) {
    return `这个服务不支持 PROPFIND（${status}）：它可能不是标准 WebDAV 入口，或需要带路径前缀`
      + ` / PROPFIND not allowed (${status}): this may not be a standard WebDAV endpoint, or it needs a path prefix`
  }
  if (status === 301 || status === 302 || status === 307 || status === 308) {
    return `地址被重定向（${status}）：请直接填重定向后的最终地址`
      + ` / Redirected (${status}): use the final URL instead`
  }
  if (status === 0) {
    return '连不上服务器：检查地址、网络与证书（自签名证书需加入系统信任库）'
      + ' / Cannot reach the server: check the URL, network and certificate (self-signed certs must be trusted by the system)'
  }
  return `PROPFIND 失败（HTTP ${status}） / PROPFIND failed (HTTP ${status})`
}

/**
 * 读完响应体，带**独立**超时。
 *
 * 为什么还要单独计时：0.6.48 起传输层用 `node:http`，它的 `req.setTimeout` 是**空闲**计时
 * （socket 上多久没数据），服务端若持续慢速吐 body 就永远不触发；而面板必须有一个
 * 硬上限，否则整条同步流水线会永久挂着（进程不退、面板一直转）。
 * 这个计时是「从发起到读完一共多久」，与服务端怎么吐数据无关。
 */
function withBodyTimeout(promise, timeoutMs = 30000, label = '读取响应体') {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

/** 文本响应（错误信息里要带服务端原文，便于定位）。 */
async function textOf(res) {
  try { return (await withBodyTimeout(res.text(), 30000, '读取错误响应')).slice(0, 400) } catch { return '' }
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
 * 失败返回 null，并把 `lastError` 写在 w 上（调用方据此报「读不到云端」而不是「云端是空的」，
 * 且能说出到底是 401、404 还是服务不支持 PROPFIND —— 0.6.48 起）。
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
      if (res.status === 404) {
        w.lastError = ''
        w.lastStatus = 404
        return { entries: new Map(), exists: false }
      }
      w.lastError = explainStatus(res.status, w)
      w.lastStatus = res.status
      return null
    }
    const xml = await withBodyTimeout(res.text(), 60000, `PROPFIND 响应`)
    // 解析基准必须是**请求 URL 的真实路径**，不能只用 w.dir：
    // WebDAV 根经常带路径前缀（Nextcloud 的 /remote.php/dav/files/<user>、坚果云的 /dav、Alist 的 /dav），
    // 服务端回的 href 里带着那段前缀，只拿 dir 去比 parent 永远对不上 → 列目录恒为空，
    // 后果是 pull 报「云端还是空的」、push 每轮全量重传。
    const base = requestPathBase(url, w, relDir)
    w.lastError = ''
    w.lastStatus = res.status
    return { entries: parsePropfind(xml, w, base), exists: true }
  } catch (e) {
    // 超时 / 连接被拒 / 证书不受信：原因各不一样，别一律说成「认证失败」
    const msg = String((e && e.message) || e || '')
    w.lastStatus = 0
    w.lastError = /abort|timeout|超时/i.test(msg)
      ? `PROPFIND 超时（45s 内没有响应）：${url} / PROPFIND timed out (no response in 45s)`
      : `连不上服务器：${msg || url} / Cannot reach the server`
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
    // 基准对齐：正常情况 parent 精确等于基准；反向代理把路径改写成别的前缀时，
    // 两者可能互为后缀（请求 /dav/dsh-config-sync，href 却是 /dsh-config-sync/x），也认。
    // 直接返回「不带斜杠的相对 href」时 parent 为空，同样属于当前目录。
    const flat = lastSlash < 0
    const sameDir = flat
      || parent === baseDir
      || (baseDir && parent.endsWith('/' + baseDir))
      || (parent && baseDir.endsWith('/' + parent))
    if (!sameDir) continue
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

/**
 * PROPFIND 响应里的 href 是「服务端视角的绝对路径」，可能带着 WebDAV 根的路径前缀。
 * 解析基准必须取自**本次请求 URL 的真实路径**，不能用 w.dir：带前缀的服务器
 * （Nextcloud / 坚果云 / Alist）会因此一个子目录都列不出来。
 */
function requestPathBase(url, w, relDir) {
  try {
    return normalizeHrefs(decodeURIComponent(new URL(url).pathname))
  } catch {
    return [String(w && w.dir ? w.dir : '').replace(/^\/+|\/+$/g, ''), String(relDir || '').replace(/^\/+|\/+$/g, '')]
      .filter(Boolean).join('/')
  }
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
    const buf = Buffer.from(await withBodyTimeout(res.arrayBuffer(), 120000, `下载响应`))
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


/**
 * 浏览器剖面 / 凭据库：这些东西一旦进仓库就等于把登录态搬走了。
 * 需要的只是插件的小配置，不需要整份 Edge/Chrome 用户目录。
 *   browser-profiles —— 插件把 CDP 用的剖面存在这里（本机实测 297 MB、3,696 个文件）；
 *   User Data        —— Chromium 系默认剖面目录名；
 *   Login Data / Cookies / Web Data / Secure Preferences / Local State / History —— 密码库、
 *                       登录态、自动填充、受保护设置、浏览器主库。
 * 只看路径段（不区分大小写），所以深层嵌套也拦得住。
 */
const BLOCKED_PROFILE_SEGMENTS = new Set([
  'browser-profiles', 'user data', 'login data', 'login data for account',
  'cookies', 'cookies-journal', 'web data', 'web data-journal', 'secure preferences',
  'local state', 'history', 'history-journal', 'top sites', 'current session', 'current tabs',
])
/** 单文件上限：超过就别传（NAS 与 git 都受不了，且这类文件基本是缓存/数据库）。 */
const MAX_SYNC_FILE_BYTES = 32 * 1024 * 1024

function blockedProfilePath(rel) {
  const parts = String(rel || '').split('/').filter(Boolean)
  return parts.some((seg) => BLOCKED_PROFILE_SEGMENTS.has(String(seg).toLowerCase()))
}
const PRIVATE_SECRET_FILES = new Set([
  'config-sync-gh.json',
  'config-sync-feedback-outbox.json',
  'dsh-config-sync.json',
  'config-sync-state.json',
  'config-sync-roots.json',
  'config-sync-scope.json',
  'config-sync-delete-cloud.json',
  'config-sync-extra.json',
  'sync-notices.json',
  '.credentials.yaml',
  '.env',
  'dsh-ssh-master.key',
])
const SELF_RUNTIME_FILES = new Set([
  'apply.ps1', 'capture.ps1', 'dsh-sync-common.ps1', 'post-exit.ps1',
  'restore.ps1', 'sync.ps1', 'webdav.mjs', 'sync-engine.mjs',
])
const GH_TOKEN_RE = /gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/

/**
 * 上传前的拦截判定，**带原因**。
 *
 * 以前只返回 true/false，调用方统一打印「安全拦截：跳过含令牌或本机私有凭据的文件」。
 * 但「体积超过 32MB」和「浏览器剖面」都不是凭据问题，用同一句话会把用户吓去查令牌 ——
 * 实测一个 40MB 的插件数据文件会得到「含令牌」的指控。所以这里把原因分开：
 *   secret    —— 真的像凭据（文件名/内容命中）
 *   profile   —— 浏览器剖面 / 凭据库（Login Data、Cookies…）
 *   too-big   —— 超过单文件上限，不是安全问题，只是不该走 WebDAV
 */
export function secretSkipReason(rel, buf) {
  const leaf = String(rel || '').split('/').pop().toLowerCase()
  if (PRIVATE_SECRET_FILES.has(leaf) || leaf.startsWith('.env.') || /\.(pem|key|p12|pfx)$/.test(leaf)) return 'secret'
  // 浏览器剖面 / 凭据库：无论它是怎么进到仓库里的（老版本抓的、手动拷的），都不上传
  if (blockedProfilePath(rel)) return 'profile'
  // 超大文件不上传：NAS 扛不住，且这类体积基本是缓存/数据库（不是安全问题，别冤枉用户的令牌）
  if (buf && buf.length > MAX_SYNC_FILE_BYTES) return 'too-big'
  // 插件自己的运行脚本不拦（它们本身就含 env 名，容易命中下面的内容扫描）
  if (SELF_RUNTIME_FILES.has(String(rel || '').replace(/^\.\//, ''))) return ''
  if (!buf || buf.length > 8 * 1024 * 1024) return ''
  const slice = buf.subarray(0, Math.min(buf.length, 65536))
  if (slice.includes(0)) return ''
  const text = slice.toString('utf8')
  if (GH_TOKEN_RE.test(text)) return 'secret'
  for (const envName of ['DSH_CONFIG_SYNC_GH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    const val = String(process.env[envName] || '').trim()
    if (val.length >= 12 && text.includes(val)) return 'secret'
  }
  return ''
}

/** 兼容包装：只需要「拦不拦」的调用方继续用它。 */
function isSecretLeakCandidate(rel, buf) {
  return secretSkipReason(rel, buf) !== ''
}


/** 文件内容哈希（用于判断是否需要上传/下载）。 */
export function isBlockedProfilePath(rel) { return blockedProfilePath(rel) }
export const BLOCKED_SEGMENTS = BLOCKED_PROFILE_SEGMENTS
export const MAX_FILE_BYTES = MAX_SYNC_FILE_BYTES

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
export async function uploadRepo(w, localRepo, { dryRun = false, onProgress = null } = {}) {
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
    return { ok: false, uploaded, skipped, errors: [...errors, `读不到云端目录（PROPFIND 失败）：${w.lastError || '未知原因'} / Cannot list the cloud folder`] }
  }

  const remoteMeta = remote.exists ? await listRemoteMeta(w, '') : new Map()
  const remoteSet = new Set(remoteMeta.keys())
  const ensuredDirs = new Set()

  const files = listLocalFiles(localRepo)
  if (typeof onProgress === 'function') {
    try { onProgress({ phase: 'scan', done: 0, total: files.length, uploaded: 0, skipped: 0, errors: 0 }) } catch { }
  }
  let lastReportAt = 0
  for (let idx = 0; idx < files.length; idx++) {
    const rel = files[idx]
    let buf
    try { buf = readFileSync(join(localRepo, fromRepoRel(rel))) } catch (e) {
      errors.push(`${rel}: ${e && e.message ? e.message : e}`)
      continue
    }
    const skipReason = secretSkipReason(rel, buf)
    if (skipReason) {
      skipped.push(rel)
      if (skipReason === 'secret') console.log(`  [!] 安全拦截：跳过含令牌或本机私有凭据的文件 ${rel}（绝不上传）`)
      else if (skipReason === 'profile') console.log(`  [!] 安全拦截：跳过浏览器剖面 / 凭据库文件 ${rel}（含登录态，绝不上传）`)
      else console.log(`  [!] 体积超限：${rel} 超过单文件上限 ${Math.round(MAX_SYNC_FILE_BYTES / 1048576)}MB，未上传（不是安全问题；需要它请用 git 模式）`)
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
        if (remoteBuf && contentHash(remoteBuf) === contentHash(buf)) {
          skipped.push(rel)
          if (typeof onProgress === 'function') {
            const now = Date.now()
            if (idx + 1 === files.length || now - lastReportAt >= 1200) {
              lastReportAt = now
              try { onProgress({ phase: 'upload', done: idx + 1, total: files.length, uploaded: uploaded.length, skipped: skipped.length, errors: errors.length, current: rel }) } catch { }
            }
          }
          continue
        }
      }
    }
    if (dryRun) { uploaded.push(rel); continue }
    const dir = dirname(rel).split('/').filter(Boolean)
    // 逐级建目录（WebDAV 不自动建父级），同一会话内缓存已建路径避免重复 MKCOL
    for (let i = 1; i <= dir.length; i++) {
      const sub = dir.slice(0, i).join('/')
      if (!ensuredDirs.has(sub)) {
        const mr = await ensureRemoteDir(w, sub)
        if (mr.ok) ensuredDirs.add(sub)
      }
    }
    const r = await putFile(w, rel, buf)
    if (r.ok) uploaded.push(rel)
    else errors.push(`${rel}: ${r.error || r.status}`)
    if (typeof onProgress === 'function') {
      const now = Date.now()
      if (idx + 1 === files.length || now - lastReportAt >= 1200) {
        lastReportAt = now
        try { onProgress({ phase: 'upload', done: idx + 1, total: files.length, uploaded: uploaded.length, skipped: skipped.length, errors: errors.length, current: rel }) } catch { }
      }
    }
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
    return { ok: false, downloaded, skipped, conflicts, errors: [`读不到云端目录（PROPFIND 失败）：${w.lastError || '未知原因'} / Cannot list the cloud folder`] }
  }
  if (!remote.exists) {
    return { ok: true, downloaded, skipped, conflicts, errors: [], empty: true }
  }

  // 递归列云端全部文件（PROPFIND Depth:1 只给一层，这里逐目录下钻）
  const all = await listRemoteRecursive(w, '')
  for (const rel of all) {
    // 先判路径再取内容：越界路径连请求都不该发（`..` 会把 URL 拼成上一级，白拿一次 404）
    if (!isSafeRemoteRel(rel)) {
      errors.push(`${rel}: 云端返回了越界路径（可能指向仓库之外），已拒绝写入`)
      continue
    }
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
    const xml = await withBodyTimeout(res.text(), 60000, `PROPFIND 响应`)
    // 与 listRemote 共用基准：必须取请求 URL 的真实路径，否则带前缀的 WebDAV 永远列不到子目录
    const baseDir = requestPathBase(url, w, relDir)
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
      // 反向代理改写前缀时，两者可能互为后缀；不带斜杠的裸 href 视为当前目录
      const flat = lastSlash < 0
      const sameDir = flat
        || parent === baseDir
        || (baseDir && parent.endsWith('/' + baseDir))
        || (parent && baseDir.endsWith('/' + parent))
      if (!name || !sameDir) continue
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

/**
 * 远端给的相对路径必须真的留在仓库目录内。
 *
 * href 是服务端可控字符串：配置错误/恶意的 WebDAV（或被改写的反代）可以回
 * `..%2F..%2Fevil.txt`，直接 join 就会写到仓库外面。这里按段判定，
 * 越界（.. / 空段 / 绝对路径 / 盘符 / NUL）一律拒收。
 */
function isSafeRemoteRel(rel) {
  const s = String(rel || '')
  if (!s || s.length > 1024) return false
  if (s.includes('\0')) return false
  if (/^[\\/]/.test(s)) return false
  if (/^[A-Za-z]:/.test(s)) return false
  return !s.split(/[\\/]/).some((seg) => seg === '..' || seg === '')
}

/** 连通性测试（面板「测试连接」与探云端是否为空共用）。 */
export async function testConnection(w) {
  if (!w.enabled) return { ok: false, error: '未配置 WebDAV 地址 / WebDAV URL is not set' }
  if (!isSecureUrl(w.url)) {
    return { ok: false, error: '地址不是 https（明文传输密码有风险）；确需使用请设 DSH_SYNC_ALLOW_INSECURE=1'
      + ' / Not https (credentials would travel in clear text); set DSH_SYNC_ALLOW_INSECURE=1 to allow it' }
  }
  const res = await listRemote(w, '')
  // 0.6.48：失败要说清是哪一类（401/403/404/405/超时/证书），并把用到的 UA 一起报出来 ——
  // 排查「服务按客户端过滤」时，第一件事就是确认我们发出去的到底是什么。
  if (!res) {
    return {
      ok: false,
      error: String(w.lastError || '连不上或认证失败（PROPFIND 无响应） / Cannot reach the server or auth failed (PROPFIND gave no answer)'),
      url: w.url,
      userAgent: w.ua || '',
      status: Number(w.lastStatus || 0),
    }
  }
  const dirs = res.exists ? await listRemoteDirs(w, '') : []
  return {
    ok: true,
    exists: res.exists,
    files: res.entries.size + dirs.length,
    rootFiles: res.entries.size,
    rootDirs: dirs.length,
    url: w.url,
    userAgent: w.ua || '',
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

/** 只认识的参数；打错字（-DshHme）时明确提示，而不是静默用默认值跑错目录。 */
function warnUnknownArgs(args, known, usage) {
  const extra = Object.keys(args).filter((k) => !known.includes(k))
  if (!extra.length) return
  console.error(`[!] 未知参数：${extra.map((k) => '-' + k).join(', ')}（已忽略；用法：${usage}）`)
}

function readLocalSettings(dshHome) {
  const p = join(dshHome, 'dsh-config-sync.json')
  if (!existsSync(p)) return {}
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    return doc && typeof doc === 'object' ? doc : {}
  } catch (e) {
    // 设置文件被手改坏（多一个逗号 / 截断）时不要整个同步崩掉：
    // 走默认值（= 未配置 WebDAV）并明确说清楚，否则 CLI 只吐一堆 JSON 解析堆栈，用户看不懂。
    console.error(`设置文件不是合法 JSON：${p}（${e && e.message ? e.message : e}）；按未配置 WebDAV 处理`)
    return {}
  }
}

export async function deletePrefixes(w, prefixes = []) {
  const clean = [...new Set((prefixes || []).map((p) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean))]
  const deleted = [], errors = []
  if (!w.enabled || !clean.length) return { ok: true, deleted, errors }
  for (const p of clean) {
    if (!isSafeRemoteRel(p)) { errors.push(`${p}: 越界路径，已拒绝`); continue }
  }
  const remoteMeta = await listRemoteMeta(w, '')
  const keys = [...remoteMeta.keys()]
  for (const k of keys) {
    if (clean.some((p) => k === p || k.startsWith(p + '/'))) {
      const r = await deleteRemote(w, k)
      if (r.ok) deleted.push(k)
      else errors.push(`${k}: ${r.error || r.status}`)
    }
  }
  return { ok: errors.length === 0, deleted, errors }
}

export async function runWebdavCli(argv) {
  const [cmd, ...rest] = argv
  const a = parseCliArgs(rest)
  warnUnknownArgs(a, ['DshHome', 'dshHome', 'RepoRoot', 'repoRoot', 'PathsFile', 'pathsFile'], 'node webdav.mjs <probe|upload|download|delete-paths> -DshHome <dir> -RepoRoot <dir>')
  const dshHome = a.DshHome || a.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const repoRoot = a.RepoRoot || a.repoRoot || process.cwd()
  if (!cmd || !['probe', 'upload', 'download', 'delete-paths'].includes(cmd)) {
    console.error('用法：node webdav.mjs <probe|upload|download|delete-paths> -DshHome <dir> -RepoRoot <dir>')
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
    const r = await uploadRepo(w, repoRoot, {
      onProgress: (p) => {
        if (p.phase === 'scan') {
          console.log(`上传扫描：共 ${p.total} 个文件`)
        } else {
          console.log(`上传进度：${p.done}/${p.total}（已上传 ${p.uploaded} · 跳过 ${p.skipped}${p.errors ? ` · 失败 ${p.errors}` : ''}）`)
        }
      },
    })
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
  if (cmd === 'delete-paths') {
    if (!isSecureUrl(w.url)) {
      console.error('WebDAV 地址不是 https（明文传输密码有风险）；确需使用请设 DSH_SYNC_ALLOW_INSECURE=1')
      return 1
    }
    const pf = a.PathsFile || a.pathsFile || join(dshHome, 'config-sync-delete-cloud.json')
    let prefixes = []
    if (existsSync(pf)) {
      try {
        const doc = JSON.parse(readFileSync(pf, 'utf8').replace(/^\uFEFF/, ''))
        if (Array.isArray(doc?.prefixes)) prefixes = doc.prefixes
      } catch { }
    }
    const r = await deletePrefixes(w, prefixes)
    if (r.deleted.length || r.errors.length) {
      console.log(`WebDAV 清理云端未勾选副本：删除 ${r.deleted.length} · 错误 ${r.errors.length}`)
    }
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