// 会话记录（conversations 组）的跨平台实现。
//
// 为什么要有这个文件
//   0.6.49 之前这一组只有 Windows 的 capture.ps1 / apply.ps1 会做，macOS / Linux 上
//   勾了「会话记录」也只是勾着好看（面板现在会标明不支持）。这里把它搬进 Node 引擎，
//   与 PowerShell 版**同一套目录命名与同一份 session-index.json**，两边能互相同步。
//
// 关键约定（与 capture.ps1 / apply.ps1 逐条对齐，改这里必须同步改那边）
//   1. 本机目录名 = 工作区绝对路径的编码（`--Users-huanyu-projects--`），换机必变；
//      仓库里已登记工作区一律用稳定名 `--ws-<workspaceId>--`（ID 跨机不变），
//      im 用 `--im--`，对不上工作区的按原名穿透（passthrough）。
//   2. `conversations/session-index.json` 记「仓库目录名 ↔ workspaceId」，apply 靠它反推
//      本机目录名；本机认不出的 ID 就照仓库名铺（原机再用时仍可认）。
//   3. 四块数据字节保真：sessions / attachments / storages/session_projcache/sessions /
//      storages/vision_router_session_policy/policies。
//   4. 默认工作区（`*-default-workspace--`）永远不参与同步。
//   5. 会话日志（`session*.jsonl(.zstd)`）**不能整文件覆盖**：两台机器各自 append 出不同
//      lineage 时，覆盖会让一方事件整段消失，DSH 启动报 `seq gap`。所以走
//      tools/session-log-guard.mjs 的 decide()；护栏不可用时退回整文件覆盖，并把这件事
//      写进 notes（绝不静默）。

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

const BS = sep
/** 会话数据块：本机源 → 仓库目标（仓库内一律用 / 分隔）。 */
export const CONVERSATION_BLOCKS = [
  { src: ['sessions'], dst: 'sessions', remap: true },
  { src: ['attachments'], dst: 'attachments', remap: false },
  { src: ['storages', 'session_projcache', 'sessions'], dst: 'session_projcache', remap: false },
  { src: ['storages', 'vision_router_session_policy', 'policies'], dst: 'vision_router_session_policy', remap: false },
]

/**
 * 本机会话目录名编码。
 *
 * 与 capture.ps1 的 Get-SessionDirName 一致，但**先去掉开头的分隔符**：POSIX 的绝对路径
 * 是 `/Users/...`，照字符表把 `/` 换成 `-` 会多出一个前导横线（`---Users-…--`），
 * 而 DSH 自己的目录名是 `--Users-…--` —— 差这一个字符，工作区映射就全线对不上，
 * 所有会话目录都会退化成 passthrough（0.6.49 实测）。Windows 的 `D:\…` 不受影响。
 */
export function sessionDirName(path) {
  let out = '--'
  for (const ch of String(path || '').replace(/^[\\/]+/, '')) {
    const c = ch.codePointAt(0)
    if (c === 58) continue                        // ':' 丢弃（Windows 盘符不要）
    if (c === 92 || c === 47) { out += '-'; continue }
    if (c < 128) out += ch
    else out += '~' + c.toString(16).toUpperCase().padStart(4, '0')
  }
  return out + '--'
}

/** 仓库里的稳定目录名（与 capture.ps1 的 Get-RepoSessionDirName 一致）。 */
export function repoSessionDirName(kind, id, localDir) {
  if (kind === 'ws' && id) {
    const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, '_')
    if (safe) return `--ws-${safe}--`
  }
  if (kind === 'im') return '--im--'
  return localDir
}

export function isDefaultWorkspaceDir(name) {
  return Boolean(name) && /-default-workspace--$/.test(String(name))
}

/** 会话日志文件（要过 seq 护栏的那类），与 dsh-sync-common.ps1 的 Test-SessionLogFile 一致。 */
export function isSessionLogFile(relOrName) {
  const leaf = String(relOrName || '').split(/[\\/]/).pop() || ''
  return /^session(\.[A-Za-z0-9]+)*\.jsonl(\.zstd)?$/.test(leaf)
}

