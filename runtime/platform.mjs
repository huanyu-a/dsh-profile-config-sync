// 跨端平台层 —— 把「这台机器是谁、东西装在哪、怎么执行」收敛到一处。
//
// 为什么要有这一层：上游插件把 Windows 的假设散落在 6 个 PowerShell 脚本和
// index.js 的 130+ 处（`%SystemRoot%`、HKLM/HKCU、盘符枚举、`C:\Users`、
// `.cmd`、tasklist、junction……）。要让同一份插件在 macOS / Linux 上跑起来，
// 必须先把这些假设抽出来，否则每加一个平台就要在业务代码里再撒一遍 if。
//
// 设计约束：
//   1. 零第三方依赖，只用 node:* 内建 —— 插件不能 import @deepseek-ai/*（在 app.asar 里）。
//   2. 任何探测失败都返回空/默认值，**绝不抛**：调用方拿到的永远是可用值。
//   3. 平台差异只允许出现在本文件。业务代码里出现 process.platform 就是漏了这层。

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, sep } from 'node:path'

/** 本机平台标识：与 process.platform 一致（win32 / darwin / linux）。 */
export const OS = process.platform

/** 是否 Windows。 */
export const IS_WIN = OS === 'win32'

/** 是否 macOS。 */
export const IS_MAC = OS === 'darwin'

/** 路径分隔符（\ 或 /）。 */
export const SEP = sep

/** PATH 分隔符（; 或 :）。 */
export const PATH_SEP = delimiter

/**
 * 面向 humans 的平台名（面板/日志用）。
 * 中文在前、英文在后，跟插件其余文案一致。
 */
export function platformLabel() {
  if (IS_WIN) return 'Windows'
  if (IS_MAC) return 'macOS'
  if (OS === 'linux') return 'Linux'
  return OS
}

/** 平台族：windows / posix。跨端分支只看这一个变量，不看具体是哪个 Unix。 */
export function platformFamily() {
  return IS_WIN ? 'windows' : 'posix'
}

/** DSH 配置根目录（~/.dsh）。DSH_HOME 优先，空值当没设。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim().length > 0) return env.trim()
  return join(homedir(), '.dsh')
}

/** 工作区根（默认 ~/Documents/deepseek-harness）。 */
export function defaultWorkspaceHome() {
  return join(homedir(), 'Documents', 'deepseek-harness')
}

/**
 * 判断路径是否存在且是目录。失败返回 false。
 */
export function isDir(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

/**
 * 判断路径是否存在且是文件。失败返回 false。
 *
 * 注意：Electron 主进程把 app.asar 当目录挂载，statSync 会报 isDirectory()，
 * 所以「客户端根」的判据必须同时接受 asar 目录形态（见 isAppRoot）。
 */
export function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

export function pathExists(path) {
  try { return existsSync(path) } catch { return false }
}

/**
 * 客户端安装根（AppRoot）的判据：目录里有 resources\app.asar（打包版）
 * 或 resources\app\package.json（解包版）。
 *
 * 两个判据都必须接受「asar 是目录」这一形态 —— 打包版 Electron 里
 * statSync('app.asar').isDirectory() 才是 true，只写 isFile() 会让
 * 真实客户端永远认不出自己的根。
 */
export function isAppRoot(path) {
  if (!path) return false
  const asar = join(path, 'resources', 'app.asar')
  if (pathExists(asar)) return true
  return isFile(join(path, 'resources', 'app', 'package.json'))
}

/**
 * 客户端根的候选位置，按可信度排序。Windows 上有注册表与盘符可用，
 * POSIX 上只有标准安装位置 + 环境变量。
 */
export function appRootCandidates() {
  const out = []
  const push = (p) => { if (p) out.push(p) }
  push(process.env.DSH_APP_ROOT)
  if (IS_WIN) {
    // Windows：用户级安装（LOCALAPPDATA）最常见，其次系统级。
    // 目录名按客户端实际安装名给全：安装包用的是带空格的 "DeepSeek Harness"，
    // 只写 DeepSeekHarness 会让最常见的用户级安装探测不到。
    for (const base of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env.ProgramW6432]) {
      if (!base) continue
      push(join(base, 'Programs', 'DeepSeek Harness'))
      push(join(base, 'DeepSeek Harness'))
      push(join(base, 'Programs', 'DeepSeekHarness'))
      push(join(base, 'DeepSeekHarness'))
    }
    // 客户端常被卸载重装到别的盘，盘符全扫一遍；判据仍是 resources\app.asar。
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      push(`${letter}:\\DeepSeek Harness`)
      push(`${letter}:\\DeepSeekHarness`)
      push(`${letter}:\\DSH`)
    }
  } else {
    // macOS：Electron 应用是 .app bundle，可执行文件在 Contents/MacOS 下。
    push('/Applications/DeepSeek Harness.app')
    push(join(homedir(), 'Applications', 'DeepSeek Harness.app'))
    // Linux：AppImage / 解包目录 / /opt。
    push(join(homedir(), 'Applications', 'DeepSeek Harness'))
    push('/opt/DeepSeek Harness')
    push('/opt/deepseek-harness')
    push('/usr/local/DeepSeek Harness')
  }
  return out
}

