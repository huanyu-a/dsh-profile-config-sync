/**
 * dsh-config-sync — 宿主半身（Host half）
 *
 * 职责边界（重要）
 * ----------------
 * DSH 运行期间不可能安全地做 push/pull：capture 要读正在被应用持有的 cordis.patch.yml，
 * apply 写完之后会被退出时的进程回写覆盖。所以这个插件**不执行**同步动作，只做两件事：
 *   1. 只读体检：两端版本契约、仓库领先/落后、待提交文件、bundle 能否在本机解析；
 *   2. 备命令：按本机实际路径生成一份 同步-推送.cmd / 同步-拉取.cmd，
 *      退出 DSH 后双击即可跑，参数不用手敲。
 *
 * 约束
 * ----
 * - apply() 不抛异常：抛了会让 loader 那条 fiber 失败，启动期报 "Failed to load plugins"。
 * - 只 inject 一定存在的服务（webServer），否则 fiber 会一直 PENDING 拖住整棵插件树。
 * - 零第三方依赖：只用 node:* 内建（第三方插件不能 import @deepseek-ai/*，它们在 app.asar 里）。
 */
import { execFile, execFileSync } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { gunzipSync } from 'node:zlib'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { writeFileAtomicSync } from './runtime/atomic-write.mjs'
import { SETTINGS_SOURCES, settingsSourcePath as settingsSourcePathOf, zeroVolatileFields } from './runtime/settings-sources.mjs'
import {
  EXTRA_CONFIG_NAME, EXTRA_DEFAULT_EXCLUDE, EXTRA_DEFAULT_SKIP_DIRS, EXTRA_HARD_MAX_BYTES,
  EXTRA_MANDATORY_EXCLUDES, EXTRA_MANDATORY_SKIP_DIRS, extraConfigPath, extraSkipReason,
  readExtraConfig, topUpExtraMandatory, wildcardToRegex,
} from './runtime/extra-rules.mjs'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
// 0.3.76：会话投影缓存守卫（agent-busy 自动清缓存，让缓存按日志重建）
import { runGuard, clearSessionCaches, appendGuardLog } from './runtime/tools/session-cache-guard.mjs'
// 0.3.76：工作区显示状态（三态 + 会话独立隐藏），自包含读写 DSH 两个权威文件
import { readView, setWorkspaceState, setSessionState } from './runtime/tools/workspace-view.mjs'
// 0.5.2：在线推送的 CLIXML 日志清洗（单独成文件，自检可直接跑真实片段）
import { extractLiveLogText } from './runtime/live-log.mjs'
// 0.3.82：实时通道。拿不到 workspaceRegistry 时，这两个函数内部自动退回上面的文件写法。
import { setWorkspaceStateLive, setSessionStateLive } from './runtime/tools/workspace-view.mjs'
// 0.4.0：跨端（Windows / macOS / Linux）。平台差异全部收敛在 runtime/platform.mjs，
// 这里只消费它的结论 —— 业务代码里不允许再出现 process.platform 分支。
import {
  IS_WIN, OS, appRootCandidates, appRootLayout, asarPath, clientExecutable,
  clientProcessPattern, defaultRepoPath, findGit, findSsh, hostNodeExe,
  hostDshNodeModules as platformHostDshNodeModules,
  isAppRoot as pfIsAppRoot, isFile as pfIsFile, normalizeAppRoot, platformFamily, platformLabel,
  postExitScriptName, readAppVersion as platformReadAppVersion,
  readElectronVersion as platformReadElectronVersion, repoPathProblem,
  normalizeSyncExtraPaths,
} from './runtime/platform.mjs'
// 0.4.0：客户端身份（仓库里 machines/<id>.json）—— 跨端不分叉仓库，只登记「谁推的」
import { listMachines } from './runtime/machines.mjs'
// 0.4.0：宿主契约跨端读取（platforms / platformFamily 字段，旧契约缺失即视为兼容）
import { checkContract, readContract } from './runtime/contract.mjs'
// 0.4.0：WebDAV 通道（第二种同步方式，与 git 共用同一份仓库格式）
import {
  downloadRepo, isSecureUrl, normalizeWebdav, sanitizeUserAgent, testConnection, uploadRepo, webdavActive,
} from './runtime/webdav.mjs'

const pluginRequire = createRequire(import.meta.url)

const PACKAGE_ID = 'dsh-profile-config-sync'
const ROUTE_STATUS = '/config-sync/status'
const ROUTE_PREPARE = '/config-sync/prepare'
const ROUTE_SETTINGS = '/config-sync/settings'
const ROUTE_UPDATE = '/config-sync/update'
const ROUTE_SCOPE = '/config-sync/scope'
const ROUTE_CONFLICT = '/config-sync/conflict'
// 0.3.30：跨机路径确认（每台机器把自己的根目录报给插件一次）与问题反馈（落仓库 feedback\ 再推 GitHub）
const ROUTE_ROOTS = '/config-sync/roots'
const ROUTE_FEEDBACK = '/config-sync/feedback'
/** 反馈请求体上限：4 个附件 × 20 MB 的 base64（约 27 MB/个）+ 余量。 */
const ROUTE_FEEDBACK_MAX_BODY = 160 * 1024 * 1024
// 0.3.76：会话投影缓存守卫（GET 只读扫描 / POST scan|sweep|clear|busy）
const ROUTE_CACHE_GUARD = '/config-sync/cache-guard'
// 0.3.76：工作区显示状态（GET 读 / POST workspace 三态 | session 独立隐藏）
const ROUTE_WORKSPACE_VIEW = '/config-sync/workspace-view'
// 0.4.0：WebDAV 通道（GET 状态 / POST test|upload|download|save）
const ROUTE_WEBDAV = '/config-sync/webdav'
const SETTINGS_NAME = 'dsh-config-sync.json'
/** 本插件自己的安装目录（插件根，含 runtime\ 与 index.js）—— 插件备份还原时的目标。 */
const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '')

/**
 * 双语：面板是中文还是英文，跟客户端语言走（客户端每个请求都带 accept-language）。
 * t(zh, en) 只在**面向用户**的文案上用；生成的 .cmd 脚本内容、日志一律保持中文。
 */
const langStore = new AsyncLocalStorage()

function pickLang(req) {
  try {
    const raw = String((req && req.headers && (req.headers['accept-language'] || req.headers['Accept-Language'])) || '').toLowerCase()
    if (!raw) return 'zh'
    return raw.includes('zh') ? 'zh' : 'en'
  } catch { return 'zh' }
}

function t(zh, en) {
  return langStore.getStore() === 'en' ? en : zh
}

// ---- 插件自身的版本与更新源 ----
// 插件目录就是 index.js 所在目录（apply 会把它部署成 <AppRoot>\dsh-profile-config-sync-<ver>\）。
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
    return String(pkg.version || '')
  } catch { return '' }
})()
// ── 0.6.47 起：更新检查只查 npm，不看 GitHub ──
// 用户明确要求「插件更新只检查 npm 是否有更新，不检查 GitHub」。
//
// 版本判定：npm registry 的 dist-tags.latest。
// 下载地址与校验值：该版本的单版本文档里的 dist.tarball / dist.integrity / dist.shasum。
// 发布说明：npm tarball 里的 package/release-notes.json（已加进 package.json 的 files 字段）。
//
// 为什么这么换（不是"顺手改一下"，是踩到过坑）：
// GitHub release 资产与 npm tarball **不是同一个字节流** —— 实测 npm pack 产物与 registry 上的
// tarball 逐字节一致（sha256 相同），但与 pnpm pack 的资产不同，差在打包元数据。
// 于是旧实现「清单里记 pnpm 的 sha256、下载走 npm 兜底」在校验那一步必然失败，
// 那条「npm 兜底下载」的路一直有坑。改成单一 npm 源后，校验改用 registry 自己的
// dist.integrity / dist.shasum，权威值与被校验物同源，不会再出现这种错配。
//
// npm 作为唯一更新源（0.6.47 起）
const NPM_PACKAGE_NAME = 'dsh-profile-config-sync'
// registry / dist-tags / 版本文档的 URL 一律由 npmUrls(registry) 现算（见下方 effectiveNpmRegistry），
// 不在模块顶层写死 —— 否则夹具没法用本地服务器当 registry。

// 30 秒：慢链路 10 秒根本不够
const UPDATE_FETCH_TIMEOUT = 30 * 1000
const UPDATE_CHECK_TTL = 30 * 60 * 1000
const GH_TOKEN_ENV_CANDIDATES = ['DSH_CONFIG_SYNC_GH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']
// 0.6.47：npm registry 可被设置或环境变量覆盖。
// 用途有两个：① 国内用户换 npmmirror 之类镜像（仍然只查 npm，只是换了个 registry）；
// ② 审计夹具用本地 HTTP 服务器当 registry，不必真的连公网。
// 环境变量优先，便于夹具在进程启动前就定好；设置里改了下次检查生效。
const NPM_REGISTRY_ENV = 'DSH_CONFIG_SYNC_NPM_REGISTRY'
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'

function effectiveNpmRegistry(settings = {}) {
  const fromSettings = String((settings && settings.updateRegistry) || '').trim()
  if (fromSettings) return fromSettings.replace(/\/+$/, '')
  const fromEnv = String(process.env[NPM_REGISTRY_ENV] || '').trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  return DEFAULT_NPM_REGISTRY
}

function npmUrls(registry) {
  const base = String(registry || DEFAULT_NPM_REGISTRY).replace(/\/+$/, '')
  return {
    registry: base,
    distTags: `${base}/${NPM_PACKAGE_NAME}/-/package/${NPM_PACKAGE_NAME}/dist-tags`,
    versionDoc: (v) => `${base}/${NPM_PACKAGE_NAME}/${encodeURIComponent(v)}`,
    latestDoc: `${base}/${NPM_PACKAGE_NAME}/latest`,
    tarball: (v) => `${base}/${NPM_PACKAGE_NAME}/-/${NPM_PACKAGE_NAME}-${v}.tgz`,
  }
}

const winEnvCache = new Map()
function clearWinEnvCache() { winEnvCache.clear() }

function parseEnvTokenRef(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  let m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(s)
  if (m) return m[1]
  m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(s)
  if (m) return m[1]
  m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/i.exec(s)
  if (m) return m[1]
  return ''
}

function readWinEnvVar(name) {
  if (!IS_WIN || !name) return ''
  const now = Date.now()
  const hit = winEnvCache.get(name)
  if (hit && now - hit.at < 15000) return hit.value
  let val = ''
  const regPaths = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']
  for (const regPath of regPaths) {
    try {
      const out = execFileSync('reg.exe', ['query', regPath, '/v', name], { windowsHide: true, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] })
      const lines = String(out || '').split(/\r?\n/)
      for (const line of lines) {
        const m = line.match(/^\s*\S+\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i)
        if (m && m[1].trim()) { val = m[1].trim(); break }
      }
      if (val) break
    } catch { }
  }
  winEnvCache.set(name, { value: val, at: now })
  return val
}

function getEnvValue(name) {
  const key = String(name || '').trim()
  if (!key) return ''
  const fromProc = String(process.env[key] || '').trim()
  if (fromProc) return fromProc
  return readWinEnvVar(key)
}

function resolveTokenSpec(spec, fallbackNames = GH_TOKEN_ENV_CANDIDATES) {
  const raw = String(spec || '').trim()
  const envRef = parseEnvTokenRef(raw)
  if (envRef) {
    return { token: getEnvValue(envRef), source: 'env', envName: envRef, rawRef: true }
  }
  if (raw) {
    return { token: raw, source: 'file', envName: '', rawRef: false }
  }
  for (const name of (fallbackNames || [])) {
    const v = getEnvValue(name)
    if (v) return { token: v, source: 'env', envName: name, rawRef: false }
  }
  return { token: '', source: 'none', envName: '', rawRef: false }
}

/**
 * 定位客户端根目录（AppRoot）。
 * 首选 config.appRoot；其次由插件自身位置反推（插件被 apply 部署在 <AppRoot>\dsh-profile-config-sync-<ver>\，
 * 上一级就是 AppRoot，换机不用改配置）；都对不上时按常见安装位置探测。
 * 判据：解包版有 resources\app\package.json，打包版有 resources\app.asar —— 只看目录名会让装错位置的情况蒙混过去，
 * 只认解包版又会让 asar 构建的机器全部落空（那台会把"插件所在目录"当成客户端根）。
 */
function isAppRoot(path) {
  return pfIsAppRoot(path)
}

/** 宿主自带 bundle 的落点：解包版 resources\app\dsh\node_modules，打包版 resources\app.asar.unpacked\dsh\node_modules。
 *  0.4.0：macOS 上 resources 在 <AppRoot>/Contents/Resources，统一交给 platform.mjs 算。 */
function hostDshNodeModules(appRoot) {
  return platformHostDshNodeModules(appRoot)
}

/**
 * 注册表里的 InstallLocation 最权威：客户端被卸载重装到别的盘时，只有它立刻指向新位置。
 *
 * 0.4.0：**只有 Windows 有注册表**。非 Windows 上直接返回空，
 * 交给按位置探测（platform.mjs 的 appRootCandidates）。
 */
let registryAppRootCache = null
let registryAppRootLoaded = false
function readRegistryAppRoot() {
  if (registryAppRootLoaded) return registryAppRootCache
  registryAppRootLoaded = true
  registryAppRootCache = null
  if (!IS_WIN) return null
  try {
    const script = "$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');" +
      "Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.DisplayName -like '*DeepSeek Harness*' -and $_.InstallLocation } | " +
      "Select-Object -First 1 -ExpandProperty InstallLocation"
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000, encoding: 'utf8' })
    const value = String(out || '').trim().replace(/[\\/]+$/, '')
    if (value && (pfIsFile(join(value, 'resources', 'app.asar')) || pfIsFile(join(value, 'resources', 'app', 'package.json')))) {
      registryAppRootCache = value
    }
  } catch { /* 读不到就退回按位置探测 */ }
  return registryAppRootCache
}

/**
 * 定位客户端根（AppRoot）。
 *
 * 0.4.0：候选顺序交给 platform.mjs —— Windows 用注册表 + LOCALAPPDATA + 盘符扫描，
 * macOS 用 /Applications/*.app 与 ~/Applications，Linux 用 /opt 与 ~/Applications。
 * 插件自身位置（`<AppRoot>/...`）仍然排在最前，因为那是最可靠的信号。
 */
function resolveAppRoot(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  try { candidates.push(dirname(dirname(fileURLToPath(import.meta.url)))) } catch { /* 忽略 */ }
  const fromRegistry = readRegistryAppRoot()
  if (fromRegistry) candidates.push(fromRegistry)
  for (const c of appRootCandidates()) candidates.push(c)
  for (const c of candidates) {
    if (pfIsAppRoot(c)) return c
  }
  // 用户可能把 appRoot 填成 .app 内部路径（/Applications/X.app/Contents/Resources）。
  // 第二轮把候选归一成「客户端根」再判一次，别让一个多余的后缀把整块功能锁死。
  for (const c of candidates) {
    const n = normalizeAppRoot(c)
    if (n && n !== c && pfIsAppRoot(n)) return n
  }
  // 一个都认不出就返回空，让上层明确报错；绝不把插件自己所在的那一级当成客户端根。
  return ''
}

/**
 * 读客户端 app 版本：解包版直接读 resources\app\package.json；打包版从 app.asar 里取 dsh\package.json。
 * 读不到返回 null（调用方只告警，不阻断）。
 *
 * 0.4.0：resources 目录随平台不同（macOS 在 <AppRoot>/Contents/Resources），
 * 统一用 platform.mjs 的 appRootLayout 算，不在本函数里写平台分支。
 */
function readAppMeta(appRoot) {
  if (!appRoot) return null
  const layout = appRootLayout(appRoot)
  const res = layout.resources || join(appRoot, 'resources')
  const plain = readJson(join(res, 'app', 'package.json'))
  if (plain) return plain
  // 打包版：优先交给平台层按 asar 头解析（macOS 的 asar 在 Contents/Resources 下，
  // 路径由 asarPath 统一算，不再各处硬拼 <root>/resources）
  const viaPlatform = platformReadAppVersion(appRoot)
  if (viaPlatform) return { version: viaPlatform }
  const asar = asarPath(appRoot)
  const viaMount = readJson(join(asar, 'dsh', 'package.json'))
  if (viaMount) return viaMount
  if (!asar || !pfIsFile(asar)) return null
  try {
    const fd = openSync(asar, 'r')
    try {
      const head = Buffer.alloc(16)
      readSync(fd, head, 0, 16, 0)
      const headerSize = head.readUInt32LE(4)
      const jsonLen = head.readUInt32LE(12)
      if (jsonLen < 2 || jsonLen > 64 * 1024 * 1024) return null
      const json = Buffer.alloc(jsonLen)
      readSync(fd, json, 0, jsonLen, 16)
      const header = JSON.parse(json.toString('utf8'))
      const entry = header?.files?.dsh?.files?.['package.json'] || header?.files?.['package.json']
      if (!entry || entry.size == null || entry.offset == null) return null
      const body = Buffer.alloc(Number(entry.size))
      readSync(fd, body, 0, Number(entry.size), 8 + headerSize + Number(entry.offset))
      return JSON.parse(body.toString('utf8'))
    } finally { closeSync(fd) }
  } catch { return null }
}

/** 读 JSON；失败返回 null，绝不抛。 */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function readText(path) {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

/**
 * 本机同步设置（仓库路径 + 远端地址 + SSH 私钥路径）。
 * 只存路径不存密钥内容；文件跟着本机走、不进仓库，所以换机重填一次即可。
 */
function settingsPath(dshHome) {
  return join(dshHome, SETTINGS_NAME)
}

function readSettings(dshHome) {
  const raw = readJson(settingsPath(dshHome)) || {}
  return {
    repoPath: typeof raw.repoPath === 'string' ? raw.repoPath : '',
    remoteUrl: typeof raw.remoteUrl === 'string' ? raw.remoteUrl : '',
    sshKey: typeof raw.sshKey === 'string' ? raw.sshKey : '',
    // 两个自动化开关，默认关：不打开就完全保持原来的手动流程
    autoPull: raw.autoPull === true,
    autoPush: raw.autoPush === true,
    autoRestart: raw.autoRestart !== false,
    // 更新清单地址（留空用内置默认）；换镜像/自建仓库或本地测试时才会填
    updateManifestUrl: typeof raw.updateManifestUrl === 'string' ? raw.updateManifestUrl : '',
    // 仓库是私有库时，读清单/下包都要带只读令牌（Gitee 私人令牌）；留空就按匿名 raw 读
    updateToken: typeof raw.updateToken === 'string' ? raw.updateToken : '',
    // 备份快照放哪：留空 = 默认 <DshHome>\backups（apply.ps1 每次跑之前都往那儿打一份）
    backupRoot: typeof raw.backupRoot === 'string' ? raw.backupRoot : '',
    // 同步完成重启前把 DSH 的「默认工作区」校正到谁：
    // 留空 = 自动找名字/路径是 default-workspace 的工作区；可填工作区路径或 ID；填 off 关闭。
    defaultWorkspace: typeof raw.defaultWorkspace === 'string' ? raw.defaultWorkspace : '',
    // 0.3.76：会话投影缓存守卫，默认开。关掉后既不定时扫描，也不理会客户端的 agent-busy 上报。
    cacheGuard: raw.cacheGuard !== false,
    // 0.4.0：WebDAV 同步。syncMode 决定走哪条路：
    //   git（默认，向后兼容）/ webdav / auto（有 webdav 配置就用，否则 git）
    syncMode: raw.syncMode === 'webdav' || raw.syncMode === 'auto' ? raw.syncMode : 'git',
    webdavUrl: typeof raw.webdavUrl === 'string' ? raw.webdavUrl : '',
    webdavUser: typeof raw.webdavUser === 'string' ? raw.webdavUser : '',
    // 密码只存本机、不进仓库；面板不回显明文，只显示「已设置」
    webdavPass: typeof raw.webdavPass === 'string' ? raw.webdavPass : '',
    // WebDAV 上存放同步包的目录（相对根，默认 dsh-config-sync）
    webdavDir: typeof raw.webdavDir === 'string' ? raw.webdavDir : '',
    // 0.6.48：自定义 User-Agent。部分第三方 WebDAV 按 UA 放行/拦截，默认 undici UA 会被拒。
    // 留空 = 不发 User-Agent 头（与 0.6.47 之前的行为一致）。
    webdavUserAgent: typeof raw.webdavUserAgent === 'string' ? raw.webdavUserAgent : '',
  }
}

/** 备份根：设置里填了就用填的，否则用默认 <DshHome>\backups。 */
function backupRootOf(dshHome, settings) {
  const custom = settings && typeof settings.backupRoot === 'string' ? settings.backupRoot.trim() : ''
  return custom || join(dshHome, 'backups')
}

function writeSettings(dshHome, s) {
  // 归一化已知字段，但**以传入对象为底**：面板只提交一个开关时，不能把没说到的
  // WebDAV 地址/账号/密码/模式（以及以后新增的键）连带清空 —— 那是数据丢失。
  const merged = { ...(s && typeof s === 'object' ? s : {}),
    repoPath: s.repoPath || '',
    remoteUrl: s.remoteUrl || '',
    sshKey: s.sshKey || '',
    autoPull: s.autoPull === true,
    autoPush: s.autoPush === true,
    autoRestart: s.autoRestart !== false,
    updateManifestUrl: s.updateManifestUrl || '',
    updateToken: s.updateToken || '',
    backupRoot: s.backupRoot || '',
    defaultWorkspace: s.defaultWorkspace || '',
    cacheGuard: s.cacheGuard !== false,
    // 0.4.0：WebDAV
    syncMode: s.syncMode === 'webdav' || s.syncMode === 'auto' ? s.syncMode : 'git',
    webdavUrl: s.webdavUrl || '',
    webdavUser: s.webdavUser || '',
    webdavPass: s.webdavPass || '',
    webdavDir: s.webdavDir || '',
    webdavUserAgent: s.webdavUserAgent || '',
  }
  const payload = JSON.stringify(merged, null, 2) + '\n'
  // 这份文件里有 WebDAV 密码与更新令牌：POSIX 上收紧到仅本人可读写（Windows 靠用户目录 ACL，0o600 是空操作）
  writeFileAtomicSync(settingsPath(dshHome), payload, { mode: 0o600 })
}

/** 没配过时给一个能用的默认私钥：优先 gitee 那把，其次通用 id_ed25519。 */
function defaultSshKey() {
  const dir = join(homedir(), '.ssh')
  for (const name of ['id_ed25519_gitee', 'id_ed25519', 'id_rsa']) {
    const p = join(dir, name)
    if (isFile(p)) return p
  }
  return ''
}

/**
 * ssh 可执行文件：生成脚本时用它们拼 GIT_SSH_COMMAND，免依赖 .ssh\config。
 *
 * 0.4.0：候选位置交给 platform.mjs —— Windows 上有 Git 自带 ssh 与系统 OpenSSH 两套，
 * 且用户级安装（LOCALAPPDATA）很常见；POSIX 直接信 PATH。
 * GIT_SSH_COMMAND 的第一个词必须是**真实可执行文件**，否则 git 会把整串当命令交给 sh，
 * 报 `invalid option` 并把问题伪装成「仓库读不到」。所以这里只返回 stat 得到的路径。
 */
function resolveSshExe() {
  return findSsh()
}

/** git 的 core.sshCommand 优先级最高：用户显式写的命令本身带 ssh 程序，直接照用。 */
function readSshCommandFromGitConfig(repo) {
  const files = [join(homedir(), '.gitconfig')]
  if (repo) files.push(join(repo, '.git', 'config'))
  for (const f of files) {
    try {
      if (!isFile(f)) continue
      const m = readFileSync(f, 'utf8').match(/^\s*sshCommand\s*=\s*(.+)$/mi)
      if (m && m[1].trim()) return m[1].trim()
    } catch { /* 忽略 */ }
  }
  return ''
}

function isDir(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

/**
 * 一个目录算不算 dsh-config 仓库：判据是同时有 profile/package.json 与
 * 一份执行体（Windows 的 apply.ps1，或跨平台的 sync-engine.mjs）。
 * （避免把同名目录认错）。status 用来看「能不能真的推送/拉取」。
 *
 * 0.4.0：不再只认 apply.ps1 —— macOS/Linux 上仓库里是 sync-engine.mjs，
 * 只认 .ps1 会让非 Windows 机器永远判「不像仓库」，面板不给按钮。
 */
function isRepoDir(dir) {
  if (!dir || !isFile(join(dir, 'profile', 'package.json'))) return false
  return isFile(join(dir, 'apply.ps1')) || isFile(join(dir, 'sync-engine.mjs'))
}

/**
 * 仓库里有没有「能跑的执行体」。
 * Windows：sync.ps1（PowerShell 主编排）；macOS/Linux：sync-engine.mjs（Node 引擎）。
 * 与 isRepoDir 分开：isRepoDir 判「是不是仓库」，这里判「能不能动手」。
 */
function hasRunner(dir) {
  if (!dir) return false
  return IS_WIN ? isFile(join(dir, 'sync.ps1')) : isFile(join(dir, 'sync-engine.mjs'))
}

/**
 * 定位 dsh-config 仓库，并说清这个路径是怎么来的（设置文件 → 插件配置 → 自动探测）。
 * 设置文件优先：用户可以在面板里改，不该被 cordis.patch.yml 里的旧值锁死。
 */
function resolveRepo(explicit, dshHome) {
  const settingsRepo = dshHome ? readSettings(dshHome).repoPath : ''
  const tried = []
  const pick = (value, source) => {
    if (!value) return null
    tried.push(`${source}:${value}`)
    // 空目录也是有效答案：新机器先把路径填好、等首次拉取，这时不该被自动探测到的另一个仓库顶掉
    const phase = repoPhase(value)
    return (phase === 'ok' || phase === 'empty') ? { repo: value, source } : null
  }
  // 设置里的路径是用户在面板里亲手填的：填了但已失效（目录被移走/改名）就原样报回去，
  // 让面板停在"未配置"强制他重设，而不是静默换成自动探测到的另一个仓库。
  if (settingsRepo && !isRepoDir(settingsRepo)) {
    return { repo: settingsRepo, source: 'settings', tried }
  }
  for (const hit of [
    pick(settingsRepo, 'settings'),
    pick(explicit, 'config'),
    (() => {
      const env = process.env.DSH_CONFIG_REPO || ''
      return env ? pick(env, 'env') : null
    })(),
  ]) {
    if (hit) return hit
  }

  const home = homedir()
  // 0.6.49：自动探测的候选随平台走 —— 原来前三个是 Windows 盘符（D:/G:/C:），
  // macOS 上等于扫了三个永远不存在的位置；现在 Windows 保原样，POSIX 只探自己语义下的路径。
  const guesses = IS_WIN
    ? ['D:\\dsh-config', 'G:\\dsh-config', 'C:\\dsh-config', join(home, 'dsh-config')]
    : [defaultRepoPath(), join(home, 'Documents', 'dsh-config'), join(home, 'dsh-config')]
  for (const c of guesses) {
    if (isRepoDir(c)) {
      tried.push(`自动探测:${c}`)
      return { repo: c, source: 'auto' }
    }
  }
  // 都没命中：把「用户填过但不对」的那个原样带回去，面板才能显示他填了什么、错在哪。
  return { repo: settingsRepo || '', source: settingsRepo ? 'settings' : (explicit ? 'config' : 'none'), tried }
}

/**
 * git 可执行文件的位置。
 *
 * Electron 主进程的 PATH 往往不含 Git（用户双击启动时继承的环境很干净），
 * 裸 'git' 会 ENOENT，体检就只剩一堆 null。所以按常见安装位置先探测一遍。
 *
 * 0.4.0：候选位置交给 platform.mjs —— Windows 探 Git for Windows 的系统级/用户级安装，
 * POSIX 探 /usr/bin、/opt/homebrew/bin 等；显式环境变量 DSH_SYNC_GIT 仍然优先。
 */
let gitExeCache = null
function resolveGitExe() {
  if (gitExeCache !== null) return gitExeCache
  if (process.env.DSH_SYNC_GIT) {
    gitExeCache = process.env.DSH_SYNC_GIT
    return gitExeCache
  }
  gitExeCache = findGit() || 'git'
  return gitExeCache
}

/** 跑 git，拿标准输出；找不到 git 或失败返回 null。 */
function git(repo, args) {
  return new Promise((resolve) => {
    execFile(resolveGitExe(), ['-C', repo, ...args], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim())
    })
  })
}

/**
 * 云端仓库到底有没有「可拉的内容」。
 * 之前只看分支数（ls-remote --heads），结果踩了个大坑：远端 main 还在、树却被删空了，
 * 分支数=1 → 判「有内容，只许拉取」，可拉下来是个空目录，状态永远停在 await-pull，
 * 初始化推送的入口也永远不出现，人就被卡死。所以真正的判据是「分支指向的树里有没有文件」。
 *
 * 分两步，省网络：
 *   1) ls-remote --heads 数分支 —— 0 个分支直接就是空仓库，不用再 fetch 了；
 *   2) 有分支才探树：临时 bare 仓库 fetch --depth 1（优先 --filter=blob:none 只取树对象，
 *      远端不支持就退回普通浅取），再 ls-tree 数文件。探测完删掉临时目录，不碰用户仓库。
 * 返回 { heads, files }：files===null 表示判不了（离线/认证失败/超时），调用方按保守处理。
 */
const remoteProbeCache = new Map()
// 缓存放长到 5 分钟：探测是打一次真实的 ls-remote（+ 可能一次 fetch），不该每分钟都来一遍。
// 云端真变了也不怕：写操作（推送/拉取）都会自己取最新状态，这个值只用于面板上的「云端有没有内容」。
const REMOTE_PROBE_TTL = 300000

function gitProbeEnv(settings) {
  const key = (settings && settings.sshKey) || defaultSshKey()
  const hasKey = Boolean(key) && isFile(key)
  const coreSsh = readSshCommandFromGitConfig('')
  const sshExe = coreSsh ? '' : resolveSshExe()
  const env = { ...process.env }
  if (hasKey && coreSsh) env.GIT_SSH_COMMAND = coreSsh
  else if (hasKey && sshExe) env.GIT_SSH_COMMAND = `"${sshExe}" -i "${key}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new`
  return env
}

/** 跑一次 git，返回 { ok, out }；失败不抛。 */
function runGit(args, env, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(resolveGitExe(), args, { windowsHide: true, timeout, env }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '') })
    })
  })
}

function lsRemoteHeads(url, settings) {
  return probeRemote(url, settings).then((p) => (p ? p.heads : null))
}

/** 临时 bare 仓库里数一次远端某个分支的文件数；失败返回 null。 */
async function remoteFileCount(url, settings, quiet) {
  const env = gitProbeEnv(settings)
  let dir = ''
  try {
    dir = mkdtempSync(join(tmpdir(), 'dcs-probe-'))
    if (!(await runGit(['init', '--bare', '--quiet', dir], env, 15000)).ok) return null
    // 只取树对象；远端不认 partial clone 时退回普通浅取
    let fetched = await runGit(['-C', dir, 'fetch', '--depth', '1', '--no-tags', '--filter=blob:none', url, 'HEAD'], env, 45000)
    if (!fetched.ok) fetched = await runGit(['-C', dir, 'fetch', '--depth', '1', '--no-tags', url, 'HEAD'], env, 45000)
    if (!fetched.ok) return null
    const tree = await runGit(['-C', dir, 'ls-tree', '-r', '--name-only', 'FETCH_HEAD'], env, 15000)
    if (!tree.ok) return null
    const files = tree.out.split('\n').filter((line) => line.trim()).length
    return files
  } catch {
    return null
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { } }
  }
}

async function probeRemote(url, settings) {
  if (!url) return null
  const hit = remoteProbeCache.get(url)
  if (hit && Date.now() - hit.at < REMOTE_PROBE_TTL) return hit.value
  // 先数分支（便宜），0 个分支就不用 fetch 了
  const headsEnv = gitProbeEnv(settings)
  const heads = await new Promise((resolve) => {
    execFile(resolveGitExe(), ['ls-remote', '--heads', url], { windowsHide: true, timeout: 15000, env: headsEnv }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').split('\n').filter((line) => line.includes('refs/heads/')).length)
    })
  })
  let value = null
  if (heads === null) value = { heads: null, files: null }
  else if (heads === 0) value = { heads: 0, files: 0 }
  else value = { heads, files: await remoteFileCount(url, settings, 'quiet') }
  remoteProbeCache.set(url, { at: Date.now(), value })
  return value
}

async function probeWebdavRemote(settings) {
  const w = normalizeWebdav(settings)
  if (!w.enabled) return null
  const key = `webdav:${w.url}/${w.dir}`
  const hit = remoteProbeCache.get(key)
  if (hit && Date.now() - hit.at < REMOTE_PROBE_TTL) return hit.value
  let value = { heads: null, files: null }
  try {
    const res = await testConnection(w)
    if (res && res.ok) {
      value = (!res.exists || res.files === 0)
        ? { heads: 0, files: 0, transport: 'webdav' }
        : { heads: 1, files: res.files, transport: 'webdav' }
    } else {
      value = { heads: null, files: null, transport: 'webdav', error: (res && res.error) || '' }
    }
  } catch {
    value = { heads: null, files: null, transport: 'webdav' }
  }
  remoteProbeCache.set(key, { at: Date.now(), value })
  return value
}

function clearWebdavProbeCache() {
  for (const k of remoteProbeCache.keys()) {
    if (String(k).startsWith('webdav:')) remoteProbeCache.delete(k)
  }
}

/** 只读缓存，不触发任何网络动作。 */
function probeRemoteCached(url) {
  const hit = remoteProbeCache.get(url)
  return hit && Date.now() - hit.at < REMOTE_PROBE_TTL ? hit.value : null
}

/**
 * 启动预热：插件装载后先探一次云端（只在本机仓库还没就位时才值得探）。
 * 失败无所谓——probeRemote 自身全兜底，探不到就缓存 null，面板照常工作。
 */
function warmRemoteProbe(config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const settings = readSettings(dshHome)
  const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
  if (repo && repoPhase(repo) === 'ok') return
  if (webdavActive(settings)) {
    probeWebdavRemote(settings).catch(() => { })
    return
  }
  const url = settings.remoteUrl || ''
  if (!url) return
  probeRemote(url, settings).catch(() => { })
}

/**
 * 给 status 用的「带预算的探测」：缓存命中立刻返回；没命中就让探测在后台跑，
 * 自己最多等 budgetMs —— 超时先返回「判不了」（heads/files 都是 null）。
 *
 * 为什么要有预算：Gitee 上 ls-remote 实测 2.5 秒，原样 await 会让整次 status 到
 * 11 秒（还有备份统计的 7.7 秒），前端那一次 fetch 就很容易被宿主/浏览器掐掉，
 * 表现成「几率性读取失败」。这里把等待压到一个可接受的常数，探测本身继续跑，
 * 下次刷新（或后台预热）就能读到真值。
 */
function probeRemoteQuick(url, settings, budgetMs) {
  const useWebdav = webdavActive(settings)
  if (!url && !useWebdav) return Promise.resolve(null)
  const w = useWebdav ? normalizeWebdav(settings) : null
  const cacheKey = useWebdav ? `webdav:${w.url}/${w.dir}` : url
  const cached = probeRemoteCached(cacheKey)
  if (cached) return Promise.resolve(cached)
  const unknown = { heads: null, files: null }
  const running = useWebdav ? probeWebdavRemote(settings) : probeRemote(url, settings)
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(probeRemoteCached(cacheKey) || unknown)
    }, budgetMs)
    if (typeof timer.unref === 'function') timer.unref()
    running.then((value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value || unknown)
    }, () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(unknown)
    })
  })
}

function readBundles(profileDir) {
  const pkg = readJson(join(profileDir, 'package.json'))
  return {
    bundles: Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [],
    deps: Object.keys(pkg?.dependencies || {}),
  }
}

/**
 * 打包版客户端把宿主 bundle 塞在 app.asar 里（dsh/node_modules/<pkg>），磁盘上没有目录。
 * 只查路径会把 asar 版的 20 多个自带 bundle 全判成「缺失」，进而误删实验性 bundle —— 所以读包内包名。
 * 读不到（没 node 运行环境/头损坏）返回 null，调用方当作「判不了」，不要报缺失。
 */
let asarNamesCache = new Map()
function asarBundleNames(appRoot) {
  if (!appRoot) return null
  const asar = asarPath(appRoot)
  if (!asar) return null
  if (asarNamesCache.has(asar)) return asarNamesCache.get(asar)
  let names = null
  try {
    if (isFile(asar)) {
      const fd = openSync(asar, 'r')
      try {
        const head = Buffer.alloc(16)
        readSync(fd, head, 0, 16, 0)
        const jsonLen = head.readUInt32LE(12)
        const json = Buffer.alloc(jsonLen)
        readSync(fd, json, 0, jsonLen, 16)
        const header = JSON.parse(json.toString('utf8'))
        const root = header?.files?.dsh?.files?.node_modules || header?.files?.node_modules
        names = []
        const walk = (node, prefix, depth) => {
          if (!node || !node.files || depth > 2) return
          for (const [k, v] of Object.entries(node.files)) {
            const name = prefix ? `${prefix}/${k}` : k
            if (v && v.files) { names.push(name); walk(v, name, depth + 1) }
          }
        }
        walk(root, '', 1)
      } finally { closeSync(fd) }
    }
  } catch { names = null }
  asarNamesCache.set(asar, names)
  return names
}

/** bundle 解析顺序与 DSH 一致：profile\node_modules 优先，再宿主的 node_modules（解包版路径 / asar 包内）。 */
function unresolvedBundles(bundles, profileDir, appRoot) {
  const searchRoots = [join(profileDir, 'node_modules'), ...hostDshNodeModules(appRoot)]
  const inAsar = asarBundleNames(appRoot)
  const missing = []
  for (const b of bundles) {
    const rel = String(b).replace(/\//g, '\\')
    let found = false
    for (const root of searchRoots) {
      if (isFile(join(root, rel, 'package.json'))) { found = true; break }
    }
    if (!found && inAsar) found = inAsar.includes(String(b))
    // 包内清单读不到时（inAsar === null）按「判不了」放过，绝不误报缺失
    if (!found && inAsar !== null) missing.push(b)
  }
  return missing
}

function missingDeps(deps, profileDir) {
  return deps.filter((d) => !isDir(join(profileDir, 'node_modules', String(d).replace(/\//g, '\\'))))
}

/**
 * 读快照根上的 package.json（没有或读不动就 null）。
 * 不用 isFile 单独判：Windows 上目录同名也会让 isFile 真，读一次最省事也最准。
 */
function readSnapshotPkg(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { return null }
}

/**
 * 一份备份快照到底是「哪一类备份」。
 *
 * 备份根 ~\.dsh\backups 是**多用途共用**的，不只是配置快照：
 *   profile  apply / restore 打的整份配置快照     顶层 package.json，name = dsh-profile-<名字>，带 dependencies
 *   plugin   插件自更新前打的插件本体备份          顶层 package.json，name = dsh-profile-config-sync（带 dsh 字段），
 *                                                  或只有一个 dsh-profile-config-sync-<ver>\ 子目录（半截残留）
 *   session  修会话前的会话目录备份                顶层全是 --<路径编码>-- 目录
 *   other    冲突对照 / 手工拷来的 / 认不出来的     只给手动还原指引
 *
 * 为什么不能只看「有没有 package.json」：插件包自己也带 package.json，
 * 按那个判据会把插件备份当成配置快照，还原时把插件的 package.json 写进 profile，依赖清单直接丢。
 */
function classifySnapshot(name, dir) {
  const pkg = readSnapshotPkg(dir)
  const pkgName = String((pkg && pkg.name) || '')
  // profile 优先：profile 的 package.json 里**也有** dsh 字段（dsh.profile.bundles），
  // 拿 dsh 判插件会把整份配置快照误判成插件备份 —— 实测 config-* / manual-* 全部中招。
  if (pkg && (/^dsh-profile-/i.test(pkgName) || (pkg.dsh && pkg.dsh.profile))) return 'profile'
  if (pkg && pkgName === PACKAGE_ID) return 'plugin'
  if (pkg && pkg.dependencies) return 'profile'
  if (pkg && pkg.dsh) return 'plugin'
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return 'other' }
  if (entries.length) {
    // 会话目录在 sessions 下是 --<路径编码>--，原样被拷进快照
    if (entries.every((e) => e.isDirectory() && /^--.*--$/.test(e.name))) return 'session'
    if (entries.some((e) => e.isFile() && e.name === 'client.js') || entries.some((e) => e.isDirectory() && e.name === 'runtime')) return 'plugin'
    if (entries.length === 1 && entries[0].isDirectory() && /^dsh-config-sync/i.test(entries[0].name)) return 'plugin'
  }
  // 名字兜底：目录名本身就是产出来源（空目录 / 半截残留也认得出是哪类）
  if (/^plugin-/i.test(name)) return 'plugin'
  if (/^session/i.test(name)) return 'session'
  if (/^config-|^manual-/i.test(name)) return 'profile'
  return 'other'
}

/**
 * 还原会用到的快照。规则与 restore.ps1 保持一致：不加 -BackupDir 时取
 * 「备份根」下按修改时间最新的一份；备份根默认 <DshHome>\backups，可在面板里改。
 * 返回的不只是"最新一份"：面板要列出所有快照让人挑，所以带上全量列表（最多 60 份）。
 */
function inspectBackup(dshHome, rootOverride) {
  const root = rootOverride || join(dshHome, 'backups')
  const defaultRoot = join(dshHome, 'backups')
  const empty = { root, defaultRoot, custom: root !== defaultRoot, exists: false, latest: '', latestAt: null, count: 0, latestFiles: 0, candidates: [], snapshots: [] }
  let names = []
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return empty }
  const all = []
  for (const name of names) {
    const dir = join(root, name)
    try {
      const st = statSync(dir)
      // 体积/文件数**不在这里统计**：每个快照都是一份完整的 profile（几千个文件），
      // 92 份快照 = 4.8 万个文件，逐个 statSync 要 7.7 秒 —— 而 status 每次刷新都会走这里。
      // 列表只给「名字 + 时间 + 插件数 + 能不能还原」，体积交给资源管理器。
      let plugins = 0
      let bundles = 0
      // 先分类，再决定怎么解析：只有 profile 快照的 package.json 才有「插件数」这层含义
      const kind = classifySnapshot(name, dir)
      const hasProfile = kind === 'profile' && isFile(join(dir, 'package.json'))
      if (hasProfile) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
          plugins = Object.keys(pkg?.dependencies || {}).length
          bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.length : 0
        } catch { }
      }
      // 非 profile 快照：顶层条目数就是「里面有几个东西」，面板上直接给个数（不递归，不拖慢刷新）
      let entries = null
      let entryNames = null
      if (!hasProfile) {
        try {
          const list = readdirSync(dir, { withFileTypes: true })
          entries = list.length
          entryNames = list.slice(0, 6).map((e) => e.name)
        } catch { }
      }
      // at 用整型毫秒：mtimeMs 是浮点，直接进 JSON 会变成 1795845400410.4312 这种小数，
      // 面板与读结果文件的地方都得再处理一次
      all.push({ name, dir, at: Math.round(st.mtimeMs), files: null, bytes: null, hasProfile, plugins, bundles, kind, entries, entryNames })
    } catch { }
  }
  all.sort((a, b) => b.at - a.at)
  if (!all.length) return { ...empty, exists: true }
  const usable = all.filter((x) => x.hasProfile)
  const latestPick = usable[0] || all[0]
  const shape = (x) => ({
    name: x.name,
    dir: x.dir,
    at: x.at,
    files: x.files,
    bytes: x.bytes,
    // usable = 能一键还原。
    //   profile：必须有 package.json（otherwise 那是空快照）
    //   plugin / session：里面得真有东西（空目录还原只会得到一个空动作）
    //   other：认不出类型 → 不给自动还原，面板改给「手动还原」指引
    usable: x.kind === 'profile' ? x.hasProfile : (x.kind === 'plugin' || x.kind === 'session') ? (Number(x.entries || 0) > 0) : false,
    kind: x.kind,
    entries: x.entries,
    entryNames: x.entryNames,
    plugins: x.plugins,
    bundles: x.bundles,
  })
  return {
    root,
    defaultRoot,
    custom: root !== defaultRoot,
    exists: true,
    latest: latestPick.dir,
    latestAt: latestPick.at,
    count: all.length,
    latestFiles: latestPick.files,
    candidates: all.slice(0, 8).map(shape),
    snapshots: all.slice(0, 60).map(shape),
  }
}

/**
 * 还原预览：算出「还原到这份快照会发生什么」，给面板的确认框用。
 *
 * 口径必须和 restore.ps1 -RollbackToPoint 完全一致，否则确认框会骗人：
 *   willWrite / willOverwrite = 快照里有、会被写回（内容不同才列入 overwrite）
 *   willRemove                = 当前 profile 有、快照没有 → 会被移进 manual\rollback\files
 *   pluginsRemove             = 当前依赖有、快照没有 → 会被撤走（链接删掉或实体目录移入 rollback）
 *   pluginsInstall            = 快照依赖有、当前没有 → 还原后由 pnpm install 装上
 */
function restorePreview(dshHome, snapshotDir, config) {
  const profileDir = join(dshHome, 'profiles', config?.profileName || 'desktop')
  const profileFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']
  const homeFiles = ['AGENTS.md', 'prompt-inject.md']

  const willWrite = []
  const willOverwrite = []
  const same = (a, b) => {
    try { return readFileSync(a, 'utf8') === readFileSync(b, 'utf8') } catch { return false }
  }
  for (const f of profileFiles) {
    const src = join(snapshotDir, f)
    if (!isFile(src)) continue
    const dst = join(profileDir, f)
    if (!isFile(dst)) { willWrite.push(f); continue }
    if (!same(src, dst)) willOverwrite.push(f)
  }
  for (const f of homeFiles) {
    const src = join(snapshotDir, f)
    if (!isFile(src)) continue
    const dst = join(dshHome, f)
    if (!isFile(dst)) { willWrite.push(f); continue }
    if (!same(src, dst)) willOverwrite.push(f)
  }
  const settingsDir = join(snapshotDir, 'settings')
  if (isDir(settingsDir)) {
    let names = []
    try { names = readdirSync(settingsDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) } catch { }
    for (const n of names) {
      const src = join(settingsDir, n)
      const dst = join(dshHome, n)
      if (!isFile(dst)) { willWrite.push(`settings/${n}`); continue }
      if (!same(src, dst)) willOverwrite.push(`settings/${n}`)
    }
  }

  // 会移走的文件：当前 profile 目录里有、快照里没有（node_modules 单独按插件算）
  const snapSet = new Set()
  const walk = (root, onFile) => {
    const stack = [root]
    while (stack.length) {
      const cur = stack.pop()
      let entries = []
      try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const p = join(cur, e.name)
        if (e.isDirectory()) stack.push(p)
        else onFile(p, relative(root, p))
      }
    }
  }
  walk(snapshotDir, (_full, rel) => snapSet.add(rel))
  const willRemove = []
  walk(profileDir, (full, rel) => {
    const normalized = rel.split('/').join('\\')
    if (normalized.toLowerCase().startsWith('node_modules\\')) return
    if (!snapSet.has(rel)) willRemove.push(normalized)
  })

  const readDeps = (p) => {
    try { return Object.keys(JSON.parse(readFileSync(p, 'utf8'))?.dependencies || {}) } catch { return null }
  }
  const snapDeps = readDeps(join(snapshotDir, 'package.json')) || []
  const curDeps = readDeps(join(profileDir, 'package.json'))
  const pluginsRemove = curDeps === null ? [] : curDeps.filter((d) => !snapDeps.includes(d))
  const pluginsInstall = snapDeps.filter((d) => !(curDeps || []).includes(d))

  const CAP = 300
  return {
    snapshot: snapshotDir,
    willWrite: willWrite.slice(0, CAP),
    willOverwrite: willOverwrite.slice(0, CAP),
    willRemove: willRemove.slice(0, CAP),
    pluginsRemove,
    pluginsInstall,
    truncated: (willWrite.length + willOverwrite.length + willRemove.length) > CAP,
  }
}

/**
 * 插件备份 / 会话备份的还原预览。
 *
 * 这两类不是「回到某个时间点的 profile」，所以不复用 restorePreview 的差异口径：
 *   plugin   把快照里的插件文件写回当前插件安装目录（先整份备份当前插件）
 *   session  把快照里的 --<路径编码>-- 会话目录写回 ~\.dsh\sessions（先备份当前同名目录）
 * 面板只需要「写到哪、写几个东西、先备份到哪」，不要给一堆 willRemove 让人误以为是时点回退。
 */
function restorePreviewForKind(snap, dshHome) {
  const kind = snap.kind
  if (kind === 'plugin') {
    // 半截备份会多一层 dsh-profile-config-sync-<ver>\：真正要写回的是里面的内容
    let srcRoot = snap.dir
    let entries = []
    try { entries = readdirSync(srcRoot, { withFileTypes: true }) } catch { }
    if (entries.length === 1 && entries[0].isDirectory() && /^dsh-config-sync/i.test(entries[0].name)) {
      srcRoot = join(srcRoot, entries[0].name)
      try { entries = readdirSync(srcRoot, { withFileTypes: true }) } catch { entries = [] }
    }
    return {
      snapshot: snap.dir,
      kind: 'plugin',
      target: PLUGIN_ROOT,
      source: srcRoot,
      items: entries.slice(0, 40).map((e) => (e.isDirectory() ? e.name + '\\' : e.name)),
      total: entries.length,
      backupTo: join(dshHome, 'backups', `plugin-<当前版本>-<时间戳>`),
      note: t(
        '会把这份插件备份的文件写回当前插件安装目录，覆盖前先把当前插件整份备份成 plugin-<版本>-<时间戳>；还原后客户端重启才生效',
        'This plugin backup will be written back into the current plugin folder. The current plugin is copied to plugin-<version>-<timestamp> first; the client must restart to pick it up.',
      ),
    }
  }
  let dirs = []
  try { dirs = readdirSync(snap.dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { }
  return {
    snapshot: snap.dir,
    kind: 'session',
    target: join(dshHome, 'sessions'),
    items: dirs.slice(0, 40),
    total: dirs.length,
    backupTo: join(dshHome, 'backups', 'session-<时间戳>'),
    note: t(
      '会把这份备份里的会话目录写回 ~\\.dsh\\sessions，同名目录先整份备份成 session-<时间戳> 再覆盖；写回的是会话历史文件，不影响配置与插件',
      'These session folders will be written back into ~\\.dsh\\sessions. Any folder with the same name is copied to session-<timestamp> first. Only conversation history is touched — config and plugins are not.',
    ),
  }
}

/**
 * 校验「要还原哪一份快照」：存在、在备份根之下、能认出类型、按类型具备还原条件。
 * prepare（生成 cmd）、restore-preview、restore-now 共用，避免三处判断漂移。
 * 返回 { dir, kind }：kind = profile | plugin | session。
 */
function resolveSnapshotDir(dshHome, backupDirRaw) {
  const backupDir = String(backupDirRaw || '').trim()
  if (!backupDir) throw new Error(t('没有指定要还原的备份目录', 'No backup directory was given'))
  if (/["\r\n]/.test(backupDir)) throw new Error(t('备份路径里不能含引号或换行', 'The backup path must not contain quotes or newlines'))
  if (!isDir(backupDir)) throw new Error(t(`备份目录不存在：${backupDir}`, `Backup directory does not exist: ${backupDir}`))
  const root = backupRootOf(dshHome, readSettings(dshHome))
  const rel = relative(root, backupDir)
  if (rel.startsWith('..') || rel === '' || isAbsolute(rel)) {
    throw new Error(t(`只能在备份根 ${root} 下选快照，不接受 ${backupDir}`, `Only snapshots under ${root} can be restored; refusing ${backupDir}`))
  }
  const kind = classifySnapshot(basename(backupDir), backupDir)
  if (kind === 'other') {
    throw new Error(t(
      `这份备份认不出是哪一类（不是配置快照、插件备份或会话备份），不能自动还原：${backupDir}`
      + '。请按面板「还原备份」里的手动还原指引，把里面的文件拷到对应位置',
      `Cannot tell what this backup is (not a config snapshot, plugin backup or session backup), so it cannot be restored automatically: ${backupDir}`
      + '. Follow the manual restore hint shown on the Restore card and copy the files into place yourself.',
    ))
  }
  if (kind === 'profile' && !isFile(join(backupDir, 'package.json'))) {
    throw new Error(t(
      `这份配置快照里没有 profile 文件（package.json），还原会失败：${backupDir}`,
      `This config snapshot has no profile files (package.json) and cannot be restored: ${backupDir}`,
    ))
  }
  return { dir: backupDir, kind }
}

/**
 * 本机仓库当前处在哪个阶段。面板上的「能不能推送 / 能不能拉取」全按它来判：
 *   ok       真仓库（有 .git 且是 dsh-config 结构）→ 推送、拉取都可以
 *   empty    目录在、但里面是空的（新机器刚建目录，或只有生成过的 同步-*.cmd）
 *            → 这是「等着从云端拉」的正常状态，不算异常；拉取会自动 init + fetch + checkout
 *   missing  目录不存在（路径写了但没建）
 *   unusable 目录在、但既不是空目录也不是仓库（多半填错路径了）
 */
function repoPhase(dir) {
  if (!dir) return 'missing'
  if (isRepoDir(dir)) return 'ok'
  if (!isDir(dir)) return 'missing'
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return 'unusable' }
  // 只有本插件自己生成的脚本、或隐藏项（.git 等）才算「空」：其余文件说明这目录本来就有别的东西。
  // 0.4.0：同时认 .cmd（Windows）与 .sh（macOS/Linux），否则在非 Windows 上
  // 生成过脚本的目录会被判成 unusable，面板就再也不给「拉取」按钮。
  const others = entries.filter((e) => !e.name.startsWith('.') && !/^同步-[\s\S]*\.(cmd|sh)$/i.test(e.name))
  return others.length === 0 ? 'empty' : 'unusable'
}

/**
 * 体检。全部只读，不写任何文件（除了 prepare 那次由用户显式触发的 cmd 生成）。
 */
async function inspect(config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const resolved = resolveRepo(config?.repoPath, dshHome)
  const repo = resolved.repo
  const appRoot = resolveAppRoot(config?.appRoot)
  const profileDir = join(dshHome, 'profiles', config?.profileName || 'desktop')

  const localApp = readAppMeta(appRoot)
  const localVersion = typeof localApp?.version === 'string' ? localApp.version : ''
  // 0.6.49：Electron 版本统一交给 platform.mjs（macOS 没有 <root>/version 文件，
  // 原来读出来永远是空串，面板那一格只剩 "app 0.2.2-rc.5 /"）
  const electronVersion = platformReadElectronVersion(appRoot) || readText(join(appRoot, 'version')).trim()
  const contract = readJson(join(repo, 'profile', 'host-contract.json'))
  const contractVersion = typeof contract?.appVersion === 'string' ? contract.appVersion : ''

  const { bundles, deps } = readBundles(profileDir)
  const unresolved = unresolvedBundles(bundles, profileDir, appRoot)
  const missing = missingDeps(deps, profileDir)

  const settings = readSettings(dshHome)
  const gitRemoteUrl = repo && isDir(join(repo, '.git')) ? await git(repo, ['remote', 'get-url', 'origin']) : null
  const sshKey = settings.sshKey || defaultSshKey()

  const gitStatus = repo && isDir(join(repo, '.git'))
    ? (await git(repo, ['status', '--porcelain'])) ?? null
    : null
  const head = repo ? await git(repo, ['log', '-1', '--pretty=%h %s']) : null
  const branch = repo ? await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) : null
  const counts = repo ? await git(repo, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']) : null
  let ahead = null
  let behind = null
  if (counts) {
    const parts = counts.split(/\s+/)
    ahead = Number(parts[0] ?? '')
    behind = Number(parts[1] ?? '')
    if (!Number.isFinite(ahead)) ahead = null
    if (!Number.isFinite(behind)) behind = null
  }

  const dirty = gitStatus === null ? null : gitStatus.split('\n').filter(Boolean).length
  const versionMatch = Boolean(localVersion && contractVersion && localVersion === contractVersion)
  // 本机数据（会话/资料）有没有比"上次同步"更新：git 干净也可能有新会话没 capture
  const syncState = readSyncState(dshHome)
  const local = localPending(dshHome, syncState.lastSyncAt, config?.profileName, { repo, appRoot })

  const advice = []
  // 本机仓库处在哪个阶段：空白目录 = 等首次拉取，是正常状态，不该报异常
  const phase = repoPhase(repo)
  // 云端有没有「可拉的内容」：只在本地仓库还没就位时才探（真仓库不需要每次刷面板都打一次网络）
  const useWebdav = webdavActive(settings)
  const remoteProbeUrl = useWebdav ? normalizeWebdav(settings).url : (gitRemoteUrl || settings.remoteUrl || '')
  const remoteProbe = (remoteProbeUrl && phase !== 'ok')
    ? await probeRemoteQuick(remoteProbeUrl, settings, 2500)
    : null
  const remoteHeads = remoteProbe ? remoteProbe.heads : null
  // 分支指向的树里有几个文件 —— 这才是「有没有内容」的真判据：分支还在但树被删空，等同空中空
  const remoteFiles = remoteProbe ? remoteProbe.files : null
  if (!appRoot) {
    advice.push(t(
      '定位不到客户端根目录：插件不在 <客户端根> 下（如 D:\\DeepSeekHarness\\dsh-profile-config-sync-0.3.67），'
      + '或客户端是打包版（resources\\app.asar）而这里没认出来 —— 三份同步脚本会因此生成不了',
      'Cannot locate the client root: the plugin is not under <client root> (e.g. D:\\DeepSeekHarness\\dsh-profile-config-sync-0.3.67), '
      + 'or this is a packaged build (resources\\app.asar) that was not recognized — the three sync scripts cannot be generated.',
    ))
  }
  if (!repo) {
    advice.push(t(
      '还没有配置仓库目录：请在下面「本机仓库」卡的「仓库路径」框里填好目录并点「保存」（已有仓库或新空目录均可）',
      'The repo directory is not set: enter the path in the Repo path box in the Local repo card below and click Save (an existing repo or new empty folder both work).',
    ))
  } else if (phase === 'empty' || phase === 'missing') {
    const where = phase === 'missing'
      ? t(`目录还不存在（${repo}）`, `the folder does not exist yet (${repo})`)
      : t(`还是空目录（${repo}）`, `is still an empty folder (${repo})`)
    if (remoteFiles === 0) {
      advice.push(t(
        useWebdav
          ? `本机仓库${where}，云端 WebDAV 也还没有任何内容：点「初始化推送」把本机配置作为初始内容传上去（自动抓配置并上传 WebDAV）`
          : `本机仓库${where}，云端仓库也还没有任何内容：点「初始化推送」把本机配置当作初始内容推上去（自动 git init + capture + 提交 + 推送）`,
        useWebdav
          ? `The local repo ${where} and WebDAV has nothing yet: use "Initialize push" to capture and upload this machine's config as the initial content.`
          : `The local repo ${where} and the cloud has nothing yet: use "Initialize push" to upload this machine's config as the initial content (git init + capture + commit + push).`,
      ))
    } else if (remoteFiles === null && (remoteHeads === 0 || remoteHeads === null)) {
      advice.push(t(
        `本机仓库${where}，云端连不上/判不了（离线或认证失败）：按老规矩先只允许拉取`,
        `The local repo ${where} and the cloud cannot be determined (offline or auth failure): only Pull is allowed, as before.`,
      ))
    } else if (remoteHeads !== null && remoteHeads > 0 && remoteFiles === 0) {
      advice.push(t(
        `云端仓库只有分支、里面一个文件都没有（历史被删空了）：点「初始化推送」可以把本机配置重新推成初始内容`,
        `The cloud repo has a branch but not a single file (its history was emptied): use "Initialize push" to upload this machine's config as the initial content again.`,
      ))
    } else {
      advice.push(t(
        useWebdav
          ? `本机仓库${where} —— 执行「拉取」会从 WebDAV 把配置拉到这里（首次拉取自动下载并还原，不需要推送）`
          : `本机仓库${where} —— 执行「拉取」会从云端把仓库内容拉到这里（首次拉取自动初始化，不需要推送）`,
        useWebdav
          ? `The local repo ${where} — running Pull downloads the repo from WebDAV into this folder (no push needed).`
          : `The local repo ${where} — running Pull brings the repo down from the cloud (the first pull initializes it; no push needed).`,
      ))
    }
  } else if (!isRepoDir(repo)) {
    advice.push(t(
      `这个目录既不是空目录、也不像 dsh-config 仓库（缺 profile\\package.json 或执行体 apply.ps1 / sync-engine.mjs）：${repo} —— 请在「本机仓库」卡里重新设路径`,
      `That folder is neither empty nor a dsh-config repo (no profile\\package.json or no runner apply.ps1 / sync-engine.mjs): ${repo} — set the path again in the Local repo card.`,
    ))
  } else if (!hasRunner(repo)) {
    // 0.4.0：Windows 看 sync.ps1，POSIX 看 sync-engine.mjs；缺了就明确说，不生成必然失败的脚本
    advice.push(t(
      `仓库目录里没有可执行的同步脚本（Windows 需 sync.ps1，macOS/Linux 需 sync-engine.mjs）：${repo}`,
      `The repo has no runnable sync script (sync.ps1 on Windows, sync-engine.mjs on macOS/Linux): ${repo}`,
    ))
  }
  // 0.4.0：WebDAV 模式下不需要 git 远端，所以这条只在 git 模式才提醒
  if (repo && !webdavActive(settings) && !(gitRemoteUrl || settings.remoteUrl)) {
    advice.push(t(
      '还没有配置云端仓库地址：推送/拉取生成不了，请在「云端仓库」卡里填远端地址并保存（或改用 WebDAV 同步方式）',
      'The cloud repo is not set: push/pull cannot be generated — fill in the remote URL in the Cloud repo card (or switch to WebDAV).',
    ))
  }
  if (!localVersion) {
    advice.push(t(
      `读不到客户端版本（${appRoot ? `${appRoot}\\resources\\app\\package.json 或 resources\\app.asar` : 'AppRoot 没定位到'}）`,
      `Cannot read the client version (${appRoot ? `${appRoot}\\resources\\app\\package.json or resources\\app.asar` : 'AppRoot not found'})`,
    ))
  }
  if (localVersion && contractVersion && !versionMatch) {
    advice.push(t(
      `两端客户端版本不同：本机 ${localVersion}，仓库契约 ${contractVersion}。先升级较旧那台，或 pull 时加 -AllowVersionDrift`,
      `The two clients differ: this machine ${localVersion}, repo contract ${contractVersion}. Upgrade the older one, or pass -AllowVersionDrift when pulling.`,
    ))
  }
  if (unresolved.length) {
    advice.push(t(
      `${unresolved.length} 个 bundle 在本机解析不到，启动会在 entry loading 崩溃：${unresolved.join(', ')}`,
      `${unresolved.length} bundle(s) cannot be resolved on this machine and will crash entry loading: ${unresolved.join(', ')}`,
    ))
  }
  if (missing.length) {
    advice.push(t(
      `${missing.length} 个依赖没装（pnpm install 没跑成）：${missing.join(', ')}`,
      `${missing.length} dependency(ies) missing (pnpm install did not finish): ${missing.join(', ')}`,
    ))
  }
  if (behind !== null && behind > 0) {
    advice.push(t(`仓库落后 ${behind} 个提交：退出 DSH 后执行「拉取」`, `The repo is ${behind} commit(s) behind: run Pull after DSH exits.`))
  }
  if (ahead !== null && ahead > 0) {
    advice.push(t(`仓库领先 ${ahead} 个提交（本机改过还没推）：退出 DSH 后执行「推送」`, `${ahead} local commit(s) not pushed yet: run Push after DSH exits.`))
  }
  if (dirty !== null && dirty > 0) {
    advice.push(t(`工作区有 ${dirty} 项未提交：退出 DSH 后跑「推送」会一并提交`, `${dirty} uncommitted change(s): running Push after DSH exits commits them too.`))
  }
  if (local.known && local.pending > 0) {
    // 文案按「实际参与同步的类别」说：取消勾选「会话记录」后还写「新会话/资料」，
    // 用户会以为取消勾选没生效（实测反馈）。这里只提真正会被推送的那些组，
    // 并且按条数从多到少点名最多三类——待推送现在覆盖 12 组，只写「配置类文件」
    // 会把「插件数据改了 3 个文件」说成配置变更，同样是错话。
    const ranked = (Array.isArray(local.groups) ? local.groups : [])
      .filter((g) => g && g.count > 0 && PENDING_GROUP_LABEL[g.id])
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
    const kindsZh = ranked.map((g) => PENDING_GROUP_LABEL[g.id][0]).join(' / ')
    const kindsEn = ranked.map((g) => PENDING_GROUP_LABEL[g.id][1]).join(' / ')
    advice.push(kindsZh
      ? t(
        `本机有 ${local.pending} 个文件在上次同步之后有更新（${kindsZh}${ranked.length < local.groups.length ? ' 等' : ''}），仓库里还没有：退出 DSH 后跑「推送」`,
        `${local.pending} file(s) changed since the last sync (${kindsEn}${ranked.length < (local.groups || []).length ? ' etc.' : ''}) and are not in the repo yet: run Push after DSH exits.`,
      )
      : t(
        `本机有 ${local.pending} 个文件在上次同步之后有更新，仓库里还没有：退出 DSH 后跑「推送」`,
        `${local.pending} file(s) changed since the last sync and are not in the repo yet: run Push after DSH exits.`,
      ))
  }
  if (!advice.length) {
    // 「一致」这句话只有在真的扫完、且真的没变化时才成立：
    // 从没同步过（known=false）与扫描被预算截断（truncated）都不等于「一致」。
    if (local && local.known === false) {
      advice.push(t('本机还没有同步记录：先推送一次，之后才知道哪些是新的', 'No sync record on this machine yet — push once, then the panel can tell what is new.'))
    } else if (local && local.truncated) {
      advice.push(t('待推送扫描没跑完（文件太多或超时），这次的数字可能偏小：可再刷新一次', 'The pending scan did not finish (too many files or a timeout); the count may be low — refresh again.'))
    } else if (local && Array.isArray(local.engineGroups)) {
      // 非 Windows：这句话只覆盖引擎真会同步的四组，不能写成「仓库与本机一致」
      advice.push(t(
        `这台机器走跨平台引擎，只同步 ${local.engineGroups.join(' / ')}，这几组与仓库一致（会话记录、插件数据、额外路径要 Windows 版才会同步）`,
        `This machine uses the cross-platform engine, which syncs only ${local.engineGroups.join(' / ')}; those groups match the repo (conversations, plugin data and extra paths sync on Windows).`,
      ))
    } else {
      advice.push(t('仓库与本机一致，没有待办', 'The repo matches this machine — nothing to do.'))
    }
  }

  return {
    ok: true,
    at: Date.now(),
    repo: {
      path: repo,
      // 有路径 ≠ 目录还在：路径被移走/改名时这里必须是 false，面板才会重新强制设置。
      exists: Boolean(repo) && isRepoDir(repo),
      // 空目录 = 等首次拉取（正常状态，不报异常）；pushAllowed/pullAllowed 就是按它算出来的门禁
      phase,
      empty: phase === 'empty',
      // 云端仓库的分支数：0=空仓库，null=没探成（离线/认证失败/真仓库时不探）
      remoteHeads,
      // 分支树里的文件数：0=有分支但内容为空（历史被删空也算），null=判不了
      remoteFiles,
      // 「云端有没有东西可拉」的真判据——不是分支数，是树里的文件数
      remoteEmpty: remoteFiles === 0,
      // 仓库三态，面板据此决定强调哪个按钮：
      //   ok         真仓库，推送/拉取都行
      //   await-pull 本机空、云端有内容 → 只允许拉取
      //   await-init 两边都空（含「云端只剩空分支」）→ 只允许推送，而且这次推送就是「初始化推送」
      mode: phase === 'ok'
        ? 'ok'
        : (remoteFiles === 0 ? 'await-init' : 'await-pull'),
      // 推送：真仓库，或「空目录 + 云端确实没文件」的首次推送（判不了时不放行，宁可按老规矩只拉）
      pushAllowed: phase === 'ok' || (phase === 'empty' && remoteFiles === 0),
      // 拉取：真仓库，或空目录/没建目录且云端确实有文件（sync.ps1 的 Initialize-RepoIfNeeded 会自动 init + fetch + checkout）
      pullAllowed: phase === 'ok' || ((phase === 'empty' || phase === 'missing') && remoteFiles !== 0),
      // 路径是怎么来的：settings=本机设置（面板可改）、config=插件配置、env=环境变量、auto=自动探测、none=没配
      source: resolved.source,
      configured: Boolean(settings.repoPath || config?.repoPath),
      tried: resolved.tried || [],
      branch: branch || '',
      head: head || '',
      dirty,
      ahead,
      behind,
      // 本机待同步（还没 capture 进仓库的会话/配置改动），与 git 工作树 dirty 是两件事。
      pending: (local && local.pending) || 0,
      // 面板上用户理解的「未提交」= git 工作树改动 + 本机还没同步的改动，反映「还没进云端的本机改动总数」。
      uncommitted: (dirty || 0) + ((local && local.pending) || 0),
    },
    version: { local: localVersion, contract: contractVersion, electron: electronVersion, match: versionMatch },
    // 本机数据侧：上次同步时间 + 「之后又写过多少文件」，与 repo.dirty 是两件事
    local: { ...syncState, ...local },
    bundles: { total: bundles.length, unresolved },
    deps: { total: deps.length, missing },
    advice,
    backup: inspectBackup(dshHome, backupRootOf(dshHome, settings)),
    remote: {
      url: gitRemoteUrl || settings.remoteUrl || '',
      urlSource: gitRemoteUrl ? 'git' : (settings.remoteUrl ? 'settings' : 'none'),
      // 配没配过云端仓库：推送/拉取都以它为前置，缺了面板就强制先设
      configured: Boolean(gitRemoteUrl || settings.remoteUrl),
      sshKey,
      sshKeyExists: Boolean(sshKey) && isFile(sshKey),
      sshKeyFrom: settings.sshKey ? 'settings' : (sshKey ? 'default' : 'none'),
      sshConfig: isFile(join(homedir(), '.ssh', 'config')),
      updateTokenSet: Boolean(resolveTokenSpec(settings.updateToken, settings.updateManifestUrl ? [] : GH_TOKEN_ENV_CANDIDATES).token),
      // 备份根：留空=默认。面板「还原备份」卡据此显示当前值并判断是否被改过
      backupRoot: backupRootOf(dshHome, settings),
      backupRootCustom: Boolean(settings.backupRoot),
      settingsPath: settingsPath(dshHome),
    },
    paths: { appRoot, dshHome, profileDir },
    // 「本机路径」区平时不在页面上出现（0.3.37）。面板靠这三个计数决定标题行按钮是不是该变橙色，
    // 所以计数必须在 status 里给出——不能等用户把那一区点开才知道有没有事。
    localPaths: (() => {
      const countItems = (doc, key) => {
        const list = doc && Array.isArray(doc[key]) ? doc[key] : []
        return list.length
      }
      const pendingDoc = readJson(pendingPathOf(dshHome)) || {}
      const absDoc = readJson(absolutePathsPathOf(dshHome)) || {}
      const ovDoc = readJson(overwritePathOf(dshHome)) || {}
      const pending = countItems(pendingDoc, 'missing')
      // 根外路径清单是「推送时」capture 写下来的：本机自己推的，本机这些路径当然都在，
      // 不该算告警。只有清单来自另一台机器（本机是接收方）时才是真问题，才计入告警数。
      const absMachine = String(absDoc.machine || '')
      const absFromOther = Boolean(absMachine) && Boolean(localMachineName()) && !sameMachine(absMachine, localMachineName())
      const absolute = absFromOther ? countItems(absDoc, 'items') : 0
      const overwrite = countItems(ovDoc, 'items')
      // 三类都算告警（0.3.40）：待确认路径、仓库里的根外绝对路径（限别的机器写的）、被覆盖的本机配置。
      // alert 与 total 目前同值，字段分开留着：面板只看 alert，以后要拆开也不用改前端。
      const total = pending + absolute + overwrite
      return { pending, absolute, overwrite, alert: total, total, absMachine, absFromOtherMachine: absFromOther }
    })(),
    auto: {
      pull: settings.autoPull === true,
      push: settings.autoPush === true,
      restart: settings.autoRestart !== false,
      checking: autoState.checking,
      lastCheckAt: autoState.lastCheckAt,
      lastCheckError: autoState.lastCheckError,
      drift: autoState.drift,
      pending: autoState.pending,
      // 0.6.49：后台自动拉取（启动时那条，没有请求也没有面板）在 macOS 上不再弹原生框，
      // 而是把这个提示挂出来，由面板的「立即拉取」接手 —— 否则对话框被窗口挡住就等于永不发生。
      pullPrompt: autoState.pullPrompt || null,
      watcherStartedAt: autoState.watcherStartedAt,
      script: autoScript(dshHome, repo),
      // post-exit.ps1 上次执行的结果（成功/失败/是否回滚），客户端启动后据此弹 5 秒提示
      lastResult: readAutoResult(dshHome),
      // 不关闭 DSH 的在线推送状态（running / finishedAt / ok / phase / message / log）
      livePush: { ...autoState.livePush },
    },
    // 拉取被本机文件挡住时 sync.ps1 留下的冲突清单，面板「同步冲突」卡据此渲染
    conflicts: (() => {
      const c = readConflicts(dshHome)
      if (!c) return { exists: false, total: 0, pending: 0, at: '', backupDir: '' }
      const pending = c.items.filter((it) => !it.choice).length
      return { exists: true, total: c.items.length, pending, at: c.at || '', backupDir: c.backupDir || '' }
    })(),
    // 0.3.76：会话投影缓存守卫状态（面板「会话缓存守卫」卡用）
    cacheGuard: cacheGuardSnapshot(config),
    // 0.4.0：跨端信息。面板据此显示「本机平台 / 仓库契约来自哪个平台 / 已登记哪些机器」。
    // 这里刻意不显示本机绝对路径的明文（那是本机私有），只给平台族与版本。
    platform: (() => {
      const contract = repo ? readContract(repo) : null
      const local = {
        os: OS,
        osLabel: platformLabel(),
        osFamily: platformFamily(),
        arch: (() => { try { return process.arch } catch { return '' } })(),
        dshVersion: localVersion,
        electronVersion,
        appRoot,
        clientExe: clientExecutable(appRoot),
        isWindows: IS_WIN,
        scriptKind: IS_WIN ? 'cmd' : 'sh',
      }
      const compat = contract
        ? checkContract(contract, { dshVersion: localVersion, os: OS })
        : { level: 'ok', reason: 'no-contract', crossPlatform: false }
      return {
        local,
        contract: contract ? {
          appVersion: contract.appVersion,
          platforms: contract.platforms || [],
          platformFamily: contract.platformFamily || '',
          os: contract.os || '',
          arch: contract.arch || '',
        } : null,
        compat,
        // 已登记的机器（仓库里 machines/*.json）：谁推过这份配置
        machines: repo ? listMachines(repo).slice(0, 20) : [],
      }
    })(),
    // 0.4.0：WebDAV 通道状态（面板「同步方式」卡用）。密码不回显，只给「是否已设置」。
    webdav: (() => {
      const w = normalizeWebdav(settings)
      return {
        mode: w.mode,
        active: webdavActive(settings),
        configured: Boolean(w.url),
        hasPassword: Boolean(w.pass),
        url: w.url,
        user: w.user,
        dir: w.dir,
        // 0.6.48：UA（留空 = 不发 User-Agent 头）
        userAgent: w.ua,
        secure: isSecureUrl(w.url),
      }
    })(),
  }
}

/** 只在 Host 本机、且来源可信时放行（防任意网页 POST 进来）。 */
function originAllowed(req) {
  const host = String(req.headers.host || '')
  const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') return false
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  if (origin === 'null') return hostLocal
  if (/^app:/i.test(String(origin))) return hostLocal
  try { return new URL(String(origin)).host === host } catch { return false }
}

/**
 * 准入判定：先问宿主 Connection 的围栏，只有在宿主没提供 connection 服务时才退回本地围栏。
 *
 * 为什么必须问宿主：`webServer.register` 只是裸 HTTP 载体，官方文档写明「The carrier owns no
 * authentication or Origin policy」——路由鉴权是组合层的责任。宿主为此提供了
 * `ctx.connection.requestRejection(request)`（Host/Origin 围栏 + 浏览器会话鉴权，返回
 * 401/403/undefined）与 `ctx.connection.admit(request)`。不接它，等于只靠自己写的
 * `originAllowed`：缺 Origin 头的请求（curl、非浏览器进程、部分沙箱 iframe 的 `null`）
 * 会被当成可信来源放行，本机上任何能发 HTTP 的东西都能读配置、触发推送/还原。
 *
 * @returns {0|401|403} 0 表示放行
 */
function admissionVerdict(ctx, req) {
  try {
    const conn = ctx && typeof ctx.get === 'function' ? ctx.get('connection', false) : null
    if (conn && typeof conn.requestRejection === 'function') {
      const verdict = conn.requestRejection({ headers: req.headers })
      if (verdict === 401 || verdict === 403) return verdict
      return 0
    }
  } catch { /* connection 在激活中/不可用：落到下面的本地围栏，不让请求变成 500 */ }
  return originAllowed(req) ? 0 : 403
}

/** 给一条路由套上准入判定：拒绝时只回状态码与原因，不执行处理器。 */
function admitWrap(ctx, handler) {
  return (req, res) => {
    const verdict = admissionVerdict(ctx, req)
    if (verdict) {
      sendJson(res, verdict, { ok: false, error: verdict === 401 ? 'unauthorized' : 'forbidden' })
      return undefined
    }
    return handler(req, res)
  }
}

function sendJson(res, code, body) {
  try {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  } catch { /* 客户端已断开就忽略 */ }
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    // 用数组收块、最后再 join：反馈路由的请求体上限放宽到 160 MB，
    // 逐块 `data += c` 会在这种体量下反复复制整条字符串（O(n²)），内存也翻倍。
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
      total += buf.length
      // 0.6.48：上限可放宽（反馈带附件时 base64 会超 64 KB），默认值不变，
      // 其它路由的行为一个字节都不动。
      if (total > maxBytes) { reject(new Error('body too large')); req.destroy() }
      else chunks.push(buf)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 生成"退出后执行"的 cmd：参数按本机实际路径写死，双击即可。
 * action: push | pull | restore
 */
const PS_EXE = '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -ExecutionPolicy Bypass -NoProfile'
// 绝对路径调任务列表和代码页：PATH 被裁过（或用户改坏）时也能跑，别指望 `tasklist` 能解析到
const TASKLIST = '%SystemRoot%\\System32\\tasklist.exe'
const CHCP = '%SystemRoot%\\System32\\chcp.com'
const FIND = '%SystemRoot%\\System32\\find.exe'
const PROC_GUARD = [
  `${TASKLIST} /fi "imagename eq DeepSeek Harness.exe" | ${FIND} /i "DeepSeek Harness.exe" >nul && (`,
  '  echo [X] DeepSeek Harness 还在运行，请先完全退出（窗口 + 托盘）再重试。',
  '  pause',
  '  exit /b 1',
  ')',
]

function cmdHead(title) {
  return [
    '@echo off',
    `${CHCP} 65001 >nul`,
    'setlocal',
    `echo 本脚本由 DSH 插件 dsh-profile-config-sync 生成：${title}`,
    ...PROC_GUARD,
    'echo.',
  ]
}

/**
 * cmd 的 echo 会把 < > | & ^ 当语法、把 % 当变量展开：
 * 直接 echo 一句带 `<时间戳>` 的提示，双击时会变成"从叫 时间戳 的文件读输入"并报
 * The system cannot find the file specified，那句话还打不出来。所有动态文案先过这里。
 */
function echoSafe(text) {
  return String(text).replace(/%/g, '%%').replace(/[<>|&^]/g, (c) => '^' + c)
}

/**
 * 生成 cmd 时要调用的 PowerShell 入口从哪来：
 *   1) 仓库里已经有 sync.ps1 / restore.ps1 → 用仓库那份（同步脚本随之更新）；
 *   2) 只有插件、仓库还没克隆（新机器刚装完）→ 用插件自带的 runtime\（随 tgz 一起发布）。
 * 两条路径都必须存在，否则明确报错，不生成一个双击必然失败的脚本。
 */
function pickPs1(repo, name) {
  const fromRepo = join(repo, name)
  if (isFile(fromRepo)) return fromRepo
  const fromPlugin = join(pluginRoot(), 'runtime', name)
  if (isFile(fromPlugin)) return fromPlugin
  throw new Error(t(
    `找不到 ${name}：仓库里没有（${fromRepo}），插件自带的 runtime 也没有（${fromPlugin}）`,
    `Cannot find ${name}: not in the repo (${fromRepo}) and not in the plugin's bundled runtime (${fromPlugin})`,
  ))
}

function pluginRoot() {
  try { return dirname(fileURLToPath(import.meta.url)) } catch { return '' }
}

function buildCmd(config, action, repo, appRoot, dshHome, state = {}) {
  const isRestore = action === 'restore' || action === 'restore-backup'
  const restorePs1 = isRestore ? pickPs1(repo, 'restore.ps1') : ''
  const syncPs1 = isRestore ? '' : pickPs1(repo, 'sync.ps1')
  // 仓库还没克隆时先建出目录，脚本要落在那里；clone 由 sync.ps1 首次执行时做完。
  if (!isDir(repo)) { try { mkdirSync(repo) } catch { /* 建不出来就让后面的 writeFileSync 报 */ } }
  const common = [`-RepoRoot "${repo}"`, `-AppRoot "${appRoot}"`, `-DshHome "${dshHome}"`]

  // push/pull 要跟远端认证：设置里配了私钥就用它，不靠 .ssh\config 的默认选择。
  // 铁律：GIT_SSH_COMMAND 必须以可执行程序开头。找不到 ssh.exe 时宁可不设（交给 .ssh\config），
  // 也不能输出「-i "key" -o …」——git 会把它当命令交给 sh，直接 invalid option，报错还伪装成"仓库读不到"。
  const settings = readSettings(dshHome)
  const w = normalizeWebdav(settings)
  const useWebdav = webdavActive(settings)
  const key = settings.sshKey || defaultSshKey()
  const hasKey = Boolean(key) && isFile(key)
  const coreSsh = readSshCommandFromGitConfig(repo)
  const sshExe = coreSsh ? '' : resolveSshExe()
  let envLines = []
  if (useWebdav) {
    envLines = [
      `echo ${echoSafe(`传输：WebDAV（${w.url} / ${w.dir}）`)}`,
    ]
  } else if (hasKey && coreSsh) {
    envLines = [
      `set GIT_SSH_COMMAND=${coreSsh}`,
      `echo ${echoSafe(`认证：git config core.sshCommand（私钥 ${key} 由该命令使用）`)}`,
    ]
  } else if (hasKey && sshExe) {
    envLines = [
      `set GIT_SSH_COMMAND="${sshExe}" -i "${key}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
      `echo ${echoSafe(`认证：SSH 私钥 ${key}`)}`,
      `echo ${echoSafe(`认证：ssh ${sshExe}`)}`,
    ]
  } else if (hasKey) {
    envLines = [
      `echo ${echoSafe(`认证：私钥 ${key}`)}`,
      `echo ${echoSafe('认证：本机没找到 ssh.exe，脚本内不设 GIT_SSH_COMMAND（它必须以可执行程序开头）')}`,
      `echo ${echoSafe('认证：改为交给 .ssh\\config；若仍报 Could not read from remote，就装 Git 官方版或配 git config core.sshCommand')}`,
    ]
  } else {
    envLines = [`echo ${echoSafe('认证：未配置私钥，交给 .ssh\\config 决定')}`]
  }

  if (isRestore) {
    // 生成时如果已经有快照，就把那一份明写进脚本（双击前就知道退回哪里）；
    // 还没有快照（新机器刚装插件）时不写 -BackupDir，交给 restore.ps1 运行时取最新一份 ——
    // 否则脚本会一直咬住"生成那一刻没有快照"，之后拉取生成了快照也用不上。
    // 面板「还原备份」里点某一行的还原时，state.backupDir 会带来那一份的绝对路径（已校验在备份根之下）。
    const settings = readSettings(dshHome)
    const backup = inspectBackup(dshHome, backupRootOf(dshHome, settings))
    const picked = String(state.backupDir || '')
    const pickedSnap = picked ? (backup.snapshots || []).find((s) => s.dir === picked) : null
    const backupArg = (picked || backup.latest) ? [`-BackupDir "${picked || backup.latest}"`] : []
    // 指定的是插件备份 / 会话备份时，restore.ps1 要按类型走不同分支（默认 profile）
    const kind = pickedSnap ? pickedSnap.kind : ''
    const kindArg = kind && kind !== 'profile' ? [`-SnapshotKind "${kind}"`] : []
    const pluginArg = kind === 'plugin' ? [`-PluginDir "${pluginRoot()}"`] : []
    const allArgs = [...common, ...backupArg, ...kindArg, ...pluginArg]
    const dry = `${PS_EXE} -File "${restorePs1}" ${allArgs.join(' ')} -DryRun`
    const real = `${PS_EXE} -File "${restorePs1}" ${allArgs.join(' ')}`
    const backupLines = (picked || backup.latest)
      ? [
        `echo ${echoSafe(`备份快照：${picked || backup.latest}`)}`,
        `echo ${echoSafe(`快照时间：${new Date(pickedSnap ? pickedSnap.at : backup.latestAt).toLocaleString('zh-CN', { hour12: false })}　备份根下共 ${backup.count} 份，这份含 ${pickedSnap ? pickedSnap.files : backup.latestFiles} 个文件`)}`,
      ]
      : [
        `echo ${echoSafe(`备份快照：${backup.root}（生成脚本时这里还没有快照）`)}`,
        `echo ${echoSafe('执行时由 restore.ps1 自动取该目录下最新一份；若那时仍为空，会提示你先跑一次拉取。')}`,
      ]
    const whatItDoes = kind === 'plugin'
      ? t('把当前插件回滚到这份插件备份（先把当前插件整份备份，再覆盖）', 'Roll the plugin back to this plugin backup (the current plugin is copied aside first, then overwritten)')
      : (kind === 'session'
        ? t('把会话目录还原成这份会话备份（先把当前同名目录备份，再覆盖）', 'Restore the session folders from this backup (folders with the same name are copied aside first, then overwritten)')
        : t('把本机 profile 退回到下面这个快照（先自保、再回退、再核对/重装依赖）。', 'Roll the local profile back to this snapshot (copy the current state aside, restore, then verify/reinstall dependencies).'))
    const text = [
      ...cmdHead(whatItDoes),
      ...backupLines,
      'echo.',
      'echo 要换成别的快照或仓库某提交，编辑本文件，把 -BackupDir 改掉或换成 -FromCommit。',
      'echo.',
      'echo [第一步] 只看不动，先打印还原计划：',
      dry,
      'echo.',
      'if /i "%~1"=="--yes" goto SYNC_RUN',
      'set /p GO=按上面的计划执行还原？(y/N) ',
      'if /i "%GO%"=="y" goto SYNC_RUN',
      `echo ${echoSafe('没有收到确认（y），已退出：本机什么都没改。')}`,
      'exit /b 0',
      ':SYNC_RUN',
      'echo.',
      'echo [第二步] 开始还原（会先把当前 profile 另存一份再覆盖）：',
      real,
      'echo.',
      'echo 执行结束。确认无误后再启动 DSH。',
      'pause',
    ].join('\r\n')
    // 指定了某一份快照（面板点行还原）时脚本名带上快照名，多份还原脚本可以同时存在、互不覆盖
    const fileName = pickedSnap ? `同步-还原-${pickedSnap.name}.cmd` : '同步-还原.cmd'
    const path = join(repo, fileName)
    writeFileSync(path, text, 'utf8')
    const label = kind === 'plugin'
      ? t('还原（插件 → 备份版本）', 'Restore (plugin → backup)')
      : (kind === 'session' ? t('还原（会话 → 备份）', 'Restore (sessions → backup)') : t('还原（本机 → 快照）', 'Restore (machine → snapshot)'))
    return { action, label, path, command: real,
      backup: { dir: picked || backup.latest, root: backup.root, at: pickedSnap ? pickedSnap.at : backup.latestAt, count: backup.count, files: pickedSnap ? pickedSnap.files : backup.latestFiles } }
  }

  const target = action === 'push' ? 'push' : 'pull'
  const label = target === 'push'
    ? t('推送（本机 → 远端）', 'Push (machine → remote)')
    : t('拉取（远端 → 本机）', 'Pull (remote → machine)')
  // 提交说明只对 push 有意义：用户在面板里填一句，时间由 sync.ps1 在实际执行那一刻追加。
  // 这里只做清洗（去引号/换行、% 转义、限长）：引号会破坏参数结构，% 会被 cmd 当变量展开。
  const note = target === 'push' ? String(state.message || '').replace(/["\r\n]/g, ' ').replace(/%/g, '%%').trim().slice(0, 120) : ''
  const command = [PS_EXE, '-File', `"${syncPs1}"`, target, ...common.map((c) => c),
    ...(note ? ['-Message', `"${note}"`] : [])].join(' ')
  const ahead = Number(state.ahead) || 0
  const dirty = Number(state.dirty) || 0
  const warnings = []
  if (target === 'pull') {
    if (ahead > 0) {
      warnings.push(t(
        `本机领先远端 ${ahead} 个提交（还没推送），拉取后这些改动在仓库里仍然缺失`,
        `This machine is ${ahead} commit(s) ahead (not pushed yet); after pulling, those changes are still missing from the repo.`,
      ))
    }
    if (dirty > 0) {
      warnings.push(t(
        `工作区有 ${dirty} 项未提交，拉取会用仓库版本覆盖对应的本机文件`,
        `${dirty} uncommitted change(s): pulling overwrites the matching local files with the repo version.`,
      ))
    }
    warnings.push(t(
      '拉取 = 拉远端 + apply 到本机：会用仓库里的版本覆盖本机配置',
      'Pull = fetch the remote and apply it locally: the repo version overwrites the local config.',
    ))
  }
  const guard = target === 'pull'
    ? [
      ...(ahead > 0 ? [`echo ${echoSafe(`[!] 本机领先远端 ${ahead} 个提交（还没推送），这些改动拉取后不会进仓库。`)}`] : []),
      ...(dirty > 0 ? [`echo ${echoSafe(`[!] 工作区有 ${dirty} 项未提交，拉取会用仓库版本覆盖对应本机文件。`)}`] : []),
      `echo ${echoSafe('[!] 拉取会用仓库里的版本覆盖本机配置（覆盖前仍会先存一份 backups\\config-<时间戳> 快照）。')}`,
      'echo.',
      // chcp 之后 set /p 读不到被重定向的输入（会拿到空值静默退出），所以另给一个 --yes 免确认开关，
      // 顺便让"没人按 y"这件事有明确回执，而不是什么都不发生。
      'if /i "%~1"=="--yes" goto SYNC_RUN',
      'set /p GO=拉取会覆盖本机配置，确认继续？(y/N) ',
      'if /i "%GO%"=="y" goto SYNC_RUN',
      `echo ${echoSafe('没有收到确认（y），已退出：本机什么都没改。')}`,
      'exit /b 0',
      ':SYNC_RUN',
      'echo.',
    ]
    : []
  const text = [
    ...cmdHead(`会先确认 DSH 是否已退出，再执行「${label}」。`),
    ...envLines,
    'echo.',
    ...guard,
    ...(note ? [`echo ${echoSafe(`提交说明：${note}（时间自动附在后面）`)}`] : []),
    command,
    'echo.',
    `echo 执行结束。若为拉取，确认无误后启动 DSH。`,
    'pause',
  ].join('\r\n')
  const path = join(repo, `同步-${target === 'push' ? '推送' : '拉取'}.cmd`)
  writeFileSync(path, text, 'utf8')
  return { action: target, label, path, command, warnings, message: note }
}

/* ============================ 跨端：POSIX 脚本生成（0.4.0） ============================
 * macOS / Linux 上没有 cmd.exe，也没有 powershell.exe。
 * 这里生成的是功能等价的 POSIX sh 脚本，调用 Node 版执行引擎（runtime/sync-engine.mjs）：
 *
 *   同步-推送.sh / 同步-拉取.sh / 同步-还原.sh
 *
 * 与 .cmd 的差异（如实说明，不掩盖）：
 *   - 进程守护用 `pgrep -f` 而不是 tasklist；
 *   - 没有 chcp（UTF-8 是默认）；
 *   - 认证走 .ssh/config 或 GIT_SSH_COMMAND（与 Windows 同语义）；
 *   - 还原备份的「时点回退」依赖仓库里的快照目录，逻辑与 Windows 一致。
 */

/** shell 单引号转义：把 ' 换成 '\'' （POSIX 标准写法）。 */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** POSIX 脚本头：shebang + set -e +  UTF-8 说明。 */
function shHead(title) {
  return [
    '#!/bin/sh',
    '# 本脚本由 DSH 插件 dsh-profile-config-sync 生成：' + title,
    '# 双击（或 sh 文件名）即可；参数 --yes 免确认。',
    'set -u',
    'export LC_ALL=${LC_ALL:-zh_CN.UTF-8}',
    '',
  ]
}

/**
 * 进程守护：DSH 还在跑就拒绝执行。
 * 用 pgrep -f 匹配客户端可执行文件；找不到 pgrep 时跳过（不假装守护成功）。
 */
function shProcGuard(appRoot) {
  // 0.6.49：用**客户端可执行文件路径**匹配，不用进程名。
  // 按名字匹配会命中我们自己的 Node 执行体（它的命令行里带着 ".../DeepSeek Harness.app/..."），
  // 于是一个已经退出的场景也会被判成「还在运行」，脚本永远拒绝执行。
  const pattern = clientProcessPattern(appRoot)
  return [
    '# 先确认 DSH 已退出：运行中 capture 会读到写了一半的 cordis.patch.yml',
    'if command -v pgrep >/dev/null 2>&1; then',
    `  if pgrep -f ${shQuote(pattern)} >/dev/null 2>&1; then`,
    '    echo "[X] DSH 还在运行，请先完全退出（窗口 + 托盘）再重试。"',
    '    exit 1',
    '  fi',
    'fi',
    '',
  ]
}

/** 找 Node 可执行文件：客户端自带优先，其次 PATH。 */
function shResolveNode(appRoot) {
  const bundled = hostNodeExe(appRoot)
  return bundled || 'node'
}

/**
 * 生成 POSIX 版「退出后执行」脚本。
 * 与 buildCmd 一一对应（push / pull / restore），返回同样的形状。
 */
function buildSh(config, action, repo, appRoot, dshHome, state = {}) {
  const isRestore = action === 'restore' || action === 'restore-backup'
  const engine = pickEngine(repo)
  if (!isDir(repo)) { try { mkdirSync(repo, { recursive: true }) } catch { /* 让后面报错 */ } }
  const nodeExe = shResolveNode(appRoot)
  const common = [
    `-RepoRoot ${shQuote(repo)}`,
    `-AppRoot ${shQuote(appRoot)}`,
    `-DshHome ${shQuote(dshHome)}`,
  ]
  const settings = readSettings(dshHome)
  const w = normalizeWebdav(settings)
  const useWebdav = webdavActive(settings)
  const key = settings.sshKey || defaultSshKey()
  const hasKey = Boolean(key) && isFile(key)
  const sshExe = hasKey ? resolveSshExe() : ''
  const envLines = []
  if (useWebdav) {
    envLines.push(`echo ${shQuote(`传输：WebDAV（${w.url} / ${w.dir}）`)}`)
  } else {
    if (hasKey && sshExe) {
      envLines.push(`export GIT_SSH_COMMAND=${shQuote(`${sshExe} -i ${key} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`)}`)
    }
    envLines.push('echo "认证：未配置私钥时交给 .ssh/config 决定"')
  }

  const target = action === 'push' ? 'push' : 'pull'
  const label = target === 'push'
    ? t('推送（本机 → 云端）', 'Push (machine → cloud)')
    : t('拉取（云端 → 本机）', 'Pull (cloud → machine)')

  const note = target === 'push'
    ? String(state.message || '').replace(/["\r\n]/g, ' ').trim().slice(0, 120)
    : ''
  // 提示与 .cmd 版同语义（面板拿 payload.warnings 提示「本机领先，别点错」）。
  // 0.6.49 之前 buildSh 直接不返回这两个字段，于是 macOS 面板上永远看不到这些提醒。
  const warnings = []
  if (target === 'pull') {
    const ahead = Number(state.ahead) || 0
    const dirty = Number(state.dirty) || 0
    if (ahead > 0) {
      warnings.push(t(
        `本机领先远端 ${ahead} 个提交（还没推送），拉取后这些改动在仓库里仍然缺失`,
        `This machine is ${ahead} commit(s) ahead (not pushed yet); after pulling, those changes are still missing from the repo.`,
      ))
    }
    if (dirty > 0) {
      warnings.push(t(
        `工作区有 ${dirty} 项未提交，拉取会用仓库版本覆盖对应的本机文件`,
        `${dirty} uncommitted change(s): pulling overwrites the matching local files with the repo version.`,
      ))
    }
    warnings.push(t(
      '拉取 = 拉远端 + apply 到本机：会用仓库里的版本覆盖本机配置',
      'Pull = fetch the remote and apply it locally: the repo version overwrites the local config.',
    ))
  }

  const confirmBlock = target === 'pull'
    ? [
      'echo "[!] 拉取会用云端版本覆盖本机配置（覆盖前会先存一份快照）。"',
      'if [ "${1:-}" = "--yes" ]; then',
      '  :',
      'else',
      '  printf "拉取会覆盖本机配置，确认继续？(y/N) "',
      '  read -r GO',
      '  case "$GO" in y|Y) ;; *) echo "没有收到确认（y），已退出：本机什么都没改。"; exit 0 ;; esac',
      'fi',
      '',
    ]
    : []

  // 还原：生成时就挑好快照并写进脚本（与 .cmd 版同语义）。
  // 0.6.49 之前 POSIX 的还原脚本只是裸调一次 restore —— 既不显示用的是哪份快照、
  // 也不先 dry-run、更没有确认（.cmd 版三样都有）；响应里也没有 backup 字段，面板拿不到快照信息。
  let backupInfo = null
  const body = []
  if (isRestore) {
    const settings = readSettings(dshHome)
    const backup = inspectBackup(dshHome, backupRootOf(dshHome, settings))
    const picked = String(state.backupDir || '')
    const pickedSnap = picked ? (backup.snapshots || []).find((sn) => sn.dir === picked) : null
    const chosen = picked || backup.latest || ''
    const kind = String(state.snapshotKind || (pickedSnap ? pickedSnap.kind : '') || '')
    const restoreState = { ...state, backupDir: chosen, snapshotKind: kind }
    backupInfo = {
      dir: chosen, root: backup.root,
      at: pickedSnap ? pickedSnap.at : backup.latestAt,
      count: backup.count, files: pickedSnap ? pickedSnap.files : backup.latestFiles,
    }
    const drySupported = engineSupportsDryRun(engine)
    const dry = drySupported
      ? buildShRestoreInvocation({ engine, nodeExe, common, state: restoreState, extra: ['-DryRun'] })
      : []
    const real = buildShRestoreInvocation({ engine, nodeExe, common, state: restoreState })
    body.push(
      chosen
        ? `echo ${shQuote(`备份快照：${chosen}`)}`
        : `echo ${shQuote(`备份快照：${backup.root}（生成脚本时这里还没有快照）`)}`,
      chosen
        ? `echo ${shQuote(`快照时间：${new Date(backupInfo.at || Date.now()).toLocaleString('zh-CN', { hour12: false })}　备份根下共 ${backup.count} 份`
          // files 可能是 null（体积/文件数不递归统计，见 inspectBackup）——别把 null 印成「含 null 个文件」
          + (typeof backupInfo.files === 'number' && Number.isFinite(backupInfo.files)
            ? `，这份含 ${backupInfo.files} 个文件` : '（文件数未统计）'))}`
        : `echo ${shQuote('执行时由 sync-engine.mjs 自动取该目录下最新一份；若那时仍为空，会提示你先跑一次拉取。')}`,
      '',
      ...(drySupported
        ? [`echo ${shQuote('[第一步] 只看不动，先打印还原计划：')}`, ...dry]
        : [`echo ${shQuote('[!] 这个执行体还不认 -DryRun（仓库里那份偏旧）：跳过计划预览；先推送一次即可刷新它。')}`]),
      'echo',
      ...restoreConfirmBlock(),
      `echo ${shQuote('[第二步] 开始还原（会先把当前 profile 另存一份再覆盖）：')}`,
      ...real,
    )
  } else {
    body.push(
      ...confirmBlock,
      `${shQuote(nodeExe)} ${shQuote(engine)} ${target} ${common.join(' ')}` +
        (note ? ` -Message ${shQuote(note)}` : ''),
    )
  }

  const headWhat = isRestore
    ? t('把本机 profile 退回到下面这个快照（先留底、再覆盖、再核对依赖）。',
      'Roll the local profile back to the snapshot below (copy aside, restore, then verify dependencies).')
    : `会先确认 DSH 是否已退出，再执行「${label}」。`
  const text = [
    ...shHead(headWhat),
    ...shProcGuard(appRoot),
    ...envLines,
    '',
    ...body,
    '',
    `echo ${shQuote(isRestore ? '执行结束。确认无误后再启动 DSH。' : '执行结束。若为拉取，确认无误后启动 DSH。')}`,
  ].join('\n')

  const fileName = isRestore
    ? (pickedName(state))
    : `同步-${target === 'push' ? '推送' : '拉取'}.sh`
  const path = join(repo, fileName)
  writeFileSync(path, text, 'utf8')
  try { chmodSync(path, 0o755) } catch { /* Windows 上没意义，忽略 */ }
  const result = {
    action: isRestore ? 'restore' : target,
    label: isRestore ? t('还原（本机 → 快照）', 'Restore (machine → snapshot)') : label,
    path,
    command: body.filter((l) => /sync-engine\.mjs/.test(l)).pop() || '',
    warnings,
    message: note,
    platform: 'posix',
  }
  if (backupInfo) result.backup = backupInfo
  return result
}

/** 还原脚本文件名：面板点某一行的还原时带快照名，多份脚本互不覆盖。 */
function pickedName(state) {
  return state.snapshotName ? `同步-还原-${state.snapshotName}.sh` : '同步-还原.sh'
}

/** 还原脚本的命令拼装（POSIX）。 */
function buildShRestoreInvocation({ engine, nodeExe, common, state, extra = [] }) {
  const args = [...common]
  if (state.backupDir) args.push(`-BackupDir ${shQuote(state.backupDir)}`)
  if (state.snapshotKind && state.snapshotKind !== 'profile') {
    args.push(`-SnapshotKind ${shQuote(state.snapshotKind)}`)
  }
  args.push(...extra)
  return [`${shQuote(nodeExe)} ${shQuote(engine)} restore ${args.join(' ')}`]
}

/** 还原的确认守卫（POSIX）：--yes 免确认，否则读一行 y。 */
function restoreConfirmBlock() {
  return [
    'if [ "${1:-}" = "--yes" ]; then',
    '  :',
    'else',
    '  printf "按上面的计划执行还原？(y/N) "',
    '  read -r GO',
    '  case "$GO" in y|Y) ;; *) echo "没有收到确认（y），已退出：本机什么都没改。"; exit 0 ;; esac',
    'fi',
    '',
  ]
}

/**
 * 挑执行引擎：优先仓库里的 sync-engine.mjs（随仓库更新），
 * 其次插件自带的 runtime\（新机器刚装、仓库还没拉下来时）。
 * 找不到返回空串，调用方据此明确报错，不生成一个必然失败的脚本。
 */
function pickEngine(repo) {
  // 0.6.49：插件自带的执行体优先。旧顺序是仓库优先（理由：随仓库更新），但实测代价太大 ——
  // 仓库里那份可能是老版本，它不认识新参数（-DryRun 被当成未知参数忽略，还原脚本的
  // 「第一步只看不动」直接变成真还原）。插件自带的永远是「正在跑的这份代码」，其余从属。
  const fromPlugin = join(pluginRoot(), 'runtime', 'sync-engine.mjs')
  if (isFile(fromPlugin)) return fromPlugin
  const fromRepo = join(repo, 'sync-engine.mjs')
  return isFile(fromRepo) ? fromRepo : ''
}

/** 执行体是否认 -DryRun（老版本的仓库执行体不认，别让「计划」变成真跑）。 */
function engineSupportsDryRun(engine) {
  try { return readFileSync(engine, 'utf8').includes('DryRun') } catch { return false }
}

/* ============================ 自动同步 / 自动推送 ============================
 * 插件跑在 DSH 主进程里：DSH 一退出插件就没了，所以"等 DSH 完全关闭再同步"不能由插件自己盯。
 * 做法是：需要动手时，插件用 detached 方式拉起 runtime\post-exit.ps1（它只等本进程 pid 消失），
 * 由那个外部脚本在退出后执行 pull / push，必要时再重启客户端。
 * 两个开关默认关；关着一行代码都不会跑。
 */

const ROUTE_AUTO = '/config-sync/auto'

const autoState = {
  checking: false,
  lastCheckAt: 0,
  lastCheckError: '',
  drift: null,          // { ahead, behind, at }
  pending: null,        // { mode, at, reason?, restarted? } 已排队、等退出后执行
  watcherStartedAt: 0,
  timer: null,
  interval: null,       // 每 2 分钟的复查（会话/资料是运行中产生的，只判一次会全漏）
  livePush: {
    running: false,
    startedAt: 0,
    finishedAt: 0,
    ok: null,
    phase: '',
    message: '',
    detail: '',
    recent: [],
    log: '',
    initPush: false,
    transport: '',
  },
}

function autoScript(dshHome, repo) {
  // 0.6.49：执行体随平台走 —— Windows 用 post-exit.ps1，macOS / Linux 用 post-exit.mjs。
  // 原来这里只找 .ps1，于是非 Windows 上 autoScript() 恒为空，spawnWatcher 直接返回
  // 「插件与仓库里都没有 post-exit.ps1，无法排队」—— 退出后推送/拉取/还原/更新整条链路都是死的。
  const name = postExitScriptName()
  const fromPlugin = join(pluginRoot(), 'runtime', name)
  if (isFile(fromPlugin)) return fromPlugin
  const fromRepo = join(repo || '', name)
  if (isFile(fromRepo)) return fromRepo
  // 兼容老仓库（里面只有 .ps1）：Windows 上仍能退回它，POSIX 上不能（跑不起来）
  if (IS_WIN) {
    const legacy = join(repo || '', 'post-exit.ps1')
    if (isFile(legacy)) return legacy
  }
  return ''
}

/**
 * 上次「退出后自动同步」的结果（post-exit.ps1 落的盘）。
 * 只读，读不到/坏掉都返回 null，绝不影响客户端启动。
 * 字段：{ mode, ok, at(ms), code, message, restored, log, notices }
 * notices：本次没同步成的文件清单（post-exit 从 sync-notices.json 带过来）
 */
function readAutoResult(dshHome) {
  try {
    const file = join(dshHome, 'auto-sync-result.json')
    if (!isFile(file)) return null
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (!j || typeof j !== 'object') return null
    return {
      mode: j.mode === 'push' ? 'push' : 'pull',
      ok: j.ok === true,
      at: Number(j.at) || 0,
      code: Number(j.code) || 0,
      message: String(j.message || ''),
      restored: j.restored === true,
      log: String(j.log || ''),
      notices: readNoticeList(dshHome, j.notices),
    }
  } catch { return null }
}

/**
 * 未同步文件清单：优先用结果文件里带的那份；结果文件里没有（比如面板刷新时这次还没跑完）
 * 就回落到 ~/.dsh/sync-notices.json。两种情况都做裁剪，避免一个几万文件的仓库把 /status 撑爆。
 */
function readNoticeList(dshHome, fromResult) {
  const KINDS = ['plugin-missing', 'context-state', 'history', 'too-large', 'failed', 'skipped']
  let raw = fromResult
  if (!raw || !Array.isArray(raw.items)) {
    try {
      const file = join(dshHome, 'sync-notices.json')
      if (isFile(file)) raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    } catch { raw = null }
  }
  if (!raw || !Array.isArray(raw.items) || !raw.items.length) return null
  const items = raw.items
    .filter((it) => it && it.path)
    .slice(0, 30)
    .map((it) => ({
      kind: KINDS.includes(it.kind) ? it.kind : 'skipped',
      path: String(it.path),
      bytes: Number(it.bytes) || 0,
      reason: String(it.reason || ''),
    }))
  const byKind = {}
  for (const k of KINDS) byKind[k] = 0
  for (const it of raw.items) {
    const k = KINDS.includes(it && it.kind) ? it.kind : 'skipped'
    byKind[k] += 1
  }
  return {
    at: Number(raw.at) || 0,
    mode: String(raw.mode || ''),
    total: Number(raw.total) || raw.items.length,
    byKind,
    items,
    truncated: (Number(raw.total) || raw.items.length) > items.length,
  }
}

/** 只读探询：fetch 一次再比 HEAD 与 origin/<branch>。任何失败都返回 null，绝不影响客户端启动。 */
async function checkDrift(repo) {
  if (!repo || !isDir(join(repo, '.git'))) return null
  const branch = await currentBranch(repo)
  const fetched = await git(repo, ['fetch', 'origin', '--quiet'])
  if (fetched === null) return null
  const counts = await git(repo, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`])
  if (!counts) return null
  const [ahead, behind] = counts.trim().split(/\s+/).map((n) => Number(n) || 0)
  return { ahead, behind, branch, at: Date.now() }
}

/** 系统确认框（立在 DSH 窗口前面，不开面板也看得见）。Yes → true。 */
function askConfirm(title, text) {
  // 0.6.49：POSIX 上用 osascript 的 display dialog。原来只会 spawn powershell.exe，
  // macOS 上 'error' 事件直接 resolve(false) —— 自动拉取的确认框永远等于「用户点了取消」，
  // 更新（apply）流程也永远走不到安装那一步。
  if (!IS_WIN) return askConfirmPosix(title, text)
  return new Promise((resolve) => {
    // 参数走 spawn 的数组形式，不经过 shell 解析，所以文本里的引号/换行不会被二次解释。
    const safe = (s) => String(s).replace(/'/g, "''")
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      `$r = [System.Windows.Forms.MessageBox]::Show('${safe(text)}', '${safe(title)}', ` +
        '[System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)',
      'if ($r -eq [System.Windows.Forms.DialogResult]::Yes) { exit 6 } else { exit 7 }',
    ].join('\n')
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: 'ignore' })
    ps.on('error', () => resolve(false))
    ps.on('close', (code) => resolve(code === 6))
    // 12 分钟没人点就当取消，别把后台挂着
    const timer = setTimeout(() => { try { ps.kill() } catch { } resolve(false) }, 12 * 60 * 1000)
    try { timer.unref?.() } catch { }
  })
}

/**
 * POSIX 版确认框：AppleScript 的 display dialog。
 * 两个按钮「取消 / 继续」，默认「继续」；回车=继续，Esc/取消=取消。
 * 脚本从 stdin 读，免得把中文与引号拼进 -e 参数时被 shell/AppleScript 二次解释。
 */
function askConfirmPosix(title, text) {
  return new Promise((resolve) => {
    if (!isFile('/usr/bin/osascript')) { resolve(false); return }
    // AppleScript 字符串就是 "..."：用 JSON.stringify 得到同样语义的转义（\" \\ \n）
    const asStr = (s) => JSON.stringify(String(s == null ? '' : s))
    const script = [
      'try',
      `  display dialog ${asStr(text)} with title ${asStr(title)} buttons {"取消", "继续"} default button "继续" with icon caution`,
      '  return "continue"',
      'on error number -128',
      '  return "cancel"',
      'end try',
    ].join('\n')
    let out = ''
    const child = spawn('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'pipe', 'ignore'] })
    child.on('error', () => resolve(false))
    child.stdout.on('data', (c) => { out += c })
    child.on('close', () => resolve(/continue/.test(out)))
    try { child.stdin.end(script, 'utf8') } catch { resolve(false) }
    const timer = setTimeout(() => { try { child.kill() } catch { } resolve(false) }, 12 * 60 * 1000)
    try { timer.unref?.() } catch { }
  })
}

/**
 * 找 powershell 的绝对路径。
 * 不能只写 'powershell.exe' 靠 PATH：Electron 主进程继承的 PATH 可能被裁剪（本机实测就是
 * spawn 返回对象、pid 看着有，但进程根本没起来、post-exit 的日志一行都没落 —— 假成功）。
 */
function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  for (const c of [
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]) {
    if (isFile(c)) return c
  }
  return 'powershell.exe'
}

/** 记录"起守护进程"这件事本身：成功/失败都留痕，否则失败时只剩一个不存在的 pid。 */
function logLaunch(dshHome, text) {
  try {
    const dir = join(dshHome, 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'auto-sync-launch.log'), `[${new Date().toISOString()}] ${text}\n`, { flag: 'a' })
  } catch { }
}

/** 拼 PowerShell 单引号字面量（路径里有单引号就双写）。 */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/**
 * 为 PowerShell 的 `Start-Process -ArgumentList @(...)` 拼单个参数。
 * PowerShell 5.1 会把数组元素直接用空格拼成命令行、不会自动给含空格的值加引号，
 * 结果像 `C:\Users\...\DeepSeek Harness` 会被拆成两个参数，把后续参数全顶偏并崩溃。
 * 这里按 Windows CommandLineToArgvW 规则把空串或含空白/引号的参数包上双引号。
 */
function psWinArg(value) {
  const s = String(value == null ? '' : value)
  if (!s) return '""'
  if (!/[\s"]/.test(s)) return s
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

/**
 * 拉起外部守护：等本进程退出后执行一次同步。
 *
 * 两个坑都在这踩过：
 * 1. spawn() 找不到可执行文件是**异步**报错，不会抛异常 —— 只看 try/catch 会"假装成功"；
 *    所以下面要等 launcher 的 exit 码，失败就如实返回，并写 auto-sync-launch.log。
 * 2. 直接用 `detached: true` 起 powershell，在 Windows 上它会**当场退出**：
 *    实测（同一个 exe、同一个脚本）detached=true 时进程 3 秒后已消失、post-exit 日志一行没有；
 *    detached=false 立刻就在写日志。所以这里不 detached，而是让一个短命 powershell 用
 *    Start-Process 把真正的 post-exit 起成独立进程 —— 父进程（DSH）退出后它照样活着。
 */
async function spawnWatcher({ mode, repo, appRoot, dshHome, restart, extraArgs = [], closeRequested = false }) {
  const script = autoScript(dshHome, repo)
  if (!script) {
    return { ok: false, error: t(
      `插件与仓库里都没有 ${postExitScriptName()}，无法排队`,
      `${postExitScriptName()} is in neither the plugin nor the repo — cannot queue`,
    ) }
  }
  // 同一时刻只允许一次同步。实测过的坑：启动首检排了 push、用户在确认框点确认又排了 pull，
  // 两个守护都在等同一个 pid —— DSH 一退出它们**同时开工**，一次推送一次拉取并行跑、各重启一次，
  // 配置可能互相覆盖。锁文件记 pid，进程还活着就拒掉后来者。
  //
  // 0.6.49：这段原来只在 Windows 分支里（在 spawnWatcher 后半段），POSIX 走新分支后
  // 锁就没人写了 —— 面板显示「排队中」而磁盘上没有痕迹，两个动作同时排队也没人挡。
  // 现在两个平台共用同一套判定，放在分支之前。
  const lockFile = join(dshHome, 'auto-sync.lock')
  try {
    if (isFile(lockFile)) {
      const lockText = readFileSync(lockFile, 'utf8')
      const lockPid = Number((lockText.match(/"pid"\s*:\s*(\d+)/) || [])[1])
      if (lockPid > 0) {
        let alive = false
        try { process.kill(lockPid, 0); alive = true } catch { alive = false }
        if (alive) {
          const lockMode = (lockText.match(/"mode"\s*:\s*"([a-z]+)"/) || [])[1]
          // 同一种同步已经在等，直接复用，别再加一个并行的
          if (lockMode === mode) return { ok: true, pid: lockPid, reused: true }
          // 不同的同步正在等（例如首检排了推送、用户在确认框点了拉取）：用户的手动动作优先，
          // 干掉那个还没开工的等待进程，改排这一次。
          try { process.kill(lockPid) } catch { }
          logLaunch(dshHome, `取消上一个等待中的 ${lockMode || '同步'}（pid ${lockPid}），改排 ${mode}`)
        }
      }
      try { unlinkSync(lockFile) } catch { }
    }
  } catch { }

  // 0.6.49：POSIX 走 Node 执行体（post-exit.mjs）。它不是「等退出→换可见窗口」两段式，
  // 自己就盯着 pid，所以这里直接 detached 起它，不必先起一个短命 launcher。
  if (!IS_WIN) {
    const nodeExe = hostNodeExe(appRoot) || process.execPath
    const args = ['-Mode', mode, '-WatchPid', String(process.pid), '-DshHome', dshHome]
    if (closeRequested) args.push('-CloseWhenIdle')
    if (repo) args.push('-RepoRoot', repo)
    if (appRoot) args.push('-AppRoot', appRoot)
    if (restart) args.push('-Restart')
    if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs)
    try {
      const child = spawn(nodeExe, [script, ...args], {
        detached: true, stdio: 'ignore', windowsHide: true,
      })
      child.unref()
    } catch (error) {
      const msg = String((error && error.message) || error)
      try { unlinkSync(lockFile) } catch { }
      logLaunch(dshHome, `启动失败 ${mode} exe=${nodeExe}：${msg}`)
      return { ok: false, error: t(`拉不起 Node 执行体（${nodeExe}）：${msg}`, `Cannot launch the Node runner (${nodeExe}): ${msg}`) }
    }
    autoState.watcherStartedAt = Date.now()
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, mode, at: Date.now() }), 'utf8')
    } catch { }
    logLaunch(dshHome, `已启动 ${mode}（Node 执行体 ${postExitScriptName()}，等 pid ${process.pid} 退出）`)
    return { ok: true, pid: process.pid, via: 'node' }
  }

  const logsDir = join(dshHome, 'logs')
  try { if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true }) } catch { }
  const pidFile = join(logsDir, `.watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pid`)

  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    // 这一段是「等待态」：隐藏进程只盯着 DSH 退出，退出后才由它拉起一个可见窗口干活，
    // 否则排队期间（可能几小时）会一直挂着一个挡视线的空窗口。
    '-Mode', mode, '-WatchPid', String(process.pid), '-Phase', 'wait', '-DshHome', dshHome,
    '-PidFile', pidFile]
  // 只有「插件自己请求过关闭客户端」的流程才允许守护进程在窗口消失后强杀残留进程；
  // 被动等待（自动推送/拉取）绝不强杀 —— 否则用户把窗口收进托盘就会被静默杀掉。
  if (closeRequested) args.push('-CloseWhenIdle')
  if (repo) args.push('-RepoRoot', repo)
  if (appRoot) args.push('-AppRoot', appRoot)
  if (restart) args.push('-Restart')
  // 更新模式要带上下载地址与校验值，交给 post-exit 的 run 段执行
  if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs)
  const exe = powershellExe()
  const argLine = args.map((a) => psWinArg(a)).join(' ')
  const inner = [
    // DSH 在 Windows 下位于带 KILL_ON_JOB_CLOSE 且禁止 BREAKAWAY 的 Job Object 内；
    // 直接 Start-Process 会继承同一 Job Object，DSH 一退等待进程就被连杀。
    // 优先通过 Shell.Application.ShellExecute 委托 explorer.exe 启动（inJob=False），
    // 等待脚本写出真实 PID；若无桌面 Shell 再兜底退回 Start-Process。
    'try {',
    `  (New-Object -ComObject Shell.Application).ShellExecute(${psQuote(exe)}, ${psQuote(argLine)}, ${psQuote(dshHome)}, 'open', 0)`,
    `  for ($i = 0; $i -lt 35; $i++) {`,
    `    if (Test-Path -LiteralPath ${psQuote(pidFile)}) {`,
    `      $v = (Get-Content -LiteralPath ${psQuote(pidFile)} -Raw -ErrorAction SilentlyContinue).Trim()`,
    `      if ($v -match '^\\d+$') { Write-Output "explorer:$v"; exit 0 }`,
    '    }',
    '    Start-Sleep -Milliseconds 150',
    '  }',
    '} catch { }',
    `$p = Start-Process -FilePath ${psQuote(exe)} -ArgumentList @(${args.map((a) => psQuote(psWinArg(a))).join(', ')}) -WindowStyle Hidden -PassThru`,
    'Write-Output "direct:$($p.Id)"',
  ].join('; ')
  const encoded = Buffer.from(inner, 'utf16le').toString('base64')
  let child
  try {
    child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    try { unlinkSync(pidFile) } catch { }
    const msg = String((error && error.message) || error)
    logLaunch(dshHome, `启动失败 ${mode} exe=${exe}：${msg}`)
    return { ok: false, error: t(`拉不起 powershell（${exe}）：${msg}`, `Cannot launch PowerShell (${exe}): ${msg}`) }
  }
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (c) => { stdout += c })
  child.stderr.on('data', (c) => { stderr += c })
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 10000)
    child.once('exit', (c) => { clearTimeout(timer); resolve(c) })
    child.once('error', (e) => { clearTimeout(timer); resolve('error:' + ((e && e.message) || e)) })
  })
  try { unlinkSync(pidFile) } catch { }
  if (code !== 0) {
    const detail = String(stderr || stdout || code).trim().slice(0, 300)
    logLaunch(dshHome, `启动失败 ${mode} exe=${exe}：${detail}`)
    return { ok: false, error: t(`拉不起 post-exit（launcher 退出码 ${code}）：${detail}`, `Cannot launch post-exit (launcher exit code ${code}): ${detail}`) }
  }
  const token = String(stdout).trim().split(/\s+/).pop() || ''
  const via = token.startsWith('explorer:') ? 'explorer' : 'direct'
  const pid = Number(token.replace(/^(explorer|direct):/, '')) || 0
  autoState.watcherStartedAt = Date.now()
  try {
    writeFileSync(lockFile, JSON.stringify({ pid, mode, at: Date.now() }), 'utf8')
  } catch { }
  logLaunch(dshHome, `已启动 ${mode} pid=${pid} via=${via} exe=${exe} script=${script}`)
  return { ok: true, pid, via }
}

/**
 * 宿主是 Electron 主进程（插件就装在主进程里），所以能拿到 app —— 但 CLI 形态运行、
 * 或加载器换了模块解析时取不到，一律返回 null，调用方退回 taskkill。
 */
function electronApp() {
  try {
    const mod = pluginRequire('electron')
    return mod && mod.app && mod.BrowserWindow ? mod : null
  } catch { return null }
}

/**
 * 让客户端**真的退出**。
 *
 * 旧实现是 `taskkill /PID <主进程>`（不带 /F）：对 Electron 主进程无效 ——
 * 主进程没有自己的顶层窗口，实测直接报 "This process can only be terminated forcefully"，
 * 于是「确认后自动退出 DSH」根本不生效，守护进程只能干等到 30 分钟超时。
 *
 * 现在优先 app.quit()（走 before-quit，配置照常落盘）；拿不到 electron 才退回 taskkill。
 */
function closeDsh(appRoot = '') {
  const el = electronApp()
  const quitSoft = () => {
    // Electron 主进程形态下 app.quit 最温和（有 before-quit 落盘）
    if (el) { try { el.app.quit(); return true } catch { } }
    return false
  }

  // 0.6.49：POSIX 上没有 taskkill（原来这里 join(C:\\Windows, System32, taskkill.exe)，
  // 在 macOS 上 spawn 一个不存在的可执行文件，'error' 事件没人接 —— 关不掉客户端还会掉异常）。
  if (!IS_WIN) {
    if (quitSoft()) return true
    // 交给 AppleScript 走客户端的正常退出流程（等价于用户按 ⌘Q，配置照常落盘）
    try {
      spawn('/usr/bin/osascript', ['-e', 'tell application "DeepSeek Harness" to quit'],
        { stdio: 'ignore', detached: false })
    } catch { /* 没有 osascript 时退回下面的强杀 */ }
    // 6 秒后还在就按可执行文件整族结束（用户已经点过「立即同步」，明确授权关闭）
    const timer = setTimeout(() => {
      // 按可执行文件路径精确结束：按名字会把「等客户端退出的 post-exit.mjs」一起杀掉，
      // 于是用户点完「立即拉取」反而什么都没发生。
      try {
        spawn('/usr/bin/pkill', ['-f', clientProcessPattern(appRoot || resolveAppRoot(''))], { stdio: 'ignore' })
      } catch { }
    }, 6000)
    try { timer.unref?.() } catch { }
    return true
  }

  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
  const imageName = 'DeepSeek Harness.exe'
  const run = (args) => {
    try {
      const child = spawn(isFile(exe) ? exe : 'taskkill', args, { stdio: 'ignore', windowsHide: true, detached: false })
      child.on?.('error', () => { })
    } catch { }
  }

  // 先走一次「礼貌关闭」（不带 /F 只对带窗口的进程有效，会让 Electron 走正常关闭流程）。
  run(['/IM', imageName])
  // 3.5 秒后强制收尾：实测点关闭后 7 个进程全部残留（单杀 process.pid 只打掉一个子进程，
  // 因为插件跑在子进程里、进程号不是客户端主进程），必须按映像名整族收掉，
  // 否则「退出后自动推送」的等待进程会一直等到 30 分钟超时。
  const timer = setTimeout(() => { run(['/IM', imageName, '/F']) }, 3500)
  try { timer.unref?.() } catch { }

  quitSoft()
  return true
}

function isProcessAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
const STATE_NAME = 'config-sync-state.json'

/**
 * 上次同步成功的时间（由 sync.ps1 在 push/pull 成功后写进 <DshHome>\config-sync-state.json）。
 * 面板拿它当"本机数据有没有比仓库新"的分界线 —— 以前只比 git status，新会话还没 capture 时
 * 面板会显示"仓库与本机一致"，看着像没同步，其实只是没跑 capture。
 */
function readSyncState(dshHome) {
  const s = readJson(join(dshHome, STATE_NAME)) || {}
  return {
    lastSyncAt: typeof s.lastSyncAt === 'string' ? s.lastSyncAt : '',
    mode: typeof s.mode === 'string' ? s.mode : '',
    head: typeof s.head === 'string' ? s.head : '',
  }
}

/** 本机登记的工作区目录（capture 会把它们镜像进仓库，所以它们变了也算待推送）。 */
function workspaceRoots(dshHome) {
  return listWorkspaceEntries(dshHome).map((w) => w.path).filter(Boolean)
}

function encodeSessionDirName(pathStr) {
  let out = '--'
  for (const ch of String(pathStr || '')) {
    const c = ch.charCodeAt(0)
    if (c === 58) continue
    if (c === 92 || c === 47) { out += '-'; continue }
    if (c < 128) out += ch
    else out += '~' + c.toString(16).toUpperCase().padStart(4, '0')
  }
  return out + '--'
}

// 本机待推送文件按「同步内容」的分组归类；标签与 collectScopeGroups 的 titleZh/titleEn 对齐
const PENDING_GROUP_LABEL = {
  profile: ['本机 profile', 'Local profile'],
  prompt: ['全局提示', 'Global prompts'],
  skills: ['Skills', 'Skills'],
  presets: ['Agent 预设', 'Agent presets'],
  'storages-record': ['技能市场台账', 'Skill market ledger'],
  settings: ['插件设置与工作流', 'Plugin settings & workflows'],
  mnemon: ['记忆数据', 'Memory data'],
  'local-plugins': ['本地源码插件包', 'Local plugin packages'],
  'plugin-data': ['插件数据', 'Plugin data'],
  extra: ['额外路径', 'Extra paths'],
  workspace: ['工作区资料', 'Workspace files'],
  conversations: ['会话记录', 'Conversations'],
  other: ['其它', 'Other'],
}

function pendingGroupOf(file, dshHome, profileDir, workspacePaths, roots, settingsPaths) {
  const norm = String(file).replace(/\\/g, '/')
  const base = String(dshHome).replace(/\\/g, '/').replace(/\/+$/, '')
  const prof = String(profileDir).replace(/\\/g, '/').replace(/\/+$/, '')
  // 设置类单文件排在最前：它们多数住在 <DshHome> 一级目录里（our-free-model / dsh-pet / task-board …），
  // 同时也落在「插件数据」的槽里，先认成设置才不会被算到插件数据头上、也不会被 profile 前缀吞掉。
  if (settingsPaths && settingsPaths.has(norm.toLowerCase())) return 'settings'
  if (prof && norm.startsWith(prof + '/')) return 'profile'
  if (/\/AGENTS\.md$|\/prompt-inject\.md$/i.test(norm)) return 'prompt'
  if (norm.startsWith(base + '/skills/')) return 'skills'
  if (norm.startsWith(base + '/.agent-presets/')) return 'presets'
  if (norm.startsWith(base + '/storages/@montersy123/dsh-skill-market/data/')) return 'storages-record'
  if (norm.startsWith(base + '/mnemon/')) return 'mnemon'
  if (norm.startsWith(base + '/sessions/')) return 'conversations'
  // 用户自己指定的根（插件数据槽 / 额外路径 / 本地插件包）先认：
  // 额外路径很可能就指在某个工作区里，那种情况该算「额外路径」而不是「工作区资料」。
  for (const r of roots || []) {
    const rn = String(r.path).replace(/\\/g, '/').replace(/\/+$/, '')
    if (rn && (norm === rn || norm.startsWith(rn + '/'))) return r.group
  }
  for (const w of workspacePaths || []) {
    const wn = String(w).replace(/\\/g, '/').replace(/\/+$/, '')
    if (wn && norm.startsWith(wn + '/')) return 'workspace'
  }
  return 'other'
}

// 会话文件的标题：投影缓存 record.rows.title.val 就是 DSH 面板显示的会话名
function sessionTitleOf(dshHome, sessionId) {
  if (!sessionId) return ''
  try {
    const p = join(dshHome, 'storages', 'session_projcache', 'sessions', sessionId + '.json')
    const o = JSON.parse(readFileSync(p, 'utf8'))
    const t = o && o.record && o.record.rows && o.record.rows.title && o.record.rows.title.val
    return typeof t === 'string' && t.trim() ? t : ''
  } catch { return '' }
}

/**
 * 本机 DSH 数据里「上次同步之后又写过」的文件有多少个。
 * 只看 mtime，不读内容、**不跑 capture**（跑 capture 要复制整个工作区，几 GB）。
 * 代价控制：跳过 node_modules / models / .git 等，最多 20000 个文件、最多 1.5 秒。
 *
 * 为什么要补一层内容比对：`profile\cordis.patch.yml` 这类文件 **DSH 每次启动都会重写**
 * （把仓库里存的 `{{APP_ROOT}}` 占位符展开成真实安装路径），mtime 永远比上次同步新，
 * 只看 mtime 就会出现「明明什么都没改，面板却一直建议推送」。所以对这几个有仓库对应物的
 * 单文件，mtime 更新后再把内容归一（占位符还原、换行统一）比一次，相同就不计入。
 */
function localPending(dshHome, lastSyncAt, profileName, ctx = {}) {
  const since = lastSyncAt ? Date.parse(lastSyncAt) : NaN
  if (!Number.isFinite(since)) return { known: false, pending: 0, newestAt: '', sample: [], groups: [] }
  // 注意 attachments 不在跳过名单里：conversations 组现在把 <DshHome>\attachments 也算一块
  // （capture 就是这么抓的），留着它会让附件永远不计入待推送。
  const skip = new Set(['node_modules', '.git', 'models', '_tmp', 'staging', 'logs'])
  const profile = join(dshHome, 'profiles', profileName || 'desktop')
  const appRoot = String(ctx.appRoot || '')
  const scope = readScope(dshHome)
  const wsEntries = listWorkspaceEntries(dshHome)
  const wsEncToId = new Map()
  const activeWorkspacePaths = []
  for (const w of wsEntries) {
    if (w.path) wsEncToId.set(encodeSessionDirName(w.path), w.id)
    if (w.path && scopeItemEnabled(scope, 'workspace', w.id)) activeWorkspacePaths.push(w.path)
  }
  const workspacePaths = scopeGroupEnabled(scope, 'workspace') ? activeWorkspacePaths : []
  // 分组归类靠这张表：便宜的配置类根（下面 stack2）按路径前缀一眼能认出来，
  // 而插件数据 / 额外路径 / 本地插件包这类「用户自己指定的根」只能登记下来再比对。
  const roots = []
  // 只有「设置组真的会同步的那个文件」才算设置：关掉设置组之后，这些文件如果还落在
  // 某个插件数据槽里，capture 会以插件数据的名义照抓，这时就该算插件数据（否则会漏报）。
  const settingsPaths = new Set(
    scopeGroupEnabled(scope, 'settings')
      ? SYNC_SETTINGS_SOURCES
        .filter((e) => scopeItemEnabled(scope, 'settings', e.id))
        .map((e) => settingsSourcePath(dshHome, profile, e).replace(/\\/g, '/').toLowerCase())
      : [],
  )
  const addRoot = (path, group, item, extra) => {
    if (!path) return null
    roots.push({ path, group, item: item || '', ...(extra || {}) })
    return path
  }
  // ① 便宜且要紧的根（先扫完，再扫贵的）：profile / 提示 / Skills / 预设 / 台账 / 设置 / 记忆 / 会话
  const stack = [
    join(profile, 'package.json'),
    join(profile, 'pnpm-lock.yaml'),
    join(profile, 'pnpm-workspace.yaml'),
    join(profile, 'cordis.yml'),
    join(profile, 'cordis.patch.yml'),
    join(profile, 'host-contract.json'),
  ]
  if (scopeGroupEnabled(scope, 'prompt')) {
    if (scopeItemEnabled(scope, 'prompt', 'AGENTS.md')) stack.push(join(dshHome, 'AGENTS.md'))
    if (scopeItemEnabled(scope, 'prompt', 'prompt-inject.md')) stack.push(join(dshHome, 'prompt-inject.md'))
  }
  if (scopeGroupEnabled(scope, 'skills')) {
    const skillsRoot = join(dshHome, 'skills')
    for (const name of listSubDirs(skillsRoot)) {
      if (scopeItemEnabled(scope, 'skills', name)) stack.push(join(skillsRoot, name))
    }
  }
  if (scopeGroupEnabled(scope, 'presets')) {
    const presetsRoot = join(dshHome, '.agent-presets')
    for (const name of listSubDirs(presetsRoot)) {
      if (scopeItemEnabled(scope, 'presets', name)) stack.push(join(presetsRoot, name))
    }
  }
  // 技能市场台账：capture 抓的是这两个 fixed 文件，面板的待推送也只看这两个
  if (scopeGroupEnabled(scope, 'storages-record')) {
    const ledgerDir = join(dshHome, 'storages', '@montersy123', 'dsh-skill-market', 'data')
    for (const [file, id] of [['installed.json', 'skill-market-installed.json'], ['panel.json', 'skill-market-panel.json']]) {
      if (scopeItemEnabled(scope, 'storages-record', id)) stack.push(join(ledgerDir, file))
    }
  }
  // 插件设置与工作流：与 collectScopeGroups / capture 的 Get-SyncSettingsMap 同一份清单（14 条）
  if (scopeGroupEnabled(scope, 'settings')) {
    for (const entry of SYNC_SETTINGS_SOURCES) {
      if (!scopeItemEnabled(scope, 'settings', entry.id)) continue
      stack.push(settingsSourcePath(dshHome, profile, entry))
    }
  }
  // 记忆数据：capture 读的是 <AppRoot>\mnemon（不是 <DshHome>\mnemon，这里以前写错过）
  if (scopeGroupEnabled(scope, 'mnemon') && appRoot) {
    const mnemonRoot = join(appRoot, 'mnemon')
    addRoot(mnemonRoot, 'mnemon', 'mnemon')
    stack.push(mnemonRoot)
  }
  // ② 贵的根（会话、工作区、插件数据、额外路径、本地插件包）：扫描预算有限，
  //    它们必须排在便宜的配置类之后，否则工作区里两万个文件会把 skills/profile 挤出去，
  //    面板就报「配置没变」而其实配置变了。
  const deferred = []
  let extraCfg = null
  try { extraCfg = readExtraConfig(dshHome) } catch { extraCfg = null }
  if (scopeGroupEnabled(scope, 'conversations')) {
    // conversations 组在 capture 里是四块（sessions / attachments / projcache / policies），
    // 以前待推送只数 sessions：往附件里丢一张图、或某个会话的 projcache 更新，
    // 面板照样说「仓库与本机一致」，一推却动了文件。
    const sessRoot = join(dshHome, 'sessions')
    const skipSessIds = new Set()
    for (const dirName of listSubDirs(sessRoot)) {
      if (/default-workspace/i.test(dirName)) continue
      const wsId = wsEncToId.get(dirName)
      if (wsId && !scopeItemEnabled(scope, 'conversations', wsId)) {
        for (const sid of listSubDirs(join(sessRoot, dirName))) skipSessIds.add(sid)
        continue
      }
      deferred.push(join(sessRoot, dirName))
    }
    const attachRoot = join(dshHome, 'attachments')
    if (existsSync(attachRoot)) {
      addRoot(attachRoot, 'conversations', 'attachments')
      deferred.push(attachRoot)
    }
    // projcache / policies：第一段是会话 id（形如 <sid>.json），按被取消勾选的会话逐个筛掉
    for (const [root, item] of [
      [join(dshHome, 'storages', 'session_projcache', 'sessions'), 'projcache'],
      [join(dshHome, 'storages', 'vision_router_session_policy', 'policies'), 'policies'],
    ]) {
      if (!existsSync(root)) continue
      addRoot(root, 'conversations', item, { skipSessionIds: skipSessIds })
      deferred.push(root)
    }
  }
  deferred.push(...workspacePaths)
  // 本地插件包：capture 把 link: 挂进来的插件目录打成 zip，所以源目录就是待推送的判据
  if (scopeGroupEnabled(scope, 'local-plugins')) {
    try {
      const pkg = readJson(join(profile, 'package.json')) || {}
      const deps = pkg.dependencies || {}
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
        const target = spec.slice(5)
        const leaf = String(target).split(/[\\/]+/).filter(Boolean).pop() || name
        if (!scopeItemEnabled(scope, 'local-plugins', leaf)) continue
        if (!isDir(target)) continue
        addRoot(target, 'local-plugins', leaf)
        deferred.push(target)
      }
    } catch { /* link 目标读不出来就不算，反正 push 时还会再判一次 */ }
  }
  // 插件数据：槽清单与面板「插件数据」组一致（都是 <DshHome> 一级目录去掉 skipDirs 与隐藏目录），
  // 但这里**不调 listPluginDataSlots**：那个函数会把每个槽整个数一遍文件，
  // 而待推送扫描本来就要走一遍，数两遍纯粹浪费（browser-profiles 这种槽就几千个文件）。
  if (extraCfg && scopeGroupEnabled(scope, 'plugin-data') && extraCfg.pluginData.enabled !== false) {
    const skipDirs = new Set(extraCfg.pluginData.skipDirs || [])
    let entries = []
    try { entries = readdirSync(dshHome, { withFileTypes: true }) } catch { entries = [] }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (skipDirs.has(e.name)) continue
      if (e.name.startsWith('.')) continue
      // 浏览器剖面/凭据库一律不扫（哪怕用户规则里删掉了这条跳过项）
      if (isBlockedProfilePath(e.name)) continue
      if (!scopeItemEnabled(scope, 'plugin-data', e.name)) continue
      addRoot(join(dshHome, e.name), 'plugin-data', e.name)
      deferred.push(join(dshHome, e.name))
    }
  }
  // 额外路径：用户自己登记的 src（文件或目录），逐个按条目勾选
  if (extraCfg && scopeGroupEnabled(scope, 'extra') && extraCfg.extra.enabled !== false) {
    for (const p of extraCfg.extra.paths || []) {
      if (!p || !p.src) continue
      if (!scopeItemEnabled(scope, 'extra', p.id)) continue
      addRoot(p.src, 'extra', p.id)
      deferred.push(p.src)
    }
  }
  // unshift 而不是 push：pop() 从尾部取，贵的根要排在数组前部才会最后被扫到
  stack.unshift(...deferred)
  // 有仓库对应物的单文件：路径 → 仓库里的那份。只有这些才值得读内容比对。
  const repoRoot = String(ctx.repo || '')
  const mirrored = new Map()
  if (repoRoot) {
    mirrored.set(join(dshHome, 'AGENTS.md'), join(repoRoot, 'prompt', 'AGENTS.md'))
    mirrored.set(join(dshHome, 'prompt-inject.md'), join(repoRoot, 'prompt', 'prompt-inject.md'))
    for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml', 'host-contract.json']) {
      mirrored.set(join(profile, f), join(repoRoot, 'profile', f))
    }
  }
  const deadline = Date.now() + 1500
  let scanned = 0
  let pending = 0
  let newest = 0
  const sample = []
  const groupCount = new Map()
  // 每组保留具体明细名称（会话记录名 / 本机 profile 文件名 …），供面板展开查看
  const groupItems = new Map()
  const DETAIL_CAP = 50
  // 用户自定的根（插件数据槽 / 额外路径 / 本地插件包）里 capture 还会按规则过滤：
  // 插件数据与额外路径走 config-sync-extra.json 的 exclude 名单与单文件上限，本地插件包固定跳过
  // .git / node_modules / releases / .cache。待推送计数必须同样过滤，否则「被排除的 .db 一直在变」
  // 会让面板永远建议推送（插件自己的 sqlite 每次写入都会更新 mtime）。
  const normRoots = roots.map((r) => ({
    group: r.group,
    base: String(r.path).replace(/\\/g, '/').replace(/\/+$/, ''),
    skipSessionIds: r.skipSessionIds || null,
    rules: (r.group === 'plugin-data' || r.group === 'extra') && extraCfg
      ? { cfg: extraCfg, dirs: dirHasRules(extraCfg) }
      : r.group === 'local-plugins' ? { cfg: null, segs: new Set(['.git', 'node_modules', 'releases', '.cache']) } : null,
  }))
  const ownerOf = (p) => {
    const n = String(p).replace(/\\/g, '/')
    for (const r of normRoots) {
      if (n === r.base || n.startsWith(r.base + '/')) return r
    }
    return null
  }
  while (stack.length && scanned < 20000 && Date.now() < deadline) {
    const cur = stack.pop()
    let st
    try { st = statSync(cur) } catch { continue }
    const owner = ownerOf(cur)
    // 浏览器剖面 / 凭据库的路径段：capture 永远不会抓（Test-BlockedProfilePath 硬拦），
    // 待推送也不该数——否则浏览器一跑，几千个缓存/登录态文件就永远显示「待推送」。
    if (owner && (owner.group === 'plugin-data' || owner.group === 'extra') && isBlockedProfilePath(relative(owner.base, String(cur).replace(/\\/g, '/')))) continue
    // projcache / policies：第一段是会话 id（<sid>.json），被取消勾选的工作区里的会话整块不抓
    if (owner && owner.skipSessionIds && owner.skipSessionIds.size) {
      const head = relative(owner.base, String(cur).replace(/\\/g, '/')).split('/')[0] || ''
      const sid = head.replace(/\.[^.]+$/, '')
      if (owner.skipSessionIds.has(head) || owner.skipSessionIds.has(sid)) continue
    }
    if (st.isDirectory()) {
      if (skip.has(basename(cur))) continue
      const leaf = basename(cur).toLowerCase()
      if (owner && owner.rules) {
        if (owner.rules.dirs && owner.rules.dirs.some((re) => re.test(basename(cur)))) continue
        if (owner.rules.segs && owner.rules.segs.has(leaf)) continue
      }
      let entries = []
      try { entries = readdirSync(cur) } catch { continue }
      for (const e of entries) stack.push(join(cur, e))
      continue
    }
    scanned++
    if (st.mtimeMs > since) {
      // 被 capture 的规则排除掉的文件永远进不了仓库，不该算成「待推送」
      if (owner && owner.rules && owner.rules.cfg) {
        const rel = relative(owner.base, String(cur).replace(/\\/g, '/'))
        if (extraSkipReason(rel, st.size, owner.rules.cfg)) continue
      }
      // 镜像文件的 mtime 更新可能只是宿主重写占位符：内容归一后一致就不算待推送
      const twin = mirrored.get(cur)
      if (twin && isFile(twin)) {
        try {
          if (mirrorText(cur, ctx.appRoot) === mirrorText(twin, ctx.appRoot)) continue
        } catch { }
      }
      pending++
      if (st.mtimeMs > newest) newest = st.mtimeMs
      const gid = pendingGroupOf(cur, dshHome, profile, workspacePaths, roots, settingsPaths)
      // 非 Windows 走的是 runtime\sync-engine.mjs：它只抓 profile / 提示 / Skills / 预设。
      // 在这台机器上把会话记录、插件数据、额外路径也算成「待推送」，等于承诺一件永远不会发生的事。
      if (ENGINE_SYNCED_GROUPS && !ENGINE_SYNCED_GROUPS.has(gid)) { pending--; continue }
      groupCount.set(gid, (groupCount.get(gid) || 0) + 1)
      // 会话文件显示会话标题而不是目录 ID；其余显示父目录/文件名
      let label = `${basename(dirname(cur))}/${basename(cur)}`
      if (gid === 'conversations') {
        const sid = basename(dirname(cur)) // sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd
        const title = sessionTitleOf(dshHome, sid)
        if (title) label = title
        else label = `${sid}（会话）`
      } else if (gid === 'profile') {
        label = basename(cur) // 本机 profile 文件：package.json / cordis.patch.yml …
      }
      if (sample.length < 3) sample.push(label)
      // 按组收集明细名（去重、限量）：面板展开可看具体会话记录名 / 本机 profile 文件
      let items = groupItems.get(gid)
      if (!items) { items = []; groupItems.set(gid, items) }
      if (items.length < DETAIL_CAP && !items.includes(label)) items.push(label)
    }
  }
  const groups = [...groupCount.entries()]
    .map(([id, count]) => ({
      id,
      zh: PENDING_GROUP_LABEL[id]?.[0] || id,
      en: PENDING_GROUP_LABEL[id]?.[1] || id,
      count,
      items: groupItems.get(id) || [],
    }))
    .sort((a, b) => b.count - a.count)
  return {
    known: true,
    pending,
    newestAt: newest ? new Date(newest).toISOString() : '',
    sample,
    groups,
    profileName: profileName || 'desktop',
    truncated: scanned >= 20000 || Date.now() >= deadline,
    // 非 Windows 时只统计引擎真会同步的四组，把这件事说出来（面板会显示，不让用户以为别的组也在同步）
    engineGroups: ENGINE_SYNCED_GROUPS ? [...ENGINE_SYNCED_GROUPS] : null,
  }
}

/** 读成"可比较的文本"：换行统一、去尾部空白、把真实安装路径还原成 {{APP_ROOT}} 占位符。 */
function mirrorText(file, appRoot) {
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '')
  const root = String(appRoot || '').replace(/[\\/]+$/, '')
  if (root) {
    for (const variant of new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')])) {
      if (variant) text = text.split(variant).join('{{APP_ROOT}}')
    }
  }
  return text
}

async function repoState(repo) {
  if (!repo || !isDir(join(repo, '.git'))) return { ahead: 0, dirty: 0 }
  const status = await git(repo, ['status', '--porcelain'])
  const dirty = status ? status.split('\n').filter((l) => l.trim()).length : 0
  return { ahead: await aheadCount(repo), dirty }
}

/** 当前分支名（游离 HEAD 时给出 'main' 兜底，跟以前的行为一致）。 */
async function currentBranch(repo) {
  const raw = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const name = String(raw || '').trim()
  return name && name !== 'HEAD' ? name : 'main'
}

/**
 * 本机领先远端多少提交。
 * 不能把分支名写死成 origin/main（以前就是这么写的，分支叫 master 或改了名时「领先」永远算 0）。
 * 优先用上游追踪（HEAD --not @{upstream}），没有上游时用当前分支对应的 origin/<分支>。
 */
async function aheadCount(repo) {
  const parse = (s) => Number(String(s || '').trim()) || 0
  const viaUpstream = await git(repo, ['rev-list', '--count', 'HEAD', '--not', '@{upstream}'])
  if (viaUpstream) return parse(viaUpstream)
  const branch = await currentBranch(repo)
  return parse(await git(repo, ['rev-list', '--count', 'HEAD', '--not', `origin/${branch}`]))
}

/** action 白名单：单个动作，或 all=一次性生成三个脚本。 */
const ACTIONS = ['push', 'pull', 'restore', 'restore-backup', 'all']


/** 远端地址只接受三种写法，别的一律拒（避免把乱七八糟的东西塞进 git remote）。 */
const REMOTE_RE = /^(git@[\w.\-]+:[^\s]+|ssh:\/\/[^\s]+|https:\/\/[^\s]+)$/i

/**
 * 保存仓库路径 / 远端地址 / 私钥路径。三样都可以单独改，也可以一起改。
 * 顺序：先校验 → 写设置文件 → 改 git remote（失败就回滚设置文件），不会留下半截状态。
 */
async function handleSettings(req, res, config) {
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
  if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = settingsPath(dshHome)
  const prevRaw = isFile(file) ? readFileSync(file, 'utf8') : null
  try {
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
    const before = readSettings(dshHome)

    let repoPath = before.repoPath
    if (has('repoPath')) {
      repoPath = String(body.repoPath || '').trim().replace(/[\\/]+$/, '')
      // POSIX 用户习惯写 ~/dsh-config：这里先展开再校验，否则会被「要绝对路径」挡回去，
      // 而用户会以为插件连自己家目录都不认。
      if (repoPath === '~' || repoPath.startsWith('~/')) repoPath = join(homedir(), repoPath.slice(1)).replace(/[\\/]+$/, '')
      if (!repoPath) throw new Error(t('仓库路径不能为空', 'Repo path cannot be empty'))
      // 0.6.49：先按平台校验写法。踩过的坑：macOS 上把 `D:\dsh-config` 当相对路径，
      // 后续 mkdirSync 会在当前工作目录里真的建出一个叫 `D:\dsh-config` 的目录（本仓库根就留了一个）；
      // 反过来 Windows 也不该接受 /Users/x/dsh-config。被拒的路径整批报错，绝不静默存成别的意思。
      const problem = repoPathProblem(repoPath)
      if (!problem.ok) {
        throw new Error(t(
          problem.reason === 'windows-shape'
            ? `仓库路径要填本机（${platformLabel()}）的绝对路径，不能是 Windows 盘符写法：${repoPath}`
            : (problem.reason === 'posix-absolute'
              ? `仓库路径要填绝对路径（以 / 开头，例如 ${defaultRepoPath()}）：${repoPath}`
              : `仓库路径要填本机（${platformLabel()}）的绝对路径（例如 ${defaultRepoPath()}）：${repoPath}`),
          problem.reason === 'windows-shape'
            ? `Repo path must be an absolute ${platformLabel()} path, not a Windows drive path: ${repoPath}`
            : (problem.reason === 'posix-absolute'
              ? `Repo path must be absolute (starting with /, e.g. ${defaultRepoPath()}): ${repoPath}`
              : `Repo path must be an absolute ${platformLabel()} path (e.g. ${defaultRepoPath()}): ${repoPath}`),
        ))
      }
      // 新机器上这个目录常常还不存在、或者是个空目录（等着首次拉取去初始化）：都允许存。
      // 只有「已经有别的东西、又明显不是 dsh-config 仓库」才拒，免得住错地方把人家目录写乱。
      // 判据统一交给 repoPhase，跟面板、体检那边保持同一套口径；带 .git\HEAD 的目录
      // （可能正克隆到一半）也放行，否则刚 init 完的目录会被拒。
      if (repoPath && repoPhase(repoPath) === 'unusable' && !isFile(join(repoPath, '.git', 'HEAD'))) {
        throw new Error(t(
          `这个目录里已经有别的东西，又不像 dsh-config 仓库（缺 apply.ps1 / sync-engine.mjs 或 profile\\package.json）：${repoPath}`,
          `That directory already holds something else and does not look like a dsh-config repo (no apply.ps1 / sync-engine.mjs or profile\\package.json): ${repoPath}`,
        ))
      }
    }

    let remoteUrl = before.remoteUrl
    if (has('remoteUrl')) {
      remoteUrl = String(body.remoteUrl || '').trim()
      if (!remoteUrl) throw new Error(t('远端地址不能为空', 'Remote URL cannot be empty'))
      if (!REMOTE_RE.test(remoteUrl)) throw new Error(t('远端地址只支持 git@host:path、ssh:// 或 https:// 三种写法', 'Remote URL must be git@host:path, ssh:// or https://'))
    }

    let sshKey = before.sshKey
    if (has('sshKey')) {
      sshKey = String(body.sshKey || '').trim()
      if (sshKey && !isFile(sshKey)) throw new Error(t(`私钥文件不存在：${sshKey}`, `Private key file does not exist: ${sshKey}`))
    }

    // 更新令牌：私有仓库读清单/下包要用。字段没给就沿用原值，明确 clearUpdateToken 才清空。
    let updateToken = before.updateToken
    if (body.clearUpdateToken === true) updateToken = ''
    else if (has('updateToken')) updateToken = String(body.updateToken || '').trim()

    // 更新清单地址：留空=用内置默认；填了必须 http(s)，免得写成半截路径
    let updateManifestUrl = before.updateManifestUrl
    if (body.clearUpdateManifestUrl === true) updateManifestUrl = ''
    else if (has('updateManifestUrl')) {
      updateManifestUrl = String(body.updateManifestUrl || '').trim()
      if (updateManifestUrl && !/^https?:\/\//i.test(updateManifestUrl)) {
        throw new Error(t('清单地址只能是 http(s) 链接；想用内置默认地址就留空', 'The manifest URL must be an http(s) link; leave it empty to use the built-in default'))
      }
    }

    // 备份根：留空 = 恢复默认 <DshHome>\backups；填了必须是绝对路径（相对路径会随 cwd 漂）
    let backupRoot = before.backupRoot
    if (body.clearBackupRoot === true) backupRoot = ''
    else if (has('backupRoot')) {
      backupRoot = String(body.backupRoot || '').trim().replace(/[\\/]+$/, '')
      if (backupRoot && !isAbsolute(backupRoot)) {
        throw new Error(t('备份目录要填绝对路径（例如 D:\\DSH备份）', 'The backup folder must be an absolute path (e.g. D:\\DSH-backups)'))
      }
      if (/["\r\n]/.test(backupRoot)) throw new Error(t('备份路径里不能含引号或换行', 'The backup path must not contain quotes or newlines'))
    }

    // 默认工作区：留空 = 自动（找名字/路径是 default-workspace 的工作区）；off = 不干预；
    // 其它值按工作区 ID 或绝对路径匹配，匹配不到时脚本会跳过并记日志，不会乱指。
    let defaultWorkspace = before.defaultWorkspace
    if (body.clearDefaultWorkspace === true) defaultWorkspace = ''
    else if (has('defaultWorkspace')) {
      defaultWorkspace = String(body.defaultWorkspace || '').trim()
      if (/["\r\n]/.test(defaultWorkspace)) throw new Error(t('默认工作区里不能含引号或换行', 'The default workspace must not contain quotes or newlines'))
    }

    // 两个自动化开关：只能布尔；字段没给就沿用原值（面板保存单个字段时不会把开关冲掉）
    const autoPull = has('autoPull') ? body.autoPull === true : before.autoPull
    const autoPush = has('autoPush') ? body.autoPush === true : before.autoPush
    const autoRestart = has('autoRestart') ? body.autoRestart !== false : before.autoRestart
    // 0.3.76：会话投影缓存守卫开关，字段没给就沿用原值
    const cacheGuard = has('cacheGuard') ? body.cacheGuard !== false : before.cacheGuard

    if (!has('repoPath') && !has('remoteUrl') && !has('sshKey') &&
        !has('autoPull') && !has('autoPush') && !has('autoRestart') &&
        !has('backupRoot') && !has('defaultWorkspace') && !has('cacheGuard') &&
        !has('updateToken') && !has('updateManifestUrl') && body.clearUpdateToken !== true && body.clearUpdateManifestUrl !== true && body.clearBackupRoot !== true && body.clearDefaultWorkspace !== true) {
      throw new Error(t(
        '没有要保存的字段（repoPath / remoteUrl / sshKey / autoPull / autoPush / autoRestart / backupRoot / defaultWorkspace / cacheGuard / updateToken / updateManifestUrl 至少给一个）',
        'Nothing to save (provide at least one of repoPath / remoteUrl / sshKey / autoPull / autoPush / autoRestart / backupRoot / defaultWorkspace / cacheGuard / updateToken / updateManifestUrl)',
      ))
    }

    // 新仓库路径一落盘，后面的 git remote 要对它做，别用改之前解析出来的旧仓库。
    const repo = repoPath || (resolveRepo(config?.repoPath, dshHome).repo || '')
    // 以「磁盘上的原始 JSON」为底：用户这次没提交的字段（尤其 webdav* / syncMode）必须原样留下。
    const rawBefore = readJson(file) || {}
    writeSettings(dshHome, {
      ...rawBefore,
      repoPath, remoteUrl, sshKey, autoPull, autoPush, autoRestart,
      updateToken, updateManifestUrl, backupRoot, defaultWorkspace, cacheGuard,
    })

    const changed = {
      repoPath: before.repoPath !== repoPath,
      remoteUrl: before.remoteUrl !== remoteUrl,
      sshKey: before.sshKey !== sshKey,
      autoPull: before.autoPull !== autoPull,
      autoPush: before.autoPush !== autoPush,
      backupRoot: before.backupRoot !== backupRoot,
      defaultWorkspace: before.defaultWorkspace !== defaultWorkspace,
      cacheGuard: before.cacheGuard !== cacheGuard,
    }
    let gitSet = null
    if (repo && isDir(join(repo, '.git')) && remoteUrl) {
      const current = await git(repo, ['remote', 'get-url', 'origin'])
      if (current !== remoteUrl) {
        // 没有 origin 的新仓库（拷目录/解 tgz 得来的、不是 clone 的）不能 set-url，要先 add。
        const args = current === null
          ? ['-C', repo, 'remote', 'add', 'origin', remoteUrl]
          : ['-C', repo, 'remote', 'set-url', 'origin', remoteUrl]
        const result = await new Promise((resolve) => {
          execFile(resolveGitExe(), args,
            { windowsHide: true, timeout: 20000 }, (err, _out, stderr) => resolve({ err, stderr }))
        })
        if (result.err) {
          // 回滚：设置文件恢复原样，别让面板显示一个 git 并未采用的地址
          if (prevRaw === null) { try { unlinkSync(file) } catch { } } else { writeFileSync(file, prevRaw, 'utf8') }
          throw new Error(t(
            `${current === null ? 'git remote add' : 'git remote set-url'} 失败：${String(result.stderr || result.err.message || result.err).trim()}`,
            `${current === null ? 'git remote add' : 'git remote set-url'} failed: ${String(result.stderr || result.err.message || result.err).trim()}`,
          ))
        }
        gitSet = remoteUrl
      }
    }

    const sshKey2 = sshKey || defaultSshKey()
    sendJson(res, 200, {
      ok: true,
      changed,
      gitRemoteSet: Boolean(gitSet),
      repo: {
        path: repo || '',
        exists: Boolean(repo) && isRepoDir(repo),
        source: repoPath ? 'settings' : (resolveRepo(config?.repoPath, dshHome).source || 'none'),
        hasGit: Boolean(repo) && isDir(join(repo, '.git')),
        hasSync: Boolean(repo) && isFile(join(repo, 'sync.ps1')),
      },
      remote: {
        url: remoteUrl,
        sshKey: sshKey2,
        sshKeyExists: Boolean(sshKey2) && isFile(sshKey2),
        sshKeyFrom: sshKey ? 'settings' : (sshKey2 ? 'default' : 'none'),
        updateTokenSet: Boolean(updateToken),
        updateManifestUrl: updateManifestUrl || '',
        backupRoot: backupRoot || backupRootOf(dshHome, { backupRoot: '' }),
        backupRootCustom: Boolean(backupRoot),
        defaultWorkspace: defaultWorkspace,
        defaultWorkspaceAuto: !defaultWorkspace,
        settingsPath: file,
      },
    })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

/**
 * 插件自身的更新检查。
 *
 * 老版本机器上怎么知道有新版本：插件每次打开面板（以及每 30 分钟）读一次云端仓库根目录的
 * version.json，只比版本号，几百字节，不拉整包。有新版 → 面板标题下多一条「有新版本 x.y.z」
 * 和「更新」按钮；点更新才真正下载 tgz（带 sha256 校验）。
 */
const updateState = {
  checkedAt: 0,
  checking: false,
  manifest: null,   // { version, notes, releasedAt, tgz, sha256 }
  error: '',
  requestUrl: '',   // 用户配置的清单地址（空 = 用内置候选列表）
  url: '',          // 这次实际读到清单的源（tgz 的相对地址按它解析）
  sources: [],      // 依次试过的源与各自结果，面板要能看见"为什么不通"
  // DSH 运行中把包装好之后记在这里：{ version, at, backup, log }
  // 只是本进程内存态：重启后 PLUGIN_VERSION 就是新版本，自然不需要它了
  liveInstall: null,
  // 只下载、不安装时记在这里：{ version, sha256, file, size, at, url }
  // 覆盖插件目录的动作留到 DSH 退出后（post-exit -Mode update），
  // 因为运行中覆盖会让宿主重建插件树、把用户正在看的面板卸载掉。
  prepared: null,
}

function versionParts(v) {
  return String(v || '').replace(/^v/i, '').split(/[.\-+]/).map((x) => Number(String(x).replace(/[^0-9]/g, '')) || 0)
}

/** a>b 返回 1，相等 0，a<b 返回 -1。 */
function compareVersion(a, b) {
  const pa = versionParts(a)
  const pb = versionParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * 0.3.89 起是「npm 双源」；0.6.47 起 npm 成为**唯一**更新源。
 *
 * 旧注释说「npm 包与 GitHub release 的 tgz 是同一份发布产物（实测 sha256 完全一致）」——
 * 这句话是错的，实测：npm pack 产物与 registry 上的 tarball 逐字节一致（sha256 相同），
 * 但与 pnpm pack 的资产**不是同一份**（打包元数据不同，sha256 不同）。
 * 于是旧实现「清单记 pnpm 的 sha256、下载走 npm 兜底」在校验那一步必然失败。
 * 0.6.47 改成单一 npm 源后，校验值取 registry 自己的 dist.integrity / dist.shasum，
 * 权威值与被校验物同源，这个错配从根上没了。
 */
function npmTgzUrls(version, registry = DEFAULT_NPM_REGISTRY) {
  const v = String(version || '').replace(/[^0-9A-Za-z.+\-]/g, '')
  if (!v) return []
  return [npmUrls(registry).tarball(v)]
}
// 兼容旧调用：返回首选 npm 地址
function npmTgzUrl(version, registry = DEFAULT_NPM_REGISTRY) {
  const list = npmTgzUrls(version, registry)
  return list.length ? list[0] : ''
}

/**
 * 0.6.47：下载地址只认 npm 单版本文档里给的 dist.tarball。
 * 没有它才退回按版本号拼 registry 地址（正常不会走到）。
 */
function resolveTgzCandidates(manifest, registry = DEFAULT_NPM_REGISTRY) {
  const tgz = String((manifest && manifest.tgz) || '')
  const npmList = npmTgzUrls(manifest && manifest.version, registry)
  if (!tgz) return npmList.slice()
  if (/^https?:\/\//i.test(tgz)) return [tgz]
  const base = String(registry || DEFAULT_NPM_REGISTRY).replace(/\/+$/, '')
  const rel = tgz.replace(/^\.?\//, '')
  return [`${base}/${rel}`]
}

/** 下载地址：优先用 registry 给的绝对地址，没有才按版本号拼。 */
function resolveTgzUrl(manifest, registry = DEFAULT_NPM_REGISTRY) {
  const list = resolveTgzCandidates(manifest, registry)
  if (list.length) return list[0]
  // 没给 tgz 时保留原来的兜底行为（返回空串，调用方自己报错）
  return ''
}

/**
 * 0.6.47：读 npm 的 dist-tags（几十字节），拿到 latest 指向的版本号。
 * 用 /-/package/<name>/dist-tags 而不是完整 packument —— 后者含全部历史版本，
 * 面板每次打开都拉一遍纯属浪费。
 */
async function fetchNpmLatestVersion(registry = DEFAULT_NPM_REGISTRY, timeoutMs = UPDATE_FETCH_TIMEOUT) {
  if (typeof fetch !== 'function') throw new Error(t('当前运行环境没有 fetch，无法检查更新', 'fetch is unavailable in this runtime — cannot check for updates'))
  const seconds = Math.round(timeoutMs / 1000)
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  let timedOut = false
  const timer = ctrl ? setTimeout(() => { timedOut = true; try { ctrl.abort() } catch { } }, timeoutMs) : null
  try {
    const res = await fetch(npmUrls(registry).distTags, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const latest = json && json.latest
    if (!latest || typeof latest !== 'string') throw new Error(t('npm 的 dist-tags 里没有 latest', 'npm dist-tags has no "latest"'))
    return String(latest)
  } catch (error) {
    if (timedOut) throw new Error(t(`超时（${seconds} 秒内没有响应）`, `timed out (no response in ${seconds}s)`))
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 0.6.47：读 npm 上某个版本的文档（2~3 KB），取 dist.tarball / dist.integrity / dist.shasum。
 * 校验值一律取 registry 自己给的 —— 权威值与被校验物同源，不会出现「清单记 A 的哈希、下载 B 的包」。
 */
async function fetchNpmVersionDoc(version, registry = DEFAULT_NPM_REGISTRY, timeoutMs = UPDATE_FETCH_TIMEOUT) {
  if (typeof fetch !== 'function') throw new Error(t('当前运行环境没有 fetch，无法检查更新', 'fetch is unavailable in this runtime — cannot check for updates'))
  const seconds = Math.round(timeoutMs / 1000)
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  let timedOut = false
  const timer = ctrl ? setTimeout(() => { timedOut = true; try { ctrl.abort() } catch { } }, timeoutMs) : null
  try {
    const res = await fetch(npmUrls(registry).versionDoc(version), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (!json || !json.version) throw new Error(t('npm 上没有这个版本的文档', 'npm has no document for that version'))
    return json
  } catch (error) {
    if (timedOut) throw new Error(t(`超时（${seconds} 秒内没有响应）`, `timed out (no response in ${seconds}s)`))
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 0.6.47：从 npm tarball 里取包内的 release-notes.json（发布说明）。
 * npm tarball 是 gzip 的 tar，只解到内存 —— 只取 release-notes.json 一个文件，
 * tar 里条目按顺序出现，release-notes.json 通常排在 package.json 之后。
 */
function extractReleaseNotesFromTarball(buf) {
  try {
    const tar = gunzipSync(buf)
    // tar 头 512 字节一块；文件名在 0..100，size 在 124..156（八进制字符串）
    for (let off = 0; off + 512 <= tar.length; off += 512) {
      const nameRaw = tar.slice(off, off + 100)
      const zero = nameRaw.indexOf(0)
      const name = zero >= 0 ? nameRaw.slice(0, zero).toString('utf8') : nameRaw.toString('utf8')
      if (!name) continue
      const sizeRaw = tar.slice(off + 124, off + 156).toString('ascii').replace(/\0.*$/, '').trim()
      const size = parseInt(sizeRaw, 8) || 0
      const body = off + 512
      const base = name.replace(/^\.\//, '')
      if (base === 'package/release-notes.json' || base === 'release-notes.json') {
        if (size > 0 && body + size <= tar.length) return JSON.parse(tar.slice(body, body + size).toString('utf8'))
      }
      off += Math.ceil(size / 512) * 512
    }
  } catch { /* 解不出来就当没有说明文字 */ }
  return null
}

/** 仅向直连官方域传令牌（绝不把令牌发给第三方反代 gh-proxy / ghfast）。 */
function authHeadersForUrl(url, token) {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    if (host === 'api.github.com') {
      const headers = {
        Accept: u.pathname.includes('/contents/') ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': PACKAGE_ID,
      }
      if (token) headers.Authorization = `Bearer ${token}`
      return headers
    }
    if (token && (host === 'raw.githubusercontent.com' || host === 'github.com' || host.endsWith('.github.com'))) {
      return { Authorization: `Bearer ${token}`, 'User-Agent': PACKAGE_ID }
    }
  } catch { }
  return {}
}

function isGithubUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase()
    return host === 'github.com' || host.endsWith('.github.com') || host === 'raw.githubusercontent.com' || host === 'api.github.com'
  } catch { return false }
}

/** 解析更新检查/下载用的令牌：自定义非 GitHub 地址不自动借用本机 GitHub 登录态。 */
async function resolveUpdateToken(settings, customUrl = '') {
  const custom = String(customUrl || '').trim()
  const spec = resolveTokenSpec(settings.updateToken, custom && !isGithubUrl(custom) ? [] : GH_TOKEN_ENV_CANDIDATES)
  if (spec.token) return spec
  if (custom && !isGithubUrl(custom)) return spec
  const cred = await credFromGitCredential()
  if (cred.token) return { token: cred.token, source: 'git-credential', envName: '', rawRef: false }
  const cliTok = await tokenFromGhCli()
  if (cliTok) return { token: cliTok, source: 'gh-cli', envName: '', rawRef: false }
  return spec
}

/**
 * 0.6.47：旧的「清单」读取路径整体退休。
 *
 * 原来是「读 GitHub 仓库根的 version.json」（raw / API / gh-proxy / ghfast 依次试），
 * 现在更新检查只查 npm，GitHub 不再参与 —— fetchManifestAuto / fetchManifest 连同
 * UPDATE_MANIFEST_MIRRORS 一起删掉，避免留下「看起来还在用」的分支。
 * 保留 withAccessToken / authHeadersForUrl：下载环节还可能碰到 Gitee 私有库与 GitHub 资产的旧配置。
 */

/**
 * 私有仓库的 raw 链接匿名读会 403，必须换成 Gitee API 的 raw 端点再带 access_token。
 * 注意 API 的 raw 端点不吃"分支写进路径"，分支要单独给 ref：
 *   https://gitee.com/<owner>/<repo>/raw/<branch>/<path>
 * → https://gitee.com/api/v5/repos/<owner>/<repo>/raw/<path>?ref=<branch>&access_token=…
 * 公开库与第三方反代（gh-proxy / ghfast）不拼入令牌，避免泄露给中间代理。
 */
function withAccessToken(url, token) {
  const raw = String(url || '')
  if (!token) return raw
  try {
    const host = new URL(raw).hostname.toLowerCase()
    if (host !== 'gitee.com' && !host.endsWith('.gitee.com')) return raw
  } catch { return raw }
  let target = raw
  const m = /^https:\/\/gitee\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/.exec(raw.split('?')[0])
  if (m) target = `https://gitee.com/api/v5/repos/${m[1]}/${m[2]}/raw/${m[4]}?ref=${encodeURIComponent(m[3])}`
  const sep = target.includes('?') ? '&' : '?'
  return target + sep + 'access_token=' + encodeURIComponent(token)
}

async function checkUpdate({ force = false, registry = '', settings = {} } = {}) {
  const reg = String(registry || effectiveNpmRegistry(settings))
  const now = Date.now()
  if (!force && updateState.requestUrl === reg && updateState.checkedAt && now - updateState.checkedAt < UPDATE_CHECK_TTL && (updateState.manifest || updateState.error)) {
    return updateState
  }
  updateState.checking = true
  updateState.requestUrl = reg
  updateState.token = ''
  try {
    // 0.6.47：只查 npm。GitHub release 不再参与更新检查。
    const got = await fetchNpmLatest(reg)
    updateState.manifest = got.manifest
    updateState.url = got.url
    updateState.sources = got.tried
    updateState.error = ''
  } catch (error) {
    updateState.manifest = null
    if (Array.isArray(error && error.sources)) updateState.sources = error.sources
    updateState.error = String((error && error.message) || error)
  } finally {
    updateState.checking = false
    updateState.checkedAt = Date.now()
  }
  return updateState
}

/**
 * 0.6.47：更新检查的唯一实现 —— 读 npm。
 *
 * 流程：
 *   1) dist-tags 拿 latest 的版本号（几十字节）；
 *   2) 该版本的单版本文档拿 dist.tarball / dist.integrity / dist.shasum（2~3 KB）；
 *   3) 发布说明从 npm tarball 里的 package/release-notes.json 读（不解包到磁盘，只在内存里解 gzip+tar）。
 *
 * 为什么第 3 步要下整包：npm 的单版本文档里没有发布说明（那是 GitHub release 的内容，
 * 而用户明确要求更新检查不查 GitHub）。tarball 400 多 KB，只在有新版本时才读一次。
 */
async function fetchNpmLatest(registry = DEFAULT_NPM_REGISTRY) {
  const u = npmUrls(registry)
  const tried = []
  const record = (url, ok, error) => {
    let host = url
    try { host = new URL(url).host } catch { }
    tried.push({ url, host, ok, ...(error ? { error } : {}) })
  }
  let latestVersion = ''
  try {
    latestVersion = await fetchNpmLatestVersion(registry)
    record(u.distTags, true)
  } catch (error) {
    record(u.distTags, false, String((error && error.message) || error))
    const detail = tried.map((x) => `${x.host}：${x.error}`).join('；')
    const err = new Error(t(`读不到 npm 的版本信息（${detail}）`, `Cannot read the version list from npm (${detail})`))
    err.sources = tried
    throw err
  }
  if (compareVersion(latestVersion, PLUGIN_VERSION) <= 0) {
    // 本机已经是 npm 上的最新版：不必再拉版本文档，省一次请求。
    // 但下载地址要能给出来 —— 面板会显示它，也便于手工核对。
    return {
      manifest: {
        version: latestVersion, notes: '', notesEn: '', releasedAt: '',
        tgz: u.tarball(latestVersion), sha256: '', integrity: '', sha1: '', source: 'npm',
      },
      url: u.distTags,
      tried,
    }
  }
  let doc = null
  try {
    doc = await fetchNpmVersionDoc(latestVersion, registry)
    record(u.versionDoc(latestVersion), true)
  } catch (error) {
    record(u.versionDoc(latestVersion), false, String((error && error.message) || error))
    const detail = tried.map((x) => `${x.host}：${x.error}`).join('；')
    const err = new Error(t(`读不到 npm 上 ${latestVersion} 的包信息（${detail}）`, `Cannot read the package info for ${latestVersion} from npm (${detail})`))
    err.sources = tried
    throw err
  }
  const dist = (doc && doc.dist) || {}
  const tarball = String(dist.tarball || '')
  const manifest = {
    version: String(doc.version || latestVersion),
    notes: '',
    notesEn: '',
    releasedAt: '',
    tgz: tarball,
    // npm 给的权威校验值：integrity 是 sha512（SRI），shasum 是 sha1。
    // 两者都取，下载时优先用 integrity（更强），退回 shasum。
    integrity: String(dist.integrity || ''),
    sha1: String(dist.shasum || ''),
    sha256: '',
    source: 'npm',
  }
  // 发布说明：下 tarball 从里面取 release-notes.json。
  // 缓存按「版本+integrity」记：同一次会话里反复点「检查更新」不该反复下 400KB。
  if (tarball) {
    const cacheKey = `${manifest.version}|${manifest.integrity}`
    const cached = notesCache.get(cacheKey)
    if (cached) {
      manifest.notes = cached.notes
      manifest.notesEn = cached.notesEn
      manifest.releasedAt = cached.releasedAt
      manifest.pkgSha256 = cached.pkgSha256
    } else {
      try {
        const buf = await fetchTarballBuffer(tarball)
        const inner = extractReleaseNotesFromTarball(buf)
        if (inner && typeof inner === 'object') {
          manifest.notes = String(inner.notes || '')
          manifest.notesEn = String(inner.notesEn || '')
          manifest.releasedAt = String(inner.releasedAt || '')
          // 包内 version.json 的 sha256 是打包时那份 tgz 的哈希，和 npm tarball 不是同一份，
          // 所以**不用**它做校验（校验用 registry 的 integrity/shasum）。
          manifest.pkgSha256 = String(inner.sha256 || '')
        }
        notesCache.set(cacheKey, {
          notes: manifest.notes, notesEn: manifest.notesEn,
          releasedAt: manifest.releasedAt, pkgSha256: manifest.pkgSha256,
        })
      } catch (error) {
        record(tarball, false, String((error && error.message) || error))
        // 取不到说明文字不算失败：版本号与下载地址已经拿到了
      }
    }
  }
  return { manifest, url: u.versionDoc(manifest.version), tried }
}

/** 下载 npm tarball 到内存（只用于取包内 release-notes.json）。 */
async function fetchTarballBuffer(url, timeoutMs = 120 * 1000) {
  if (typeof fetch !== 'function') throw new Error(t('当前运行环境没有 fetch', 'fetch is unavailable in this runtime'))
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort() } catch { } }, timeoutMs) : null
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error(t('下载到的包是空的', 'the downloaded package is empty'))
    return buf
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 发布说明缓存：key = 版本|integrity。同一次会话里反复点「检查更新」不该反复下 400KB 的包。
const notesCache = new Map()

function updatePayload(state, settings = {}, resolvedToken = null) {
  const remote = state.manifest
  const installed = state.liveInstall || null
  const reg = effectiveNpmRegistry(settings)
  const u = npmUrls(reg)
  // 装好了但进程还在跑旧代码 = 需要重启；重启后 PLUGIN_VERSION 追上来，这条自然消失
  const restartRequired = Boolean(installed && compareVersion(installed.version, PLUGIN_VERSION) > 0)
  return {
    ok: !state.error,
    local: { version: PLUGIN_VERSION || t('未知', 'unknown'), dir: PLUGIN_DIR },
    // 更新相关的配置集中在这里。0.6.47 起更新源固定是 npm：
    // 清单地址/令牌这两项对 npm 都不再适用（npm 公开包不需要令牌，也没有可换的清单地址）。
    // registry 可被设置或环境变量覆盖（换镜像 / 夹具用本地服务器），但仍然是「只查 npm」。
    config: {
      source: 'npm',
      packageName: NPM_PACKAGE_NAME,
      registry: reg,
      registryIsDefault: reg === DEFAULT_NPM_REGISTRY,
      manifestUrl: u.distTags,
      manifestUrlIsDefault: true,
      manifestSources: [u.distTags],
      tokenSet: false,
      tokenSaved: false,
      tokenSource: resolvedToken && resolvedToken.source ? resolvedToken.source : '',
      tokenEnv: resolvedToken && resolvedToken.envName ? resolvedToken.envName : '',
    },
    remote: remote ? {
      version: String(remote.version || ''),
      notes: String(remote.notes || ''),
      // 清单里的说明是中英两份（notes / notesEn），由客户端按自己的语言挑
      notesEn: String(remote.notesEn || ''),
      releasedAt: String(remote.releasedAt || ''),
      tgz: resolveTgzUrl(remote, reg),
      // npm 下载地址（单一来源，与被校验物同源）
      npmTgz: String(remote.tgz || ''),
      npmTgzUrls: remote.tgz ? [String(remote.tgz)] : [],
      sha256: String(remote.sha256 || ''),
      // registry 给的权威校验值
      integrity: String(remote.integrity || ''),
      sha1: String(remote.sha1 || ''),
    } : null,
    hasUpdate: remote ? compareVersion(remote.version, PLUGIN_VERSION) > 0 : false,
    checking: state.checking,
    checkedAt: state.checkedAt || 0,
    error: state.error || '',
    // 这次实际用上的源，以及每个源的成败 —— 检查失败时面板直接把原因列出来
    sourceUsed: state.url || '',
    sources: Array.isArray(state.sources) ? state.sources : [],
    installed,
    // 已经下到暂存目录、等着退出后安装的那个包；ready = 版本比当前进程里的新
    prepared: state.prepared
      ? {
        version: String(state.prepared.version || ''),
        file: String(state.prepared.file || ''),
        size: Number(state.prepared.size) || 0,
        sha256: String(state.prepared.sha256 || ''),
        // 0.6.47：记下这次是按哪个校验值过的 —— 面板/日志能看出「校验到底做了没有」
        integrity: String(state.prepared.integrity || ''),
        sha1: String(state.prepared.sha1 || ''),
        verifiedBy: String(state.prepared.verifiedBy || ''),
        verifiedAlgo: String(state.prepared.verifiedAlgo || ''),
        at: Number(state.prepared.at) || 0,
        ready: compareVersion(state.prepared.version, PLUGIN_VERSION) > 0,
      }
      : null,
    restartRequired,
    pending: autoState.pending,
  }
}

/**
 * 把新版本的包**只下载到暂存目录**，一个字节都不碰插件目录。
 *
 * 为什么不能边运行边装：覆盖插件目录会让宿主重新同步插件树，把「配置同步」这个 main 面板
 * 卸载掉 —— 用户正在看的页面在装到一半时自己跳走，还得点回来才能按「重启」。
 * 所以把流程拆成两段：这里只负责落盘 + 校验 sha256，真正的覆盖交给退出后的 post-exit。
 *
 * 候选地址逐个试（raw 常常不通，反代在前面兜着），全失败时把每个源的原因汇总抛出。
 * 返回 { ok, file, size, sha256, url } 或 { ok:false, error }
 */
/** 私有 GitHub Release 资产必须通过 API + Accept: application/octet-stream 取，重定向后剥掉 Authorization。 */
async function fetchGithubReleaseAsset(url, token, timeoutMs = 120 * 1000) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/?#]+)/i.exec(String(url || ''))
  if (!m || !token) return null
  const [, owner, repo, tag, assetName] = m
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`
  const apiHeaders = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': PACKAGE_ID, Authorization: `Bearer ${token}` }
  const relRes = await fetch(apiUrl, { cache: 'no-store', headers: apiHeaders, signal: AbortSignal.timeout(timeoutMs) })
  if (!relRes.ok) throw new Error(`GitHub Release API HTTP ${relRes.status}`)
  const rel = await relRes.json()
  const asset = (Array.isArray(rel && rel.assets) ? rel.assets : []).find((a) => a && a.name === decodeURIComponent(assetName))
  if (!asset || !asset.url) throw new Error(t(`Release ${tag} 里找不到资产 ${assetName}`, `Asset ${assetName} not found in release ${tag}`))
  const assetRes = await fetch(asset.url, {
    cache: 'no-store',
    redirect: 'manual',
    headers: { Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': PACKAGE_ID, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (assetRes.status >= 300 && assetRes.status < 400) {
    const loc = assetRes.headers.get('location')
    if (!loc) throw new Error(`HTTP ${assetRes.status}`)
    const s3Res = await fetch(loc, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    if (!s3Res.ok) throw new Error(`HTTP ${s3Res.status}`)
    return Buffer.from(await s3Res.arrayBuffer())
  }
  if (!assetRes.ok) throw new Error(`HTTP ${assetRes.status}`)
  return Buffer.from(await assetRes.arrayBuffer())
}

/**
 * 0.6.47：校验下载到的包。
 *
 * 权威校验值取自 npm registry 自己的 dist.integrity（SRI，通常 sha512）/ dist.shasum（sha1），
 * 与被校验物同源。旧实现用 version.json 里的 sha256 —— 那是**打包时那份 tgz**的哈希，
 * 而 npm 上的 tarball 与它不是同一份字节流（npm pack 与 registry 上的 tarball 逐字节一致，
 * 但与 pnpm pack 的资产不同），所以旧校验对 npm 下载必然失败。
 *
 * 三种校验值都收：integrity 优先，其次 shasum（sha1），最后才是 sha256（兼容旧路径）。
 * 一个都没有时**不校验**（放行）—— 但要如实记下来，不能假装校验过。
 */
function verifyDownloadedPackage(buf, { integrity = '', sha1 = '', sha256 = '' } = {}) {
  const sri = String(integrity || '').trim()
  if (sri) {
    // SRI 形如 "sha512-<base64>"，可能有多条（空格分隔），任一条对上即可
    const parts = sri.split(/\s+/).filter(Boolean)
    for (const part of parts) {
      const dash = part.indexOf('-')
      if (dash <= 0) continue
      const algo = part.slice(0, dash).toLowerCase()
      const b64 = part.slice(dash + 1)
      if (!/^sha(?:256|384|512)$/.test(algo)) continue
      const digest = createHash(algo).update(buf).digest('base64')
      if (digest === b64) return { ok: true, algo, verified: 'integrity' }
    }
    return { ok: false, error: t('包的 integrity 校验不通过', 'integrity verification failed') }
  }
  const want1 = String(sha1 || '').trim().toLowerCase()
  if (want1) {
    const got = createHash('sha1').update(buf).digest('hex')
    if (got !== want1) return { ok: false, error: t(`sha1 不一致（拿到 ${got}）`, `sha1 mismatch (got ${got})`) }
    return { ok: true, algo: 'sha1', verified: 'shasum' }
  }
  const want256 = String(sha256 || '').trim().toLowerCase()
  if (want256) {
    const got = createHash('sha256').update(buf).digest('hex')
    if (got !== want256) return { ok: false, error: t(`sha256 不一致（拿到 ${got}）`, `sha256 mismatch (got ${got})`) }
    return { ok: true, algo: 'sha256', verified: 'sha256' }
  }
  return { ok: true, algo: '', verified: 'none' }
}

async function downloadPackage({ urls, sha256, integrity = '', sha1 = '', version, dshHome, token = '' }) {
  if (typeof fetch !== 'function') return { ok: false, error: t('当前运行环境没有 fetch，无法下载更新包', 'fetch is unavailable in this runtime — cannot download the update package') }
  const dir = join(dshHome, 'update-staging')
  try { mkdirSync(dir, { recursive: true }) } catch { }
  const file = join(dir, `dsh-profile-config-sync-${version}.tgz`)
  const errors = []
  for (const rawUrl of urls) {
    const url = String(rawUrl || '').trim()
    if (!url) continue
    try {
      let buf = null
      if (token && /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//i.test(url)) {
        try { buf = await fetchGithubReleaseAsset(url, token) } catch { buf = null }
      }
      if (!buf) {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null
        const timer = ctrl ? setTimeout(() => { try { ctrl.abort() } catch { } }, 120 * 1000) : null
        const headers = authHeadersForUrl(url, token)
        const reqUrl = Object.keys(headers).length ? url : withAccessToken(url, token)
        let res
        try {
          res = await fetch(reqUrl, { cache: 'no-store', headers, signal: ctrl ? ctrl.signal : undefined })
        } finally {
          if (timer) clearTimeout(timer)
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        buf = Buffer.from(await res.arrayBuffer())
      }
      if (!buf.length) throw new Error(t('下载到的文件是空的', 'the downloaded file is empty'))
      const verdict = verifyDownloadedPackage(buf, { integrity, sha1, sha256 })
      if (!verdict.ok) throw new Error(String(verdict.error))
      const hash = createHash('sha256').update(buf).digest('hex')
      writeFileSync(file, buf)
      return { ok: true, file, size: buf.length, sha256: hash, url, verifiedBy: verdict.verified, verifiedAlgo: verdict.algo }
    } catch (error) {
      let host = url
      try { host = new URL(url).host } catch { }
      errors.push(`${host}：${(error && error.message) || String(error)}`)
    }
  }
  return { ok: false, error: t('下载更新包失败（每个地址都试过了）：', 'cannot download the update package (every URL was tried): ') + errors.join(t('；', '; ')) }
}

/**
 * 运行中直接把新版本装进插件目录（不退出 DSH）。
 *
 * 注意：界面**不再走这条**。运行中覆盖插件目录会让宿主把当前面板卸载掉，
 * 用户看到的就是"更新到一半页面自己跳走"。面板改为「prepare 下载 → 退出后安装」，
 * 见 downloadPackage 的注释。这个函数留给 CLI / 兼容场景。
 *
 * 为什么当年能这么干：插件的 ps1 只是磁盘上的脚本，index.js 已经读进内存 —— 覆盖文件不会让当前进程崩，
 * 只是"文件是新的、进程还是旧的"，所以装完必须提示重启才生效。
 * 真正干活的是 runtime/install-plugin.ps1：它自己依次尝试候选下载地址、校验 sha256、解包、
 * 备份旧目录（<DshHome>\backups\plugin-<旧版本>-<时间戳>）、覆盖，失败就把备份拷回去。
 * 返回 { ok, version, backup, log, error }
 */
function runInstallPlugin({ version, sha256, integrity = '', sha1 = '', urls, dshHome }) {
  // 0.6.49：执行体随平台走。非 Windows 用 install-plugin.mjs（原来只找 .ps1，
  // 于是 macOS 上 install-live 永远返回「插件目录里没有 runtime\install-plugin.ps1」）。
  const script = IS_WIN
    ? join(PLUGIN_DIR, 'runtime', 'install-plugin.ps1')
    : join(PLUGIN_DIR, 'runtime', 'install-plugin.mjs')
  if (!isFile(script)) {
    const name = IS_WIN ? 'install-plugin.ps1' : 'install-plugin.mjs'
    return Promise.resolve({ ok: false, error: t(`插件目录里没有 runtime\\${name}`, `runtime/${name} is missing from the plugin directory`) })
  }
  const parse = (err, stdout, stderr) => {
    const text = String(stdout || '') + String(stderr || '')
    // 执行体最后一行固定是 RESULT:{json}；前面是给人看的进度
    const line = text.split(/\r?\n/).filter((l) => l.startsWith('RESULT:')).pop()
    if (!line) {
      return { ok: false, error: t('安装脚本没有返回结果：', 'The installer returned no result: ') + (text.trim().slice(-400) || String((err && err.message) || '无输出')) }
    }
    try { return JSON.parse(line.slice('RESULT:'.length)) } catch { return { ok: false, error: t('安装脚本返回的结果不是合法 JSON', 'The installer result is not valid JSON') } }
  }
  if (!IS_WIN) {
    const nodeExe = hostNodeExe(resolveAppRoot('')) || process.execPath
    const args = [script,
      '-PluginDir', PLUGIN_DIR,
      '-Version', String(version || ''),
      '-Sha256', String(sha256 || ''),
      ...(integrity ? ['-Integrity', String(integrity)] : []),
      ...(sha1 ? ['-Sha1', String(sha1)] : []),
      '-TgzUrls', urls.join('|'),
      '-DshHome', dshHome,
    ]
    return new Promise((resolve) => {
      execFile(nodeExe, args, { timeout: 6 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve(parse(err, stdout, stderr))
      })
    })
  }
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const ps = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-PluginDir', PLUGIN_DIR,
    '-Version', String(version || ''),
    '-Sha256', String(sha256 || ''),
    ...(integrity ? ['-Integrity', String(integrity)] : []),
    ...(sha1 ? ['-Sha1', String(sha1)] : []),
    '-TgzUrls', urls.join('|'),
    '-DshHome', dshHome,
  ]
  return new Promise((resolve) => {
    execFile(ps, args, { windowsHide: true, timeout: 6 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(parse(err, stdout, stderr))
    })
  })
}

/**
 * 更新接口：
 *   GET  /config-sync/update             读缓存（30 分钟内不重复拉）
 *   POST {action:'check'}                强制重新检查
 *   POST {action:'install-live'}         运行中下载+校验+覆盖安装（不退出 DSH），装完提示重启生效
 *   POST {action:'restart'}              排队"退出后重启"，立刻关闭 DSH，由退出后的脚本用 explorer 代启拉回来
 *   POST {action:'apply'}                兜底：退出 DSH → 可见窗口下载/校验/安装 → 自动重启
 */
async function handleUpdate(req, res, config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const settings = readSettings(dshHome)
  // 0.6.47：更新源固定是 npm，没有可配置的清单地址，也不需要令牌。
  // 旧设置里的 updateManifestUrl / updateToken 保留在配置文件里不删（用户自己填的东西不该被悄悄抹掉），
  // 但更新检查不再读它们 —— 面板上那两栏也一并撤掉。
  try {
    if (req.method === 'GET') {
      sendJson(res, 200, updatePayload(await checkUpdate({ settings }), settings, null))
      return
    }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET or POST only' }); return }
    if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
    // 先读 body 再解析：读 body 之前不能有 await，否则请求流可能已经被读空/结束，
    // 事件监听挂晚了就永远等不到 'end'（实测：把令牌解析提到前面会让所有 POST 一直挂住）。
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const action = String(body.action || 'check')

    if (action === 'check') {
      clearWinEnvCache()
      const state = await checkUpdate({ force: true, settings })
      sendJson(res, 200, { ok: !state.error, action, ...updatePayload(state, settings, null) })
      return
    }

    // 只下载：把包落到 <DshHome>\update-staging\，校验 sha256，**不动插件目录**。
    // 面板点「下载更新」走这条 —— 页面不会因为插件被改写而重置。
    if (action === 'prepare') {
      const state = await checkUpdate({ force: true, settings })
      const remote = state.manifest
      if (!remote) throw new Error(t(`读不到更新清单：${state.error || '未知原因'}`, `Cannot read the update manifest: ${state.error || 'unknown reason'}`))
      if (compareVersion(remote.version, PLUGIN_VERSION) <= 0) {
        throw new Error(t(`已经是最新版本（${PLUGIN_VERSION}），无需更新`, `Already on the latest version (${PLUGIN_VERSION}) — no update needed`))
      }
      // 同一个版本已经下好就不重复下（DSH 一直开着时用户可能点第二次）
      const prev = updateState.prepared
      if (prev && prev.version === String(remote.version) && isFile(prev.file)) {
        sendJson(res, 200, { ok: true, action, prepared: prev, ...updatePayload(state, settings, null) })
        return
      }
      const urls = resolveTgzCandidates(remote, effectiveNpmRegistry(settings))
      if (!urls.length) throw new Error(t('npm 上没有给下载地址', 'npm gave no download URL'))
      const got = await downloadPackage({
        urls,
        integrity: String(remote.integrity || ''),
        sha1: String(remote.sha1 || ''),
        sha256: String(remote.sha256 || ''),
        version: String(remote.version),
        dshHome,
      })
      if (!got.ok) throw new Error(String(got.error || t('下载失败', 'download failed')))
      updateState.prepared = {
        version: String(remote.version),
        sha256: got.sha256,
        file: got.file,
        size: got.size,
        at: Date.now(),
        url: got.url,
        verifiedBy: got.verifiedBy || '',
        verifiedAlgo: got.verifiedAlgo || '',
        integrity: String(remote.integrity || ''),
        sha1: String(remote.sha1 || ''),
      }
      sendJson(res, 200, { ok: true, action, prepared: updateState.prepared, ...updatePayload(state, settings, null) })
      return
    }

    // 装并重启：退出 DSH → 退出后的脚本用**已经下好的本地包**覆盖安装 → 自动拉起
    // 覆盖发生在 DSH 已退出之后，所以运行中的面板不会被打断，用户也不会被弹走。
    if (action === 'install-restart') {
      const prepared = updateState.prepared
      if (!prepared || !isFile(prepared.file)) {
        throw new Error(t('还没有下好的更新包，请先点「下载更新」', 'No downloaded package yet — click "Download update" first'))
      }
      if (compareVersion(prepared.version, PLUGIN_VERSION) <= 0) {
        updateState.prepared = null
        throw new Error(t(`已经是最新版本（${PLUGIN_VERSION}），无需安装`, `Already on the latest version (${PLUGIN_VERSION}) — nothing to install`))
      }
      const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
      const appRoot = resolveAppRoot(config?.appRoot) || ''
      const started = await spawnWatcher({
        mode: 'update',
        repo,
        appRoot,
        dshHome,
        restart: true,
        closeRequested: true,
        extraArgs: [
          '-PluginDir', PLUGIN_DIR,
          '-UpdateTgz', prepared.file,
          '-UpdateVersion', String(prepared.version),
          '-UpdateSha256', String(prepared.sha256 || ''),
          ...(prepared.integrity ? ['-UpdateIntegrity', String(prepared.integrity)] : []),
        ],
      })
      if (!started.ok) throw new Error(started.error)
      autoState.pending = { mode: 'update', at: Date.now(), version: String(prepared.version), restart: true, watcherPid: started.pid, installFrom: prepared.file }
      const closed = closeDsh()
      autoState.pending.closeRequested = closed
      sendJson(res, 200, { ok: true, action, started: true, pending: autoState.pending, closeRequested: closed, ...updatePayload(await checkUpdate({ force: false, settings }), settings, null) })
      return
    }

    // 运行中直接装（不退出 DSH，**界面已不再使用**，留给 CLI/兼容）：下载 → 校验 sha256 → 备份旧版 → 覆盖插件目录
    if (action === 'install-live') {
      const state = await checkUpdate({ force: true, settings })
      const remote = state.manifest
      if (!remote) throw new Error(t(`读不到更新清单：${state.error || '未知原因'}`, `Cannot read the update manifest: ${state.error || 'unknown reason'}`))
      if (compareVersion(remote.version, PLUGIN_VERSION) <= 0) {
        throw new Error(t(`已经是最新版本（${PLUGIN_VERSION}），无需更新`, `Already on the latest version (${PLUGIN_VERSION}) — no update needed`))
      }
      const urls = resolveTgzCandidates(remote, effectiveNpmRegistry(settings))
      if (!urls.length) throw new Error(t('npm 上没有给下载地址', 'npm gave no download URL'))
      // 包只有一百多 KB，同步做完再回包：前端把按钮置灰等这一下就够了
      const report = await runInstallPlugin({
        version: String(remote.version),
        sha256: String(remote.sha256 || ''),
        integrity: String(remote.integrity || ''),
        sha1: String(remote.sha1 || ''),
        urls,
        dshHome,
      })
      if (!report.ok) throw new Error(String(report.error || t('安装失败', 'install failed')))
      updateState.liveInstall = {
        version: String(remote.version),
        at: Date.now(),
        backup: String(report.backup || ''),
        log: String(report.log || ''),
      }
      // 注意 hasUpdate 仍是 true：进程里跑的还是旧代码，重启后 PLUGIN_VERSION 才追上来。
      // 面板靠 restartRequired 换成「已装好，重启生效」
      sendJson(res, 200, { ok: true, action, installed: updateState.liveInstall, ...updatePayload(state, settings, null) })
      return
    }

    // 只重启：排队"退出后拉起"，由 post-exit 的 relaunch 模式用 explorer 代启（不继承本窗口作业）
    if (action === 'restart') {
      const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
      const appRoot = resolveAppRoot(config?.appRoot) || ''
      const started = await spawnWatcher({ mode: 'relaunch', repo, appRoot, dshHome, restart: true })
      if (!started.ok) throw new Error(started.error)
      autoState.pending = { mode: 'relaunch', at: Date.now(), restart: true, watcherPid: started.pid }
      const closed = closeDsh()
      autoState.pending.closeRequested = closed
      sendJson(res, 200, { ok: true, action, pending: autoState.pending, closeRequested: closed })
      return
    }

    if (action === 'apply') {
      const state = await checkUpdate({ force: true, settings })
      const remote = state.manifest
      if (!remote) throw new Error(t(`读不到更新清单：${state.error || '未知原因'}`, `Cannot read the update manifest: ${state.error || 'unknown reason'}`))
      if (compareVersion(remote.version, PLUGIN_VERSION) <= 0) {
        throw new Error(t(`已经是最新版本（${PLUGIN_VERSION}），无需更新`, `Already on the latest version (${PLUGIN_VERSION}) — no update needed`))
      }
      const tgz = resolveTgzUrl(remote, effectiveNpmRegistry(settings))
      if (!tgz) throw new Error(t('npm 上没有给下载地址', 'npm gave no download URL'))
      const notes = String((langStore.getStore() === 'en' ? (remote.notesEn || remote.notes) : remote.notes) || '').trim()
      const yes = await askConfirm(
        t('更新「配置备份与同步」插件', 'Update the Config Backup & Sync plugin'),
        t(
          `把插件从 ${PLUGIN_VERSION} 更新到 ${remote.version}？`
          + (notes ? `\n\n${notes}` : '')
          + '\n\n更新过程：退出 DSH → 下载并校验安装包 → 备份旧版 → 覆盖安装 → 自动重启。',
          `Update the plugin from ${PLUGIN_VERSION} to ${remote.version}?`
          + (notes ? `\n\n${notes}` : '')
          + '\n\nSteps: exit DSH → download and verify the package → back up the old version → install over it → relaunch automatically.',
        ),
      )
      if (!yes) { sendJson(res, 200, { ok: true, action, cancelled: true, ...updatePayload(state, settings, null) }); return }

      const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
      const appRoot = resolveAppRoot(config?.appRoot) || ''
      const started = await spawnWatcher({
        mode: 'update',
        repo,
        appRoot,
        dshHome,
        restart: true,
        closeRequested: true,
        extraArgs: [
          '-PluginDir', PLUGIN_DIR,
          '-UpdateVersion', String(remote.version),
          '-UpdateTgz', tgz,
          '-UpdateSha256', String(remote.sha256 || ''),
          ...(remote.integrity ? ['-UpdateIntegrity', String(remote.integrity)] : []),
          ...(remote.sha1 ? ['-UpdateSha1', String(remote.sha1)] : []),
        ],
      })
      if (!started.ok) throw new Error(started.error)
      autoState.pending = { mode: 'update', at: Date.now(), version: String(remote.version), restart: true, watcherPid: started.pid }
      const closed = closeDsh()
      autoState.pending.closeRequested = closed
      sendJson(res, 200, { ok: true, action, started: true, pending: autoState.pending, closeRequested: closed })
      return
    }

    throw new Error(t('action 只能是 check / install-live / restart / apply', 'action must be check / install-live / restart / apply'))
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

/* ------------------------------------------------------------------------- *
 * 同步内容勾选（scope）
 *
 * 面板「同步内容」卡片的数据落点：<DshHome>\config-sync-scope.json。
 * capture.ps1 / apply.ps1 读的是**同一个文件**，所以面板上的勾选立刻对
 * 「推送」和「拉取」两侧生效。文件不存在 = 全勾（保持老行为）。
 *
 * 语义：未勾选 = 推送不抓、拉取不还原；deleteCloud（默认关闭）打开时才顺带删掉仓库副本。
 * ------------------------------------------------------------------------- */

function scopePath(dshHome) {
  return join(dshHome, 'config-sync-scope.json')
}

function readScope(dshHome) {
  const fallback = { version: 1, deleteCloud: false, groups: {} }
  try {
    const obj = readJson(scopePath(dshHome))
    if (!obj || typeof obj !== 'object') return fallback
    return {
      version: 1,
      deleteCloud: obj.deleteCloud === true,
      groups: (obj.groups && typeof obj.groups === 'object') ? obj.groups : {},
    }
  } catch {
    return fallback
  }
}

function writeScope(dshHome, scope) {
  const file = scopePath(dshHome)
  try { mkdirSync(dirname(file), { recursive: true }) } catch { }
  const payload = JSON.stringify({
    version: 1,
    deleteCloud: scope.deleteCloud === true,
    groups: scope.groups && typeof scope.groups === 'object' ? scope.groups : {},
  }, null, 2) + '\n'
  writeFileSync(file, payload, 'utf8')
  return file
}

// 必需组：不许取消勾选 —— 因为不勾就会报错，而不是"少同步一点"。
// profile 里的 package.json / cordis.patch.yml 是 apply 的前置条件（仓库里缺它们 apply.ps1 直接 Die），
// host-contract.json 是两端版本一致性校验（丢了它版本不一致也照铺，客户端可能起不来）。
const SCOPE_REQUIRED_GROUPS = ['profile']
function scopeGroupRequired(id) { return SCOPE_REQUIRED_GROUPS.includes(id) }

function scopeGroupEnabled(scope, id) {
  if (scopeGroupRequired(id)) return true
  const g = scope && scope.groups ? scope.groups[id] : null
  if (!g || typeof g !== 'object') return true
  return g.enabled !== false
}

function scopeItemEnabled(scope, id, item) {
  if (scopeGroupRequired(id)) return true
  if (!scopeGroupEnabled(scope, id)) return false
  const g = scope.groups ? scope.groups[id] : null
  const ex = g && Array.isArray(g.excluded) ? g.excluded : []
  return !ex.includes(item)
}

/** 目录下的子目录名（排序稳定，避免面板每次顺序都在变） */
function listSubDirs(dir) {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function countEntries(dir) {
  try {
    if (!existsSync(dir)) return 0
    return readdirSync(dir).length
  } catch {
    return 0
  }
}

/**
 * 这台机器上的同步执行体实际会抓的组。
 * Windows 走 sync.ps1（12 组）；macOS/Linux 走 runtime\sync-engine.mjs，它只抓
 * profile（4 个文件）/ prompt / skills / presets —— 别的组在那台机器上根本不会被同步。
 * null 表示「全部组」，非 Windows 时是白名单。
 */
const ENGINE_SYNCED_GROUPS = IS_WIN ? null : new Set(['profile', 'prompt', 'skills', 'presets', 'storages-record', 'settings', 'mnemon', 'local-plugins', 'plugin-data', 'extra', 'conversations'])

/** profile 目录：优先 desktop，其次 profiles 下唯一的那一个 */
function resolveProfileDir(dshHome) {
  const desktop = join(dshHome, 'profiles', 'desktop')
  if (existsSync(desktop)) return desktop
  const all = listSubDirs(join(dshHome, 'profiles'))
  return all.length === 1 ? join(dshHome, 'profiles', all[0]) : desktop
}

/** 本机登记的工作区（title 用用户自己起的名，路径只用来判断在不在） */
function listWorkspaceEntries(dshHome) {
  try {
    const reg = readJson(join(dshHome, 'storages', 'workspace.json'))
    const table = reg && reg.tables && reg.tables.workspaces
    if (!table || typeof table !== 'object') return []
    return Object.keys(table).sort().map((id) => {
      const w = table[id] || {}
      const title = typeof w.title === 'string' && w.title.trim() ? w.title.trim() : id
      return { id, title, path: typeof w.path === 'string' ? w.path : '' }
    })
  } catch {
    return []
  }
}

/** link: 进 profile 的本地插件目录名（capture 会把它们打包成 local-plugins\*.zip） */
function listLocalPlugins(dshHome) {
  try {
    const pkg = readJson(join(resolveProfileDir(dshHome), 'package.json'))
    const deps = pkg && pkg.dependencies
    if (!deps || typeof deps !== 'object') return []
    const names = []
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      const target = spec.slice(5).replace(/\//g, '\\').replace(/\\+$/, '')
      const leaf = target.split('\\').filter(Boolean).pop()
      names.push(leaf || name)
    }
    return names.sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * 面板要显示的十组内容 + 组内明细项。
 * 明细项一律用「本机实际存在的名字」，因为用户勾的就是自己看得见的那份。
 */
/**
 * 插件数据 / 额外路径（0.3.51 起）的规则文件：<DshHome>\config-sync-extra.json（本机，不进仓库）。
 * 与 runtime\dsh-sync-common.ps1 的默认值必须一致，否则面板说"会同步"、capture 却跳过。
 */
const ROUTE_EXTRA_CONFIG = '/config-sync/extra-config'

/**
 * 安全必需项：用户自己的 config-sync-extra.json 不允许把它们去掉。
 * 与 runtime\dsh-sync-common.ps1 的 $SyncExtraMandatorySkipDirs / $SyncExtraMandatoryExcludes 同一份名单。
 *
 * 起因（本机实测）：exclude / skipDirs 是「整份替换」语义，用户早先存下的 50 条旧快照会让
 * 0.6.12 新增的 browser-profiles 规则整条失效 —— 那目录里有 3,696 个文件 / 268MB，含密码库与登录态。
 * 0.6.15 在 PowerShell 侧补了这条，JS 侧（面板规则 / 待推送扫描）一直没补：
 * 于是待推送会把 browser-profiles 里几千个文件的 mtime 变动算成「待推送」，而 capture 根本不会抓它们
 * —— 面板永远消不掉，退出自动推送也每次白跑。
 */

/**
 * 浏览器剖面 / 凭据库的路径段黑名单：与 PS 的 $SyncBlockedProfileSegments、webdav.mjs 的
 * BLOCKED_PROFILE_SEGMENTS 一致。按**路径段**判定，深层嵌套（User Data\Default\Login Data）也拦得住。
 */
const BLOCKED_PROFILE_SEGMENTS = new Set([
  'browser-profiles', 'user data', 'login data', 'login data for account',
  'cookies', 'cookies-journal', 'web data', 'web data-journal', 'secure preferences',
  'local state', 'history', 'history-journal', 'top sites', 'current session', 'current tabs',
])

/**
 * 把安全必需项补进 cfg（就地修改），返回补了哪些，便于面板/日志说出来。
 * 读配置要用、保存前也要用：POST 拿用户提交的名单覆盖掉之后，
 * 如果只在读的时候补，用户一保存就又把它删掉了（实测就是这样丢的）。
 */

function isBlockedProfilePath(rel) {
  const s = String(rel || '')
  if (!s) return false
  for (const seg of s.split(/[\\/]+/)) {
    if (seg && BLOCKED_PROFILE_SEGMENTS.has(seg.toLowerCase())) return true
  }
  return false
}

/**
 * 「插件设置与工作流」组的源清单 —— 必须与 runtime\dsh-sync-common.ps1 的 Get-SyncSettingsMap 一致。
 * 以前 JS 只写了 4 条，capture 却抓 14 条：面板少列了 10 个文件，用户既看不到也勾不掉它们。
 * 每条 { id, rel }：rel 是相对 <DshHome> 的路径；profileRel 表示相对 profile 目录。
 */
const SYNC_SETTINGS_SOURCES = SETTINGS_SOURCES

const settingsSourcePath = settingsSourcePathOf


function saveExtraConfig(dshHome, cfg) {
  const p = extraConfigPath(dshHome)
  const out = {
    version: 1,
    pluginData: {
      enabled: cfg.pluginData.enabled !== false,
      maxFileBytes: Math.min(Math.max(1, Math.floor(Number(cfg.pluginData.maxFileBytes) || EXTRA_HARD_MAX_BYTES)), EXTRA_HARD_MAX_BYTES),
      exclude: (cfg.pluginData.exclude || []).filter((x) => typeof x === 'string' && x),
      skipDirs: (cfg.pluginData.skipDirs || []).filter((x) => typeof x === 'string' && x),
    },
    extra: {
      enabled: cfg.extra.enabled !== false,
      paths: (cfg.extra.paths || []).map((x) => ({ id: x.id, src: x.src, label: x.label || x.id })),
    },
  }
  writeFileAtomicSync(p, JSON.stringify(out, null, 2) + '\n')
  return p
}


function dirHasRules(cfg) { return (cfg.pluginData.exclude || []).map(wildcardToRegex) }

/** 插件数据槽：<DshHome> 的一级目录（跳过系统/已覆盖目录与隐藏目录），带文件数与体积。 */
function listPluginDataSlots(dshHome, cfg) {
  const skip = new Set(cfg.pluginData.skipDirs || [])
  let entries = []
  try {
    entries = readdirSync(dshHome, { withFileTypes: true })
  } catch { return [] }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (skip.has(e.name)) continue
    if (e.name.startsWith('.')) continue
    const stat = countSlotFiles(join(dshHome, e.name), cfg, 0, 4000)
    out.push({ id: e.name, src: join(dshHome, e.name), files: stat.files, bytes: stat.bytes, capped: stat.capped, skipped: stat.skipped })
  }
  return out
}

function countSlotFiles(dir, cfg, depth, limit) {
  const acc = { files: 0, bytes: 0, skipped: 0, capped: false }
  if (depth > 8) return acc
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  const rules = dirHasRules(cfg)
  for (const e of entries) {
    if (acc.files >= limit) { acc.capped = true; break }
    if (e.isDirectory()) {
      if (rules.some((re) => re.test(e.name))) { acc.skipped++; continue }
      const sub = countSlotFiles(join(dir, e.name), cfg, depth + 1, limit - acc.files)
      acc.files += sub.files; acc.bytes += sub.bytes; acc.skipped += sub.skipped; acc.capped = acc.capped || sub.capped
      continue
    }
    if (!e.isFile()) continue
    let size = 0
    try { size = statSync(join(dir, e.name)).size } catch { continue }
    if (extraSkipReason(e.name, size, cfg)) { acc.skipped++; continue }
    acc.files++; acc.bytes += size
  }
  return acc
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function collectScopeGroups(dshHome, appRoot) {
  const profileDir = resolveProfileDir(dshHome)
  const groups = []

  const profileFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']
    .filter((f) => existsSync(join(profileDir, f)))
  groups.push({ id: 'profile', titleZh: '本机 profile', titleEn: 'Local profile',
    descZh: 'package.json / lock / cordis 等宿主启动要读的配置', descEn: 'package.json, lockfiles and cordis config the host loads at startup',
    // 这几个文件互相咬合（lock 与 package.json 的 specifier 必须一致），只做整体开关
    required: true,
    items: profileFiles.map((f) => ({ id: f, label: f, excludable: false })) })

  const promptFiles = ['AGENTS.md', 'prompt-inject.md'].filter((f) => existsSync(join(dshHome, f)))
  groups.push({ id: 'prompt', titleZh: '全局提示', titleEn: 'Global prompts',
    descZh: 'AGENTS.md 与 prompt-inject.md，所有会话共用的提示词', descEn: 'AGENTS.md and prompt-inject.md — prompts shared by every session',
    items: promptFiles.map((f) => ({ id: f, label: f })) })

  const skills = listSubDirs(join(dshHome, 'skills'))
  groups.push({ id: 'skills', titleZh: 'Skills', titleEn: 'Skills',
    descZh: '整个 skills 目录镜像到云端，另一台机器直接铺回来', descEn: 'The whole skills folder mirrored to the cloud and restored on the other machine',
    items: skills.map((n) => ({ id: n, label: n })) })

  const presets = listSubDirs(join(dshHome, '.agent-presets'))
  groups.push({ id: 'presets', titleZh: 'Agent 预设', titleEn: 'Agent presets',
    descZh: 'Agent 预设目录（新建/编辑过的预设）', descEn: 'Agent preset folders',
    items: presets.map((n) => ({ id: n, label: n })) })

  const ledgerDir = join(dshHome, 'storages', '@montersy123', 'dsh-skill-market', 'data')
  const ledger = [
    { id: 'skill-market-installed.json', src: join(ledgerDir, 'installed.json') },
    { id: 'skill-market-panel.json', src: join(ledgerDir, 'panel.json') },
  ].filter((x) => existsSync(x.src))
  groups.push({ id: 'storages-record', titleZh: '技能市场台账', titleEn: 'Skill market ledger',
    descZh: '技能市场的安装台账与面板状态', descEn: 'Skill-market install ledger and panel state',
    items: ledger.map((f) => ({ id: f.id, label: f.id })) })

  const settingsFiles = SYNC_SETTINGS_SOURCES
    .map((x) => ({ id: x.id, src: settingsSourcePath(dshHome, profileDir, x) }))
    .filter((x) => existsSync(x.src))
  groups.push({ id: 'settings', titleZh: '插件设置与工作流', titleEn: 'Plugin settings & workflows',
    descZh: '免付费模型设置、ComfyUI 工作流库、桌宠配置、插件市场状态等插件自己的小配置', descEn: 'Small per-plugin configs such as free-model settings, ComfyUI workflows, desktop-pet config and market state',
    items: settingsFiles.map((x) => ({ id: x.id, label: x.id })) })

  const mnemonDir = appRoot ? join(appRoot, 'mnemon') : ''
  const mnemonCount = mnemonDir && existsSync(mnemonDir) ? countEntries(mnemonDir) : 0
  groups.push({ id: 'mnemon', titleZh: '记忆数据', titleEn: 'Memory data',
    descZh: '记忆插件的数据目录（mnemon）', descEn: 'Memory-plugin data folder (mnemon)',
    items: mnemonDir && existsSync(mnemonDir) ? [{ id: 'mnemon', label: `mnemon（${mnemonCount} 项）`, excludable: false }] : [] })

  const localPlugins = listLocalPlugins(dshHome)
  groups.push({ id: 'local-plugins', titleZh: '本地源码插件包', titleEn: 'Local plugin packages',
    descZh: 'link 进 profile 的本地插件，打包成 zip 随配置走', descEn: 'link:-mounted local plugins, packaged as zip and carried with the config',
    items: localPlugins.map((n) => ({ id: n, label: n })) })

  // 0.3.51 起：插件自己写的配置/数据（<DshHome> 一级目录）与用户自选的额外路径
  // 规则在 config-sync-extra.json 里，默认全勾；已被上面几组覆盖的目录不进这一组（避免仓库出现两份）
  const extraCfg = readExtraConfig(dshHome)
  const pdSlots = listPluginDataSlots(dshHome, extraCfg)
  groups.push({ id: 'plugin-data', titleZh: '插件数据', titleEn: 'Plugin data',
    descZh: '各插件自己目录里的配置与数据（排除缓存、数据库、密钥与大文件）', descEn: 'Config and data plugins keep in their own folders (caches, databases, keys and big files excluded)',
    enabledOff: extraCfg.pluginData.enabled === false,
    items: pdSlots.map((s) => {
      const size = humanBytes(s.bytes)
      const label = s.files === 0
        ? `${s.id} · 0 files`
        : `${s.id} · ${s.capped ? '4000+' : s.files} files · ${size}`
      return { id: s.id, label, files: s.files, bytes: s.bytes, skipped: s.skipped }
    }) })

  groups.push({ id: 'extra', titleZh: '额外路径', titleEn: 'Extra paths',
    descZh: '你自己指定要跟着配置走的文件或目录（存在 config-sync-extra.json）', descEn: 'Files or folders you add yourself (kept in config-sync-extra.json)',
    enabledOff: extraCfg.extra.enabled === false,
    items: (extraCfg.extra.paths || []).map((p) => ({ id: p.id, label: `${p.label || p.id}  ${p.src}` })) })

  const workspaces = listWorkspaceEntries(dshHome)
  groups.push({ id: 'workspace', titleZh: '工作区资料', titleEn: 'Workspace files',
    descZh: '登记过的工作区里的资料（>100MB 与模型权重本来就不同步）', descEn: 'Files inside registered workspaces (big files and model weights are never synced)',
    items: workspaces.map((w) => ({ id: w.id, label: w.title })) })

  groups.push({ id: 'conversations', titleZh: '会话记录', titleEn: 'Conversations',
    descZh: '每个工作区的对话、附件与缓存（按工作区勾选）', descEn: 'Chats, attachments and caches per workspace',
    items: workspaces.map((w) => ({ id: w.id, label: w.title })) })

  const scope = readScope(dshHome)
  for (const g of groups) {
    g.enabled = scopeGroupEnabled(scope, g.id)
    // 组在 config-sync-extra.json 里被关掉时，面板也要显示未勾选（两处判断必须一致）
    if (g.enabledOff === true) g.enabled = false
    for (const it of g.items) it.enabled = scopeItemEnabled(scope, g.id, it.id)
  }
  return { scope, groups, extraCfg }
}

async function handleScope(req, res, config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    if (req.method === 'GET') {
      const appRoot = resolveAppRoot(config?.appRoot) || ''
      const { scope, groups } = collectScopeGroups(dshHome, appRoot)
      sendJson(res, 200, {
        ok: true,
        deleteCloud: scope.deleteCloud === true,
        path: scopePath(dshHome),
        groups: groups.map((g) => ({
          id: g.id,
          title: t(g.titleZh, g.titleEn),
          desc: t(g.descZh, g.descEn),
          enabled: g.enabled,
          required: g.required === true,
          // 0.6.49：这台机器上的引擎会不会真的同步这一组。非 Windows 只有四组（ENGINE_SYNCED_GROUPS），
          // 面板据此把其余组标成「此平台暂不支持」并禁用勾选 —— 让人勾上却永远不生效，比不给勾更糟。
          supported: ENGINE_SYNCED_GROUPS ? ENGINE_SYNCED_GROUPS.has(g.id) : true,
          items: g.items.map((it) => ({ id: it.id, label: it.label, enabled: it.enabled, excludable: it.excludable !== false })),
        })),
        engineGroups: ENGINE_SYNCED_GROUPS ? [...ENGINE_SYNCED_GROUPS] : null,
      })
      return
    }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET/POST only' }); return }
    if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    // 空 POST（或只发了 deleteCloud 的残缺请求）一律拒绝：groups 缺省会得到 {}，
    // 下面 writeScope 就会把文件改写成「全部默认」，等于用户点一下就把所有排除项清空。
    // 合法清空必须显式传 groups:{}（面板保存时永远带全量 groups）。
    if (!body || typeof body !== 'object' || !body.groups || typeof body.groups !== 'object') {
      sendJson(res, 400, { ok: false, error: '请求体缺少 groups（清空同步范围请显式传 groups:{}）' })
      return
    }
    const groupsIn = body.groups
    // 排除项只认「本机当前真实存在、且允许单独排除」的条目：
    // 拖着一堆早就不存在的 id 会让用户以后勾不回来（看不见却一直挡着同步）。
    const allowed = {}
    try {
      const cur = collectScopeGroups(dshHome, resolveAppRoot(config?.appRoot) || '')
      for (const g of cur.groups) allowed[g.id] = new Set(g.items.filter((i) => i.excludable !== false).map((i) => i.id))
    } catch { }
    const clean = {}
    // 这两组的整组开关同时写进 config-sync-extra.json：面板显示与 capture 判定都读同一处
    const extraForScope = readExtraConfig(dshHome)
    let extraDirty = false
    for (const [id, key] of [['plugin-data', 'pluginData'], ['extra', 'extra']]) {
      const g = groupsIn[id]
      if (g && typeof g === 'object' && typeof g.enabled === 'boolean') { extraForScope[key].enabled = g.enabled; extraDirty = true }
    }
    for (const [id, g] of Object.entries(groupsIn)) {
      if (!g || typeof g !== 'object') continue
      // 必需组一律按"开启、无排除"处理：关掉它会让另一台 apply 直接报错，不是"少同步一点"
      if (scopeGroupRequired(id)) continue
      const entry = {}
      if (g.enabled === false) entry.enabled = false
      let ex = Array.isArray(g.excluded) ? g.excluded.filter((x) => typeof x === 'string' && x) : []
      if (allowed[id]) ex = ex.filter((x) => allowed[id].has(x))
      if (ex.length) entry.excluded = ex
      // 全勾的组不落盘：文件里只留"跟默认不一样"的部分，手改起来也清爽
      if (Object.keys(entry).length) clean[id] = entry
    }
    const file = writeScope(dshHome, { deleteCloud: body.deleteCloud === true, groups: clean })
    if (extraDirty) { try { saveExtraConfig(dshHome, extraForScope) } catch { } }
    sendJson(res, 200, { ok: true, path: file, deleteCloud: body.deleteCloud === true })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

/**
 * 「同步冲突」接口：pull 被本机文件挡住时，sync.ps1 会写 <DshHome>\sync-conflicts.json。
 *   GET                          读清单（两侧预览 + 每项当前选择）
 *   POST {items:[{path,choice}]} 保存选择（choice 只认 '' / 'local' / 'cloud'）
 *   POST {action:'restore',path} 把某一项的本机副本从备份写回工作区
 *   POST {action:'reset'}        放弃这份清单（下次拉取会重新算）
 * 真正按选择落地的是 sync.ps1（下次「立即拉取」读同一份文件），这里只动 JSON 与备份。
 */
function conflictPath(dshHome) { return join(dshHome, 'sync-conflicts.json') }

const CONFLICT_MISSING = null

/** 读冲突清单：没有 → null；有但坏了 → { broken:true, error }（不能再统一当「没有」）。 */
function readConflicts(dshHome) {
  const p = conflictPath(dshHome)
  if (!isFile(p)) return CONFLICT_MISSING
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch (error) {
    return { broken: true, error: `读不到清单文件：${String((error && error.message) || error)}` }
  }
  try {
    const obj = JSON.parse(text)
    if (!obj || typeof obj !== 'object') return { broken: true, error: '清单不是 JSON 对象' }
    if (!Array.isArray(obj.items)) return { broken: true, error: '清单缺少 items 数组' }
    return obj
  } catch (error) {
    return { broken: true, error: `清单解析失败：${String((error && error.message) || error)}` }
  }
}

function writeConflicts(dshHome, obj) {
  const p = conflictPath(dshHome)
  mkdirSync(dirname(p), { recursive: true })
  writeFileAtomicSync(p, JSON.stringify(obj, null, 2) + '\n')
  return p
}

/**
 * 「插件数据 / 额外路径」规则：<DshHome>\config-sync-extra.json。
 * GET 返回当前规则 + 默认名单（面板用来做「恢复默认」）；
 * POST 覆盖保存：排除名单要可改（用户删一条就真不排除），单文件上限卡在 100MB（GitHub 硬限）。
 */
async function handleExtraConfig(req, res, config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    const cfgPath = extraConfigPath(dshHome)
    if (req.method === 'GET') {
      const cfg = readExtraConfig(dshHome)
      sendJson(res, 200, {
        ok: true,
        path: cfgPath,
        exists: isFile(cfgPath),
        hardMaxBytes: EXTRA_HARD_MAX_BYTES,
        defaults: {
          exclude: EXTRA_DEFAULT_EXCLUDE,
          skipDirs: EXTRA_DEFAULT_SKIP_DIRS,
          maxFileBytes: EXTRA_HARD_MAX_BYTES,
        },
        config: cfg,
      })
      return
    }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET/POST only' }); return }
    if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const src = body && typeof body.config === 'object' && body.config ? body.config : (body || {})
    const cur = readExtraConfig(dshHome)
    if (src.pluginData && typeof src.pluginData === 'object') {
      if (typeof src.pluginData.enabled === 'boolean') cur.pluginData.enabled = src.pluginData.enabled
      const n = Number(src.pluginData.maxFileBytes)
      if (Number.isFinite(n) && n > 0) cur.pluginData.maxFileBytes = Math.min(Math.floor(n), EXTRA_HARD_MAX_BYTES)
      if (Array.isArray(src.pluginData.exclude)) cur.pluginData.exclude = src.pluginData.exclude.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      if (Array.isArray(src.pluginData.skipDirs)) cur.pluginData.skipDirs = src.pluginData.skipDirs.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    }
    if (src.extra && typeof src.extra === 'object') {
      if (typeof src.extra.enabled === 'boolean') cur.extra.enabled = src.extra.enabled
      if (Array.isArray(src.extra.paths)) {
        // 校验搬进 runtime/platform.mjs（按 win32 / posix 分档），被拒的路径要整批报错：
        // 静默丢弃 = 用户的自选目录一条都没存进去，面板却显示保存成功。
        const norm = normalizeSyncExtraPaths(src.extra.paths)
        if (norm.dropped.length) {
          throw new Error(t(
            `这些路径不是绝对路径（或有盘符/分隔符问题），整批未保存：${norm.dropped.join('、')}`,
            `These paths are not absolute (or have a bad drive/separator), so nothing was saved: ${norm.dropped.join(', ')}`,
          ))
        }
        cur.extra.paths = norm.paths
      }
    }
    // 保存前再补一次安全必需项：上面刚用用户提交的名单整份覆盖过，
    // 不补就等于「用户点一次保存，browser-profiles 规则被删掉」（实测丢过一次）。
    const added = topUpExtraMandatory(cur)
    const p = saveExtraConfig(dshHome, cur)
    sendJson(res, 200, { ok: true, path: p, mandatoryRestored: added, config: readExtraConfig(dshHome) })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

async function handleConflict(req, res, config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    if (req.method === 'GET') {
      const obj = readConflicts(dshHome)
      if (!obj) { sendJson(res, 200, { ok: true, exists: false, path: conflictPath(dshHome) }); return }
      // 清单坏了也要让面板看见：否则界面显示「没有冲突」，用户以为一切正常
      if (obj.broken) {
        sendJson(res, 200, {
          ok: true,
          exists: true,
          broken: true,
          error: obj.error,
          path: conflictPath(dshHome),
          at: '', head: '', remoteHead: '', backupDir: '', items: [],
        })
        return
      }
      const items = obj.items.map((it) => ({
        path: String(it.path || ''),
        kind: String(it.kind || ''),
        localSize: Number(it.localSize) || 0,
        remoteSize: Number(it.remoteSize) || 0,
        binary: it.binary === true,
        localPreview: String(it.localPreview || ''),
        remotePreview: String(it.remotePreview || ''),
        // 备份里到底有没有这一份（旧清单 / 备份失败时面板要把对应按钮置灰）
        localSaved: it.localSaved !== false,
        cloudSaved: it.cloudSaved === true,
        choice: String(it.choice || ''),
      }))
      sendJson(res, 200, {
        ok: true,
        exists: true,
        path: conflictPath(dshHome),
        at: obj.at || '',
        head: obj.head || '',
        remoteHead: obj.remoteHead || '',
        backupDir: obj.backupDir || '',
        items,
      })
      return
    }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET/POST only' }); return }
    if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    // 重置不需要清单可读：删文件本身幂等，坏清单也得能从面板清掉（以前这里先 throw，界面无法自救）
    if (body.action === 'reset') {
      try { unlinkSync(conflictPath(dshHome)) } catch { }
      sendJson(res, 200, { ok: true, cleared: true })
      return
    }

    const obj = readConflicts(dshHome)
    if (!obj) {
      throw new Error(t(
        '当前没有待处理的冲突清单（下次拉取被本机文件挡住时会自动生成）',
        'No pending conflict list (one is created automatically when a pull is blocked)',
      ))
    }
    if (obj.broken) {
      throw new Error(t(
        `冲突清单损坏（${obj.error}），已保留原文件；可以先点「重置」丢弃它，下次拉取会重新生成`,
        `The conflict list is corrupted (${obj.error}); the file was kept. Use Reset to discard it; a new one is created on the next blocked pull`,
      ))
    }

    if (body.action === 'restore') {
      const rel = String(body.path || '').trim()
      if (!rel) throw new Error(t('没有指定要还原的文件', 'No file was given to restore'))
      // 清单是引擎/脚本写的，但来源终究是仓库路径：还原时再挡一道越界，别把文件写出仓库。
      if (/^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).some((seg) => seg === '..')) {
        throw new Error(t(`这个路径会写出仓库，拒绝还原：${rel}`, `This path escapes the repo and was refused: ${rel}`))
      }
      const side = body.side === 'cloud' ? 'cloud' : 'local'
      // 还原落到「当时发生冲突的那个仓库」（清单里记着），而不是此刻设置里的路径：
      // 用户之后改过 repoPath 也不会把副本写进另一个仓库。
      const repo = String(obj.repo || '') || resolveRepo(config?.repoPath, dshHome).repo || ''
      if (!repo) throw new Error(t('还没有配置仓库目录', 'Repo directory is not configured'))
      const known = obj.items.find((it) => String(it.path) === rel)
      if (!known) throw new Error(t(`冲突清单里没有这个文件：${rel}`, `Not in the conflict list: ${rel}`))
      const base = String(obj.backupDir || '')
      if (!base) throw new Error(t('这份清单没有记录备份目录', 'The list has no backup directory'))
      // 目录名带中英说明；旧清单（0.3.17 最早那版）是 files / files-cloud，这里兜底
      const sub = side === 'cloud'
        ? (isDir(join(base, '云端-Cloud')) ? '云端-Cloud' : 'files-cloud')
        : (isDir(join(base, '本机-Local')) ? '本机-Local' : 'files')
      const src = join(base, sub, rel)
      if (!isFile(src)) {
        throw new Error(side === 'cloud'
          ? t('备份里没有这一项的云端副本（旧版清单不会存云端），无法还原', 'No cloud copy for this item (older lists did not save one)')
          : t('备份里没有这一项的本机副本，无法还原', 'No local copy for this item in the backup'))
      }
      const dst = join(repo, rel)
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, readFileSync(src))
      sendJson(res, 200, { ok: true, restored: rel, side })
      return
    }

    const incoming = Array.isArray(body.items) ? body.items : []
    const byPath = new Map(obj.items.map((it) => [String(it.path), it]))
    for (const one of incoming) {
      const p = String((one && one.path) || '')
      const c = String((one && one.choice) || '')
      const target = byPath.get(p)
      if (!target) continue
      target.choice = (c === 'local' || c === 'cloud') ? c : ''
    }
    const saved = writeConflicts(dshHome, obj)
    const pending = obj.items.filter((it) => !it.choice).length
    sendJson(res, 200, {
      ok: true,
      path: saved,
      pending,
      total: obj.items.length,
      chosen: obj.items.length - pending,
    })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

async function handleStatus(req, res, config) {
  try {
    sendJson(res, 200, await inspect(config))
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
  }
}

/**
 * 自动同步 / 自动推送的控制口：
 *   {action:'check'}      立刻做一次只读 fetch，返回 ahead/behind
 *   {action:'pull-now'}   排队"退出后拉取"，restart=true 时拉完自动拉起客户端；可选择立刻关闭 DSH
 *   {action:'push-now'}   排队"退出后推送"
 *   {action:'cancel'}     取消已排队的动作
 * 只做只读 fetch 比对（check），真正动手一律交给退出后的 post-exit.ps1。
 */
async function ensurePushAllowed(repo, settings) {
  // 推送的门禁：真仓库直接推；本机还是空的，只有「云端确实没有文件」才能推 —— 那次推送就是初始化推送。
  // 云端已有文件时拒绝，让用户先拉取（否则本机状态会被写进一份已经在用的历史里）。
  // 注意判据是「树里有文件」而不是「有分支」：远端可能只剩一个空分支，那也是空仓库，可以初始化推送。
  if (repoPhase(repo) === 'ok') return
  const useWebdav = webdavActive(settings)
  const url = useWebdav
    ? normalizeWebdav(settings).url
    : ((await git(repo, ['remote', 'get-url', 'origin'])) || settings.remoteUrl || '')
  const probe = useWebdav ? await probeWebdavRemote(settings) : await probeRemote(url, settings)
  if (!probe || probe.files === null) {
    throw new Error(t(
      useWebdav
        ? `连不上 WebDAV（${url || '未配置'}）：${(probe && probe.error) || '初始化推送要先确认云端是空目录'}`
        : `连不上云端、或还没有云端仓库地址（${url || '未配置'}）：初始化推送要先确认云端是空仓库`,
      useWebdav
        ? `Cannot reach WebDAV (${url || 'not set'}): ${(probe && probe.error) || 'initialize push needs to confirm the cloud folder is empty.'}`
        : `Cannot reach the cloud or no remote URL is set (${url || 'not set'}): initialize push needs to confirm the cloud repo is still empty.`,
    ))
  }
  if (probe.files > 0) {
    throw new Error(t(
      `云端仓库已经有内容（${probe.files} 个文件）：本机还是空的，先「拉取」把内容拉下来，再生成推送`,
      `The cloud repo already has content (${probe.files} file(s)): run Pull to fetch it first, then push.`,
    ))
  }
}

function startLivePush({ repo, dshHome, appRoot, settings }) {
  if (autoState.livePush.running) {
    return { alreadyRunning: true, livePush: { ...autoState.livePush } }
  }
  const reqLang = langStore.getStore() || 'zh'
  const initPush = repoPhase(repo) !== 'ok'
  const transport = webdavActive(settings) ? 'webdav' : 'git'
  const logsDir = join(dshHome, 'logs')
  try { if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true }) } catch { }
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const logFile = join(logsDir, `live-push-${stamp}.log`)

  let cmd = ''
  let cmdArgs = []
  if (IS_WIN) {
    const syncScript = [join(pluginRoot(), 'runtime', 'sync.ps1'), join(repo, 'sync.ps1')].find((p) => isFile(p))
    if (!syncScript) throw new Error(t('找不到 sync.ps1，无法在线推送', 'sync.ps1 not found — cannot run live push'))
    const psArgs = [
      `Action = 'push'`,
      `RepoRoot = ${psQuote(repo)}`,
      `DshHome = ${psQuote(dshHome)}`,
      ...(appRoot ? [`AppRoot = ${psQuote(appRoot)}`] : []),
      `Force = $true`,
    ].join('; ')
    // PowerShell 5.1 脚本发生 ParseException 或终止错误时 $LASTEXITCODE 可能仍为 0，
    // 所以必须同时检查 $? 与 try/catch，否则崩溃会被当成 exit 0 假绿。
    const psCmd = [
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '$OutputEncoding = [Console]::OutputEncoding',
      "$ErrorActionPreference = 'Stop'",
      'try {',
      `  $a = @{ ${psArgs} }`,
      `  & ${psQuote(syncScript)} @a`,
      '  if (-not $?) { if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 } }',
      '  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      '  exit 0',
      '} catch {',
      '  [Console]::Error.WriteLine(($_ | Out-String))',
      '  exit 1',
      '}',
    ].join('; ')
    cmd = powershellExe()
    cmdArgs = ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(psCmd, 'utf16le').toString('base64')]
  } else {
    const engine = [join(pluginRoot(), 'runtime', 'sync-engine.mjs'), join(repo, 'sync-engine.mjs')].find((p) => isFile(p))
    if (!engine) throw new Error(t('找不到 sync-engine.mjs，无法在线推送', 'sync-engine.mjs not found — cannot run live push'))
    cmd = hostNodeExe(appRoot) || process.execPath
    cmdArgs = [engine, 'push', '-RepoRoot', repo, '-DshHome', dshHome, ...(appRoot ? ['-AppRoot', appRoot] : [])]
  }

  autoState.livePush = {
    running: true,
    startedAt: Date.now(),
    finishedAt: 0,
    ok: null,
    phase: 'starting',
    message: initPush
      ? t('正在后台初始化推送（不关闭 DSH）…', 'Initializing push in background (DSH stays open)…')
      : t('正在后台抓取并推送（不关闭 DSH）…', 'Capturing and pushing in background (DSH stays open)…'),
    detail: '',
    recent: [],
    log: logFile,
    initPush,
    transport,
  }

  const tail = []
  let sawFatalOutput = false
  // CLIXML 清洗细节（为什么这样判、踩过什么坑）见 runtime/live-log.mjs 的文件头。
  const extractUsefulText = (raw, fromStderr) => extractLiveLogText(raw, fromStderr)

  // 日志上限：同步流程会按文件刷进度，病态情况下能刷到几十 MB。
  // 超过上限后只更新面板进度、不再写盘（面板照旧能看最近几行）。
  const LOG_MAX_BYTES = 8 * 1024 * 1024
  let logBytes = 0
  try { if (existsSync(logFile)) logBytes = statSync(logFile).size } catch { }
  let logTruncated = false
  const recentWritten = []

  const appendLog = (chunk, fromStderr = false) => {
    const text = extractUsefulText(chunk, fromStderr)
    if (!text.trim()) return
    // Write-Host 出来的同一行会同时出现在 stdout 与 stderr（CLIXML），
    // 清洗后两条通道都能读出正文 → 日志里同一句话连写两遍（实测「另一台机器执行…」重复）。
    // 用最近 24 行做去重窗口，跨块也生效。
    const keep = []
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine.trim()) continue
      const key = rawLine.trim()
      if (recentWritten.includes(key)) continue
      recentWritten.push(key)
      if (recentWritten.length > 24) recentWritten.shift()
      keep.push(rawLine)
    }
    if (!keep.length) return
    const outText = keep.join('\n')
    const bytes = Buffer.byteLength(outText)
    if (logBytes < LOG_MAX_BYTES) {
      try { writeFileSync(logFile, `${outText}\n`, { flag: 'a' }); logBytes += bytes } catch { }
      if (logBytes >= LOG_MAX_BYTES && !logTruncated) {
        logTruncated = true
        try { writeFileSync(logFile, `\n[日志已截断：本次输出超过 ${Math.round(LOG_MAX_BYTES / 1048576)} MB，后续只更新面板进度]\n`, { flag: 'a' }) } catch { }
      }
    }
    if (/ParserError|FullyQualifiedErrorId|CommandNotFoundException|\+\s+CategoryInfo\s*:/i.test(outText)) sawFatalOutput = true
    langStore.run(reqLang, () => {
      for (const rawLine of outText.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line) continue
        tail.push(line)
        if (tail.length > 50) tail.shift()
        autoState.livePush.detail = line
        autoState.livePush.recent = tail.slice(-5)
        if (/==\s*初始化仓库/.test(line)) {
          autoState.livePush.phase = 'init'
          autoState.livePush.message = t('正在初始化仓库骨架…', 'Initializing repo skeleton…')
        } else if (/==\s*DSH 配置同步\s*\/\s*capture|==\s*抓取|==\s*归档|==\s*工作区|\bcapture\b/i.test(line)) {
          autoState.livePush.phase = 'capture'
          const convOn = scopeGroupEnabled(readScope(dshHome), 'conversations')
          autoState.livePush.message = convOn
            ? t('正在抓取本机配置与会话…', 'Capturing local config and sessions…')
            : t('正在抓取本机配置…', 'Capturing local config…')
        } else if (/==\s*提交/.test(line)) {
          autoState.livePush.phase = 'commit'
          autoState.livePush.message = t('正在提交本机变更…', 'Committing local changes…')
        } else if (/==\s*上传到 WebDAV|上传扫描：|上传进度：|WebDAV 上传|==\s*推送/.test(line)) {
          autoState.livePush.phase = 'upload'
          if (/上传进度：/.test(line)) {
            autoState.livePush.message = line
          } else {
            autoState.livePush.message = t('正在上传到云端…', 'Uploading to cloud…')
          }
        }
      }
    })
  }

  const finish = (ok, errText, opts = {}) => langStore.run(reqLang, async () => {
    clearWebdavProbeCache()
    if (ok) {
      try {
        if (webdavActive(settings)) {
          const wp = await probeWebdavRemote(settings)
          if (wp && wp.files !== null) {
            autoState.drift = { ahead: 0, behind: 0, transport: 'webdav', files: wp.files, at: Date.now() }
            autoState.lastCheckAt = Date.now()
            autoState.lastCheckError = ''
          }
        } else {
          const d2 = await checkDrift(repo)
          if (d2) {
            autoState.drift = d2
            autoState.lastCheckAt = Date.now()
            autoState.lastCheckError = ''
          }
        }
      } catch { }
    }
    autoState.livePush = {
      ...autoState.livePush,
      running: false,
      finishedAt: Date.now(),
      ok,
      phase: ok ? 'done' : 'error',
      message: opts.skipped
        ? t('跳过：另一个同步动作正在进行（不是故障）', 'Skipped: another sync is already running (not a failure)')
        : ok
          ? (initPush
            ? t('初始化推送完成（未关闭 DSH）', 'Initialize push completed (DSH stayed open)')
            : t('推送完成（未关闭 DSH）', 'Push completed (DSH stayed open)'))
          : (errText || t('推送失败，详见日志', 'Push failed — see log')),
      skipped: Boolean(opts.skipped),
    }
  })

  const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', (c) => appendLog(c, false))
  child.stderr.on('data', (c) => appendLog(c, true))
  child.once('error', (e) => {
    const msg = String((e && e.message) || e)
    appendLog(`\n[error] ${msg}\n`)
    finish(false, msg)
  })
  child.once('exit', async (code) => {
    // 3 是 capture/apply 的「另一个同步动作正在进行」：什么都没做，但也不是故障。
    // 按失败处理会让面板变红，还会从 tail 里随便挑一行当原因（实测会挑到「接着执行（二选一）」）。
    if (code === 3) { finish(true, null, { skipped: true }); return }
    if (code !== 0 || sawFatalOutput) {
      const errLine = [...tail].reverse().find((l) => /\[X\]|失败|error|fatal:|ParserError|UnexpectedToken/i.test(l))
        || tail[tail.length - 1]
        || `exit ${code}`
      finish(false, errLine)
      return
    }
    if (!IS_WIN && !webdavActive(settings)) {
      try {
        await git(repo, ['add', '-A'])
        const st = await git(repo, ['status', '--porcelain'])
        if (st && st.trim()) {
          await git(repo, ['commit', '-m', `sync(live): ${stamp}`])
        }
        await git(repo, ['push'])
      } catch (e) {
        const msg = String((e && e.message) || e)
        appendLog(`\n[git push error] ${msg}\n`)
        finish(false, msg)
        return
      }
    }
    if (!IS_WIN) {
      try {
        const head = (await git(repo, ['log', '-1', '--format=%h'])) || ''
        writeFileAtomicSync(join(dshHome, STATE_NAME), JSON.stringify({
          lastSyncAt: new Date().toISOString(),
          mode: 'push',
          repo,
          head: head.trim(),
        }, null, 2) + '\n')
      } catch { }
    }
    finish(true, '')
  })

  return { alreadyRunning: false, livePush: { ...autoState.livePush } }
}

async function handleAuto(req, res, config) {
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
  if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
  try {
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const action = String(body.action || '')
    const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
    const settings = readSettings(dshHome)
    const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
    // 还原只动本机快照，仓库没配也能用；推送/拉取才必须以仓库目录为前置
    const isRestore = action === 'restore-now' || action === 'restore-preview'
    if (!repo && !isRestore) throw new Error(t('还没有配置仓库目录，自动同步无从谈起', 'The repo directory is not configured, so auto sync cannot work'))
    const appRoot = resolveAppRoot(config?.appRoot) || ''

    if (action === 'check') {
      // 空白目录/还没建：这是「等首次拉取」的正常状态，不是错误 —— 别拿 git 命令去撞空目录
      const phase = repoPhase(repo)
      if (phase !== 'ok') {
        autoState.checking = false
        autoState.lastCheckAt = Date.now()
        autoState.lastCheckError = ''
        autoState.drift = null
        sendJson(res, 200, {
          ok: true, action, drift: null, error: null, pendingPull: true,
          note: t(
            '本机仓库还没内容：云端有内容就点「拉取」；两边都空就点「初始化推送」。比对差异要有仓库内容之后才做',
            'The local repo has no content yet: Pull if the cloud has content, Initialize push if both are empty. Drift needs repo content first.',
          ),
        })
        return
      }
      autoState.checking = true
      autoState.lastCheckError = ''
      let drift = null
      if (webdavActive(settings)) {
        const wp = await probeWebdavRemote(settings)
        if (wp && wp.files !== null) {
          drift = { ahead: 0, behind: 0, transport: 'webdav', files: wp.files, at: Date.now() }
        } else {
          autoState.lastCheckError = (wp && wp.error) || t('连不上 WebDAV 服务端', 'Cannot reach WebDAV server')
        }
      } else {
        drift = await checkDrift(repo)
        if (!drift) {
          autoState.lastCheckError = t(
            '读不到远端（fetch 失败或没有 origin），先确认云端仓库地址与 SSH',
            'Cannot read the remote (fetch failed or there is no origin) — check the cloud repo URL and SSH setup',
          )
        }
      }
      autoState.checking = false
      autoState.lastCheckAt = Date.now()
      autoState.drift = drift
      if (!drift || !(drift.behind > 0)) autoState.pullPrompt = null
      sendJson(res, 200, { ok: true, action, drift, error: autoState.lastCheckError || null })
      return
    }

    if (action === 'cancel') {
      autoState.pending = null
      sendJson(res, 200, { ok: true, action, pending: null })
      return
    }

    if (action === 'restore-preview') {
      const snap = resolveSnapshotDir(dshHome, body.backupDir)
      const preview = snap.kind === 'profile'
        ? { ...restorePreview(dshHome, snap.dir, config), kind: 'profile' }
        : restorePreviewForKind(snap, dshHome)
      sendJson(res, 200, { ok: true, action, preview })
      return
    }

    if (action === 'restore-now') {
      // 直接排队「退出后还原」：和 pull-now 一条流水线，只是执行体换成 restore.ps1。
      // 面板点它之前会先弹确认框（预览差异），确认之后才走到这里。
      // 类型决定 restore.ps1 走哪条分支：profile（时点回退）/ plugin（插件回滚）/ session（会话还原）。
      const snap = resolveSnapshotDir(dshHome, body.backupDir)
      const restart = body.restart !== false && settings.autoRestart !== false
      const extraArgs = ['-BackupDir', snap.dir]
      if (snap.kind !== 'profile') extraArgs.push('-SnapshotKind', snap.kind)
      if (snap.kind === 'plugin') extraArgs.push('-PluginDir', PLUGIN_ROOT)
      const closeNow = body.closeNow !== false
      const started = await spawnWatcher({
        mode: 'restore', repo, appRoot, dshHome, restart,
        extraArgs, closeRequested: closeNow,
      })
      if (!started.ok) throw new Error(started.error)
      autoState.pending = { mode: 'restore', at: Date.now(), restart, watcherPid: started.pid, closeRequested: false, backupDir: snap.dir, snapshotKind: snap.kind }
      let closed = false
      if (body.closeNow !== false) {
        closed = closeDsh()
        autoState.pending.closeRequested = closed
      }
      sendJson(res, 200, { ok: true, action, pending: autoState.pending, closeRequested: closed })
      return
    }

    if (action === 'push-live') {
      await ensurePushAllowed(repo, settings)
      const started = startLivePush({ repo, dshHome, appRoot, settings })
      sendJson(res, 200, { ok: true, action, ...started })
      return
    }

    if (action === 'pull-now' || action === 'push-now') {
      const mode = action === 'pull-now' ? 'pull' : 'push'
      if (mode === 'push' && repoPhase(repo) !== 'ok') await ensurePushAllowed(repo, settings)
      // 拉取/推送做完都把客户端拉回来（用户要求"完成后自动启动 dsh"），仍受 autoRestart 开关约束
      const restart = body.restart !== false && settings.autoRestart !== false
      const closeNow = body.closeNow !== false
      const started = await spawnWatcher({ mode, repo, appRoot, dshHome, restart, closeRequested: closeNow })
      if (!started.ok) throw new Error(started.error)
      autoState.pending = { mode, at: Date.now(), restart, watcherPid: started.pid, closeRequested: false }
      autoState.pullPrompt = null
      // 用户明确要求"现在就同步"：排队后请求客户端退出（不带 /F，走正常关闭，配置能存下来）
      let closed = false
      if (body.closeNow !== false) {
        closed = closeDsh()
        autoState.pending.closeRequested = closed
      }
      sendJson(res, 200, { ok: true, action, pending: autoState.pending, closeRequested: closed })
      return
    }

    throw new Error(t('action 只能是 check / pull-now / push-now / push-live / restore-preview / restore-now / cancel', 'action must be check / pull-now / push-now / push-live / restore-preview / restore-now / cancel'))
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

/** 启动后的自动检查：延迟跑，避免和客户端自身的启动流程抢 IO；失败只记进状态，不打扰用户。 */
function scheduleAutoStart(config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const settings = readSettings(dshHome)
  if (!settings.autoPull && !settings.autoPush) return
  if (autoState.timer) return
  const run = async () => {
    try {
      // 已经排队等退出了就别重复拉起 watcher：第二遍 fetch/stat 纯属浪费
      if (autoState.pending) return
      const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
      const useWebdav = webdavActive(settings)
      if (!repo || (!useWebdav && !isDir(join(repo, '.git'))) || (useWebdav && repoPhase(repo) !== 'ok')) {
        // 空目录是「等首次拉取」的正常状态：不记错误，免得面板的云端徽标把它当成 fetch 失败
        autoState.lastCheckError = (repo && repoPhase(repo) === 'empty')
          ? ''
          : t('仓库还没就位，跳过本次自动检查', 'The repo is not in place yet — skipping this auto check')
        autoState.lastCheckAt = Date.now()
        return
      }
      autoState.checking = true
      let drift = null
      if (useWebdav) {
        const wp = await probeWebdavRemote(settings)
        autoState.checking = false
        autoState.lastCheckAt = Date.now()
        if (!wp || wp.files === null) {
          autoState.lastCheckError = (wp && wp.error) || t('连不上 WebDAV 服务端', 'Cannot reach WebDAV server')
          return
        }
        drift = { ahead: 0, behind: 0, transport: 'webdav', files: wp.files, at: Date.now() }
      } else {
        drift = await checkDrift(repo)
        autoState.checking = false
        autoState.lastCheckAt = Date.now()
        if (!drift) {
          autoState.lastCheckError = t('读不到远端（fetch 失败或没有 origin）', 'Cannot read the remote (fetch failed or there is no origin)')
          return
        }
      }
      autoState.drift = drift
      if (!drift || !(drift.behind > 0)) autoState.pullPrompt = null
      const appRoot = resolveAppRoot(config?.appRoot) || ''

      if (settings.autoPull && drift.behind > 0) {
        const title = t('云端有更新，要同步到本机吗？', 'The cloud has new commits — sync them to this machine?')
        const text = t(
          `云端比本机多 ${drift.behind} 个提交。\n`
          + '同步需要先完全退出 DSH：确认后客户端会自动关闭，拉取完成后按设置自动重新打开。\n'
          + `（本机领先 ${drift.ahead} 个提交，拉取不会动它们）`,
          `The cloud is ${drift.behind} commit(s) ahead of this machine.\n`
          + 'Syncing requires DSH to fully exit first: after you confirm, the client closes itself and reopens according to your settings once the pull finishes.\n'
          + `(This machine is ${drift.ahead} commit(s) ahead — pulling leaves those alone.)`,
        )
        // 0.6.49：启动时的自动拉取不再在 macOS 上弹原生框。这条路径是**没有请求、没有面板**的
        // 后台流程，osascript 的 display dialog 往往落在应用窗口后面甚至不出现在前台 —— 用户看
        // 不见就等于「自动拉取从来不会发生」，而 DSH 还以为在等确认（12 分钟超时）。
        // 现在改成把提示挂进状态，面板的「不一致 · 立即拉取」一键接手；Windows 保持原样。
        let yes = false
        if (IS_WIN) {
          yes = await askConfirm(title, text)
        } else {
          autoState.pullPrompt = { behind: drift.behind, ahead: drift.ahead, at: Date.now(), title, message: text }
          try {
            const logDir = join(dshHome, 'logs')
            mkdirSync(logDir, { recursive: true })
            writeFileSync(join(logDir, 'auto-sync-pull-prompt.log'),
              `[${new Date().toISOString()}] 云端领先 ${drift.behind} 个提交：等用户在面板里点「立即拉取」\n`, { flag: 'a' })
          } catch { }
        }
        if (yes) {
          // 用户点了确认，插件随后自己关客户端 → 允许守护进程在窗口消失后清残留
          const started = await spawnWatcher({ mode: 'pull', repo, appRoot, dshHome, restart: settings.autoRestart, closeRequested: true })
          if (started.ok) {
            autoState.pending = { mode: 'pull', at: Date.now(), restart: settings.autoRestart, watcherPid: started.pid, closeRequested: true }
            closeDsh()
          } else {
            autoState.lastCheckError = started.error
          }
        } else {
          autoState.pending = null
        }
        return
      }

      if (settings.autoPush) {
        // 该不该推，三个来源都算：本地领先的提交、未提交的改动、以及"本机资料比上次同步新"
        // （新会话还没 capture 时仓库是干净的，只看 ahead 会把最该推的那种改动漏掉 —— 真实踩过）
        let dirty = 0
        const raw = await git(repo, ['status', '--porcelain'])
        if (raw) dirty = raw.split('\n').filter((l) => l.trim()).length
        const syncState = readSyncState(dshHome)
        const lp = localPending(dshHome, syncState.lastSyncAt, config?.profileName, { repo, appRoot })
        // 后台调度里拿不到请求语言，所以中英各存一份，由客户端按自己的语言挑
        const reasonZh = drift.ahead > 0 ? `领先 ${drift.ahead} 个提交`
          : dirty > 0 ? `未提交 ${dirty} 项`
            : (lp.known && lp.pending > 0) ? `本机 ${lp.pending} 个文件比上次同步新` : ''
        const reasonEn = drift.ahead > 0 ? `${drift.ahead} commit(s) ahead`
          : dirty > 0 ? `${dirty} uncommitted change(s)`
            : (lp.known && lp.pending > 0) ? `${lp.pending} file(s) newer than the last sync` : ''
        if (reasonZh) {
          // 自动推送不需要确认（用户已开开关），排队等退出即可；推完把客户端拉回来
          const restart = settings.autoRestart !== false
          const started = await spawnWatcher({ mode: 'push', repo, appRoot, dshHome, restart })
          if (started.ok) {
            autoState.pending = { mode: 'push', at: Date.now(), reason: reasonZh, reasonZh, reasonEn, restart, watcherPid: started.pid, closeRequested: false }
          } else {
            autoState.lastCheckError = started.error
          }
        }
      }
    } catch (error) {
      autoState.checking = false
      autoState.lastCheckAt = Date.now()
      autoState.lastCheckError = String((error && error.message) || error)
    }
  }
  // 首检别拖太久：用户可能开起来看一眼就关窗口，20 秒会让他这次关闭什么都没推。
  autoState.timer = setTimeout(run, 8 * 1000)
  try { autoState.timer.unref?.() } catch { }
  // 之后每 2 分钟复查一次：会话/资料是运行中才产生的，只在启动判一次会把它们全漏掉。
  // 命中就排一次队，watcher 已在等进程退出，退出即执行；已排队时 run 会直接返回。
  try {
    autoState.interval = setInterval(run, 2 * 60 * 1000)
    autoState.interval.unref?.()
  } catch { }
}

/**
 * 用户点右上角 × 关闭 DSH 时，立即判一次自动拉取/推送并排好 watcher（0.3.93）。
 *
 * 为什么要单独做：原来开关只在 scheduleAutoStart 的 8 秒首检 + 每 2 分钟复查里判，
 * 用户勾了开关、做了改动，没等到下一次复查就点 × 关掉 —— 那一刻没有任何 watcher 在排队，
 * 退出后自然什么都不执行，看着就像"勾了没用"。现在把「判一次并排队」接到关闭钩子上：
 * 点 × → 这里同步判一次 → 拉起独立 watcher → app.quit()，watcher 在 DSH 退出后照常执行，
 * 语义和手动「立即拉取/推送」完全一致。
 *
 * 关闭场景窗口都在关了，不弹确认框；autoPull 仍只在云端确实领先（或本机仓库还没内容）时才排队，
 * 免得没更新也白拉一次还把客户端重启回来。和 scheduleAutoStart 一样「拉取优先，二者只排一个」。
 */
async function triggerAutoSyncOnClose(config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    const settings = readSettings(dshHome)
    if (!settings.autoPull && !settings.autoPush) return { queued: false }
    // 已经排过队（2 分钟复查 / 手动按钮）就别重复拉起 watcher：spawnWatcher 的锁也会挡，这里先省一次开销
    if (autoState.pending && isProcessAlive(autoState.pending.watcherPid)) {
      return { queued: false, reused: true, mode: autoState.pending.mode }
    }
    const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
    if (!repo) return { queued: false }
    const appRoot = resolveAppRoot(config?.appRoot) || ''
    const phase = repoPhase(repo)

    // 本机仓库还没内容：autoPull 可以直接排队（sync.ps1 首次 clone），autoPush 不行（要先确认云端为空）
    if (phase !== 'ok') {
      if (settings.autoPull && phase === 'empty') {
        const restart = settings.autoRestart !== false
        const started = await spawnWatcher({ mode: 'pull', repo, appRoot, dshHome, restart })
        if (!started.ok) return { queued: false, error: started.error }
        autoState.pending = { mode: 'pull', at: Date.now(), reasonZh: '本机仓库为空，拉取初始化', reasonEn: 'Empty local repo — pull to initialize', restart, watcherPid: started.pid }
        return { queued: true, mode: 'pull' }
      }
      return { queued: false }
    }

    const useWebdav = webdavActive(settings)
    const drift = useWebdav
      ? (() => ({ ahead: 0, behind: 0, transport: 'webdav', at: Date.now() }))()
      : await checkDrift(repo)
    if (!drift) return { queued: false }

    // 拉取优先，和 scheduleAutoStart 一致；关闭时不再弹确认框，云端领先就排
    if (settings.autoPull && drift.behind > 0) {
      const restart = settings.autoRestart !== false
      const started = await spawnWatcher({ mode: 'pull', repo, appRoot, dshHome, restart })
      if (!started.ok) return { queued: false, error: started.error }
      autoState.pending = {
        mode: 'pull', at: Date.now(), restart, watcherPid: started.pid,
        reasonZh: `退出前检查：云端领先 ${drift.behind} 个提交`, reasonEn: `Checked on exit: ${drift.behind} commit(s) behind`,
      }
      return { queued: true, mode: 'pull' }
    }

    if (settings.autoPush) {
      // 判据和 scheduleAutoStart 完全相同：领先提交 / 未提交改动 / 本机资料比上次同步新
      let dirty = 0
      if (!useWebdav || isDir(join(repo, '.git'))) {
        const raw = await git(repo, ['status', '--porcelain'])
        if (raw) dirty = raw.split('\n').filter((l) => l.trim()).length
      }
      const syncState = readSyncState(dshHome)
      const lp = localPending(dshHome, syncState.lastSyncAt, config?.profileName, { repo, appRoot })
      const shouldPush = drift.ahead > 0 || dirty > 0 || (lp.known && lp.pending > 0)
      if (shouldPush) {
        const restart = settings.autoRestart !== false
        const reasonZh = drift.ahead > 0 ? `领先 ${drift.ahead} 个提交` : dirty > 0 ? `未提交 ${dirty} 项` : `本机 ${lp.pending} 个文件比上次同步新`
        const reasonEn = drift.ahead > 0 ? `${drift.ahead} commit(s) ahead` : dirty > 0 ? `${dirty} uncommitted change(s)` : `${lp.pending} file(s) newer than the last sync`
        const started = await spawnWatcher({ mode: 'push', repo, appRoot, dshHome, restart })
        if (!started.ok) return { queued: false, error: started.error }
        autoState.pending = { mode: 'push', at: Date.now(), reason: reasonZh, reasonZh, reasonEn, restart, watcherPid: started.pid }
        return { queued: true, mode: 'push' }
      }
    }
    return { queued: false }
  } catch (error) {
    logLaunch(dshHome, `退出前自动同步排队失败：${(error && error.message) || error}`)
    return { queued: false }
  }
}

async function handlePrepare(req, res, config) {
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
  if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
  try {
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const action = String(body.action || '')
    if (!ACTIONS.includes(action)) throw new Error(t(`action 只能是 ${ACTIONS.join(' / ')}`, `action must be one of ${ACTIONS.join(' / ')}`))
    const message = typeof body.message === 'string' ? body.message : ''
    const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
    const resolved = resolveRepo(config?.repoPath, dshHome)
    const repo = resolved.repo
    // 仓库还没克隆（新机器只装了插件）也允许生成：脚本会用插件自带的 runtime\，首次拉取由 sync.ps1 现场 clone。
    // 只有「压根没配过路径」才拦。
    if (!repo) {
      throw new Error(t(
        '还没有配置仓库目录：请先在面板「本机仓库」卡的「仓库路径」框里填好目录并点「保存」（本地还没有仓库时，首次拉取会自动从云端拉取/初始化）',
        'The repo directory is not configured: enter the path in the Repo path box in the Local repo card and click Save first (if the repo is not local yet, the first pull initializes it from the cloud automatically)',
      ))
    }
    const repoReady = isRepoDir(repo)
    const phase = repoPhase(repo)
    // 本机还没内容时，先问一次云端：云端也空 = 只能「初始化推送」，云端有内容 = 只能拉取。
    // 一次请求算清楚，下面 push 门禁、all 的脚本组合、bootstrap 说明都用这同一个答案。
    // 判据是「云端分支树里有没有文件」——远端只剩空分支时也算空仓库（历史被删空就是这个样子）。
    const probeSettings = readSettings(dshHome)
    const useWebdavForPrepare = webdavActive(probeSettings)
    let remoteFilesForPrepare = null
    let remoteHeadsForPrepare = null
    if (phase !== 'ok') {
      if (useWebdavForPrepare) {
        const probe = await probeWebdavRemote(probeSettings)
        remoteFilesForPrepare = probe ? probe.files : null
        remoteHeadsForPrepare = probe ? probe.heads : null
      } else {
        const probeUrl = (await git(repo, ['remote', 'get-url', 'origin'])) || probeSettings.remoteUrl || ''
        const probe = await probeRemote(probeUrl, probeSettings)
        remoteFilesForPrepare = probe ? probe.files : null
        remoteHeadsForPrepare = probe ? probe.heads : null
      }
    }
    // 空白文件夹（或还没建）代表「本机还没有仓库内容」：能不能推，取决于云端有没有内容 ——
    //   云端也空 → 允许，这次推送就是「初始化推送」（sync.ps1 会 git init + 写骨架 + capture + 提交 + 推）
    //   云端有内容 → 拒绝，先拉取（硬推会把本机状态写进一份正在使用的历史）
    if (action === 'push' && phase !== 'ok') {
      if (remoteFilesForPrepare === null) {
        const targetHint = useWebdavForPrepare ? normalizeWebdav(probeSettings).url : (probeSettings.remoteUrl || '还没配地址')
        throw new Error(t(
          `连不上云端仓库（${targetHint}）：初始化推送要先确认云端是空仓库，请先确认地址与网络`,
          `Cannot reach the cloud repo (${useWebdavForPrepare ? normalizeWebdav(probeSettings).url : (probeSettings.remoteUrl || 'no URL configured')}): initialize push needs to confirm the cloud repo is empty — check the URL and network.`,
        ))
      }
      if (remoteFilesForPrepare > 0) {
        throw new Error(t(
          `云端仓库已经有内容（${remoteFilesForPrepare} 个文件）：本机还是空的，先执行「拉取」把内容拉下来，之后才能推送`,
          `The cloud repo already has content (${remoteFilesForPrepare} file(s)): run Pull first to bring it down, then push.`,
        ))
      }
    }
    // 反过来：云端也空的时候不许生成拉取脚本 —— 拉下来只会得到一个空目录 + .git，
    // 面板状态原地不动，人以为「同步过了」，实际什么都没下来。两边都空只走「推送（初始化）」。
    if (action === 'pull' && phase !== 'ok') {
      if (remoteFilesForPrepare === null) {
        const targetHint = useWebdavForPrepare ? normalizeWebdav(probeSettings).url : (probeSettings.remoteUrl || '还没配地址')
        throw new Error(t(
          '连不上云端仓库（' + targetHint + '）：先确认地址与网络，再生成拉取脚本',
          'Cannot reach the cloud repo (' + (useWebdavForPrepare ? normalizeWebdav(probeSettings).url : (probeSettings.remoteUrl || 'no URL configured')) + '): check the URL and network before generating the pull script.',
        ))
      }
      if (remoteFilesForPrepare === 0) {
        throw new Error(t(
          '云端仓库里一个文件都没有，没有内容可拉：本机和云端都空时请用「推送」（那次就是初始化推送）',
          'The cloud repo has no file at all, so there is nothing to pull: when both sides are empty, use Push (that run initializes the repo).',
        ))
      }
    }
    // 推送 / 拉取都以「云端仓库地址」为前置；还原（最新快照或指定快照）只动本机快照，不需要远端。
    // 0.4.0：WebDAV 模式下不需要 git remoteUrl。
    if (action !== 'restore' && action !== 'restore-backup' && !useWebdavForPrepare) {
      const origin = isDir(join(repo, '.git')) ? await git(repo, ['remote', 'get-url', 'origin']) : null
      const remoteUrl = origin || probeSettings.remoteUrl
      if (!remoteUrl) {
        throw new Error(t(
          '还没有配置云端仓库地址：请先在面板「云端仓库」卡里填好远端地址并保存，再生成推送/拉取脚本',
          'The cloud repo is not configured: fill in the remote URL in the Cloud repo card and save before generating push/pull scripts',
        ))
      }
    }
    const appRoot = resolveAppRoot(config?.appRoot)
    // 定位不到客户端根就不许生成脚本：-AppRoot 错了会把插件部署进仓库、{{APP_ROOT}} 也全展开错位。
    if (!appRoot) {
      throw new Error(t(
        '定位不到客户端根目录（要能找到 resources\\app\\package.json 或 resources\\app.asar）：'
        + '请确认插件装在 <客户端根> 下（例如 D:\\DeepSeekHarness\\dsh-profile-config-sync-0.3.67），或在设置里填客户端根 appRoot',
        'Cannot locate the client root (needs resources\\app\\package.json or resources\\app.asar): '
        + 'make sure the plugin is installed under <client root> (e.g. D:\\DeepSeekHarness\\dsh-profile-config-sync-0.3.67), or set appRoot in the settings',
      ))
    }
    const state = {...await repoState(repo), message}
    // 「还原备份」点某一行：备份目录必须是备份根之下真实存在的一份快照 ——
    // 面板传来的路径直接拼进 cmd，所以这里既校验存在，也校验不含引号/换行，避免生成出跑不起来的脚本。
    let backupDir = ''
    let snapshotKind = ''
    if (action === 'restore-backup') {
      // 与 restore-now 共用同一套校验：存在、在备份根之下、能认出类型（profile / plugin / session）
      const snap = resolveSnapshotDir(dshHome, body.backupDir)
      backupDir = snap.dir
      snapshotKind = snap.kind
    }
    const stateWithBackup = { ...state, backupDir, snapshotKind }
    // 「云端确实没有文件」——包括远端只剩空分支（历史被删空的现场）→ 都算可以初始化推送
    const cloudEmptyForPrepare = remoteFilesForPrepare === 0
    const bootstrap = repoReady ? null : {
      repo,
      initPush: phase !== 'ok' && cloudEmptyForPrepare,
      note: t(
        cloudEmptyForPrepare
          ? '本机仓库和云端仓库都还是空的：点「推送」即「初始化推送」——会 git init、写出仓库骨架（apply/capture/sync 等执行体与版本契约）并把本机配置作为初始内容提交推送'
          : (phase === 'empty'
            ? '本机仓库是空目录：点「拉取」会用插件自带的 runtime 从云端把仓库内容拉到这个路径（拉完就能正常推送/拉取）'
            : '本机还没有这个仓库（或还没克隆）：生成的三份脚本先用插件自带的 runtime，第一次执行拉取会自动从云端克隆到该目录'),
        cloudEmptyForPrepare
          ? 'Both the local repo and the cloud are empty: Push becomes Initialize push — it runs git init, writes the repo skeleton (apply/capture/sync bodies plus the version contract) and commits this machine\'s config as the initial content.'
          : (phase === 'empty'
            ? 'The local repo folder is empty: Pull uses the bundled runtime to fetch the repo from the cloud into that path (after that, push/pull work normally).'
            : 'This repo is not on this machine yet (or not cloned): the scripts use the plugin\'s bundled runtime, and the first pull clones it from the cloud into that directory.'),
      ),
    }
    if (action === 'all') {
      // 脚本怎么组合，跟门禁同一套口径：真仓库全给；两边都空只给「推送（初始化）+ 还原」；
      // 本机空云端有内容只给「拉取 + 还原」。面板上的「一键生成」按同一份规则显示按钮文案。
      const wanted = phase === 'ok' ? ['push', 'pull', 'restore']
        : (cloudEmptyForPrepare ? ['push', 'restore'] : ['pull', 'restore'])
      const skipped = phase === 'ok' ? [] : (cloudEmptyForPrepare ? ['pull'] : ['push'])
      // 0.4.0：Windows 生成 .cmd（PowerShell 执行体），macOS/Linux 生成 .sh（Node 执行引擎）。
      // 两端口径一致：同一套门禁、同一份仓库格式，只是脚本外壳不同。
      const build = IS_WIN ? buildCmd : buildSh
      const built = wanted.map((a) => build(config, a, repo, appRoot, dshHome, state))
      sendJson(res, 200, { ok: true, action, built, bootstrap, skipped, platform: OS })
      return
    }
    const build = IS_WIN ? buildCmd : buildSh
    const built = build(config, action, repo, appRoot, dshHome, stateWithBackup)
    sendJson(res, 200, { ok: true, action, ...built, bootstrap, platform: OS })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

/**
 * 跨机路径根：仓库里的配置存的是 {{APP_ROOT}} / {{DSH_HOME}} / {{WORKSPACE_HOME}} / {{ROOT:<key>}}，
 * 换一台机器落地时，这几个根都不一样。所以每台机器在这里确认一次自己的根，记进
 * <dshHome>\config-sync-roots.json（本机私有，不进仓库），apply 再按这份值展开。
 * 确认过的不再问：文件里有值就直接用，面板只在缺值时列出来。
 */
function rootsPathOf(dshHome) { return join(dshHome, 'config-sync-roots.json') }
function pendingPathOf(dshHome) { return join(dshHome, 'config-sync-pending-paths.json') }
function absolutePathsPathOf(dshHome) { return join(dshHome, 'config-sync-absolute-paths.json') }
function overwritePathOf(dshHome) { return join(dshHome, 'config-sync-overwrite.json') }

/**
 * 本机机器名：和 capture.ps1 写报告时用的 $env:COMPUTERNAME 对得上。
 * 报告里带着 machine，面板据此判断「这份配置是别的机器写的」——只有那种情况才该提示跨机路径。
 */
function localMachineName() {
  try { return String(hostname() || '') } catch { return '' }
}
function sameMachine(a, b) {
  const x = String(a || '').trim().toLowerCase()
  const y = String(b || '').trim().toLowerCase()
  return Boolean(x) && Boolean(y) && x === y
}

/** 路径比较用：统一斜杠、折叠重复斜杠、去尾斜杠、转小写（Windows 不区分大小写） */
function pathKeyOf(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()
}

/**
 * 给仓库里一条根外绝对路径，算「这台机器上应该在哪个目录」。
 * 两种依据，从准到糙：
 *   1) root  —— 报告里记着对方那台机器的根值，前缀命中就换成本机的同名根（精确映射）
 *   2) namesake —— 没有根可换，就按最后一级目录名在本机常见位置找同名目录（启发式）
 * 都不中就返回 kind='none'，面板只说「本机没有等价目录」，不乱指地方。
 */
function suggestLocalPathFor(remotePath, report, ctx) {
  const rp = String(remotePath || '')
  if (!rp) return { path: '', kind: 'none', note: '', remoteRoot: '', rest: '' }
  // 分段保留原大小写（Windows 路径不敏感，但推荐结果要写成 D:\DSH\SquadLink 这种原样，
  // 不能因为比较时转小写就把 SquadLink 推荐成 squadlink）
  const segOrig = rp.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').split('/').filter(Boolean)
  const remoteRoots = (report && report.roots && typeof report.roots === 'object') ? report.roots : {}
  const pairs = []
  const addPair = (remoteValue, localValue) => {
    const rk = pathKeyOf(remoteValue)
    if (rk && localValue) pairs.push({ rk: rk.split('/').filter(Boolean), local: String(localValue) })
  }
  addPair(remoteRoots.appRoot, ctx.appRoot)
  addPair(remoteRoots.dshHome, ctx.dshHome)
  addPair(remoteRoots.workspaceHome, ctx.workspaceHome)
  const remoteCustom = (remoteRoots.custom && typeof remoteRoots.custom === 'object') ? remoteRoots.custom : {}
  for (const [k, v] of Object.entries(remoteCustom)) addPair(v, (ctx.custom || {})[k] || '')
  // 最长前缀优先：工作区根比客户端安装目录更具体
  pairs.sort((a, b) => b.rk.length - a.rk.length)
  for (const pair of pairs) {
    if (pair.rk.length > segOrig.length) continue
    if (!pair.rk.every((seg, i) => seg === segOrig[i].toLowerCase())) continue
    const rest = segOrig.slice(pair.rk.length)
    const target = rest.length ? join(pair.local, ...rest) : pair.local
    return {
      path: target,
      kind: 'root',
      remoteRoot: segOrig.slice(0, pair.rk.length).join('/'),
      rest: rest.join('/'),
      note: t('按对方机器的根映射到本机同名根', 'mapped onto this machine\'s same root'),
    }
  }
  const leaf = segOrig[segOrig.length - 1] || ''
  if (leaf && /^[A-Za-z0-9._-]+$/.test(leaf) && leaf.includes('.')) {
    // 最后一段是文件名，不算目录名，不猜
    return { path: '', kind: 'none', note: '', remoteRoot: '', rest: '', leaf }
  }
  if (leaf) {
    for (const base of (ctx.candidates || [])) {
      if (!base) continue
      const cand = join(base, leaf)
      try { if (existsSync(cand)) return { path: cand, kind: 'namesake', leaf, note: t('本机有同名目录', 'a same-named folder exists here'), remoteRoot: '', rest: '' } } catch { }
    }
  }
  return { path: '', kind: 'none', note: '', remoteRoot: '', rest: '', leaf }
}

/** 猜同名目录时本机该去哪儿找：本机的几个根、用户主目录、桌面、各固定盘根、已确认的自选目录 */
function candidateParentDirs(localRoots) {
  const out = []
  const push = (p) => {
    const s = String(p == null ? '' : p).trim()
    if (s && !out.some((x) => pathKeyOf(x) === pathKeyOf(s))) out.push(s)
  }
  const r = localRoots || {}
  push(r.appRoot)
  push(r.workspaceHome)
  try { push(homedir()) } catch { }
  try { push(join(homedir(), 'Desktop')) } catch { }
  for (const letter of ['C', 'D', 'E', 'F', 'G']) {
    const root = `${letter}:\\`
    try { if (existsSync(root)) push(root) } catch { }
  }
  for (const v of Object.values(r.custom || {})) push(v)
  return out
}


/** 工作区根：本机工作区一般建在同一层，取登记表里出现最多的那个父目录 */
function guessWorkspaceHome(dshHome) {
  const list = workspaceRoots(dshHome)
  if (!list.length) return ''
  const parents = list.map((p) => dirname(String(p).replace(/[\\/]+$/, ''))).filter(Boolean)
  let best = ''
  let bestCount = 0
  for (const p of parents) {
    let c = 0
    for (const q of parents) { if (q.toLowerCase() === p.toLowerCase()) c += 1 }
    if (c > bestCount) { bestCount = c; best = p }
  }
  return best
}

function tokenHint(token) {
  const key = String(token || '')
  if (key === '{{APP_ROOT}}') return t('客户端安装目录（DeepSeekHarness 所在的那个目录）', 'Client install root (the folder that contains DeepSeekHarness)')
  if (key === '{{DSH_HOME}}') return t('.dsh 配置目录（一般是 %USERPROFILE%\\.dsh）', '.dsh folder (usually %USERPROFILE%\\.dsh)')
  if (key === '{{WORKSPACE_HOME}}') return t('工作区根目录（本机工作区都建在它下面）', 'Workspace root (all workspaces live under it)')
  const name = key.replace(/^\{\{ROOT:/, '').replace(/\}\}$/, '')
  return t(`自选目录：${name} —— 这台机器上对应的路径由你来定`, `Custom folder "${name}" — pick the matching path on this machine`)
}

/**
 * 0.4.0：WebDAV 通道路由。
 *
 * GET  → 当前配置（不回显密码明文，只给「是否已设置」）+ 远端连通性
 * POST → { action: 'save' | 'test' | 'upload' | 'download' }
 *
 * 安全边界：
 *   - 密码只在 POST save 时写入本机 `dsh-config-sync.json`，任何响应都不回显；
 *   - 非 https 地址默认拒绝（明文传密码），要放行必须本机设 DSH_SYNC_ALLOW_INSECURE=1；
 *   - upload/download 会**改本机文件**，所以只接受本机来源（originAllowed）。
 */
async function handleWebdav(req, res, config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const settings = readSettings(dshHome)

  if (req.method === 'GET') {
    const w = normalizeWebdav(settings)
    const probe = w.enabled ? await testConnection(w) : { ok: false, error: '未配置' }
    sendJson(res, 200, {
      ok: true,
      // 明文密码绝不下发：面板只显示「已设置 / 未设置」
      configured: Boolean(w.url),
      hasPassword: Boolean(w.pass),
      url: w.url,
      user: w.user,
      dir: w.dir,
      mode: w.mode,
      // 0.6.48：UA 回显（面板要能确认「发出去的到底是什么」），留空表示不发 User-Agent
      userAgent: w.ua,
      userAgentSanitized: Boolean(String(settings.webdavUserAgent || '').trim()) && !w.ua,
      secure: isSecureUrl(w.url),
      probe,
      platform: OS,
    })
    return
  }

  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
  if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'origin not allowed' }); return }

  let body = {}
  try { body = JSON.parse(await readBody(req)) || {} } catch { body = {} }
  const action = String(body.action || '')

  // save：只更新给出的字段；密码留空表示「不改」（避免面板回显后把密码清空）
  if (action === 'save') {
    try {
      const next = { ...settings }
      if (typeof body.url === 'string') next.webdavUrl = body.url.trim()
      if (typeof body.user === 'string') next.webdavUser = body.user.trim()
      if (typeof body.dir === 'string') next.webdavDir = body.dir.trim()
      if (typeof body.mode === 'string' && ['git', 'webdav', 'auto'].includes(body.mode)) next.syncMode = body.mode
      if (typeof body.pass === 'string' && body.pass.length > 0) next.webdavPass = body.pass
      // 0.6.48：UA。非法值（含 CRLF / 非 ASCII / 超长）不静默存：明确报错，
      // 否则用户以为填上了，实际发出去的还是默认 UA，症状又变成「连不上」。
      if (typeof body.userAgent === 'string') {
        const raw = body.userAgent.trim()
        const safe = sanitizeUserAgent(raw)
        if (raw && !safe) {
          throw new Error(t(
            'User-Agent 只能是一行可见 ASCII（不含换行、中文、制表符），且不超过 200 字符',
            'User-Agent must be a single line of visible ASCII (no newlines, CJK or tabs), at most 200 characters',
          ))
        }
        next.webdavUserAgent = safe
      }
      writeSettings(dshHome, next)
      clearWebdavProbeCache()
      const w = normalizeWebdav(next)
      sendJson(res, 200, { ok: true, configured: Boolean(w.url), hasPassword: Boolean(w.pass), mode: w.mode })
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String((e && e.message) || e) })
    }
    return
  }

  const w = normalizeWebdav(settings)
  if (!w.enabled) { sendJson(res, 400, { ok: false, error: 'WebDAV 未配置（先保存地址）' }); return }

  if (action === 'test') {
    sendJson(res, 200, { ok: true, result: await testConnection(w) })
    return
  }

  // 上传/下载都要动本机文件，但两者的前提不同：
  //   upload   必须有内容（空目录没东西可传）
  //   download 恰恰要把空目录填满 —— 新机器首次拉取就是这个场景，不能拒
  const repo = resolveRepo(config?.repoPath, dshHome).repo
  if (!repo) {
    sendJson(res, 400, { ok: false, error: '还没有设置本机仓库目录（先在「本机仓库」卡里设置路径）' })
    return
  }
  const repoLooksReal = isRepoDir(repo) || isDir(join(repo, 'machines'))
  if (action === 'upload') {
    if (!isDir(repo)) {
      sendJson(res, 400, { ok: false, error: '本机仓库目录不存在（先在「本机仓库」卡里设置路径）' })
      return
    }
    if (!repoLooksReal) {
      sendJson(res, 400, { ok: false, error: `这个目录不像同步仓库：${repo}` })
      return
    }
  }
  if (action === 'download') {
    // 不存在就建；空目录放行；非空又不像仓库才拒（防止把配置铺到别人的目录里）
    if (!isDir(repo)) {
      try { mkdirSync(repo, { recursive: true }) } catch (e) {
        sendJson(res, 400, { ok: false, error: `建不了本机仓库目录：${String((e && e.message) || e)}` })
        return
      }
    }
    let entries = []
    try { entries = readdirSync(repo).filter((n) => !n.startsWith('.')) } catch { entries = [] }
    if (entries.length > 0 && !repoLooksReal) {
      sendJson(res, 400, { ok: false, error: `这个目录不像同步仓库：${repo}` })
      return
    }
  }

  if (action === 'upload') {
    const r = await uploadRepo(w, repo)
    sendJson(res, 200, { ok: r.ok, uploaded: r.uploaded.length, skipped: r.skipped.length, errors: r.errors.slice(0, 20) })
    return
  }
  if (action === 'download') {
    const r = await downloadRepo(w, repo)
    sendJson(res, 200, {
      ok: r.ok,
      downloaded: r.downloaded.length,
      skipped: r.skipped.length,
      conflicts: r.conflicts.length,
      errors: r.errors.slice(0, 20),
    })
    return
  }
  sendJson(res, 400, { ok: false, error: `未知动作：${action}` })
}

async function handleRoots(req, res, config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  if (req.method === 'GET') {
    try {
      const saved = readJson(rootsPathOf(dshHome)) || {}
      const detected = {
        appRoot: resolveAppRoot(config?.appRoot) || '',
        dshHome,
        workspaceHome: guessWorkspaceHome(dshHome),
      }
      const pending = readJson(pendingPathOf(dshHome)) || {}
      const missing = Array.isArray(pending.missing) ? pending.missing : []
      // 两份体检报告（0.3.36 起）：推送时扫出的「根外绝对路径」、拉取时扫出的「被覆盖的本机配置」
      const absReport = readJson(absolutePathsPathOf(dshHome)) || {}
      const absItems = Array.isArray(absReport.items) ? absReport.items : []
      const ovReport = readJson(overwritePathOf(dshHome)) || {}
      const ovItems = Array.isArray(ovReport.items) ? ovReport.items : []
      // 本机这几个根：推荐路径就是拿它们跟报告里「对方机器的根」对出来的
      const localRoots = {
        appRoot: saved.appRoot || detected.appRoot,
        dshHome: saved.dshHome || detected.dshHome,
        workspaceHome: saved.workspaceHome || detected.workspaceHome,
        custom: (() => {
          // 用户主目录能自动探测，不用问人：工作区建在 Documents\deepseek-harness 下时靠它展开
          const c = saved.custom && typeof saved.custom === 'object' ? { ...saved.custom } : {}
          let home = ''
          try { home = homedir() } catch { }
          if (home && !c.userHome) c.userHome = home
          return c
        })(),
      }
      sendJson(res, 200, {
        ok: true,
        roots: localRoots,
        confirmed: Array.isArray(saved.confirmed) ? saved.confirmed : [],
        updatedAt: saved.updatedAt || '',
        detected,
        missing: missing.map((m) => ({
          token: String(m.token || ''),
          file: String(m.file || ''),
          label: String(m.label || ''),
          hint: String(m.hint || tokenHint(m.token)),
        })),
        // 根外绝对路径：只有「这份配置是另一台机器写的」才是问题——本机推出去的路径在本机当然存在，
        // 那条清单在本机显示只会误导（0.3.43 起按 machine 判断，并逐条给本机推荐目录）
        absolutePaths: (() => {
          const machine = String(absReport.machine || '')
          const localMachine = localMachineName()
          const fromOtherMachine = Boolean(machine) && Boolean(localMachine) && !sameMachine(machine, localMachine)
          const candidates = candidateParentDirs(localRoots)
          const adoptedKeys = new Set(Object.values(localRoots.custom || {}).map(pathKeyOf))
          const items = absItems.slice(0, 30).map((it) => {
            const remotePath = String(it.path || '')
            const sug = suggestLocalPathFor(remotePath, absReport, { ...localRoots, candidates })
            const suggestPath = sug.kind === 'none' ? '' : sug.path
            return {
              file: String(it.file || ''),
              path: remotePath,
              // config = 配置文件里的路径；data = 工作区/会话记录里的路径（决定工作区开在哪个目录、会话回到哪个目录）
              scope: String(it.scope || 'config'),
              suggest: suggestPath,
              suggestKind: sug.kind,
              suggestNote: sug.note || '',
              // 采纳时用的自选目录 key：目录名去扩展名；取不到就 dir
              suggestKey: String(sug.leaf || (sug.rest || '').split('/').filter(Boolean).pop() || 'dir').replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[^A-Za-z0-9_.-]/g, '') || 'dir',
              adopted: Boolean(suggestPath) && adoptedKeys.has(pathKeyOf(suggestPath)),
              remoteRoot: sug.remoteRoot || '',
              rest: sug.rest || '',
            }
          })
          return {
            at: String(absReport.at || ''),
            machine,
            localMachine,
            fromOtherMachine,
            total: absItems.length,
            items,
            suggested: items.filter((x) => x.suggest).length,
            adoptedCount: items.filter((x) => x.adopted).length,
          }
        })(),
        // 上次拉取覆盖了哪些本机配置（含备份路径）：本机有未推送改动时会出现
        overwrite: {
          at: String(ovReport.at || ''),
          total: ovItems.length,
          items: ovItems.slice(0, 20).map((it) => ({
            repo: String(it.repo || ''), label: String(it.label || ''), src: String(it.src || ''), backup: String(it.backup || ''),
          })),
        },
        file: rootsPathOf(dshHome),
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
    }
    return
  }
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
  if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
  try {
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const input = body.roots && typeof body.roots === 'object' ? body.roots : {}
    const prev = readJson(rootsPathOf(dshHome)) || {}
    const pick = (key, fallback) => {
      const v = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : prev[key]
      return String(v == null ? '' : v).trim() || String(fallback || '').trim()
    }
    const next = {
      version: 1,
      appRoot: pick('appRoot', resolveAppRoot(config?.appRoot) || ''),
      dshHome: pick('dshHome', dshHome),
      workspaceHome: pick('workspaceHome', guessWorkspaceHome(dshHome)),
      custom: {},
      confirmed: [],
      updatedAt: new Date().toISOString(),
    }
    const rawCustom = Object.prototype.hasOwnProperty.call(input, 'custom') ? input.custom : (prev.custom || {})
    next.custom = normalizeCustomRoots(rawCustom)
    // 校验：三个根都不能空、必须是绝对路径。目录不存在只提示不拒 —— 新机器上目标目录常常还没建。
    const warns = []
    for (const key of ['appRoot', 'dshHome', 'workspaceHome']) {
      if (!next[key]) {
        throw new Error(t(
          `本机路径不能为空：${key}`,
          `A local path cannot be empty: ${key}`,
        ))
      }
      if (!isAbsolute(next[key])) {
        throw new Error(t(
          `要填绝对路径（例如 D:\\DeepSeekHarness）：${next[key]}`,
          `An absolute path is required (e.g. D:\\DeepSeekHarness): ${next[key]}`,
        ))
      }
      if (!existsSync(next[key])) warns.push(t(`目录还不存在：${next[key]}`, `Folder does not exist yet: ${next[key]}`))
    }
    for (const [k, v] of Object.entries(next.custom)) {
      if (!isAbsolute(v)) throw new Error(t(`自选目录要填绝对路径：${k} = ${v}`, `Custom folder must be an absolute path: ${k} = ${v}`))
      if (!existsSync(v)) warns.push(t(`目录还不存在：${v}`, `Folder does not exist yet: ${v}`))
    }
    const confirmed = new Set(Array.isArray(prev.confirmed) ? prev.confirmed : [])
    for (const key of ['appRoot', 'dshHome', 'workspaceHome']) confirmed.add(key)
    for (const k of Object.keys(next.custom)) confirmed.add(`ROOT:${k}`)
    next.confirmed = [...confirmed]

    mkdirSync(dirname(rootsPathOf(dshHome)), { recursive: true })
    writeFileAtomicSync(rootsPathOf(dshHome), `${JSON.stringify(next, null, 2)}\n`)
    // 根都确认了，待确认清单就没意义了：清掉，下次拉取不再拦
    try { if (existsSync(pendingPathOf(dshHome))) unlinkSync(pendingPathOf(dshHome)) } catch { }

    sendJson(res, 200, {
      ok: true,
      roots: next,
      warns,
      note: t(
        '已保存本机路径。接着点一次「拉取」（或退出后用拉取脚本），配置就会按这台机器的路径重新落地。',
        'Saved. Run Pull once (or the pull script after quitting) so the configs are written with these paths.',
      ),
    })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

/**
 * 归一化「自选目录」。三种形状都认：
 *   { 名字: '绝对路径' }                 —— 真实文件 / 面板发送的形状
 *   [ { name|key: '名字', path: '绝对路径' } ] —— 数组形状（手工编辑或旧文件）
 *   [ '绝对路径', ... ]                  —— 纯路径数组，名字取目录名
 * 返回对象映射；形状完全无法识别时抛一条人能看懂的错。
 */
function normalizeCustomRoots(raw) {
  const out = {}
  const leafKey = (v) => String(v).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || ''
  const put = (name, value) => {
    const key = String(name || '').trim() || leafKey(value)
    const val = String(value == null ? '' : value).trim()
    if (key && val) out[key] = val
  }
  if (Array.isArray(raw)) {
    raw.forEach((item, i) => {
      if (item == null) return
      if (typeof item === 'string') { put('', item); return }
      if (typeof item === 'object') {
        const path = item.path ?? item.value ?? item.dir ?? ''
        const name = item.name ?? item.key ?? item.id ?? ''
        if (!String(path || '').trim()) {
          throw new Error(t(
            `自选目录第 ${i + 1} 项没有 path 字段（应为 { name, path } 或纯路径字符串）`,
            `Custom folder entry #${i + 1} has no path field (expected { name, path } or a plain path string)`,
          ))
        }
        put(name, path)
        return
      }
      throw new Error(t(
        `自选目录第 ${i + 1} 项看不懂：${typeof item}（应为 { name, path } 或纯路径字符串）`,
        `Custom folder entry #${i + 1} is not understood: ${typeof item} (expected { name, path } or a plain path string)`,
      ))
    })
    return out
  }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object') {
        const nested = v.path ?? v.value ?? v.dir ?? ''
        if (!String(nested || '').trim()) {
          throw new Error(t(
            `自选目录「${k}」没有 path 字段（应为 { name, path } 或纯路径字符串）`,
            `Custom folder "${k}" has no path field (expected { name, path } or a plain path string)`,
          ))
        }
        put(k, nested)
        continue
      }
      put(k, v)
    }
    return out
  }
  if (raw == null || raw === '') return out
  throw new Error(t(
    `自选目录格式不对：应为 { 名字: 路径 } 或数组`,
    `Custom folders must be an object map or an array`,
  ))
}
/**
 * 问题反馈：落成仓库里的 feedback\<时间戳>-<id>.json，再 git add/commit/push 到云端。
 * 为什么用文件而不是 Issue：不依赖 API 令牌，另一台机器拉取后同样能在面板里看到；
 * 推送失败也不回滚本地文件（先把反馈留住，等网络好了下次推送会带上）。
 */
// ---------- 问题反馈：GitHub Issue 是唯一真源（0.3.31） ----------
// 面板里提交 → 直接建 issue（label=feedback，正文附环境块）；列表读 issue（含 open/closed）；
// 点「已解决」就 PATCH 成 closed。网络不通时先进本机待发队列，下次点「补发」再建 issue。

const GH_DEFAULT_REPO = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
    const raw = String((pkg && pkg.repository && (pkg.repository.url || pkg.repository)) || '')
    const m = raw.match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[#?/]|$)/i)
    if (m && m[1]) return m[1]
  } catch { }
  return 'huanyu-a/dsh-profile-config-sync'
})()
const LEGACY_UPSTREAM_REPOS = new Set(['QcWyGm/dsh-config-sync-plugin', 'QcWyGm/dsh-config-sync'])
const GH_FEEDBACK_LABEL = 'feedback'

/** 当前插件版本（读自己的 package.json；读不到就空串，不抛）。 */
function pluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
    return String(pkg.version || '')
  } catch { return '' }
}

function ghPathOf(dshHome) { return join(dshHome, 'config-sync-gh.json') }
function outboxPathOf(dshHome) { return join(dshHome, 'config-sync-feedback-outbox.json') }

function normalizeGhRepo(raw) {
  const s = String(raw || '').trim()
  if (!s || LEGACY_UPSTREAM_REPOS.has(s)) return GH_DEFAULT_REPO
  return s
}

function readGh(dshHome) {
  const j = readJson(ghPathOf(dshHome)) || {}
  return {
    token: String(j.token || ''),
    tokenEnv: String(j.tokenEnv || '').trim(),
    repo: normalizeGhRepo(j.repo),
    login: String(j.login || ''),
    updatedAt: String(j.updatedAt || ''),
  }
}

function writeGh(dshHome, o) {
  const f = ghPathOf(dshHome)
  try { mkdirSync(dirname(f), { recursive: true }) } catch { }
  const prev = readGh(dshHome)
  const hasToken = Object.prototype.hasOwnProperty.call(o || {}, 'token')
  const hasTokenEnv = Object.prototype.hasOwnProperty.call(o || {}, 'tokenEnv')
  const hasLogin = Object.prototype.hasOwnProperty.call(o || {}, 'login')
  const body = {
    token: hasToken ? String(o.token || '') : prev.token,
    tokenEnv: hasTokenEnv ? String(o.tokenEnv || '').trim() : prev.tokenEnv,
    repo: normalizeGhRepo((o && o.repo) || prev.repo),
    // 令牌没换就沿用之前认出来的账号，免得每轮都调 /user
    login: hasLogin ? String(o.login || '') : prev.login,
    updatedAt: new Date().toISOString(),
  }
  writeFileSync(f, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  return f
}

function readOutbox(dshHome) {
  const j = readJson(outboxPathOf(dshHome))
  return Array.isArray(j?.items) ? j.items : []
}

function writeOutbox(dshHome, items) {
  const f = outboxPathOf(dshHome)
  try { mkdirSync(dirname(f), { recursive: true }) } catch { }
  writeFileSync(f, `${JSON.stringify({ items }, null, 2)}\n`, 'utf8')
  return f
}

/** 从本机 git 凭据里取 GitHub 令牌与用户名：用户平时 push 过，这里就不用再填。 */
function credFromGitCredential() {
  return new Promise((resolve) => {
    let p = null
    try {
      p = spawn(resolveGitExe(), ['credential', 'fill'], { windowsHide: true })
    } catch { resolve({ token: '', username: '' }); return }
    let out = ''
    const timer = setTimeout(() => { try { p.kill() } catch { } resolve({ token: '', username: '' }) }, 8000)
    p.stdout.on('data', (d) => { out += String(d) })
    p.on('error', () => { clearTimeout(timer); resolve({ token: '', username: '' }) })
    p.on('close', () => {
      clearTimeout(timer)
      const pm = out.match(/password=([^\r\n]+)/)
      const um = out.match(/username=([^\r\n]+)/)
      resolve({ token: pm ? pm[1].trim() : '', username: um ? um[1].trim() : '' })
    })
    try { p.stdin.write('protocol=https\nhost=github.com\n\n'); p.stdin.end() } catch { }
  })
}

function tokenFromGitCredential() {
  return credFromGitCredential().then((c) => c.token)
}

/** 从本机 GitHub CLI（gh auth token）读取登录令牌，作为 git credential 的补充。 */
function tokenFromGhCli() {
  return new Promise((resolve) => {
    let p = null
    try {
      p = spawn(IS_WIN ? 'gh.exe' : 'gh', ['auth', 'token'], { windowsHide: true })
    } catch { resolve(''); return }
    let out = ''
    const timer = setTimeout(() => { try { p.kill() } catch { } resolve('') }, 4000)
    p.stdout.on('data', (d) => { out += String(d) })
    p.on('error', () => { clearTimeout(timer); resolve('') })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? String(out || '').trim() : '')
    })
  })
}

/**
 * 令牌读取顺序（绝不把环境变量或凭据助手的令牌写进同步仓库）：
 *   1. config-sync-gh.json 里显式绑定的环境变量名 tokenEnv（实时读取，不落盘明文）；
 *   2. config-sync-gh.json 里保存的令牌（若写成 $VAR / ${VAR} / env:VAR 也按环境变量实时解析）；
 *   3. 本机常见环境变量（DSH_CONFIG_SYNC_GH_TOKEN / GITHUB_TOKEN / GH_TOKEN，不落盘）；
 *   4. 本机 git 凭据（git credential fill，仅放内存使用，不落盘）；
 *   5. 本机 GitHub CLI（gh auth token，仅放内存使用，不落盘）。
 */
async function ghToken(config, dshHome) {
  const g = readGh(dshHome)
  if (g.tokenEnv) {
    return { ...g, token: getEnvValue(g.tokenEnv), source: 'env', envName: g.tokenEnv, tokenSaved: false, credLogin: '' }
  }
  if (g.token) {
    const refEnv = parseEnvTokenRef(g.token)
    if (refEnv) {
      return { ...g, token: getEnvValue(refEnv), source: 'env', envName: refEnv, tokenSaved: false, credLogin: '' }
    }
    return { ...g, source: 'file', envName: '', tokenSaved: true, credLogin: '' }
  }
  for (const name of GH_TOKEN_ENV_CANDIDATES) {
    const v = getEnvValue(name)
    if (v) return { ...g, token: v, source: 'env', envName: name, tokenSaved: false, credLogin: '' }
  }
  const cred = await credFromGitCredential()
  if (cred.token) {
    return { ...g, token: cred.token, source: 'git-credential', envName: '', tokenSaved: false, credLogin: cred.username || '' }
  }
  const ghCliTok = await tokenFromGhCli()
  if (ghCliTok) {
    return { ...g, token: ghCliTok, source: 'gh-cli', envName: '', tokenSaved: false, credLogin: cred.username || '' }
  }
  return { ...g, source: 'none', envName: '', tokenSaved: false, credLogin: cred.username || '' }
}

async function ghApi(pathname, options = {}) {
  const { method = 'GET', token, body, timeoutMs = 15000 } = options
  const url = pathname.startsWith('http') ? pathname : `https://api.github.com${pathname}`
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': PACKAGE_ID,
  }
  // 公开仓库的读接口可以匿名调（60 次/小时/IP），所以 token 允许为空
  if (token) headers.Authorization = `Bearer ${token}`
  const init = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    init.body = JSON.stringify(body)
  }
  let timer = null
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(timeoutMs)
    } else if (typeof AbortController !== 'undefined') {
      const ac = new AbortController()
      init.signal = ac.signal
      timer = setTimeout(() => ac.abort(), timeoutMs)
    }
    const res = await fetch(url, init)
    const raw = await res.text()
    let json = null
    try { json = raw ? JSON.parse(raw) : null } catch { json = null }
    return { ok: res.ok, status: res.status, networkError: false, json, text: raw }
  } catch (err) {
    const causeMsg = err && err.cause && err.cause.message ? String(err.cause.message) : ''
    const baseMsg = String((err && err.message) || err || 'fetch failed')
    const msg = causeMsg && !baseMsg.includes(causeMsg) ? `${baseMsg}: ${causeMsg}` : baseMsg
    return { ok: false, status: 0, networkError: true, json: { message: msg }, text: msg }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function issueToItem(it) {
  return {
    number: Number(it.number || 0),
    title: String(it.title || ''),
    body: String(it.body || ''),
    state: String(it.state || ''),
    url: String(it.html_url || ''),
    createdAt: String(it.created_at || ''),
    updatedAt: String(it.updated_at || ''),
    user: String((it.user && it.user.login) || ''),
    comments: Number(it.comments || 0),
    labels: (Array.isArray(it.labels) ? it.labels : []).map((l) => String((l && l.name) || '')),
  }
}

async function listIssues(repo, token, state) {
  const q = `state=${state}&labels=${GH_FEEDBACK_LABEL}&per_page=50&sort=created&direction=desc`
  const r = await ghApi(`/repos/${repo}/issues?${q}`, { token })
  if (!r.ok) throw new Error(`${r.status} ${String((r.json && r.json.message) || '').slice(0, 200) || '调用 GitHub 失败'}`)
  const arr = Array.isArray(r.json) ? r.json : []
  return arr.filter((x) => !x.pull_request).map(issueToItem)
}

/** 正文末尾附一段环境块：在 GitHub 上看反馈时不用再问"你哪个版本、哪台机器"。 */
function issueBodyOf(text, config) {
  const env = [
    `- 插件版本 / plugin: ${pluginVersion() || '?'}`,
    `- 机器 / machine: ${(() => { try { return hostname() } catch { return '?' } })()}`,
    `- 时间 / at: ${new Date().toISOString()}`,
    `- 平台 / platform: ${process.platform}`,
    `- 安装目录 / appRoot: ${(config && config.appRoot) || '?'}`,
    `- 配置仓库 / repo: ${(config && config.repoPath) || '?'}`,
  ].join('\n')
  return `${String(text || '').trim()}\n\n---\n### 环境 / Environment\n${env}\n`
}

/* ---------- 0.6.48：反馈附件（图片 / 视频） ----------
 * 起因（issue #9）：面板只能打字，截图与录屏没法带上来 —— 而这两样恰恰是
 * 「界面显示不对」「同步报错」类反馈里最关键的证据。
 *
 * 做法：走 GitHub 自己的 release asset 上传接口，不借道第三方图床。
 *   1) 找一个用来挂附件的 release（见 feedbackAssetRelease）：没有就建一个
 *      名为 `feedback-assets` 的草稿 release（draft，标签页看不见，只有
 *      知道链接的人才打得到 —— 反馈附件本来就不该公开发布）；
 *   2) POST 到该 release 的 `upload_url`（形如
 *      https://uploads.github.com/repos/<o>/<r>/releases/<id>/assets{?name,label}），
 *      body 是原始字节，Content-Type 是真实类型，`?name=` 给出文件名；
 *   3) 把返回的 `browser_download_url` 按 Markdown 图片 / 普通链接插进正文。
 *
 * 为什么要自己找 release：Issue 本身没有附件接口，只有 release 才有。
 * 而附件存成 release asset 的好处是：链接永久有效、换机器与别人看都能打开，
 * 且不依赖你本机的文件还在不在。
 *
 * 边界：
 *   - 单文件 20 MB、最多 4 个（GitHub 单 asset 上限 2 GB，这里收紧是为了面板不卡）；
 *   - 白名单类型：PNG / JPEG / GIF / WebP / MP4 / MOV / WebM / 文本日志；
 *     其它一律拒（可执行文件、压缩包不进资产）；
 *   - 没有令牌时退回「浏览器预填页面」，并明确告知附件没上传，
 *     提示用户手动拖进网页 —— 不静默丢弃。
 */
const FEEDBACK_MAX_ATTACH_BYTES = 20 * 1024 * 1024
const FEEDBACK_MAX_ATTACH_COUNT = 4
const FEEDBACK_ATTACH_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  log: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
}

/** 附件的扩展名 → MIME。不在白名单里返回 ''（调用方据此拒收）。 */
function feedbackAttachMime(name) {
  const leaf = String(name || '').split(/[\\/]/).pop() || ''
  const dot = leaf.lastIndexOf('.')
  if (dot <= 0) return ''
  return FEEDBACK_ATTACH_MIME[leaf.slice(dot + 1).toLowerCase()] || ''
}

/** Markdown 引用：图片用 ![]()，其它（视频/日志）用普通链接，点开是下载/播放。 */
function feedbackAttachMarkdown(item) {
  const url = String((item && item.url) || '')
  const name = String((item && item.name) || 'attachment').replace(/([\[\]])/g, '\\$1')
  if (!url) return ''
  return /^image\//.test(String((item && item.type) || '')) ? `![${name}](${url})` : `- [${name}](${url})`
}

/**
 * 上传一个附件到 GitHub（两步：拿上传地址 → PUT 字节）。
 * 成功返回 { ok: true, name, url, type }，失败返回 { ok: false, name, error } —— 不抛，
 * 因为「有一个附件传不上去」不该让整条反馈都发不出去。
 */
/**
 * 找（或建）一个用来挂反馈附件的 release。
 *
 * GitHub 只有 release 有 asset 接口，Issue 没有。先按 tag `feedback-assets` 找；
 * 找不到就建一个**草稿** release（draft=true）：它不会出现在 Releases 页面、
 * 不会被搜索引擎收录，但知道链接的人打得开 —— 反馈附件本来就不该公开发布。
 *
 * 缓存到进程内存里：一次反馈最多 4 个附件，不该为每个文件都去查一遍。
 */
const feedbackReleaseCache = new Map()

async function feedbackAssetRelease(repo, token) {
  const cached = feedbackReleaseCache.get(repo)
  if (cached) return cached
  const tag = 'feedback-assets'
  const found = await ghApi(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { token })
  if (found.ok && found.json && found.json.id) {
    const r = { id: found.json.id, uploadUrl: String(found.json.upload_url || '') }
    feedbackReleaseCache.set(repo, r)
    return r
  }
  // 没有就建：草稿 release，tag 固定，名字写明用途
  const created = await ghApi(`/repos/${repo}/releases`, {
    method: 'POST',
    token,
    body: {
      tag_name: tag,
      name: 'feedback-assets',
      body: 'Draft release holding the attachments of GitHub Issues in this repository. Created automatically by dsh-profile-config-sync; not published on purpose.',
      draft: true,
      prerelease: false,
    },
    timeoutMs: 20000,
  })
  if (!created.ok || !created.json || !created.json.id) {
    return { error: `${created.status} ${String((created.json && created.json.message) || '').slice(0, 160) || '建不了存放附件的 release'}` }
  }
  const r = { id: created.json.id, uploadUrl: String(created.json.upload_url || '') }
  feedbackReleaseCache.set(repo, r)
  return r
}

/**
 * 上传一个附件到 GitHub 的 release assets。
 * 成功返回 { ok: true, name, url, type }，失败返回 { ok: false, name, error } —— 不抛，
 * 因为「有一个附件传不上去」不该让整条反馈都发不出去。
 */
async function uploadFeedbackAsset(repo, token, name, buf, mime) {
  const safe = String(name || 'attachment').split(/[\\/]/).pop().slice(0, 120) || 'attachment'
  const rel = await feedbackAssetRelease(repo, token)
  if (!rel || !rel.id) {
    return { ok: false, name: safe, error: String((rel && rel.error) || '拿不到存放附件的 release') }
  }
  if (!rel.uploadUrl) {
    return { ok: false, name: safe, error: 'release 没有 upload_url' }
  }
  // upload_url 形如 https://uploads.github.com/repos/<o>/<r>/releases/<id>/assets{?name,label}
  // —— 官方格式是「{?name,label}」这一整段，不能只把 {name} 当占位符替换。
  // 去掉那段之后地址末尾没有查询串，所以要用「?」而不是「&」。
  const base = rel.uploadUrl.replace(/\{\?[^}]*\}/g, '')
  const target = base + (base.includes('?') ? '&' : '?') + 'name=' + encodeURIComponent(safe)
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': PACKAGE_ID,
    Authorization: `Bearer ${token}`,
    'Content-Type': mime || 'application/octet-stream',
    'Content-Length': String(buf.length),
  }
  let res
  try {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort() } catch { } }, 120000) : null
    try {
      res = await fetch(target, { method: 'POST', headers, body: buf, signal: ctrl ? ctrl.signal : undefined })
    } finally { if (timer) clearTimeout(timer) }
  } catch (e) {
    return { ok: false, name: safe, error: String((e && e.message) || e) }
  }
  const raw = await res.text().catch(() => '')
  let json = null
  try { json = raw ? JSON.parse(raw) : null } catch { json = null }
  if (!res.ok || !json || !json.browser_download_url) {
    return { ok: false, name: safe, error: `${res.status} ${String((json && json.message) || raw).slice(0, 160) || '上传失败'}` }
  }
  return { ok: true, name: safe, url: String(json.browser_download_url), type: mime || '' }
}

/**
 * 正文 = 用户写的 + 附件引用 + 环境块（环境块永远在最后一段）。
 * 有附件时附件在前、环境块在后；没附件时就是原来的形状，老行为一个字节都不变。
 */
function issueBodyWithAttachments(text, config, attachments) {
  const base = String(text || '').trim()
  const refs = (attachments || []).map(feedbackAttachMarkdown).filter(Boolean)
  const withRefs = refs.length ? `${base}${base ? '\n\n' : ''}### 附件 / Attachments\n${refs.join('\n')}\n` : base
  return issueBodyOf(withRefs, config)
}

async function createIssue(repo, token, title, text, config, attachments = []) {
  return ghApi(`/repos/${repo}/issues`, {
    method: 'POST',
    token,
    body: { title, body: issueBodyWithAttachments(text, config, attachments), labels: [GH_FEEDBACK_LABEL] },
  })
}

/** 仓库所有者（第一个 / 前面那段）：判断「谁能关单」就看它。 */
function ownerOf(repo) {
  return String(repo || '').split('/')[0] || ''
}

const ghIdentityCache = new Map()
/** 令牌属于谁（GET /user）。按令牌哈希放内存缓存，不依赖落盘的旧账号。 */
async function ghIdentity(token, dshHome, known) {
  if (!token) return ''
  const key = createHash('sha256').update(String(token)).digest('hex')
  if (ghIdentityCache.has(key)) return ghIdentityCache.get(key) || ''
  const r = await ghApi('/user', { token })
  const login = r.ok && r.json ? String(r.json.login || '') : ''
  if (login) {
    ghIdentityCache.set(key, login)
    if (isFile(ghPathOf(dshHome)) && known !== login) {
      try { writeGh(dshHome, { login }) } catch { }
    }
    return login
  }
  return String(known || '')
}

/**
 * 无令牌时的提交入口：把标题/正文/环境块塞进 GitHub 的新建 issue 页面。
 * 浏览器里已登录 GitHub 就能直接点 Submit——这条路不需要 token，代价是要人工点一次。
 */
function newIssueUrl(repo, title, text, config) {
  const q = [
    `title=${encodeURIComponent(title)}`,
    `body=${encodeURIComponent(issueBodyOf(text, config))}`,
    `labels=${encodeURIComponent(GH_FEEDBACK_LABEL)}`,
  ].join('&')
  return `https://github.com/${repo}/issues/new?${q}`
}

// ============================ 0.3.76：会话投影缓存守卫 ============================
// 背景：UI 点「新建会话」时会挑一条 summary.blank===true 的会话复用，挑中了 origin=subagent
// 的子会话就会被宿主拒绝（session/agent-busy：is owned by subagent routing）。
// 起因是投影缓存停在 session/created 那一刻（blank=true、seq=-1），而会话日志早就推进过，
// 两边不一致。这里的处理：发现这种「缓存说空、日志有货」的陈旧缓存就把它挪走，让宿主按日志重建。
let loggerRef = null
function ctxLoggerInfo(text) {
  try { loggerRef?.info?.(text) } catch { /* 没有 logger 就算了 */ }
}

/**
 * 0.3.82：拿宿主的 workspaceRegistry 服务（工作区账本的唯一权威）。
 * apply 执行时 registry 可能还没 start，热重载又会换实例，所以每次请求都惰性取一遍。
 */
let ctxRef = null
function workspaceRegistryOf() {
  try {
    const ctx = ctxRef
    if (!ctx) return null
    const reg = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : (ctx.workspaceRegistry || null)
    return reg && typeof reg.archiveSession === 'function' ? reg : null
  } catch {
    return null
  }
}

const cacheGuardState = {
  timer: null,
  interval: null,
  scans: 0,
  lastScanAt: 0,
  lastApplyAt: 0,
  lastStale: 0,
  lastRemoved: [],
  lastError: '',
  lastTrigger: '',
  busyHits: [],
}

function dshHomeOf(config) {
  return config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 跑一次扫描。apply=false 只报告不动手；apply=true 会把陈旧缓存挪到备份目录。 */
function cacheGuardRun(config, opts = {}) {
  const apply = opts.apply === true
  const dshHome = dshHomeOf(config)
  try {
    const report = runGuard(dshHome, {
      apply,
      source: opts.source || '',
      ids: Array.isArray(opts.ids) && opts.ids.length > 0 ? opts.ids : undefined,
      deep: true,
    })
    cacheGuardState.scans += 1
    cacheGuardState.lastScanAt = Date.now()
    cacheGuardState.lastTrigger = opts.source || ''
    cacheGuardState.lastStale = report.staleCount || 0
    cacheGuardState.lastError = (report.errors || []).join('; ')
    if (apply) {
      cacheGuardState.lastApplyAt = Date.now()
      cacheGuardState.lastRemoved = (report.removed || []).map((x) => ({ id: x.id, to: x.to }))
      if (cacheGuardState.lastRemoved.length > 0) {
        ctxLoggerInfo(`[dsh-profile-config-sync] 已清理 ${cacheGuardState.lastRemoved.length} 条陈旧会话投影缓存：${cacheGuardState.lastRemoved.map((x) => x.id).join(', ')}`)
      }
    }
    return report
  } catch (error) {
    const message = String((error && error.message) || error)
    cacheGuardState.scans += 1
    cacheGuardState.lastScanAt = Date.now()
    cacheGuardState.lastTrigger = opts.source || ''
    cacheGuardState.lastError = message
    return { ok: false, scanned: 0, blank: 0, staleCount: 0, stale: [], removed: [], errors: [message] }
  }
}

/** 客户端报某条会话撞了 agent-busy：先把它的缓存定点点掉，再全盘扫一遍同类陈旧项。 */
function cacheGuardOnBusy(config, sessionId) {
  const dshHome = dshHomeOf(config)
  const id = String(sessionId || '').trim()
  const out = { ok: true, sessionId: id, cleared: false, report: null }
  if (id) {
    try {
      const res = clearSessionCaches(dshHome, [id], { reason: 'agent-busy' })
      out.cleared = Array.isArray(res.removed) && res.removed.length > 0
      if (out.cleared) {
        appendGuardLog(dshHome, `[agent-busy] 客户端报 session/agent-busy，已清掉 ${id} 的投影缓存`)
        ctxLoggerInfo(`[dsh-profile-config-sync] agent-busy：已清掉 ${id} 的投影缓存，下次新建会话会按日志重建`)
      }
    } catch (error) {
      out.ok = false
      out.error = String((error && error.message) || error)
    }
  }
  out.report = cacheGuardRun(config, { apply: true, source: 'agent-busy' })
  cacheGuardState.busyHits.unshift({ at: Date.now(), sessionId: id, cleared: out.cleared })
  if (cacheGuardState.busyHits.length > 20) cacheGuardState.busyHits.length = 20
  return out
}

/** 启动后 12 秒首扫一次，之后每 3 分钟一次；设置里关掉就完全不启动。 */
function scheduleCacheGuard(config) {
  try {
    if (cacheGuardState.timer) return
    if (readSettings(dshHomeOf(config)).cacheGuard === false) return
    const run = () => {
      try { cacheGuardRun(config, { apply: true, source: 'timer' }) } catch { /* 定时任务不抛 */ }
    }
    cacheGuardState.timer = setTimeout(run, 12 * 1000)
    try { cacheGuardState.timer.unref?.() } catch { }
    cacheGuardState.interval = setInterval(run, 3 * 60 * 1000)
    try { cacheGuardState.interval.unref?.() } catch { }
  } catch { /* 定时器起不来不影响插件其它功能 */ }
}

function cacheGuardSnapshot(config) {
  const dshHome = dshHomeOf(config)
  const settings = readSettings(dshHome)
  return {
    enabled: settings.cacheGuard !== false,
    scans: cacheGuardState.scans,
    lastScanAt: cacheGuardState.lastScanAt,
    lastApplyAt: cacheGuardState.lastApplyAt,
    lastStale: cacheGuardState.lastStale,
    lastRemoved: cacheGuardState.lastRemoved,
    lastError: cacheGuardState.lastError,
    lastTrigger: cacheGuardState.lastTrigger,
    busyHits: cacheGuardState.busyHits.slice(0, 5),
    backupDir: join(dshHome, 'logs', 'session-cache-guard-backup'),
    logPath: join(dshHome, 'logs', 'session-cache-guard.log'),
  }
}

async function handleCacheGuard(req, res, config) {
  if (req.method === 'GET') {
    const report = cacheGuardRun(config, { apply: false, source: 'panel' })
    sendJson(res, 200, {
      ok: true,
      applied: false,
      state: cacheGuardSnapshot(config),
      scanned: report.scanned,
      blank: report.blank,
      staleCount: report.staleCount,
      stale: report.stale || [],
      removed: [],
      errors: report.errors || [],
    })
    return
  }
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET/POST only' }); return }
  if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
  try {
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const action = String(body.action || 'scan')
    if (action === 'scan') {
      const report = cacheGuardRun(config, { apply: false, source: 'panel' })
      sendJson(res, 200, {
        ok: true,
        applied: false,
        state: cacheGuardSnapshot(config),
        scanned: report.scanned,
        blank: report.blank,
        staleCount: report.staleCount,
        stale: report.stale || [],
        errors: report.errors || [],
      })
      return
    }
    if (action === 'sweep') {
      const report = cacheGuardRun(config, { apply: true, source: 'panel' })
      sendJson(res, 200, {
        ok: true,
        applied: true,
        state: cacheGuardSnapshot(config),
        scanned: report.scanned,
        blank: report.blank,
        staleCount: report.staleCount,
        stale: report.stale || [],
        removed: report.removed || [],
        errors: report.errors || [],
      })
      return
    }
    if (action === 'clear') {
      const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x || '').trim()).filter(Boolean) : []
      if (ids.length === 0) throw new Error(t('ids 不能为空', 'ids must not be empty'))
      const out = clearSessionCaches(dshHomeOf(config), ids, { reason: 'panel' })
      sendJson(res, 200, { ok: true, applied: true, removed: out.removed || [], errors: out.errors || [], state: cacheGuardSnapshot(config) })
      return
    }
    if (action === 'busy') {
      const out = cacheGuardOnBusy(config, body.sessionId)
      sendJson(res, 200, out)
      return
    }
    throw new Error(t('action 只能是 scan / sweep / clear / busy', 'action must be one of scan / sweep / clear / busy'))
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

// 0.3.76：工作区显示状态。自包含读写，不依赖 session-manager API（那个要 owner 凭证）。
// 0.3.82：改成优先走 workspaceRegistry（宿主服务）→ 落盘同时触发 session-list feed，
// 面板上切隐藏/显示即时生效；拿不到 registry 时函数内部退回纯文件写法（live:false）。
// 0.3.83：视图默认多折叠一类「空会话」（创建后没发过消息、也没跑过 turn），
// 以及 Mnemon 空闲审查的父容器（它只有 subagent/catalog，按空会话判定），
// 面板不会再列出一堆空白条目。`?agents=1` / `?blank=1` 分别把两类放回来。
async function handleWorkspaceView(req, res, config) {
  const dshHome = dshHomeOf(config)
  const registry = workspaceRegistryOf()
  const includeAgents = Boolean(req.url && /[?&]agents=1\b/.test(req.url))
  const includeBlank = Boolean(req.url && /[?&]blank=1\b/.test(req.url))
  if (req.method === 'GET') {
    try { sendJson(res, 200, { ok: true, ...readView(dshHome, { includeAgents, includeBlank }) }) }
    catch (error) { sendJson(res, 400, { ok: false, error: String((error && error.message) || error) }) }
    return
  }
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET/POST only' }); return }
  if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
  try {
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const action = String(body.action || '')
    const withAgents = body.includeAgents === true
    const withBlank = body.includeBlank === true
    if (action === 'workspace') {
      const view = await setWorkspaceStateLive(dshHome, String(body.workspaceId || ''), String(body.state || ''), { registry, includeAgents: withAgents, includeBlank: withBlank })
      sendJson(res, 200, { ok: true, ...view })
      return
    }
    if (action === 'session') {
      const view = await setSessionStateLive(dshHome, String(body.sessionId || ''), body.hidden === true, { registry, includeAgents: withAgents, includeBlank: withBlank })
      sendJson(res, 200, { ok: true, ...view })
      return
    }
    throw new Error(t('action 只能是 workspace / session', 'action must be workspace / session'))
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

async function handleFeedback(req, res, config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const action = String(url.searchParams.get('action') || '').trim()
  const number = Number(url.searchParams.get('number') || 0)

  if (req.method === 'GET') {
    try {
      if (url.searchParams.get('refresh') === '1') clearWinEnvCache()
      const g = await ghToken(config, dshHome)
      const outbox = readOutbox(dshHome)
      const owner = ownerOf(g.repo)
      const login = g.token ? await ghIdentity(g.token, dshHome, g.login || g.credLogin || '') : ''
      const envCandidates = GH_TOKEN_ENV_CANDIDATES.filter((n) => Boolean(getEnvValue(n)))
      const base = {
        ok: true,
        repo: g.repo,
        defaultRepo: GH_DEFAULT_REPO,
        label: GH_FEEDBACK_LABEL,
        owner,
        login,
        // 有关闭权限 = 令牌属于仓库所有者；别人的令牌也能改 issue 状态，所以在服务端挡住
        canClose: !!(login && owner && login.toLowerCase() === owner.toLowerCase()),
        connected: false,
        readAnon: false,
        tokenPresent: Boolean(g.token),
        tokenSaved: Boolean(g.tokenSaved),
        tokenSource: g.source || (g.token ? 'file' : 'none'),
        tokenEnv: g.envName || g.tokenEnv || '',
        envCandidates,
        items: [],
        counts: { open: 0, closed: 0, total: 0 },
        outbox: outbox.map((x) => ({ title: String(x.title || ''), createdAt: String(x.createdAt || '') })),
        version: pluginVersion(),
        ghFile: ghPathOf(dshHome),
      }
      // 读：有令牌先带令牌（自己的账号、限额 5000/小时）；网络本身不通时不重复打匿名请求，仅 HTTP 401/403 才退回匿名
      const attempts = g.token ? [g.token, ''] : ['']
      let lastError = ''
      for (const tok of attempts) {
        try {
          const items = await listIssues(g.repo, tok, 'all')
          const counts = {
            open: items.filter((x) => x.state === 'open').length,
            closed: items.filter((x) => x.state === 'closed').length,
            total: items.length,
          }
          sendJson(res, 200, {
            ...base,
            connected: !!tok,
            readAnon: !tok,
            items,
            counts,
            note: !tok
              ? (g.token
                ? t(`当前令牌认证未通过（${lastError || '401'}），已退回匿名读取；请点「换令牌」或重新登录 GitHub`, `Token auth failed (${lastError || '401'}); fell back to anonymous read. Re-auth or update token.`)
                : t('匿名读取（公开仓库，不限令牌；上限 60 次/小时），提交和关单需要令牌', 'Anonymous read (public repo, no token needed; 60 requests/hour). Submitting and closing need a token.'))
              : '',
          })
          return
        } catch (error) {
          lastError = String((error && error.message) || error)
          if (tok && /^0\s/.test(lastError)) break
        }
      }
      sendJson(res, 200, { ...base, error: lastError || t('读不到 issue 列表', 'Cannot read the issue list') })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
    }
    return
  }

  if (req.method !== 'POST' && req.method !== 'PATCH') { sendJson(res, 405, { ok: false, error: 'GET / POST / PATCH only' }); return }
  if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }

  try {
    // 0.6.48：反馈可能带最多 4 个附件的 base64（每个 20 MB 上限，但 base64 后按 32 MB 算）。
    // 这里给 160 MB 的上限：够 4×20 MB 的极端情况，又不至于让一个请求把内存吃穿。
    const raw = await readBody(req, ROUTE_FEEDBACK_MAX_BODY)
    const payload = raw.trim() ? JSON.parse(raw) : {}
    const g = await ghToken(config, dshHome)

    // 1) 存令牌 / 绑定环境变量 / 换反馈仓库（用一次只读接口验证；绑定环境变量时绝不落盘令牌值）
    if (action === 'token') {
      clearWinEnvCache()
      const repo = String(payload.repo || g.repo || GH_DEFAULT_REPO).trim() || GH_DEFAULT_REPO
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        throw new Error(t('仓库格式不对，应为 owner/repo', 'Invalid repo format — expected owner/repo'))
      }
      if (payload.clearToken === true) {
        writeGh(dshHome, {
          token: '',
          tokenEnv: payload.clearEnv === true ? '' : undefined,
          repo,
          login: '',
        })
        const next = await ghToken(config, dshHome)
        const me = next.token ? await ghIdentity(next.token, dshHome, next.credLogin || '') : ''
        const owner = ownerOf(repo)
        sendJson(res, 200, {
          ok: true,
          cleared: true,
          connected: Boolean(next.token),
          tokenPresent: Boolean(next.token),
          repo,
          tokenSource: next.source || 'none',
          tokenEnv: next.envName || next.tokenEnv || '',
          tokenSaved: Boolean(next.tokenSaved),
          login: me,
          owner,
          canClose: !!(me && owner && me.toLowerCase() === owner.toLowerCase()),
        })
        return
      }
      const rawToken = String(payload.token || '').trim()
      const explicitEnv = String(payload.tokenEnv || '').trim()
      const envName = explicitEnv || parseEnvTokenRef(rawToken)
      let verifyToken = ''
      let saveFields = { repo }
      if (envName) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
          throw new Error(t('环境变量名格式不对（仅支持字母、数字和下划线）', 'Invalid env var name (letters, digits and underscores only)'))
        }
        verifyToken = getEnvValue(envName)
        if (!verifyToken) {
          throw new Error(t(`本机环境变量 ${envName} 为空，请先设置它后再保存`, `Local environment variable ${envName} is empty — set it first`))
        }
        // 只存变量名，绝不把令牌值写进 config-sync-gh.json
        saveFields = { token: '', tokenEnv: envName, repo }
      } else if (rawToken) {
        verifyToken = rawToken
        saveFields = { token: rawToken, tokenEnv: '', repo }
      } else if (g.token) {
        // 只改 repo（保留当前已有的环境变量 / 凭据 / 已存令牌）
        verifyToken = g.token
        saveFields = { repo }
      } else {
        throw new Error(t('请输入令牌或环境变量名（如 $GITHUB_TOKEN）', 'Enter a token or an environment variable reference (e.g. $GITHUB_TOKEN)'))
      }
      const probe = await ghApi(`/repos/${repo}`, { token: verifyToken })
      if (!probe.ok) throw new Error(`${probe.status} ${String((probe.json && probe.json.message) || '').slice(0, 160) || '令牌或仓库不对'}`)
      const me = await ghIdentity(verifyToken, dshHome)
      writeGh(dshHome, { ...saveFields, login: me })
      const owner = ownerOf(repo)
      sendJson(res, 200, {
        ok: true,
        connected: true,
        tokenPresent: true,
        repo,
        saved: ghPathOf(dshHome),
        tokenSource: envName ? 'env' : (rawToken ? 'file' : (g.source || 'file')),
        tokenEnv: envName || g.envName || '',
        tokenSaved: Boolean(rawToken || (!envName && g.tokenSaved)),
        login: me,
        owner,
        canClose: !!(me && owner && me.toLowerCase() === owner.toLowerCase()),
      })
      return
    }

    // 2) 补发本机队列里的反馈
    if (action === 'flush') {
      const pending = readOutbox(dshHome)
      if (!g.token) throw new Error(t('没有 GitHub 令牌，补发不了', 'No GitHub token, cannot flush'))
      const sent = []
      const failed = []
      for (const item of pending) {
        // 0.6.48：队列里可能带着已经上传好的附件 URL（建 issue 那步失败时留下的），
        // 补发直接引用，不再重传 —— 附件已经在仓库资产里，重传只会留下垃圾。
        const r = await createIssue(g.repo, g.token, String(item.title || ''), String(item.body || ''), config, Array.isArray(item.attachments) ? item.attachments : [])
        if (r.ok && r.json) sent.push({ number: r.json.number, url: r.json.html_url })
        else failed.push(item)
      }
      writeOutbox(dshHome, failed)
      sendJson(res, 200, { ok: true, sent, remaining: failed.length })
      return
    }

    // 3) 把某条 issue 标记成已解决 / 重新打开 —— 只有仓库所有者本人的令牌可以
    if (req.method === 'PATCH' || action === 'state') {
      if (!number) throw new Error(t('缺 issue 编号', 'Missing issue number'))
      if (!g.token) throw new Error(t('没有令牌：改状态需要令牌', 'No token: changing state needs one'))
      const login = await ghIdentity(g.token, dshHome, g.login)
      const owner = ownerOf(g.repo)
      if (!login || login.toLowerCase() !== owner.toLowerCase()) {
        sendJson(res, 403, {
          ok: false,
          error: t(`只有仓库所有者（${owner}）能关单；当前令牌属于 ${login || '未知账号'}`, `Only the repo owner (${owner}) can close issues; this token belongs to ${login || 'unknown'}`),
        })
        return
      }
      const state = String(payload.state || 'closed') === 'closed' ? 'closed' : 'open'
      const r = await ghApi(`/repos/${g.repo}/issues/${number}`, { method: 'PATCH', token: g.token, body: { state } })
      if (!r.ok) throw new Error(`${r.status} ${String((r.json && r.json.message) || '').slice(0, 160)}`)
      sendJson(res, 200, { ok: true, number, state })
      return
    }

    // 4) 提交一条新反馈
    const title = String(payload.title || '').trim().slice(0, 200)
    const text = String(payload.body || payload.detail || '').trim().slice(0, 6000)
    if (!title) throw new Error(t('先写个标题，方便以后对上号', 'Give it a title so it can be found later'))

    // 4a) 附件（issue #9：图片 / 视频）。面板把文件读成 base64 放进 payload.attachments：
    //     [{ name, type, data }]。这里先校验再上传 —— 上传是不可撤销的（资产留在仓库里），
    //     所以宁可在本地就拒掉不合规的，也不要传上去再删。
    const attachments = []
    const attachErrors = []
    const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : []
    if (rawAttachments.length > FEEDBACK_MAX_ATTACH_COUNT) {
      throw new Error(t(
        `附件最多 ${FEEDBACK_MAX_ATTACH_COUNT} 个（收到 ${rawAttachments.length} 个）`,
        `At most ${FEEDBACK_MAX_ATTACH_COUNT} attachments (got ${rawAttachments.length})`,
      ))
    }
    for (const item of rawAttachments) {
      const name = String((item && item.name) || '')
      const mime = feedbackAttachMime(name)
      if (!mime) {
        attachErrors.push(`${name || '?'}: ${t('不支持的文件类型（只收图片 / 视频 / 日志）', 'unsupported type (images, videos and logs only)')}`)
        continue
      }
      let buf = null
      try {
        const b64 = String((item && item.data) || '')
        // 先按 base64 长度粗筛：base64 约为原字节的 4/3，
        // 超上限十几倍的数据根本不该解码（否则先占一份内存再丢掉）。
        if (b64 && b64.length <= Math.ceil(FEEDBACK_MAX_ATTACH_BYTES * 4 / 3) + 8) buf = Buffer.from(b64, 'base64')
      } catch { buf = null }
      if (!buf || buf.length === 0) {
        attachErrors.push(`${name || '?'}: ${t('读不到文件内容', 'cannot read the file content')}`)
        continue
      }
      if (buf.length > FEEDBACK_MAX_ATTACH_BYTES) {
        attachErrors.push(`${name}: ${t(`超过 ${Math.round(FEEDBACK_MAX_ATTACH_BYTES / 1048576)} MB`, `larger than ${Math.round(FEEDBACK_MAX_ATTACH_BYTES / 1048576)} MB`)}`)
        continue
      }
      attachments.push({ name, type: mime, buf })
    }

    // 没令牌：不硬失败，给一条浏览器预填链接（浏览器登录了 GitHub 就能点提交）。
    // 有附件时必须在消息里说清楚「附件没带上，要手动拖进网页」—— 静默丢弃是这类功能最常见的坑。
    if (!g.token) {
      const localNames = attachments.map((a) => a.name)
      const notes = []
      if (localNames.length) {
        notes.push(t(
          `没有令牌：附件（${localNames.join('、')}）没能上传，请在打开的页面里手动把它们拖进正文；标题和正文都已填好。`,
          `No token: attachments (${localNames.join(', ')}) were not uploaded — drag them into the body on the opened page; title and body are prefilled.`,
        ))
      }
      // 被拒的附件也要说：悄悄丢掉一个 .exe，用户会以为「它上去了」
      if (attachErrors.length) {
        notes.push(t(`有附件没带上：${attachErrors.join('、')}`, `Some attachments were left out: ${attachErrors.join(', ')}`))
      }
      sendJson(res, 200, {
        ok: true,
        needToken: true,
        submitted: false,
        fallbackUrl: newIssueUrl(g.repo, title, text, config),
        pendingAttachments: localNames,
        attachmentErrors: attachErrors,
        error: notes.join(' ') || t('没有令牌：可以打开预填好的新建 issue 页面，在浏览器里点一下提交', 'No token: open the prefilled new-issue page and press submit in the browser'),
      })
      return
    }

    // 先传附件：资产一旦上传就留在仓库里，所以放在建 issue 之前——
    // 建 issue 失败时至少能把这些 URL 存进待发队列，补发时不用再传一遍。
    const uploaded = []
    for (const a of attachments) {
      const r = await uploadFeedbackAsset(g.repo, g.token, a.name, a.buf, a.type)
      if (r.ok) uploaded.push({ name: r.name, url: r.url, type: r.type })
      else attachErrors.push(`${a.name}: ${r.error}`)
    }

    const r = await createIssue(g.repo, g.token, title, text, config, uploaded)
    if (r.ok && r.json) {
      sendJson(res, 200, {
        ok: true,
        number: r.json.number,
        url: r.json.html_url,
        item: issueToItem(r.json),
        attachments: uploaded.map((u) => ({ name: u.name, url: u.url })),
        attachmentErrors: attachErrors,
      })
      return
    }
    // 建 issue 失败：进本机队列，网络好了点「补发」
    const items = readOutbox(dshHome)
    items.push({
      title,
      body: text,
      createdAt: new Date().toISOString(),
      error: `${r.status} ${String((r.json && r.json.message) || '').slice(0, 160)}`,
      // 附件 URL 一起入队：补发时直接引用，不重复上传
      attachments: uploaded.map((u) => ({ name: u.name, url: u.url, type: u.type })),
    })
    writeOutbox(dshHome, items)
    sendJson(res, 200, {
      ok: true,
      queued: true,
      remaining: items.length,
      attachments: uploaded.map((u) => ({ name: u.name, url: u.url })),
      attachmentErrors: attachErrors,
      error: `${r.status} ${String((r.json && r.json.message) || '').slice(0, 160)}`,
    })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

export function apply(ctx, config) {
  try {
    try { loggerRef = ctx?.logger || null } catch { }
    try { ctxRef = ctx || null } catch { }
    ctx.inject(['webServer'], (scoped) => {
      // 每个请求按 accept-language 决定返回中文还是英文：AsyncLocalStorage 让 t() 在
      // 任何异步后续里都能读到本次请求的语言，不用把语言参数一层层往下传。
      const withLang = (handler) => (req, res) => langStore.run(pickLang(req), () => handler(req, res, config))
      // 每条路由都过准入：先由宿主 Connection 判定（Host/Origin 围栏 + 浏览器会话鉴权），
      // 宿主没提供 connection 时退回本地 originAllowed。少套一层就等于本机任何进程都能进来。
      const guarded = (handler) => admitWrap(ctx, withLang(handler))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_STATUS,
        handler: guarded(handleStatus),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_PREPARE,
        handler: guarded(handlePrepare),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_SETTINGS,
        handler: guarded(handleSettings),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_AUTO,
        handler: guarded(handleAuto),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_UPDATE,
        handler: guarded(handleUpdate),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_SCOPE,
        handler: guarded(handleScope),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_EXTRA_CONFIG,
        handler: guarded(handleExtraConfig),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_CONFLICT,
        handler: guarded(handleConflict),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_ROOTS,
        handler: guarded(handleRoots),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_FEEDBACK,
        handler: guarded(handleFeedback),
      }))
      // 0.3.76：会话投影缓存守卫（GET 只读扫描 / POST scan|sweep|clear|busy）
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_CACHE_GUARD,
        handler: guarded(handleCacheGuard),
      }))
      // 0.3.76：工作区显示状态卡片
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_WORKSPACE_VIEW,
        handler: guarded(handleWorkspaceView),
      }))
      // 0.4.0：WebDAV 通道（连通性测试 / 立即上传 / 立即下载 / 保存设置）
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_WEBDAV,
        handler: guarded(handleWebdav),
      }))
    })
    // 开关打开才排一次启动检查（默认关 = 什么都不做）
    scheduleAutoStart(config)
    // 云端探测预热：插件一装上就去探一次（不阻塞、不 await）。这样面板打开时缓存多半已经热了，
    // status 不用再为首屏那 2.5 秒的 ls-remote 埋单。
    typeof setTimeout === 'function' ? setTimeout(() => { try { warmRemoteProbe(config) } catch { } }, 300) : null
    installQuitWhenAllWindowsClosed(ctx, config)
    // 0.3.76：会话投影缓存守卫的定时扫描（默认开，设置里可关）
    scheduleCacheGuard(config)
  } catch (error) {
    // 不抛：缺 webServer 的 profile 里这个插件静默不激活即可
    try { ctx.logger?.warn?.(`[${PACKAGE_ID}] webServer 不可用，设置页面板不会出现：${error}`) } catch { }
  }
}

/**
 * 用户点窗口右上角的关闭键时，让客户端**真的退出**。
 *
 * 为什么要主动补一刀：宿主自己的 window-all-closed 只在"所有窗口都销毁"时才 quit，
 * 实测点了关闭后主进程又活了 1.5 分钟以上（还有隐藏/后台窗口在），
 * 而「退出后自动推送」的守护进程只认"主进程 pid 消失"——于是永远等不到，推送不执行。
 * 这里在窗口 closed 后查一遍：一个可见窗口都没有了就 app.quit()。
 */
function installQuitWhenAllWindowsClosed(ctx, config) {
  try {
    const el = electronApp()
    if (!el) return
    const flag = '__dshConfigSyncQuitHook'
    if (globalThis[flag]) return
    globalThis[flag] = true
    el.app.on('browser-window-created', (_event, win) => {
      try {
        win.on('closed', () => {
          setTimeout(async () => {
            try {
              const alive = el.BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed())
              const visible = alive.filter((w) => { try { return w.isVisible() } catch { return false } })
              if (visible.length === 0) {
                // 0.3.93：退出前判一次自动拉取/推送并排好 watcher，再 quit。
                // 必须在 app.quit() 之前 await：插件随主进程退出而消失，quit 后再判就来不及排队了。
                // 开关都关 / 没有待同步内容时这个函数很快返回，不影响关闭速度。
                try {
                  const r = await triggerAutoSyncOnClose(config)
                  if (r && r.queued) {
                    try { ctx.logger?.info?.(`[${PACKAGE_ID}] 退出前已排队 ${r.mode}（自动同步）：DSH 退出后立即执行`) } catch { }
                  }
                } catch { }
                try { ctx.logger?.info?.(`[${PACKAGE_ID}] 已无可见窗口，退出客户端（好让退出后同步开始）`) } catch { }
                el.app.quit()
              }
            } catch { }
          }, 600)
        })
      } catch { }
    })
  } catch { }
}

export default { name: PACKAGE_ID, apply }