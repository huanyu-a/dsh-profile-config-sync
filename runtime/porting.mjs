/**
 * 跨平台移植：把另一套系统上传的配置改成本机能用的样子。
 *
 * 为什么需要这一层：0.6.49 之前只有 Windows 版，"换机还原"默认两边都是 Windows。
 * 现在 macOS 也能同步，云端的 `profile/package.json` 里就会出现
 *
 *   "@local/dsh-personal": "link:{{ROOT:userHome}}/AppData/Local/dsh-personal"
 *
 * 这类依赖 —— 在 macOS 上展开成 `/Users/xxx/AppData/Local/dsh-personal`，目录不存在，
 * pnpm 解不出 link 依赖，profile 起不来。`cordis.patch.yml`、`settings/dsh-workspaces.json`、
 * `prompt/AGENTS.md` 里同理全是 `D:\project\...` 之类的路径。
 *
 * 这一层的态度：**能翻的翻，翻了不可用的直接丢掉并写清楚原因**，绝不原样铺过去。
 * 翻译规则按「最像的对应物」排优先级，全部以本机文件系统是否存在为准：
 *
 *   ① 用户在 `config-sync-port.json` 里写死的映射（最长前缀优先）；
 *   ② `%USERPROFILE%` / `%LOCALAPPDATA%` / `%APPDATA%` 这类环境变量；
 *   ③ WSL 的 `/mnt/c/Users/<U>/...`；
 *   ④ `C:\Users\<U>\<rest>` → `<userHome>/<rest>`；
 *   ⑤ `D:\<...>\<leaf>` → 本机同名工作区（按标题 / 目录名匹配）→ `<userHome>/projects/<leaf>`
 *      → `<userHome>/<leaf>` → `<userHome>/Documents/<leaf>`，取第一个真实存在的。
 *
 * 一条都命中不了就返回 null，调用方据此跳过该项（而不是写一个不存在的路径）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { accessSync } from 'node:fs'
import { basename, join } from 'node:path'

export const PORT_CONFIG_NAME = 'config-sync-port.json'

/** 读用户写的映射表。格式：{ "paths": { "D:\\c": "{{ROOT:userHome}}/dsh-personal" }, "extra": ["D:\\data"] } */
export function readPortConfig(dshHome) {
  const out = { paths: [], ok: true, note: '' }
  const p = join(dshHome, PORT_CONFIG_NAME)
  if (!existsSync(p)) return out
  let doc = null
  try {
    doc = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    return { paths: [], ok: false, note: `${PORT_CONFIG_NAME} 不是合法 JSON：${e && e.message ? e.message : e}` }
  }
  const map = doc && typeof doc.paths === 'object' && doc.paths ? doc.paths : {}
  for (const [from, to] of Object.entries(map)) {
    if (!from || typeof to !== 'string' || !to) continue
    out.paths.push({ from: String(from), to })
  }
  // 长前缀优先，避免 D:\c 抢走 D:\c\dsh-personal 的匹配
  out.paths.sort((a, b) => b.from.length - a.from.length)
  return out
}

/** 本机上下文：家目录、工作区清单、根占位符表。 */
export function portContext({ userHome, roots = {}, localWorkspaces = [], portConfig = { paths: [] }, expand = null } = {}) {
  return {
    userHome,
    roots,
    localWorkspaces: Array.isArray(localWorkspaces) ? localWorkspaces : [],
    rules: Array.isArray(portConfig.paths) ? portConfig.paths : [],
    // 可选：把 {{ROOT:x}} / {{DSH_HOME}} 这类占位符展开成真实路径（由调用方注入，避免两个模块互相依赖）
    expand: typeof expand === 'function' ? expand : null,
    exists: (p) => {
      try {
        accessSync(p, fsConstants.F_OK)
        return true
      } catch {
        return false
      }
    },
  }
}

/** 把 {{ROOT:x}} 占位符展开成真实路径（会用 ctx.roots，缺的返回 null 交给调用方判空）。 */
function expandPlaceholders(text, ctx) {
  return String(text).replace(/\{\{ROOT:([A-Za-z0-9_.-]+)\}\}/g, (m, name) => {
    const v = ctx.roots[name]
    return typeof v === 'string' && v ? v : m
  })
}

