// 退出后执行（macOS / Linux）—— post-exit.ps1 的 Node 版等价物。
//
// 为什么必须有这一层：插件跑在 DSH 进程里，自己等不了自己退出。Windows 版用
// post-exit.ps1（PowerShell + Start-Process），macOS / Linux 上没有 PowerShell，
// 于是 0.6.47 之前这边整条「退出后推送 / 拉取 / 还原 / 重启」都是死路：
// spawnWatcher() 拉 powershell.exe 必然 ENOENT，面板上点了按钮什么都没发生。
//
// 用法（由插件在运行期以 detached 方式拉起）：
//   node post-exit.mjs -Mode pull|push|restore|relaunch|update -WatchPid <dsh pid> \
//       -DshHome ~/.dsh [-RepoRoot ~/dsh-config] [-AppRoot /Applications/DeepSeek Harness.app] \
//       [-Restart] [-CloseWhenIdle] [-BackupDir <snap>] [-SnapshotKind profile|plugin|session] \
//       [-PluginDir <plugin>] [-PidFile <file>] [-MaxWaitMinutes 30]
//
// 契约（与 PowerShell 版一致，面板读的是同一份结果文件）：
//   - 只认 -WatchPid：那个进程真的消失后才动手，绝不在客户端运行期 apply；
//   - 动作做完（无论成败）写 <DshHome>/auto-sync-result.json，客户端下次启动读它弹提示；
//   - -Restart 时把客户端重新拉起来（macOS 用 `open -a`，Linux 用可执行文件本身）；
//   - 互斥锁 <DshHome>/auto-sync.lock 里记自己的 pid，别的同步动作看到它会排队。

import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { clientExecutable, listClientProcesses } from './platform.mjs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const IS_MAC = process.platform === 'darwin'

/** 把 `-Key value` / `-Key=value` 混写的参数解析成对象（与 sync-engine.mjs 同语义）。 */
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

const a = parseArgs(process.argv.slice(2))
const mode = String(a.Mode || a.mode || '').toLowerCase()
const watchPid = Number(a.WatchPid || a.watchPid || 0) || 0
const dshHome = resolve(String(a.DshHome || a.dshHome || join(process.env.HOME || '', '.dsh')))
const repoRoot = String(a.RepoRoot || a.repoRoot || '')
const appRoot = String(a.AppRoot || a.appRoot || '')
const workspaceHome = String(a.WorkspaceHome || a.workspaceHome || '')
const profileName = String(a.ProfileName || a.profileName || 'desktop')
const restart = a.Restart === true || a.restart === true
const closeWhenIdle = a.CloseWhenIdle === true || a.closeWhenIdle === true
const backupDir = String(a.BackupDir || a.backupDir || '')
const snapshotKind = String(a.SnapshotKind || a.snapshotKind || 'profile')
const pluginDir = String(a.PluginDir || a.pluginDir || '')
const pidFile = String(a.PidFile || a.pidFile || '')
const maxWaitMinutes = Number(a.MaxWaitMinutes ?? a.maxWaitMinutes ?? 30)
const maxWait = Number.isFinite(maxWaitMinutes) && maxWaitMinutes >= 0 ? maxWaitMinutes : 30
// 夹具用：跳过「等客户端退出」这一步（自检里 DSH 本来就在跑，否则每套夹具都要等 30 分钟）。
const forceRun = a.ForceRun === true || a.forceRun === true
const updateTgz = String(a.UpdateTgz || a.updateTgz || '')
const updateVersion = String(a.UpdateVersion || a.updateVersion || '')

const KINDS = ['pull', 'push', 'restore', 'update', 'relaunch']
if (!KINDS.includes(mode)) {
  console.error(`post-exit: -Mode 只能是 ${KINDS.join(' / ')}（收到 "${mode}"）`)
  process.exit(2)
}

const logsDir = join(dshHome, 'logs')
try { mkdirSync(logsDir, { recursive: true }) } catch { /* 建不出来就让下面的写日志失败被忽略 */ }
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const logFile = join(logsDir, `auto-sync-${mode}-${stamp}.log`)
const resultFile = join(dshHome, 'auto-sync-result.json')
const lockFile = join(dshHome, 'auto-sync.lock')