/**
 * 从 .app bundle 里取真正的「客户端根」。
 *
 * macOS 上 Electron 应用的 resources 目录在 `Xxx.app/Contents/Resources`，
 * 而插件被部署在 `<AppRoot>` 的上一级。这里把 .app 内的 Resources 归一成
 * 与 Windows 一致的形状，让上层逻辑（readAppMeta / hostDshNodeModules）不用改。
 */
export function normalizeAppRoot(path) {
  if (!path || !isDir(path)) return path
  if (IS_MAC && path.endsWith('.app')) {
    const inner = join(path, 'Contents', 'Resources')
    if (isDir(inner)) return inner
  }
  return path
}

/**
 * 客户端根下真正放可执行文件 / resources 的目录。
 *
 * Windows：就是 AppRoot 本身。
 * macOS：.app bundle → Contents/MacOS（可执行）与 Contents/Resources（资源）。
 */
export function appRootLayout(appRoot) {
  if (!appRoot) return { root: appRoot, resources: '', macos: '' }
  if (IS_MAC && appRoot.endsWith('.app')) {
    return {
      root: appRoot,
      resources: join(appRoot, 'Contents', 'Resources'),
      macos: join(appRoot, 'Contents', 'MacOS'),
    }
  }
  return { root: appRoot, resources: join(appRoot, 'resources'), macos: appRoot }
}

/**
 * 客户端可执行文件（用于「DSH 是否还在运行」判断与重启）。
 * Windows: <root>\DeepSeek Harness.exe
 * macOS:   <root>\Contents\MacOS\DeepSeek Harness
 * Linux:   <root>/dsh 或 <root>/DeepSeek Harness
 *
 * 找不到返回空串（调用方据此降级：不做进程守护，只靠 pid）。
 */
export function clientExecutable(appRoot) {
  const layout = appRootLayout(appRoot)
  const names = IS_WIN
    ? ['DeepSeek Harness.exe']
    : (IS_MAC ? ['DeepSeek Harness'] : ['dsh', 'DeepSeek Harness', 'deepseek-harness'])
  const bases = IS_MAC ? [layout.macos, layout.root] : [layout.root]
  for (const base of bases) {
    if (!base) continue
    for (const n of names) {
      const p = join(base, n)
      if (isFile(p)) return p
    }
  }
  return ''
}

/**
 * 客户端进程名（不含扩展名）。用于跨平台进程枚举。
 * Windows 上 Get-Process 用 'DeepSeek Harness'（不带 .exe）。
 */
export function clientProcessNames() {
  if (IS_WIN) return ['DeepSeek Harness', 'deepseek harness']
  if (IS_MAC) return ['DeepSeek Harness', 'DeepSeekHarness']
  return ['dsh', 'deepseek-harness', 'DeepSeek Harness']
}

