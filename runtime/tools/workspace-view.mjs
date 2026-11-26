/**
 * workspace-view — 配置同步面板「工作区显示状态」卡片的宿主侧工具（0.3.76）
 *
 * 职责：在本插件内自包含地读写 DSH 的两套原生隐藏/归档状态文件，不依赖
 * session-manager 的 web API（那个 API 需要 DSH connection owner 凭证，插件
 * 自己的路由拿不到）。
 *
 * 两个权威落点：
 *   1) <DshHome>\storages\workspace.json  -> global.archivedSessionIds[]   会话级「隐藏」
 *   2) <DshHome>\dsh-session-manager\workspace-archives.v1.json
 *        -> workspaces[wsId] = {workspaceId, archived:true, archivedAt, sessionIds, pending}
 *                                                                        工作区级「归档」
 *
 * 三态（工作区）：
 *   normal       显示：无 archive 记录 + 该工作区会话都不在 archivedSessionIds
 *   hide-sessions 隐藏会话：无 archive 记录 + 该工作区所有会话进 archivedSessionIds（工作区仍留列表）
 *   archive      归档工作区：写 archive 记录 archived:true + 所有会话进 archivedSessionIds（工作区从列表消失）
 *   partial      部分会话被单独隐藏（只读状态，前端显示但切换时按用户所选三态归一化）
 *
 * 会话级独立操作：隐藏/显示单个会话只增删 global.archivedSessionIds 里的一个 id，
 * 不碰工作区 archive 记录 —— 与工作区三态互不影响。
 *
 * 会话名称：从会话日志开头的 `session/title` 事件读取（fallback / provider 两种，
 * 取最后一个、即 provider 生成的那个）；没有 title 事件时回退到第一条 user/message
 * 文本。只读每个日志的前若干 zstd 帧，不解压整份历史，按 mtime 缓存。
 *
 * 格式保持：两个状态文件原本都是 UTF-8 无 BOM、LF、2 空格缩进、末尾一个 \n。
 * 写回统一用 JSON.stringify(obj, null, 2) + '\n'，实测与原文件逐字节一致。
 */
import * as fs from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const WS_REL = ['storages', 'workspace.json']
const ARCH_REL = ['dsh-session-manager', 'workspace-archives.v1.json']
const SESSIONS_REL = ['sessions']

const ZSTD_MAGIC = 0xfd2fb528
const TITLE_EVENTS = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl']
const TITLE_FRAME_LIMIT = 40          // 只读开头 40 帧：title 事件在前 10 帧内
const TITLE_CACHE = new Map()         // path+mtime -> {title, byId}