function log(text) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${text}\n`
  try { appendFileSync(logFile, line, 'utf8') } catch { /* 日志写不进去不能影响同步 */ }
  try { process.stdout.write(line) } catch { /* 没有终端就静默 */ }
}

function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
    writeFileSync(path, readFileSync(tmp, 'utf8'), 'utf8')
    rmSync(tmp, { force: true })
    return true
  } catch {
    try { rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
    return false
  }
}

function readNotices() {
  try {
    const p = join(dshHome, 'sync-notices.json')
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    return j && Number(j.total) > 0 ? j : null
  } catch { return null }
}

function writeResult(ok, code, message, restored) {
  const payload = {
    mode,
    ok: Boolean(ok),
    at: Date.now(),
    code: Number(code) || 0,
    message: String(message || ''),
    restored: Boolean(restored),
    log: logFile,
    appRoot,
    restart,
    platform: process.platform,
    host: (() => { try { return hostname() } catch { return '' } })(),
    notices: readNotices(),
  }
  if (writeJsonAtomic(resultFile, payload)) log(`结果已写入：${resultFile}`)
  else log('写结果文件失败（不影响本次同步本身）')
}

/** 进程还活着吗（pid 复用也当活着，宁可多等一轮）。 */
function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * 客户端是否还在跑。
 *
 * 0.6.49：**不能**按进程名模糊匹配。本进程自己的命令行里就带着
 * "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/.../node post-exit.mjs"，
 * 用 `pgrep -f "DeepSeek Harness"` 会匹配到自己 → 客户端早退了它还在等，等到 30 分钟超时
 * 一件正事都不做；`pkill -f` 更会把自己杀掉。现在按客户端可执行文件路径精确匹配（见
 * runtime/platform.mjs 的 listClientProcesses / looksLikeClientProcess）。
 * 返回 true / false；判不了（没有 ps）返回 null。
 */
function clientRunning() {
  const list = listClientProcesses(appRoot, process.pid)
  if (list === null) return null
  return list.length > 0
}

/** 写等待日志：面板只读结果文件，这个日志是给人排查用的。 */
function waitLog(text) {
  try { appendFileSync(join(logsDir, 'auto-sync-wait.log'), `[${new Date().toISOString()}] [${mode}] ${text}\n`, 'utf8') } catch { /* 忽略 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等 DSH 完全退出。超时返回 false。 */
async function waitForExit() {
  if (forceRun) { waitLog('夹具模式：跳过等待'); return true }
  if (!watchPid) return true
  const deadline = Date.now() + maxWait * 60 * 1000
  waitLog(`等待开始（pid ${watchPid}）`)
  let sawRunning = false
  while (Date.now() < deadline) {
    const byPid = alive(watchPid)
    const byName = clientRunning()
    const running = byPid || byName === true
    if (running) sawRunning = true
    if (!byPid && byName !== true) { waitLog('DSH 已完全退出'); return true }
    if (closeWhenIdle && sawRunning && !byPid) {
      // 插件请求过关闭（用户点了「立即拉取」这类）：pid 没了但还有同名进程赖着，
      // 说明是收进托盘的残留，明确授权下按可执行文件路径精确结束。
      waitLog('pid 已退出但仍有客户端进程，按 -CloseWhenIdle 收掉残留')
      // 按可执行文件路径精确结束（按名字会把自己这个等待进程也一起杀掉）
      const procs = listClientProcesses(appRoot, process.pid) || []
      for (const pid of procs) {
        try { process.kill(pid, 'SIGTERM') } catch { /* 已经退了 */ }
      }
    }
    await sleep(2000)
  }
  waitLog('等待超时，放弃本次同步')
  return false
}

/** 客户端自带 Node 优先，其次当前进程的 node。 */
function nodeExe() {
  const bundled = appRoot ? join(appRoot, 'Contents', 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node') : ''
  if (bundled && existsSync(bundled)) return bundled
  return process.execPath
}

/** 执行体：仓库里的优先（随仓库更新），其次插件自带的。 */
function engine() {
  // 顺序：插件自带 → 仓库那份。
  // 0.6.49：原来仓库优先，可仓库里那份可能是旧版（换机后先 pull 的机器上尤其常见），
  // 旧版不认新参数（-DryRun 会被当未知参数忽略，计划步骤直接变成真还原）。插件自带的
  // 永远是「正在跑的这份代码」，仓库那份只在插件目录都找不到时兜底。
  const candidates = [
    join(SELF_DIR, 'sync-engine.mjs'),
    pluginDir ? join(pluginDir, 'runtime', 'sync-engine.mjs') : '',
    repoRoot ? join(repoRoot, 'sync-engine.mjs') : '',
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || ''
}

function runEngine(args, timeoutMs = 30 * 60 * 1000) {
  const eng = engine()
  if (!eng) return { code: 3, out: '', err: '插件与仓库里都没有 sync-engine.mjs' }
  const argv = [eng]
  if (mode !== 'restore' && mode !== 'relaunch' && mode !== 'update') argv.push(mode)
  else if (mode === 'restore') argv.push('restore')
  argv.push('-RepoRoot', repoRoot || dirname(eng), '-DshHome', dshHome)
  if (appRoot) argv.push('-AppRoot', appRoot)
  if (workspaceHome) argv.push('-WorkspaceHome', workspaceHome)
  argv.push('-ProfileName', profileName)
  argv.push(...args)
  log(`执行：${nodeExe()} ${argv.join(' ')}`)
  const r = spawnSync(nodeExe(), argv, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
  const out = String(r.stdout || '')
  const err = String(r.stderr || '')
  for (const line of (out + err).split(/\r?\n/)) if (line.trim()) log(`  ${line}`)
  return { code: typeof r.status === 'number' ? r.status : (r.error ? 1 : 0), out, err }
}

/** 把客户端重新拉起来（macOS 用 open -a，Linux 直接起可执行文件）。 */
function relaunch() {
  try {
    if (IS_MAC && appRoot) {
      const r = spawnSync('open', ['-a', appRoot], { encoding: 'utf8' })
      if (r.status === 0) return true
      log(`open -a 失败：${String(r.stderr || '').trim()}`)
    }
    // 可执行文件交给 platform.mjs 认（macOS .app / Linux 解包目录都对）
    const exe = clientExecutable(appRoot)
    if (exe && existsSync(exe)) {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
      child.unref()
      return true
    }
    log('找不到客户端可执行文件，无法自动重启')
    return false
  } catch (e) {
    log(`重启客户端失败：${e && e.message ? e.message : e}`)
    return false
  }
}

/** 插件更新：把已经下好的 tgz 或 URL 交给 install-plugin.mjs。 */
function installUpdate() {
  const installer = [join(SELF_DIR, 'install-plugin.mjs'), pluginDir ? join(pluginDir, 'runtime', 'install-plugin.mjs') : '']
    .filter(Boolean).find((p) => existsSync(p))
  if (!installer) return { ok: false, code: 3, error: '插件目录里没有 runtime/install-plugin.mjs' }
  const args = [installer, '-PluginDir', pluginDir || '', '-Version', updateVersion || '']
  // 0.6.49：安装器的参数名是 -TgzFile（已下好的本地包）/ -TgzUrls（候选下载地址）。
  // 原来这里传的是 -UpdateTgz（那是**本脚本**自己的参数名），安装器不认识 → 更新永远
  // 报「没有可用的下载地址」。两个脚本的参数名不是同一套，别串用。实测踩过。
  if (updateTgz) args.push('-TgzFile', updateTgz)
  if (a.UpdateSha256) args.push('-Sha256', String(a.UpdateSha256))
  if (a.UpdateIntegrity) args.push('-Integrity', String(a.UpdateIntegrity))
  if (a.UpdateSha1) args.push('-Sha1', String(a.UpdateSha1))
  args.push('-DshHome', dshHome)
  log(`安装更新：${nodeExe()} ${args.join(' ')}`)
  const r = spawnSync(nodeExe(), args, { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
  const text = String(r.stdout || '') + String(r.stderr || '')
  for (const line of text.split(/\r?\n/)) if (line.trim()) log(`  ${line}`)
  const line = text.split(/\r?\n/).filter((l) => l.startsWith('RESULT:')).pop()
  if (!line) return { ok: false, code: 1, error: `安装脚本没有返回结果：${text.trim().slice(-300) || '(无输出)'}` }
  try { return JSON.parse(line.slice('RESULT:'.length)) } catch { return { ok: false, code: 1, error: '安装结果不是合法 JSON' } }
}

/** 释放互斥锁（只在还持有的时候）。 */
function releaseLock() {
  try {
    const held = JSON.parse(readFileSync(lockFile, 'utf8'))
    if (Number(held && held.pid) !== process.pid) return
  } catch { return }
  try { rmSync(lockFile, { force: true }) } catch { /* 忽略 */ }
}

/** 收尾：写结果 → 放锁 → 退出。所有分支都走这里，别让锁留在盘上。 */
function finish(code, ok, message, restored) {
  writeResult(ok, code, message, restored)
  releaseLock()
  process.exit(Number(code) || 0)
}

// ---------- 主流程 ----------
try {
  if (pidFile) {
    try {
      mkdirSync(dirname(pidFile), { recursive: true })
      writeFileSync(pidFile, String(process.pid), 'utf8')
    } catch { /* 拿不到 pid 文件只是父进程少一次确认，不影响执行 */ }
  }
  // 接管互斥锁：等待阶段记的是那个等待进程的 pid，这里换成真正干活的进程。
  try { writeFileSync(lockFile, JSON.stringify({ pid: process.pid, mode, at: Date.now() }), 'utf8') } catch { /* 忽略 */ }

  log(`开始：mode=${mode} watchPid=${watchPid} repo=${repoRoot || '(未配置)'}`)

  const exited = await waitForExit()
  if (!exited) finish(2, false, '等客户端退出超时，本次同步没执行', false)
  // 进程刚退时文件句柄还没释放，留一点余量
  await sleep(1500)

  if (mode === 'relaunch') {
    const ok = relaunch()
    finish(ok ? 0 : 1, ok, ok ? '客户端已重新启动' : '重启客户端失败，请手动打开', false)
  }

  if (mode === 'update') {
    const r = installUpdate()
    if (!r.ok) finish(5, false, `插件更新失败：${r.error || '详见日志'}`, false)
    if (restart) relaunch()
    finish(0, true, `插件已更新到 ${updateVersion || r.version || '新版本'}（重启后生效）`, false)
  }

  if (mode === 'restore') {
    const args = []
    if (backupDir) args.push('-BackupDir', backupDir)
    if (snapshotKind && snapshotKind !== 'profile') args.push('-SnapshotKind', snapshotKind)
    if (pluginDir && snapshotKind === 'plugin') args.push('-PluginDir', pluginDir)
    args.push('-Force')
    const r = runEngine(args)
    const ok = r.code === 0
    if (restart) relaunch()
    finish(ok ? 0 : 5, ok, ok
      ? '已还原到所选备份（还原前的状态已留底，可再还原一次）'
      : '还原失败，详见日志；还原前的状态已留底', false)
  }

  // pull / push
  const r = runEngine(['-Force'])
  // 3 = 另一个同步动作正在进行（互斥）：什么都没做，但不是故障
  const skipped = r.code === 3
  const failed = r.code !== 0 && !skipped
  if (restart) relaunch()
  if (skipped) finish(0, true, `另一个同步动作正在进行，本次${mode === 'pull' ? '拉取' : '推送'}已跳过（不是故障）`, false)
  if (failed) finish(5, false, `${mode === 'pull' ? '拉取' : '推送'}失败（详见日志）`, false)
  finish(0, true, mode === 'pull' ? '云端配置已拉取到本机' : '本机改动已推送到云端', false)
} catch (error) {
  // 任何未预料的异常都要落盘 + 放锁，否则面板永远停在「排队中」
  log(`未预料的异常：${(error && error.stack) || error}`)
  finish(1, false, `执行异常：${(error && error.message) || error}`, false)
}