function sha1File(p) {
  try { return createHash('sha1').update(readFileSync(p)).digest('hex') } catch { return '' }
}

function sameContent(a, b) {
  try {
    const sa = statSync(a), sb = statSync(b)
    if (sa.size !== sb.size) return false
    return sha1File(a) === sha1File(b)
  } catch { return false }
}

/** 目录下的一级子目录名（不存在就空数组）。 */
function listDirNames(root) {
  try { return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] }
}

function listFiles(root) {
  const out = []
  const walk = (dir) => {
    let names = []
    try { names = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of names) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) out.push(abs)
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

/** 读本机工作区登记表：目录名编码 ↔ workspaceId ↔ 本机路径。 */
export function readWorkspaceMap(dshHome) {
  const encToId = new Map()
  const pathById = new Map()
  try {
    const reg = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
    const ws = reg && reg.tables && reg.tables.workspaces
    if (ws && typeof ws === 'object') {
      for (const [id, val] of Object.entries(ws)) {
        const p = val && typeof val.path === 'string' ? val.path : ''
        if (!p) continue
        encToId.set(sessionDirName(p), id)
        pathById.set(id, p)
      }
    }
  } catch { /* 没有登记表：全部按原名穿透 */ }
  return { encToId, pathById }
}

/**
 * 找 im 会话目录的本机名。
 * 短路径（ADMINI~1）时和 DSH 自己写的长名对不上 —— 先精确命中，否则在所有 `*-im--` 里
 * 挑文件最多的那个（当次机器一定在用的那个）。
 */
function findImDirName(sessionsRoot, dshHome) {
  const want = sessionDirName(join(dshHome, 'im'))
  let names = []
  try { names = readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return '' }
  if (names.includes(want)) return want
  const cands = names.filter((n) => /-im--$/.test(n))
  if (!cands.length) return ''
  let best = cands[0], bestCount = -1
  for (const n of cands) {
    const count = listFiles(join(sessionsRoot, n)).length
    if (count > bestCount) { bestCount = count; best = n }
  }
  return best
}

/** 建「仓库目录名 → 本机目录名」映射所需的信息（capture 与 apply 共用）。 */
function planDirs({ dshHome, encToId, pathById, scope, useRepoDirs }) {
  const sessionsRoot = join(dshHome, 'sessions')
  const imLocal = join(dshHome, 'im')
  const imDirName = findImDirName(sessionsRoot, dshHome)
  const entries = []
  const localToRepo = new Map()
  const skipLocal = new Set()
  // 被跳过工作区的会话 ID（projcache / vision_router 是按 sessionId 命名的，不是工作区目录名）
  const skipSids = new Set()
  const notes = []

  let names = []
  try { names = readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() } catch { names = [] }

  for (const name of names) {
    if (isDefaultWorkspaceDir(name)) { notes.push(`默认工作区不参与同步，跳过：${name}`); continue }
    const wsId = encToId.get(name) || ''
    if (wsId && scope && scope.enabled === false) { /* 整组关掉由上层处理 */ }
    if (wsId && !workspaceEnabled(scope, wsId)) {
      skipLocal.add(name)
      for (const sub of listDirNames(join(sessionsRoot, name))) skipSids.add(sub)
      notes.push(`跳过（未勾选同步）该工作区的会话：${name}`)
      continue
    }
    if (wsId) {
      const repoDir = repoSessionDirName('ws', wsId, name)
      localToRepo.set(name, repoDir)
      entries.push({ dir: repoDir, workspaceId: wsId })
    } else if (imDirName && name === imDirName) {
      const repoDir = repoSessionDirName('im', '', name)
      localToRepo.set(name, repoDir)
      entries.push({ dir: repoDir, special: 'im' })
    } else {
      entries.push({ dir: name, passthrough: true })
      notes.push(`会话目录无法对应到已登记工作区，按原名保留：${name}`)
    }
  }
  // 反方向：仓库目录名 → 本机目录名（apply 用）
  const repoToLocal = new Map()
  for (const [localDir, repoDir] of localToRepo) repoToLocal.set(repoDir, localDir)
  return { entries, localToRepo, repoToLocal, skipLocal, skipSids, notes, imLocal, imDirName, pathById, sessionsRoot, useRepoDirs }
}

/**
 * 某个工作区是否勾选（scope.groups.conversations 的形状见 config-sync-scope.json：
 * `{enabled?:false, excluded?:[工作区ID...]}`）。
 */
function workspaceEnabled(scope, wsId) {
  if (!scope) return true
  if (scope.enabled === false) return false
  const excluded = Array.isArray(scope.excluded) ? scope.excluded : []
  return !excluded.includes(String(wsId))
}

function writeIndexIfChanged(convDir, entries) {
  const text = JSON.stringify({ unit: { name: 'dsh-session-sync', version: 1 }, entries }, null, 2) + '\n'
  const p = join(convDir, 'session-index.json')
  let before = ''
  try { before = readFileSync(p, 'utf8').replace(/\r\n/g, '\n') } catch { /* 没有就写 */ }
  if (before === text) return false
  mkdirSync(convDir, { recursive: true })
  writeFileSync(p, text, 'utf8')
  return true
}

/**
 * 抓取会话记录到仓库。
 * @returns {{ok:boolean, files:number, bytes:number, changed:string[], errors:string[], notes:string[]}}
 */
export function captureConversations({ repoRoot, dshHome, scope = null, log = console.log } = {}) {
  const convDir = join(repoRoot, 'conversations')
  const changed = []
  const errors = []
  const notes = []
  let files = 0
  let bytes = 0

  const { encToId, pathById } = readWorkspaceMap(dshHome)
  const plan = planDirs({ dshHome, encToId, pathById, scope, useRepoDirs: true })
  notes.push(...plan.notes)

  mkdirSync(convDir, { recursive: true })
  if (writeIndexIfChanged(convDir, plan.entries)) changed.push('conversations/session-index.json')

  for (const block of CONVERSATION_BLOCKS) {
    const srcRoot = join(dshHome, ...block.src)
    if (!existsSync(srcRoot)) continue
    const dstRoot = join(convDir, block.dst)
    mkdirSync(dstRoot, { recursive: true })
    /** 仓库里应该存在的相对路径（/ 分隔）→ 本机源文件 */
    const wanted = new Map()
    for (const abs of listFiles(srcRoot)) {
      const relLocal = relative(srcRoot, abs).split(BS).join('/')
      const parts = relLocal.split('/')
      if (parts.length > 1 && isDefaultWorkspaceDir(parts[0])) continue
      if (block.remap && parts.length > 1 && plan.skipLocal.has(parts[0])) continue
      if (!block.remap && (block.dst === 'session_projcache' || block.dst === 'vision_router_session_policy') && parts.length > 1) {
        const sid = parts[0].replace(/\.[^.]+$/, '')
        if (plan.skipSids.has(sid)) continue
      }
      if (block.remap && plan.localToRepo.has(parts[0])) parts[0] = plan.localToRepo.get(parts[0])
      wanted.set(parts.join('/'), abs)
    }

    // 写：内容一致就不动（避免每次 capture 都把整棵会话树刷一遍）
    for (const [rel, abs] of wanted) {
      const dst = join(dstRoot, rel.split('/').join(BS))
      if (existsSync(dst) && sameContent(abs, dst)) continue
      try {
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(abs, dst)
        files += 1
        bytes += statSync(dst).size
        changed.push(`conversations/${block.dst}/${rel}`)
      } catch (e) {
        errors.push(`conversations/${block.dst}/${rel}: ${(e && e.message) || e}`)
      }
    }
    // 镜像删除：本机没有的，仓库里也删（scope 取消勾选的工作区按同一规则处理）
    for (const abs of listFiles(dstRoot)) {
      const rel = relative(dstRoot, abs).split(BS).join('/')
      if (wanted.has(rel)) continue
      try {
        rmSync(abs, { force: true })
        files += 1
        changed.push(`conversations/${block.dst}/${rel}（删除）`)
      } catch (e) {
        errors.push(`删除 conversations/${block.dst}/${rel} 失败：${(e && e.message) || e}`)
      }
    }
  }

  return { ok: errors.length === 0, files, bytes, changed, errors, notes }
}

/**
 * 把仓库里的会话记录铺回本机。
 *
 * 会话日志走 seq 护栏：本机与仓库都有且不同时，先问护栏「谁更全 / 要不要并集」，
 * 它说不能写（坏档）就跳过这一个文件并记进 errors，其余继续。
 */
export function applyConversations({ repoRoot, dshHome, scope = null, backupRoot = '', dryRun = false, guardScript = '' } = {}) {
  const convDir = join(repoRoot, 'conversations')
  const result = { ok: true, copied: 0, skipped: 0, conflicts: [], errors: [], notes: [] }
  if (!existsSync(convDir)) { result.notes.push(`仓库里没有 ${convDir}，跳过会话还原`); return result }

  const { encToId, pathById } = readWorkspaceMap(dshHome)
  const plan = planDirs({ dshHome, encToId, pathById, scope, useRepoDirs: false })
  const repoToLocal = new Map(plan.repoToLocal)
  const skipRepoDirs = new Set()
  for (const [localDir] of plan.localToRepo) {
    if (plan.skipLocal.has(localDir)) skipRepoDirs.add(plan.localToRepo.get(localDir))
  }

  // session-index.json：仓库目录名 → 本机目录名（认不出的 ID 照原名铺）
  let entries = []
  try {
    const idx = JSON.parse(readFileSync(join(convDir, 'session-index.json'), 'utf8'))
    entries = Array.isArray(idx.entries) ? idx.entries : []
  } catch { /* 没有索引就靠目录名反推 */ }
  const fromIndex = new Map()
  for (const e of entries) {
    const repoDir = String(e.dir || '')
    if (!repoDir) continue
    if (e.workspaceId && !workspaceEnabled(scope, String(e.workspaceId))) { skipRepoDirs.add(repoDir); result.notes.push(`跳过（未勾选同步）该工作区的会话：${repoDir}`); continue }
    const localPath = e.workspaceId ? plan.pathById.get(String(e.workspaceId)) : ''
    if (localPath) { fromIndex.set(repoDir, sessionDirName(localPath)); continue }
    if (e.special === 'im') { fromIndex.set(repoDir, sessionDirName(plan.imLocal)); continue }
    fromIndex.set(repoDir, repoDir)
  }
  const mapFirst = (rel) => {
    const parts = rel.split('/')
    if (parts.length < 2) return rel
    const repoDir = parts[0]
    if (skipRepoDirs.has(repoDir)) return null
    const localDir = fromIndex.get(repoDir) || repoToLocal.get(repoDir) || repoDir
    if (isDefaultWorkspaceDir(localDir)) return null
    parts[0] = localDir
    return parts.join('/')
  }

  const guard = guardScript && existsSync(guardScript) ? guardScript : ''
  if (!guard) result.notes.push('会话日志护栏不可用（tools/session-log-guard.mjs 找不到）：日志按整文件覆盖，两台机器同时写同一会话可能丢事件')

  for (const block of CONVERSATION_BLOCKS) {
    const srcRoot = join(convDir, block.dst)
    if (!existsSync(srcRoot)) continue
    for (const abs of listFiles(srcRoot)) {
      const relRepo = relative(srcRoot, abs).split(BS).join('/')
      let rel = relRepo
      if (block.remap) {
        rel = mapFirst(relRepo)
        if (rel === null) { result.skipped += 1; continue }
      }
      const dst = join(dshHome, ...block.src, ...rel.split('/').join(BS).split(BS))
      if (existsSync(dst) && sameContent(abs, dst)) { result.skipped += 1; continue }
      if (dryRun) { result.copied += 1; continue }
      try {
        mkdirSync(dirname(dst), { recursive: true })
        // 覆盖前留底（和其它组的 apply 一样：不静默丢本机内容）
        if (backupRoot && existsSync(dst) && !sameContent(abs, dst)) {
          const bk = join(backupRoot, block.dst, relRepo.split('/').join(BS))
          mkdirSync(dirname(bk), { recursive: true })
          copyFileSync(dst, bk)
          result.conflicts.push(`conversations/${block.dst}/${relRepo}`)
        }
        // 会话日志：先问护栏（它可能要求用并集覆盖，或干脆拒绝写坏档）。
        // 只对 .zstd 走护栏 —— 老版本的纯 .jsonl 日志不是 zstd 帧流，护栏会判「源无法解析」，
        // 那种文件本来也不存在 lineage 分叉问题，整文件覆盖即可。
        if (guard && /\.zstd$/i.test(rel) && existsSync(dst)) {
          const verdict = decideViaGuardCli(guard, abs, dst)
          if (verdict && verdict.action === 'keep_dst') {
            if (verdict.ok === false) result.errors.push(`conversations/${block.dst}/${relRepo}: ${verdict.detail || '护栏拒绝写入'}`)
            result.skipped += 1
            continue
          }
          if (verdict && verdict.action === 'corrupt') {
            result.errors.push(`conversations/${block.dst}/${relRepo}: ${verdict.detail || '会话日志 seq 不连续，拒绝写入'}`)
            continue
          }
          if (verdict && verdict.action === 'merge' && verdict.mergedFile && existsSync(verdict.mergedFile)) {
            copyFileSync(verdict.mergedFile, dst)
            result.copied += 1
            continue
          }
        }
        copyFileSync(abs, dst)
        result.copied += 1
      } catch (e) {
        result.errors.push(`conversations/${block.dst}/${relRepo}: ${(e && e.message) || e}`)
      }
    }
  }
  result.ok = result.errors.length === 0
  return result
}

/**
 * 本机「待推送」要扫的会话相关根（供 index.js 的 localPending 用）。
 * 只列四块数据里真实存在的目录，避免把不存在的路径也算进扫描。
 */
export function conversationPendingRoots(dshHome) {
  const out = []
  for (const block of CONVERSATION_BLOCKS) out.push({ path: join(dshHome, ...block.src), group: 'conversations' })
  return out.filter((r) => existsSync(r.path))
}

/**
 * 找护栏脚本（tools/session-log-guard.mjs）。
 * 顺序与 PowerShell 侧一致：插件自带 → 仓库里的 tools/ → 仓库根（老仓库把脚本平铺）。
 */
export function resolveGuardScript(candidates) {
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return ''
}

/**
 * 问护栏「这个会话日志能不能覆盖、要不要并集」。
 *
 * 走 CLI（`node session-log-guard.mjs decide <src> <dst> <out.json>`）而不是 import：
 * PowerShell 侧就是这么调的，两平台行为一致；也不再受 require(ESM) 的版本差异影响
 * （Node 22.12 之前不能 require 一个 .mjs）。
 */
export function decideViaGuardCli(script, srcFile, dstFile) {
  const out = join(tmpdir(), `dsh-cfg-sync-guard-${process.pid}-${Date.now()}.json`)
  try {
    const r = spawnSync(process.execPath, [script, 'decide', srcFile, dstFile, out], { encoding: 'utf8', timeout: 60000 })
    if (r.status !== 0 && r.status !== 1) {
      return { action: 'corrupt', detail: `护栏退出码 ${r.status}：${String(r.stderr || '').trim().slice(0, 200)}` }
    }
    const verdict = JSON.parse(readFileSync(out, 'utf8'))
    return verdict && typeof verdict === 'object' ? verdict : { action: 'take_src' }
  } catch (e) {
    return { action: 'corrupt', detail: `护栏执行失败：${(e && e.message) || e}` }
  } finally {
    try { rmSync(out, { force: true }) } catch { /* 清理失败无所谓 */ }
  }
}
