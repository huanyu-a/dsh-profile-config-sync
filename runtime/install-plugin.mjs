// 把插件新版本装进插件目录（macOS / Linux）—— install-plugin.ps1 的 Node 版。
//
// 为什么要有：Windows 版更新流程走 PowerShell 脚本（下载 → 校验 → 备份 → 覆盖），
// macOS / Linux 上没有 PowerShell，0.6.47 之前这边「检查到更新」之后两条路都断了：
//   - 运行中安装 install-live 调的是 install-plugin.ps1（必然 ENOENT）；
//   - 退出后安装交给 post-exit.ps1（也不存在，见 post-exit.mjs）。
//
// 用法：
//   node install-plugin.mjs -PluginDir <插件目录> [-Version 0.6.49] [-Sha256 <hex>] \
//       [-Integrity <sri>] [-Sha1 <hex>] [-TgzUrls "url1|url2"] [-TgzFile <本地 tgz>] \
//       -DshHome ~/.dsh [-LogFile <log>]
//
// 结果固定打一行 `RESULT:{json}`（ok / version / backup / log / error），与 PowerShell 版同形，
// 宿主（index.js runInstallPlugin 与 post-exit.mjs installUpdate）解析的就是这一行。
//
// 零第三方依赖：下载用全局 fetch，解包用 node:zlib 的 gunzip + 手写 ustar 解析
// （npm tarball 就是 gzip 的 tar，不需要 tar 命令，也不依赖系统装了 bsdtar）。

import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))

/** `-Key value` / `-Key=value` 解析（与 sync-engine.mjs 同语义）。 */
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
const pluginDir = resolve(String(a.PluginDir || a.pluginDir || ''))
const version = String(a.Version || a.version || '')
const sha256 = String(a.Sha256 || a.sha256 || '')
const integrity = String(a.Integrity || a.integrity || '')
const sha1 = String(a.Sha1 || a.sha1 || '')
const tgzFile = String(a.TgzFile || a.tgzFile || '')
const dshHome = resolve(String(a.DshHome || a.dshHome || join(process.env.HOME || '', '.dsh')))
const logFile = String(a.LogFile || a.logFile || '')
const urls = String(a.TgzUrls || a.tgzUrls || '').split('|').map((s) => s.trim()).filter(Boolean)

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const resolvedLog = logFile || join(dshHome, 'logs', `plugin-install-${stamp}.log`)