function readJson(path) {
  try {
    const s = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** 覆盖写：先写临时文件再 copyFile 覆盖（Windows 上 copyFile 覆盖是原子的），失败回退直写。 */
function writeJsonAtomic(path, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n'
  const tmp = `${path}.wv-${process.pid}-${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    try {
      // 同盘 rename 才是原子替换：copyFileSync 是「截断目标再写」，
      // 宿主在这一瞬间读到的是半截 JSON —— workspace.json 会被当成空表重建（工作区列表瞬间清空）。
      fs.renameSync(tmp, path)
    } catch {
      // Windows 上目标被别的进程打开时 rename 会 EPERM/EBUSY：退回拷贝，
      // 只是失去原子性，比直接写错强。
      try { fs.copyFileSync(tmp, path) } finally { try { fs.unlinkSync(tmp) } catch { } }
    }
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { }
    fs.writeFileSync(path, text, 'utf8')
  }
}

function archivePath(dshHome) { return join(dshHome, ...ARCH_REL) }
function workspacePath(dshHome) { return join(dshHome, ...WS_REL) }

/** 只扫前 maxFrames 个 zstd 帧的字节边界，返回 Buffer 片段；不再往后读。 */
function scanFrameBuffers(buf, maxFrames) {
  const out = []
  let offset = 0
  while (offset < buf.length && out.length < maxFrames) {
    const start = offset
    if (buf.length - offset < 4 || buf.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buf.length) break
    if (buf.length - offset < 1) break
    const d = buf.readUInt8(offset++)
    if ((d & 0x18) !== 0) break
    const csf = d >>> 6
    const single = (d & 0x20) !== 0
    const checksum = (d & 0x04) !== 0
    const df = d & 0x03
    const dictBytes = df === 3 ? 4 : df
    const sizeBytes = csf === 0 ? (single ? 1 : 0) : (1 << csf)
    offset += (single ? 0 : 1) + dictBytes + sizeBytes
    let ok = true
    for (;;) {
      if (buf.length - offset < 3) { ok = false; break }
      const bh = buf.readUIntLE(offset, 3); offset += 3
      const last = (bh & 1) !== 0
      const bt = (bh >>> 1) & 0x03
      const bs = bh >>> 3
      if (bt === 0x03) { ok = false; break }
      offset += bt === 0x01 ? 1 : bs
      if (last) break
    }
    if (!ok) break
    if (checksum) offset += 4
    out.push(buf.subarray(start, offset))
  }
  return out
}

function cleanTitle(text) {
  if (typeof text !== 'string') return ''
  let s = text.replace(/\s+/g, ' ').trim()
  // 系统提醒 / 工具输出这类前缀不作为标题
  if (/^<system-reminder>/.test(s)) return ''
  if (/^\[MNEMON\]/.test(s)) return ''
  if (s.length > 48) s = s.slice(0, 48) + '…'
  return s
}

/**
 * 从单个会话日志文件提取标题、来源与空会话标记。返回 {title, origin, blank} 并写入缓存。
 * origin 取自日志首个 `session` 头事件：`subagent` 表示智能体（子）会话；
 * blank 表示从没跑过对话（没有 turn/start、没有首条用户消息）。
 * 面板「工作区显示」卡片默认把这两类都折叠掉，只留用户自己真正聊过的会话。
 */
function titleFromFile(file) {
  let mtime = 0
  try { mtime = fs.statSync(file).mtimeMs } catch { return { title: '', origin: '', blank: false } }
  const key = `${file}:${mtime}`
  const hit = TITLE_CACHE.get(key)
  if (hit) return hit
  let result = { title: '', origin: '', blank: false }
  try {
    const buf = fs.readFileSync(file)
    let text = ''
    if (file.endsWith('.zstd')) {
      for (const fr of scanFrameBuffers(buf, TITLE_FRAME_LIMIT)) {
        try { text += zstdDecompressSync(fr).toString('utf8') } catch { /* torn frame */ }
      }
    } else {
      text = buf.toString('utf8', 0, 256 * 1024)
    }
    // 会话标题会演进：先产生 fallback（首条消息截断），随后 AI 生成 provider 正式标题覆盖。
    // DSH 面板显示的是最新/provider 标题；这里必须一致，不能像以前那样找到第一条就 break。
    let providerTitle = ''      // source.kind === 'provider' 的 AI 标题（取最后一条）
    let fallbackTitle = ''      // fallback 标题（取最后一条）
    let anyTitle = ''           // 无 source 信息的兜底标题（取最后一条）
    let firstUserText = ''
    let origin = ''             // 会话来源：subagent = 智能体子会话
    let sawTurn = false         // 出现过 turn/start：真正跑过对话
    for (const line of text.split('\n')) {
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      if (!origin && ev.type === 'session') {
        if (typeof ev.origin === 'string') origin = ev.origin
        else if (ev.data && typeof ev.data.origin === 'string') origin = ev.data.origin
      }
      if (ev.type === 'turn/start') sawTurn = true
      if (ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string') {
        const kind = ev.data.source && ev.data.source.kind
        if (kind === 'provider') providerTitle = ev.data.title
        else if (kind === 'fallback') fallbackTitle = ev.data.title
        else anyTitle = ev.data.title
      }
      if (!firstUserText && ev.type === 'user/message' && ev.data && Array.isArray(ev.data.content)) {
        for (const part of ev.data.content) {
          if (part && part.type === 'text' && typeof part.text === 'string') {
            firstUserText = part.text
            break
          }
        }
      }
    }
    // 优先级与 DSH 面板一致：provider 正式标题 > fallback > 无来源 title > 首条用户消息
    result = {
      title: cleanTitle(providerTitle) || cleanTitle(fallbackTitle) || cleanTitle(anyTitle) || cleanTitle(firstUserText),
      origin,
      // 空会话：从没跑过对话（没有 turn/start，也没有首条用户消息）。DSH 自己也算 blank，
      // 这里独立算一遍，因为面板要据此把「新建了没发消息」的会话藏起来。
      blank: !sawTurn && !firstUserText,
    }
  } catch {
    result = { title: '', origin: '', blank: false }
  }
  if (TITLE_CACHE.size > 400) TITLE_CACHE.clear()
  TITLE_CACHE.set(key, result)
  return result
}

/** 建一次 sid -> 日志文件路径 的索引（目录遍历很快，不读文件内容）。 */
function buildSessionLogIndex(dshHome) {
  const byId = new Map()
  const root = join(dshHome, ...SESSIONS_REL)
  let projects
  try { projects = fs.readdirSync(root, { withFileTypes: true }) } catch { return byId }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const pd = join(root, proj.name)
    let dirs
    try { dirs = fs.readdirSync(pd, { withFileTypes: true }) } catch { continue }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const dd = join(pd, d.name)
      for (const name of TITLE_EVENTS) {
        const f = join(dd, name)
        if (fs.existsSync(f)) { byId.set(d.name, f); break }
      }
    }
  }
  return byId
}

/**
 * 读视图：列出所有工作区 + 每个工作区下会话的隐藏状态 + 三态归一化 + 会话名称。
 * 默认只留用户自己真正聊过的会话，折叠两类会话：
 *   ① 智能体会话（origin === 'subagent'）；
 *   ② 空会话（blank：从没跑过对话）。
 * options.includeAgents=true 时把智能体也算进来；options.includeBlank=true 时把空会话也算进来。
 * 三态与计数都只按保留下来的会话计算。
 *
 * 「Mnemon 空闲审查」的父容器（mnemon-review-owner-v1-*）被一并折叠：
 * 它自己的 header 没有 origin（不是 subagent），但日志里只有一个 subagent/catalog
 * 事件、没有 turn/start，因此按空会话判定隐藏；真正的审查内容在它指向的
 * mnemon-review-v1-* 子会话里，那个带 origin=subagent，属于第 ① 类。
 */
export function readView(dshHome, options = {}) {
  const includeAgents = options.includeAgents === true
  const includeBlank = options.includeBlank === true
  const ws = readJson(workspacePath(dshHome))
  const arch = readJson(archivePath(dshHome))
  if (!ws || !ws.tables || !ws.tables.workspaces) {
    return { ok: true, available: false, workspaces: [], includeAgents, includeBlank, agentHidden: 0, blankHidden: 0 }
  }
  const globalArchived = new Set(Array.isArray(ws.global?.archivedSessionIds) ? ws.global.archivedSessionIds : [])
  const archMap = (arch && arch.workspaces && typeof arch.workspaces === 'object') ? arch.workspaces : {}
  const logIndex = buildSessionLogIndex(dshHome)
  const workspaces = []
  let totalAgents = 0
  let totalBlank = 0
  for (const [wsId, rec] of Object.entries(ws.tables.workspaces)) {
    if (!rec || typeof rec !== 'object') continue
    const sessionIds = Array.isArray(rec.sessionIds) ? rec.sessionIds.slice() : []
    const archRec = archMap[wsId]
    const workspaceArchived = Boolean(archRec && archRec.archived === true)
    const all = sessionIds.map((sid) => {
      const log = logIndex.get(sid)
      const meta = log ? titleFromFile(log) : { title: '', origin: '', blank: false }
      return {
        id: sid,
        title: meta.title,
        hidden: globalArchived.has(sid),
        agent: meta.origin === 'subagent',
        blank: meta.blank === true,
      }
    })
    const agentCount = all.filter((s) => s.agent).length
    const blankCount = all.filter((s) => !s.agent && s.blank).length
    totalAgents += agentCount
    totalBlank += blankCount
    // 两道过滤独立生效：智能体一类、空会话一类。
    let sessions = includeAgents ? all : all.filter((s) => !s.agent)
    if (!includeBlank) sessions = sessions.filter((s) => !s.blank)
    const hiddenCount = sessions.filter((s) => s.hidden).length
    let state = 'normal'
    if (workspaceArchived) state = 'archive'
    else if (hiddenCount > 0 && hiddenCount === sessions.length && sessions.length > 0) state = 'hide-sessions'
    else if (hiddenCount > 0) state = 'partial'
    workspaces.push({
      workspaceId: wsId,
      title: rec.title || wsId,
      path: typeof rec.path === 'string' ? rec.path : '',
      sessionCount: sessions.length,
      hiddenCount,
      agentCount,
      blankCount,
      state,
      archived: workspaceArchived,
      archivedAt: workspaceArchived && typeof archRec.archivedAt === 'number' ? archRec.archivedAt : 0,
      sessions,
    })
  }
  return { ok: true, available: true, workspaces, includeAgents, includeBlank, agentHidden: totalAgents, blankHidden: totalBlank }
}

/** 切换一个工作区的三态。state ∈ normal | hide-sessions | archive。 */
export function setWorkspaceState(dshHome, workspaceId, state) {
  const wsPath = workspacePath(dshHome)
  const archPath = archivePath(dshHome)
  const ws = readJson(wsPath)
  if (!ws || !ws.tables || !ws.tables.workspaces || !ws.tables.workspaces[workspaceId]) {
    throw new Error(`工作区不存在：${workspaceId}`)
  }
  if (!['normal', 'hide-sessions', 'archive'].includes(state)) {
    throw new Error(`不支持的工作区状态：${state}`)
  }
  const rec = ws.tables.workspaces[workspaceId]
  const sids = Array.isArray(rec.sessionIds) ? rec.sessionIds.slice() : []
  const arch = readJson(archPath) || { version: 1, workspaces: {} }
  if (!arch.workspaces || typeof arch.workspaces !== 'object') arch.workspaces = {}
  const ga = new Set(Array.isArray(ws.global?.archivedSessionIds) ? ws.global.archivedSessionIds : [])
  if (!ws.global || typeof ws.global !== 'object') ws.global = {}

  if (state === 'archive') {
    arch.workspaces[workspaceId] = {
      workspaceId,
      archived: true,
      archivedAt: Date.now(),
      sessionIds: sids,
      pending: [],
    }
    for (const sid of sids) ga.add(sid)
  } else {
    // normal / hide-sessions 都不该留工作区归档记录
    delete arch.workspaces[workspaceId]
    if (state === 'hide-sessions') {
      for (const sid of sids) ga.add(sid)
    } else {
      for (const sid of sids) ga.delete(sid)
    }
  }

  ws.global.archivedSessionIds = Array.from(ga)
  writeJsonAtomic(wsPath, ws)
  writeJsonAtomic(archPath, arch)
  return readView(dshHome)
}

/** 单独隐藏/显示一个会话：只增删 global.archivedSessionIds，不碰工作区归档记录。 */
export function setSessionState(dshHome, sessionId, hidden) {
  const wsPath = workspacePath(dshHome)
  const ws = readJson(wsPath)
  if (!ws || !ws.global || typeof ws.global !== 'object') {
    throw new Error('workspace.json 缺少 global 段')
  }
  const ga = new Set(Array.isArray(ws.global?.archivedSessionIds) ? ws.global.archivedSessionIds : [])
  if (hidden) ga.add(sessionId)
  else ga.delete(sessionId)
  ws.global.archivedSessionIds = Array.from(ga)
  writeJsonAtomic(wsPath, ws)
  return readView(dshHome)
}

/* ===================== 实时通道（0.3.82） =====================
 * 直接改 JSON 文件只能改磁盘，宿主内存里的 workspaceRegistry.archivedSessionIds
 * 与 session-list feed 都不会更新 —— 这就是以前「必须重启 DSH 才生效」的原因。
 *
 * 正路是走 workspaceRegistry 的三个公开方法：
 *   registry.archiveSession(id, {stopActivity}) → enqueueOperation → setState
 *     → global.set(state) 落盘 + storage domain changed
 *     → api-workspace-controller 的 feed.changed 发布 {type:'archived', archivedSessionIds}
 *     → 会话列表实时更新，无需重启。
 *   registry.unarchiveSession(id) 同理。
 *
 * registry 拿不到（插件先于 registry 启动、或宿主版本变更）时，自动退回上面的
 * 纯文件写法并标记 live:false，保证功能不丢，只是需要刷新才生效。
 */

/** 用 registry 改单个会话的隐藏状态；registry 不可用时返回 {via:'file'}。 */
async function applySessionState(registry, sessionId, hidden) {
  if (!registry || typeof registry.archiveSession !== 'function') return { via: 'file', stopped: false }
  if (hidden) {
    const already = Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(sessionId)
    if (already) return { via: 'live', stopped: false }
    try {
      await registry.archiveSession(sessionId, { stopActivity: false })
      return { via: 'live', stopped: false }
    } catch (error) {
      const text = String((error && (error.code || error.name || error.message)) || '')
      // 会话正在跑（有活动）时宿主会拒绝；带上 stopActivity 再试一次，先停掉活动再归档。
      if (/active/i.test(text)) {
        await registry.archiveSession(sessionId, { stopActivity: true })
        return { via: 'live', stopped: true }
      }
      throw error
    }
  }
  if (typeof registry.unarchiveSession !== 'function') return { via: 'file', stopped: false }
  await registry.unarchiveSession(sessionId)
  return { via: 'live', stopped: false }
}

/** 用 registry 内存里的 archivedSessionIds 修正视图的 hidden 标记（文件可能还没落盘）。 */
function withRegistryHidden(view, registry) {
  if (!registry || !Array.isArray(registry.archivedSessionIds)) return view
  const set = new Set(registry.archivedSessionIds)
  const workspaces = (view.workspaces || []).map((w) => {
    const sessions = (w.sessions || []).map((s) => ({ ...s, hidden: set.has(s.id) }))
    const hiddenCount = sessions.filter((s) => s.hidden).length
    let state = 'normal'
    if (w.archived) state = 'archive'
    else if (hiddenCount > 0 && hiddenCount === sessions.length && sessions.length > 0) state = 'hide-sessions'
    else if (hiddenCount > 0) state = 'partial'
    return { ...w, sessions, hiddenCount, state }
  })
  return { ...view, workspaces }
}

/**
 * 实时切换工作区三态。成功后返回的状态是重新 readView 出来的快照。
 * options.registry 传宿主 workspaceRegistry；传 null/undefined 时退回文件写法。
 */
export async function setWorkspaceStateLive(dshHome, workspaceId, state, options = {}) {
  const { registry = null, includeAgents = false, includeBlank = false } = options
  if (!['normal', 'hide-sessions', 'archive'].includes(state)) {
    throw new Error(`不支持的工作区状态：${state}`)
  }
  const wsPath = workspacePath(dshHome)
  const archPath = archivePath(dshHome)
  const ws = readJson(wsPath)
  if (!ws || !ws.tables || !ws.tables.workspaces || !ws.tables.workspaces[workspaceId]) {
    throw new Error(`工作区不存在：${workspaceId}`)
  }
  const rec = ws.tables.workspaces[workspaceId]
  const sids = Array.isArray(rec.sessionIds) ? rec.sessionIds.slice() : []

  // 工作区归档记录（session-manager 侧）先按旧写法写好：registry 只管会话级 archivedSessionIds。
  const arch = readJson(archPath) || { version: 1, workspaces: {} }
  if (!arch.workspaces || typeof arch.workspaces !== 'object') arch.workspaces = {}
  if (state === 'archive') {
    arch.workspaces[workspaceId] = {
      workspaceId,
      archived: true,
      archivedAt: Date.now(),
      sessionIds: sids,
      pending: [],
    }
  } else {
    delete arch.workspaces[workspaceId]
  }
  writeJsonAtomic(archPath, arch)

  const live = Boolean(registry && typeof registry.archiveSession === 'function')
  if (!live) {
    // 没 registry：完全按旧的文件写法（含 global.archivedSessionIds），行为不变。
    return { ...setWorkspaceState(dshHome, workspaceId, state), live: false }
  }

  const errors = []
  let stopped = 0
  const results = await Promise.all(sids.map(async (sid) => {
    try {
      const r = await applySessionState(registry, sid, state !== 'normal')
      if (r.stopped) stopped += 1
      return r
    } catch (error) {
      errors.push(`${sid}: ${String((error && error.message) || error)}`)
      return { via: 'error' }
    }
  }))
  if (errors.length > 0) {
    // 实时通道部分失败：退回文件写法把状态对齐，避免「写了一半」。
    const fallback = setWorkspaceState(dshHome, workspaceId, state)
    return { ...fallback, live: false, fallbackFrom: 'registry', stopped, errors }
  }
  void results
  return { ...withRegistryHidden(readView(dshHome, { includeAgents, includeBlank }), registry), live: true, stopped }
}

/** 实时隐藏/显示单个会话。 */
export async function setSessionStateLive(dshHome, sessionId, hidden, options = {}) {
  const { registry = null, includeAgents = false, includeBlank = false } = options
  const live = Boolean(registry && typeof registry.archiveSession === 'function')
  if (!live) {
    return { ...setSessionState(dshHome, sessionId, hidden), live: false }
  }
  const r = await applySessionState(registry, sessionId, hidden)
  return { ...withRegistryHidden(readView(dshHome, { includeAgents, includeBlank }), registry), live: true, stopped: r.stopped ? 1 : 0 }
}