/** 是否像一条 Windows 绝对路径。 */
export function looksWindowsPath(p) {
  const s = String(p || '')
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s) || /^%[A-Za-z0-9_()]+%/.test(s) || /^\/mnt\/[a-z]\//i.test(s)
}

/** 统一成反斜杠形态便于比较（只用于匹配，不用于输出）。 */
function winish(p) {
  return String(p).replace(/\//g, '\\').replace(/\\+$/, '')
}

/** Windows 路径 → 本机 POSIX 路径。返回 { to, how } 或 null。 */
export function translateWinPath(input, ctx) {
  const raw = String(input || '').trim()
  if (!raw) return null
  if (raw.startsWith('/') && !/^\/mnt\/[a-z]\//i.test(raw)) {
    // 已经是 POSIX 路径：只做占位符展开，存在就用
    const expanded = expandPlaceholders(raw, ctx)
    return ctx.exists(expanded) ? { to: expanded, how: '本机路径' } : null
  }
  // ① 用户写死的映射（最长前缀）
  const w = winish(raw)
  for (const rule of ctx.rules) {
    const from = winish(rule.from)
    if (w === from || w.toLowerCase().startsWith(from.toLowerCase() + '\\')) {
      const rest = w.slice(from.length).replace(/^\\+/, '')
      const to = expandPlaceholders(rule.to, ctx) + (rest ? '/' + rest.replace(/\\/g, '/') : '')
      return { to, how: `映射表 ${rule.from} → ${rule.to}` }
    }
  }
  // ② 环境变量
  let envHit = null
  const envMap = {
    '%USERPROFILE%': ctx.userHome,
    '%HOME%': ctx.userHome,
    '%APPDATA%': join(ctx.userHome, 'AppData', 'Roaming'),
    '%LOCALAPPDATA%': join(ctx.userHome, 'AppData', 'Local'),
  }
  const envMatch = w.match(/^(%[A-Za-z0-9_()]+%)\\?(.*)$/)
  if (envMatch) {
    const value = envMap[envMatch[1].toUpperCase()]
    const rest = envMatch[2] || ''
    if (value) {
      const to = value + (rest ? '/' + rest.replace(/\\/g, '/') : '')
      if (ctx.exists(to)) envHit = { to, how: `环境变量 ${envMatch[1]}` }
    }
  }
  if (envHit) return envHit
  // ③ WSL：/mnt/c/Users/<U>/rest
  const wsl = raw.match(/^\/mnt\/([a-z])\/(.*)$/i)
  if (wsl) {
    const tail = wsl[2]
    const users = tail.match(/^Users\/([^/]+)\/?(.*)$/i)
    const rest = users ? users[2] : tail
    const to = ctx.userHome + (rest ? '/' + rest : '')
    return ctx.exists(to) ? { to, how: 'WSL /mnt 路径' } : null
  }
  // ④ C:\Users\<U>\<rest> → <userHome>/<rest>
  const drive = raw.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!drive) return null
  const restRaw = drive[2]
  const userProfile = restRaw.match(/^Users[\\/]([^\\/]+)[\\/]?(.*)$/i)
  if (userProfile) {
    const to = ctx.userHome + (userProfile[2] ? '/' + userProfile[2].replace(/\\/g, '/') : '')
    if (ctx.exists(to)) return { to, how: 'C:\\Users → 本机家目录' }
  }
  // ⑤ 按「同名工作区 / 常见位置」找对应物
  const leaf = basename(winish(restRaw).replace(/\\/g, '/'))
  if (!leaf) return null
  const tries = []
  for (const ws of ctx.localWorkspaces) {
    if (!ws || !ws.path) continue
    const wsLeaf = basename(String(ws.path))
    if (String(ws.title || '') === leaf || wsLeaf === leaf) tries.push({ to: ws.path, how: `同名工作区「${ws.title || wsLeaf}」` })
  }
  tries.push({ to: join(ctx.userHome, 'projects', leaf), how: '~/projects/<同名>' })
  tries.push({ to: join(ctx.userHome, leaf), how: '~/<同名>' })
  tries.push({ to: join(ctx.userHome, 'Documents', leaf), how: '~/Documents/<同名>' })
  for (const t of tries) if (ctx.exists(t.to)) return t
  return null
}