function log(text) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${text}`
  try { mkdirSync(dirname(resolvedLog), { recursive: true }); writeFileSync(resolvedLog, line + '\n', { flag: 'a' }) } catch { /* 日志写不进去不影响安装 */ }
  try { process.stdout.write(line + '\n') } catch { /* 没有终端 */ }
}

function finish(ok, payload = {}) {
  const obj = {
    ok: Boolean(ok),
    version: String(payload.version || version || ''),
    backup: String(payload.backup || ''),
    log: resolvedLog,
    error: String(payload.error || ''),
  }
  process.stdout.write('RESULT:' + JSON.stringify(obj) + '\n')
  process.exit(0)
}

/** 失败时把插件目录恢复成动手前的样子。 */
function restoreBackup(backup, target) {
  if (!backup || !existsSync(backup)) return false
  try {
    for (const e of readdirSync(target, { withFileTypes: true })) {
      rmSync(join(target, e.name), { recursive: true, force: true })
    }
    for (const e of readdirSync(backup, { withFileTypes: true })) {
      copyTree(join(backup, e.name), join(target, e.name))
    }
    return true
  } catch (e) {
    log(`回滚失败：${(e && e.message) || e}`)
    return false
  }
}

function copyTree(from, to) {
  const st = statSync(from)
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const e of readdirSync(from, { withFileTypes: true })) copyTree(join(from, e.name), join(to, e.name))
    return
  }
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

/** 下载到本地文件（带超时）。 */
async function download(url, dest) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort() } catch { /* 忽略 */ } }, 180000) : null
  try {
    const res = await fetch(url, { signal: ctrl ? ctrl.signal : undefined, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(dest, buf)
    return buf.length
  } finally { if (timer) clearTimeout(timer) }
}

/** SRI（sha512-base64）校验。 */
function checkIntegrity(buf, sri) {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(String(sri || '').trim())
  if (!m) return false
  const got = createHash('sha512').update(buf).digest('base64')
  return got === m[1]
}

/**
 * 解 npm tarball（gzip 的 ustar）到目标目录。
 * 返回解出的文件数；遇到 GNU 长名（'L'）与 pax 头（'x'）都能处理。
 */
function extractTarball(tgzPath, destDir) {
  const raw = gunzipSync(readFileSync(tgzPath))
  mkdirSync(destDir, { recursive: true })
  let offset = 0
  let longName = ''
  let count = 0
  const writeOne = (name, body) => {
    // 剥掉 ./ 与 package/ 前缀，剩下的就是插件目录内容
    const rel = name.replace(/^\.\//, '').replace(/^package\//, '')
    // 安全边界：拒绝绝对路径与任何 .. 段，别让一个恶意包写到插件目录外面
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return
    // macOS 的 tar 会塞 AppleDouble 资源分叉（._xxx），解出来会在插件目录里留一堆垃圾文件
    if (rel.split('/').some((seg) => seg.startsWith('._'))) return
    const target = join(destDir, rel)
    if (body === null) { mkdirSync(target, { recursive: true }); return }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
    count++
  }
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    // 全零块 = 归档结束
    if (header.every((b) => b === 0)) break
    const readStr = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '')
    const nameRaw = readStr(0, 100)
    const sizeRaw = readStr(124, 12).trim()
    const size = sizeRaw ? parseInt(sizeRaw, 8) || 0 : 0
    const type = String.fromCharCode(header[156] || 48)
    const prefix = readStr(345, 155)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > raw.length) break
    const body = raw.subarray(dataStart, dataEnd)
    if (type === 'L') {
      // GNU 长文件名：内容就是真实路径（可能带结尾 NUL）
      longName = body.toString('utf8').replace(/\0.*$/, '')
    } else if (type === 'x' || type === 'g') {
      // pax 扩展头：只关心 path=，其余忽略
      const text = body.toString('utf8')
      const m = /(\d+) path=([^\n]+)\n/.exec(text)
      if (m) longName = m[2]
    } else if (type === '0' || type === '\0' || type === '') {
      writeOne(longName || (prefix ? prefix + '/' + nameRaw : nameRaw), body)
      longName = ''
    } else if (type === '5') {
      writeOne(longName || (prefix ? prefix + '/' + nameRaw : nameRaw), null)
      longName = ''
    }
    offset = dataEnd + Math.ceil(size / 512) * 512 - size
  }
  return count
}

async function main() {
  if (!pluginDir) return finish(false, { error: '-PluginDir 必填（插件安装目录）' })
  if (!existsSync(pluginDir)) return finish(false, { error: `插件目录不存在：${pluginDir}` })

  const work = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-'))
  let backup = ''
  try {
    // 1) 拿到安装包
    let tgz = ''
    if (tgzFile && existsSync(tgzFile)) {
      tgz = tgzFile
      log(`使用已下载的安装包：${tgz}（${statSync(tgz).size} 字节）`)
    } else {
      if (!urls.length) return finish(false, { error: '没有可用的下载地址（-TgzUrls 为空且 -TgzFile 不存在）' })
      const buf = Buffer.alloc(0)
      let lastError = ''
      for (const url of urls) {
        const dest = join(work, 'package.tgz')
        try {
          log(`下载：${url}`)
          await download(url, dest)
          tgz = dest
          break
        } catch (e) {
          lastError = `${url}：${(e && e.message) || e}`
          log(`  失败：${lastError}`)
        }
      }
      if (!tgz) return finish(false, { error: `下载失败（每个地址都试过了）：${lastError}` })
      void buf
    }

    // 2) 校验：sha256 / integrity / sha1 —— 与被校验物同源（npm registry 给的值）
    const data = readFileSync(tgz)
    const got256 = createHash('sha256').update(data).digest('hex')
    const got1 = createHash('sha1').update(data).digest('hex')
    if (sha256 && got256.toLowerCase() !== sha256.toLowerCase()) {
      return finish(false, { error: `sha256 不匹配（期望 ${sha256}，实际 ${got256}）` })
    }
    if (sha1 && got1.toLowerCase() !== sha1.toLowerCase()) {
      return finish(false, { error: `sha1 不匹配（期望 ${sha1}，实际 ${got1}）` })
    }
    if (integrity && !checkIntegrity(data, integrity)) {
      return finish(false, { error: `integrity 不匹配（期望 ${integrity}）` })
    }
    log(`校验通过：sha256=${got256.slice(0, 16)}…${sha1 ? ` sha1=${got1.slice(0, 12)}…` : ''}${integrity ? ' integrity=ok' : ''}`)

    // 3) 解包到暂存目录，并核对包里的 version 与清单一致
    const stage = join(work, 'stage')
    const files = extractTarball(tgz, stage)
    if (files === 0) return finish(false, { error: '安装包里没有解出任何文件' })
    let pkg = null
    try { pkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')) } catch { pkg = null }
    if (!pkg) return finish(false, { error: '安装包里没有 package.json（不是合法的 npm 包）' })
    const gotVersion = String(pkg.version || '')
    if (version && gotVersion !== version) {
      return finish(false, { error: `包里的版本（${gotVersion}）与清单（${version}）不一致` })
    }
    log(`解包完成：${files} 个文件，版本 ${gotVersion}`)

    // 4) 动手前整目录备份
    const backupRoot = join(dshHome, 'backups')
    mkdirSync(backupRoot, { recursive: true })
    backup = join(backupRoot, `plugin-${gotVersion || 'unknown'}-${stamp}`)
    mkdirSync(backup, { recursive: true })
    for (const e of readdirSync(pluginDir, { withFileTypes: true })) {
      copyTree(join(pluginDir, e.name), join(backup, e.name))
    }
    log(`已备份当前插件：${backup}`)

    // 5) 覆盖（先清空再拷，避免旧版本残留文件混进新版本）
    for (const e of readdirSync(pluginDir, { withFileTypes: true })) {
      rmSync(join(pluginDir, e.name), { recursive: true, force: true })
    }
    for (const e of readdirSync(stage, { withFileTypes: true })) {
      copyTree(join(stage, e.name), join(pluginDir, e.name))
    }
    log(`已覆盖插件目录：${pluginDir}`)
    finish(true, { version: gotVersion, backup })
  } catch (e) {
    const message = String((e && e.stack) || e)
    log(`安装失败：${message}`)
    if (backup && restoreBackup(backup, pluginDir)) log('已把插件目录恢复成安装前的样子')
    finish(false, { error: String((e && e.message) || e), backup })
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* 清不掉临时目录不算失败 */ }
  }
}

// spawnSync 只为保持与 PowerShell 版一致的「子进程里跑」语义（宿主用 execFile 调它）。
void spawnSync
void SELF_DIR
void sep

main()