/** 宿主自带 bundle 的落点（解包版 / 打包版）。 */
export function hostDshNodeModules(appRoot) {
  const layout = appRootLayout(appRoot)
  const res = layout.resources
  if (!res) return []
  return [
    join(res, 'app', 'dsh', 'node_modules'),
    join(res, 'app.asar.unpacked', 'dsh', 'node_modules'),
    join(res, 'dsh', 'node_modules'),
  ]
}

/**
 * 客户端自带的 Node 可执行文件。
 *
 * 这是 Node 版执行层的命脉：DSH 必带 Node，但位置随平台/打包方式变。
 * 找不到时再退回 PATH 上的 node（用户装过就用），最后返回空串。
 */
export function hostNodeExe(appRoot) {
  const layout = appRootLayout(appRoot)
  const res = layout.resources
  const candidates = []
  // 真实布局（Windows / 打包版实测 2026-11-24）：
  //   <res>\runtime\primary-runtime\dependencies\node\bin\node.exe   ← 实际位置
  //   <res>\runtime\bin\node                                        ← 启动壳（内容是一行脚本，不能执行）
  // macOS / Linux 上同一个相对位置叫 node（无 .exe）。
  const nodeDirs = res ? [
    join(res, 'runtime', 'primary-runtime', 'dependencies', 'node'),
    join(res, 'runtime'),
  ] : []
  if (appRoot) {
    nodeDirs.push(join(appRoot, 'runtime', 'primary-runtime', 'dependencies', 'node'))
    nodeDirs.push(join(appRoot, 'runtime'))
  }
  for (const base of nodeDirs) {
    if (!base) continue
    candidates.push(
      join(base, 'bin', 'node.exe'),
      join(base, 'bin', 'node'),
      join(base, 'node.exe'),
      join(base, 'node'),
    )
  }
  for (const c of candidates) {
    if (c && isFile(c)) return c
  }
  return ''
}

/**
 * Electron 主程序（ELECTRON_RUN_AS_NODE=1 时就是 node，且自带 zstd）。
 * macOS 上是 .app 内的可执行文件。
 */
export function hostElectronExe(appRoot) {
  const exe = clientExecutable(appRoot)
  if (exe) return exe
  return ''
}

/**
 * 找 git 可执行文件。Windows 上 Git 常不在 PATH（客户端进程继承的 PATH 被裁过），
 * 所以先探常见安装位置；POSIX 上直接信 PATH。
 */
export function findGit() {
  if (IS_WIN) {
    const bases = [process.env.ProgramFiles, process.env.ProgramW6432, process.env.LOCALAPPDATA]
    for (const b of bases) {
      if (!b) continue
      for (const rel of [join('Git', 'cmd', 'git.exe'), join('Git', 'bin', 'git.exe'),
        join('Programs', 'Git', 'cmd', 'git.exe')]) {
        const p = join(b, rel)
        if (isFile(p)) return p
      }
    }
  } else {
    for (const p of ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git', '/opt/local/bin/git']) {
      if (isFile(p)) return p
    }
  }
  // PATH 兜底
  for (const dir of String(process.env.PATH || '').split(PATH_SEP)) {
    if (!dir) continue
    const p = join(dir, IS_WIN ? 'git.exe' : 'git')
    if (isFile(p)) return p
  }
  return ''
}

/**
 * 找 ssh 可执行文件（推送走 SSH 时用 GIT_SSH_COMMAND）。
 * 必须以可执行程序开头 —— 只返回能 stat 到的真实文件，绝不返回半截命令。
 */