/** 文本里的 Windows 路径统一翻译（用于 cordis.patch.yml / AGENTS.md）。 */
export function translatePortableText(text, ctx) {
  const hits = []
  const misses = []
  const out = String(text || '')
    .replace(/(?:[A-Za-z]:[\\/]|\/mnt\/[a-z]\/|%[A-Za-z0-9_]+%[\\/])[^\s"'`，。；）)】]*/g, (m) => {
      const cleaned = m.replace(/[.,;:]+$/, '')
      const trailing = m.slice(cleaned.length)
      const t = translateWinPath(cleaned, ctx)
      if (t) {
        if (hits.length < 40) hits.push({ from: cleaned, to: t.to, how: t.how })
        return t.to + trailing
      }
      if (misses.length < 40) misses.push(cleaned)
      return m
    })
  return { text: out, hits, misses }
}

/**
 * 合并两个 profile 的 package.json。
 *
 * 本机那份是**权威**：name / private / 已有依赖的版本号都用本机的。
 * 云端的贡献：本机没有的依赖（link: 先翻译，翻不出来的丢掉）、只增不减的 bundles。
 */
export function portPackageJson({ localPkg, cloudPkg, ctx }) {
  const notes = []
  const dropped = []
  const local = localPkg && typeof localPkg === 'object' ? localPkg : null
  const cloud = cloudPkg && typeof cloudPkg === 'object' ? cloudPkg : null
  if (!cloud) return { pkg: null, notes: ['云端没有 package.json'], dropped }
  if (!local) return { pkg: null, notes: ['本机没有 package.json（新机器？先用 pull 之外的路径建一份）'], dropped }
  const deps = { ...(local.dependencies || {}) }
  for (const [name, specRaw] of Object.entries(cloud.dependencies || {})) {
    const spec = String(specRaw)
    if (deps[name]) {
      if (deps[name] !== spec) notes.push(`${name}: 本机 ${deps[name]} 优先于云端 ${spec}`)
      continue
    }
    if (/^link:/i.test(spec)) {
      const t = translateWinPath(spec.slice(5), ctx)
      if (!t) {
        dropped.push(`${name}: link:${spec.slice(5)} 在本机找不到对应目录`)
        continue
      }
      if (!ctx.exists(join(t.to, 'package.json'))) {
        dropped.push(`${name}: ${t.to} 里没有 package.json`)
        continue
      }
      deps[name] = 'link:' + t.to
      notes.push(`${name}: link 改写到 ${t.to}（${t.how}）`)
      continue
    }
    if (/^file:/i.test(spec)) {
      dropped.push(`${name}: ${spec} 指向的 tgz 不在云端仓库里，本机装不上`)
      continue
    }
    deps[name] = spec
    notes.push(`${name}: 新增 ${spec}`)
  }
  const bundles = [...((local.dsh && local.dsh.profile && local.dsh.profile.bundles) || [])]
  for (const b of (cloud.dsh && cloud.dsh.profile && cloud.dsh.profile.bundles) || []) {
    if (bundles.includes(b)) continue
    const isBuiltin = /^@deepseek-ai\//.test(b)
    if (isBuiltin || deps[b]) {
      bundles.push(b)
      notes.push(`bundle 新增：${b}`)
    } else {
      dropped.push(`bundle ${b}: 对应依赖既不在本机也不在云端可移植项里`)
    }
  }
  const pkg = {
    ...local,
    dependencies: deps,
    dsh: {
      ...(local.dsh || {}),
      profile: { ...((local.dsh && local.dsh.profile) || {}), bundles },
    },
  }
  return { pkg, notes, dropped }
}

/**
 * 合并工作区登记表：云端条目先翻译路径，翻不出来就跳过；本机已有的同 id / 同名条目一律优先。
 * 返回 { registry, notes, skipped } —— registry 是合并后的完整 storages/workspace.json 结构。
 */
export function portWorkspaceRegistry({ localReg, cloudReg, ctx }) {
  const notes = []
  const skipped = []
  const base = localReg && typeof localReg === 'object' ? JSON.parse(JSON.stringify(localReg)) : { version: 1, tables: { workspaces: {} }, global: {} }
  base.tables = base.tables && typeof base.tables === 'object' ? base.tables : {}
  base.tables.workspaces = base.tables.workspaces && typeof base.tables.workspaces === 'object' ? base.tables.workspaces : {}
  base.global = base.global && typeof base.global === 'object' ? base.global : {}
  const localByTitle = new Map()
  for (const [id, w] of Object.entries(base.tables.workspaces)) {
    if (w && w.title) localByTitle.set(String(w.title), { id, path: w.path })
  }
  // 两种形状都要认：仓库里的 workspace-registry.json 是 { workspaces: [] }，
  // settings 组那份整份快照是 DSH 自己的 { tables: { workspaces: { id: {...} } } }。
  let cloudList = Array.isArray(cloudReg && cloudReg.workspaces) ? cloudReg.workspaces : []
  const cloudTable = cloudReg && cloudReg.tables && cloudReg.tables.workspaces
  if (!cloudList.length && cloudTable && typeof cloudTable === 'object') {
    cloudList = Object.entries(cloudTable).map(([id, w]) => ({ id, ...(w || {}) }))
  }
  for (const w of cloudList) {
    if (!w || !w.id) continue
    if (base.tables.workspaces[w.id]) continue
    const title = w.title || w.id
    const already = localByTitle.get(String(title))
    if (already) {
      skipped.push(`${title}: 本机已有同名工作区（${already.path}），不重复登记`)
      continue
    }
    // 先展开 {{ROOT:userHome}} / {{DSH_HOME}} 这类占位符，再按 Windows 规则翻译
    const rawPath = ctx.expand ? ctx.expand(String(w.path || '')) : String(w.path || '')
    const t = translateWinPath(rawPath, ctx)
    if (!t) {
      skipped.push(`${title}: 云端路径 ${w.path} 在本机找不到对应目录`)
      continue
    }
    // 映射到「家目录本身」没有意义（那是 Windows 的 C:\Users\<U>，不是项目目录），只会给面板添乱
    if (t.to === ctx.userHome || t.to === '/') {
      skipped.push(`${title}: 云端路径 ${w.path} 只对应到本机家目录，不作为工作区`)
      continue
    }
    base.tables.workspaces[w.id] = {
      title,
      path: t.to,
      sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : [],
      archivedSessionIds: Array.isArray(w.archivedSessionIds) ? w.archivedSessionIds : [],
      pinnedSessionIds: Array.isArray(w.pinnedSessionIds) ? w.pinnedSessionIds : [],
      createdAt: w.createdAt || '',
      updatedAt: w.updatedAt || '',
    }
    notes.push(`${title}: ${w.path} → ${t.to}（${t.how}）`)
  }
  return { registry: base, notes, skipped }
}

/** 全局提示（AGENTS.md）：只翻路径，不动内容结构，开头加一句来源说明。 */
export function portAgentsMd(text, ctx) {
  const r = translatePortableText(text, ctx)
  const header = `<!-- 本文件由 dsh-profile-config-sync 从另一套系统的仓库移植：路径已按本机实际情况改写${r.misses.length ? `；${r.misses.length} 处路径在本机找不到对应物，保持原样` : ''} -->\n`
  return { text: header + r.text, hits: r.hits, misses: r.misses }
}

/** 报告用：把翻译结果压成几行给面板看。 */
export function summarizePort({ hits = [], misses = [], dropped = [], notes = [], skipped = [] } = {}) {
  const lines = []
  if (hits.length) lines.push(`翻译路径 ${hits.length} 处`)
  if (notes.length) lines.push(`依赖/条目调整 ${notes.length} 处`)
  if (dropped.length) lines.push(`丢弃 ${dropped.length} 项（本机不可用）`)
  if (skipped.length) lines.push(`跳过 ${skipped.length} 项（找不到对应物）`)
  if (misses.length) lines.push(`未翻译 ${misses.length} 处`)
  return lines.join('，')
}