export function findSsh() {
  const names = IS_WIN ? ['ssh.exe'] : ['ssh']
  const dirs = []
  if (IS_WIN) {
    const lad = process.env.LOCALAPPDATA
    if (lad) {
      dirs.push(join(lad, 'Programs', 'Git', 'usr', 'bin'))
      dirs.push(join(lad, 'Programs', 'Git', 'mingw64', 'bin'))
    }
    for (const r of [process.env.ProgramFiles, process.env.ProgramW6432]) {
      if (r) dirs.push(join(r, 'Git', 'usr', 'bin'))
    }
    dirs.push(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH'))
  } else {
    dirs.push('/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin')
  }
  for (const dir of String(process.env.PATH || '').split(PATH_SEP)) {
    if (dir) dirs.push(dir)
  }
  for (const dir of dirs) {
    for (const n of names) {
      const p = join(dir, n)
      if (isFile(p)) return p
    }
  }
  return ''
}

/**
 * 判断一个目录项是不是符号链接（POSIX）/ junction（Windows）。
 *
 * 只判「是链接」，不判目标是否存在 —— 调用方要区分「断链」与「活链」。
 * 实测（Windows / Node 24）：readdirSync(withFileTypes) 拿到的 Dirent 对
 * junction 返回 isSymbolicLink()=true，且 lstatSync 同样为 true，
 * 所以两种入参（Dirent / Stats）都能判。
 */
export function isLinkItem(item) {
  if (!item) return false
  try {
    if (typeof item.isSymbolicLink === 'function') return item.isSymbolicLink()
  } catch { /* 忽略 */ }
  return false
}

/**
 * 读链接目标。失败返回空数组。
 *
 * Windows 上 junction 用 Node 读不出来（readlinkSync 报 EINVAL，
 * 实测 2026-11-24），所以那条路径要由调用方用 `fs.realpathSync.native`
 * 或 PowerShell 兜底；这里只保证「读得到就返回，读不到就空」。
 */
export function readLinkTargets(item) {
  const out = []
  if (!item) return out
  try {
    const t = item.target ?? item.Target
    if (Array.isArray(t)) out.push(...t.map(String))
    else if (t) out.push(String(t))
  } catch { /* 忽略 */ }
  return out.filter(Boolean)
}

/**
 * 用户主目录的「占位符友好」写法：给面板显示用。
 * Windows 显示 C:\Users\you，POSIX 显示 /Users/you 或 /home/you。
 */
export function homeDisplay() {
  return homedir()
}

/** 是否支持符号链接（POSIX 恒 true；Windows 上创建 junction 不需要管理员）。 */
/**
 * 自选同步目录的路径归一化（按平台分档校验）。
 *
 * 为什么单独抽出来：这段逻辑曾经写死 Windows 语义，POSIX 上 /Users/x/docs 会被
 * 「把 / 换成 \」后判成非法再静默丢弃 —— 面板显示保存成功，实际一条都没存。
 * 现在被拒的路径会收集进 dropped，由调用方整批报错，绝不静默丢。
 */
export function normalizeSyncExtraPaths(list, platform = process.platform) {
  const win = platform === 'win32'
  const paths = []
  const dropped = []
  const used = new Set()
  const baseName = (s) => String(s).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'extra'
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.src !== 'string' || !item.src.trim()) continue
    const raw = item.src.trim()
    // Windows 上允许用户写正斜杠（C:/a/b），统一成反斜杠；POSIX 原样保留
    const abs = win ? raw.replace(/\//g, '\\') : raw
    const okPath = win
      ? (/^[A-Za-z]:[\\/]/.test(abs) || abs.startsWith('\\\\'))
      : abs.startsWith('/')
    const okAbs = win ? (abs.startsWith('\\\\') || /^[A-Za-z]:\\/.test(abs)) : abs.startsWith('/')
    if (!okPath || !okAbs) { dropped.push(raw); continue }
    const label = (typeof item.label === 'string' && item.label.trim())
      ? item.label.trim()
      : (typeof item.id === 'string' && item.id.trim() ? item.id.trim() : baseName(abs))
    let id = String(label).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'extra'
    let n = 2
    const root = id
    while (used.has(id.toLowerCase())) id = `${root}-${n++}`
    used.add(id.toLowerCase())
    paths.push({ id, src: abs, label })
  }
  return { paths, dropped }
}
export function supportsSymlink() {
  return !IS_WIN
}