#!/usr/bin/env node
// dsh-sync-allow-secret: 本文件含**假的**令牌/私钥字符串（自检夹具），打包本地插件时不算凭据。
/**
 * WebDAV 通道自检（离线、零依赖、只连 127.0.0.1）。
 *
 * 为什么要单独一份：`tools/selftest.mjs` 覆盖的是 git 通道与宿主逻辑，WebDAV 那条路
 * （PROPFIND 解析、逐级 MKCOL、按 sha256 判重、冲突留底、安全拦截）之前只能靠手搓
 * 一个假服务器临时验，验完就扔了。这台 Mac 上真正的云端就是 WebDAV，它属于主路径。
 *
 * 做法：进程内起一个最小 WebDAV 服务器（真 HTTP、真 XML、真落盘），让引擎像对待
 * 真服务器一样对待它 —— 不 mock fetch，也不碰外网，所以 CI 能直接跑。
 *
 * 用法：
 *   node tools/webdav-selftest.mjs             # 跑全部用例
 *   node tools/webdav-selftest.mjs --keep      # 失败时保留临时目录，便于看现场
 *
 * 退出码：0 全过 / 1 有失败。不写用户的 ~/.dsh，也不改仓库里的任何文件。
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  downloadRepo, normalizeWebdav, secretSkipReason, testConnection, uploadRepo,
} from '../runtime/webdav.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEEP = process.argv.includes('--keep')

let ok = 0
let failed = 0
const failures = []

function check(name, pass, detail = '') {
  if (pass) {
    ok += 1
    console.log(`  [OK] ${name}`)
  } else {
    failed += 1
    failures.push({ name, detail })
    console.log(`  [X] ${name}${detail ? ` —— ${detail}` : ''}`)
    // 失败原因单独打一行，别把 detail 挤进标题里（长 detail 会被截断，看起来像没问题）
    if (detail && String(detail).includes('\n')) console.log(String(detail).split('\n').map((l) => `      ${l}`).join('\n'))
  }
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// ── 最小 WebDAV 服务器 ───────────────────────────────────────────────────────
// 只实现引擎真的会用到的方法；行为对齐「够用就好」的第三方 DAV（不自动建父目录、
// etag 用 size+mtime 拼 —— 后者正是引擎不敢信 etag 的原因）。
function startDav(root) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const stats = { propfind: 0, mkcol: 0, put: 0, get: 0 }

  function resolveReqPath(rawUrl) {
    const p = decodeURIComponent(new URL(rawUrl, 'http://x').pathname)
    if (p !== '/dav' && !p.startsWith('/dav/')) return null
    const rest = p.slice(4)
    const rel = rest.split('/').filter((seg) => seg && seg !== '.').join(sep)
    if (rel.split(sep).includes('..')) return null
    return rel
  }

  function entry(rel, isDir) {
    const abs = join(root, rel)
    const st = statSync(abs)
    const href = '/dav/' + rel.split(sep).map(encodeURIComponent).join('/') + (isDir ? '/' : '')
    return `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>`
      + `<d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype>`
      + `<d:getcontentlength>${isDir ? 0 : st.size}</d:getcontentlength>`
      + `<d:getlastmodified>${new Date(st.mtimeMs).toUTCString()}</d:getlastmodified>`
      + `<d:etag>"${st.size}-${Math.round(st.mtimeMs)}"</d:etag>`
      + `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  }

  const server = http.createServer((req, res) => {
    const rel = resolveReqPath(req.url)
    if (rel === null) { res.writeHead(400); res.end('bad path'); return }
    const abs = join(root, rel)
    const method = String(req.method || '').toUpperCase()

    if (method === 'OPTIONS') {
      res.writeHead(200, { DAV: '1,2', Allow: 'OPTIONS,PROPFIND,MKCOL,PUT,GET,HEAD,DELETE' })
      res.end()
      return
    }
    if (method === 'PROPFIND') {
      stats.propfind += 1
      if (!existsSync(abs)) { res.writeHead(404); res.end(); return }
      const parts = []
      if (statSync(abs).isDirectory()) {
        parts.push(entry(rel, true))
        if (String(req.headers.depth || '1') !== '0') {
          for (const name of readdirSync(abs)) parts.push(entry(rel ? join(rel, name) : name, statSync(join(abs, name)).isDirectory()))
        }
      } else parts.push(entry(rel, false))
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
      res.end(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${parts.join('')}</d:multistatus>`)
      return
    }
    if (method === 'MKCOL') {
      stats.mkcol += 1
      if (existsSync(abs)) { res.writeHead(405); res.end(); return }
      // 父目录不存在时返回 409 —— 真服务器就是这么做的（这也是「上传成功但云端空」的根因）
      if (!existsSync(dirname(abs))) { res.writeHead(409); res.end(); return }
      mkdirSync(abs)
      res.writeHead(201); res.end()
      return
    }
    if (method === 'PUT') {
      stats.put += 1
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        if (!existsSync(dirname(abs))) { res.writeHead(409); res.end(); return }
        writeFileSync(abs, Buffer.concat(chunks))
        res.writeHead(201, { 'content-length': '0' }); res.end()
      })
      return
    }
    if (method === 'GET' || method === 'HEAD') {
      stats.get += 1
      if (!existsSync(abs) || statSync(abs).isDirectory()) { res.writeHead(404); res.end(); return }
      const buf = readFileSync(abs)
      res.writeHead(200, { 'content-length': String(buf.length), 'content-type': 'application/octet-stream' })
      res.end(method === 'HEAD' ? undefined : buf)
      return
    }
    if (method === 'DELETE') {
      if (!existsSync(abs) || statSync(abs).isDirectory()) { res.writeHead(404); res.end(); return }
      rmSync(abs)
      res.writeHead(204); res.end()
      return
    }
    res.writeHead(405); res.end()
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/dav`,
        stats,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

/** 把一个目录树读成 相对路径 → 内容 的 Map（用于断言「云端到底有什么」）。 */
function treeOf(dir) {
  const out = new Map()
  if (!existsSync(dir)) return out
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else out.set(relative(dir, abs).split(sep).join('/'), readFileSync(abs))
    }
  }
  walk(dir)
  return out
}

function put(dir, rel, text) {
  const abs = join(dir, rel.split('/').join(sep))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
}

// ── 用例 ─────────────────────────────────────────────────────────────────────
const stage = mkdtempSync(join(tmpdir(), 'cfg-sync-webdav-'))
const davRoot = join(stage, 'cloud')
mkdirSync(davRoot, { recursive: true })
const dav = await startDav(davRoot)

try {
  console.log(`WebDAV 自检（夹具服务器 ${dav.url}，root=${davRoot}）`)

  // 1) 配置归一化：目录默认值、末尾斜杠、auto 语义
  const w = normalizeWebdav({ webdavUrl: `${dav.url}/`, webdavDir: '' , syncMode: 'webdav' })
  check('归一化：地址去掉末尾斜杠', w.url === dav.url, w.url)
  check('归一化：目录留空 → 默认 dsh-config-sync', w.dir === 'dsh-config-sync', w.dir)
  check('归一化：syncMode=webdav 被认下', w.mode === 'webdav' && w.enabled === true)

  // 2) 明文 http 的安全闸（面板「测试连接」走同一判断）
  delete process.env.DSH_SYNC_ALLOW_INSECURE
  const insecure = await testConnection(w)
  check('http 明文地址默认被拒（并说清怎么放开）',
    insecure.ok === false && /https|ALLOW_INSECURE/.test(insecure.error || ''), JSON.stringify(insecure))
  process.env.DSH_SYNC_ALLOW_INSECURE = '1'
  const secureOk = await testConnection(w)
  check('放开后能连上（PROPFIND 空目录 = 首次同步，不算错）',
    secureOk.ok === true && secureOk.exists === false, JSON.stringify(secureOk))

  // 3) 首次上传：要逐级 MKCOL、不能因为父目录不存在而丢文件
  const repoA = join(stage, 'repoA')
  put(repoA, 'profile/package.json', '{"name":"dsh-profile-desktop"}\n')
  put(repoA, 'profile/cordis.patch.yml', '# patch\n')
  put(repoA, 'prompt/AGENTS.md', '# agents v1\n')
  put(repoA, 'skills/demo/SKILL.md', '---\nname: demo\n---\n# demo\n')
  // 私钥三种形态都试：ssh-keygen 默认名、改名后的 PEM、PuTTY
  put(repoA, 'id_ed25519', 'PRIVATE KEY MATERIAL\n')
  put(repoA, 'notes/deploy.txt', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n')
  put(repoA, 'keys/server.ppk', 'PuTTY-User-Key-File-2: ssh-rsa\n')
  put(repoA, 'notes/.env.local', 'TOKEN=abc\n')
  const up1 = await uploadRepo(w, repoA)
  const cloud1 = treeOf(join(davRoot, 'dsh-config-sync'))
  check('首次上传无错误', up1.ok === true && up1.errors.length === 0, up1.errors.join('; '))
  check('首次上传：嵌套目录里的文件真的到了云端',
    cloud1.has('skills/demo/SKILL.md') && cloud1.has('profile/cordis.patch.yml'),
    [...cloud1.keys()].join(', '))
  check('首次上传：逐级建目录（说明确实走了 MKCOL 而不是靠 PUT 自动建父级）',
    dav.stats.mkcol >= 3, `mkcol=${dav.stats.mkcol}`)
  check('安全拦截：私钥 / .env.* 绝不上传（三种私钥形态都拦）',
    !cloud1.has('id_ed25519') && !cloud1.has('notes/deploy.txt') && !cloud1.has('keys/server.ppk') && !cloud1.has('notes/.env.local'),
    [...cloud1.keys()].join(', '))
  check('安全拦截：命中项记在 skipped 里（不是静默丢弃）',
    up1.skipped.includes('id_ed25519') && up1.skipped.includes('notes/deploy.txt') && up1.skipped.includes('keys/server.ppk'),
    up1.skipped.join(', '))
  check('secretSkipReason 对非机密文件返回空', secretSkipReason('prompt/AGENTS.md', Buffer.from('# a\n')) === '')

  // 4) 幂等：内容没变就不重传（省流量是这套东西在 NAS 上的现实需求）
  const before = dav.stats.put
  const up2 = await uploadRepo(w, repoA)
  check('内容没变 → 全部跳过、一个 PUT 都不发',
    up2.uploaded.length === 0 && dav.stats.put === before, `uploaded=${up2.uploaded.length} putDelta=${dav.stats.put - before}`)

  // 4b) 推送后清理：老版本推上去的浏览器剖面必须被删掉，仓库里的其它文件不许动
  {
    const { purgeForbiddenFromCloud } = await import('../runtime/webdav.mjs')
    const profDir = join(davRoot, 'dsh-config-sync', 'plugin-data', 'browser-profiles', 'edge-cdp', 'Default')
    mkdirSync(profDir, { recursive: true })
    writeFileSync(join(profDir, 'Login Data'), 'not-really-a-db')
    writeFileSync(join(profDir, 'Cookies'), 'not-really-cookies')
    const pr = await purgeForbiddenFromCloud(w)
    // 夹具服务器的 DELETE 只删文件不删空目录，所以判「目录里再没有文件」而不是「目录不存在」
    const profLeft = existsSync(profDir) ? readdirSync(profDir, { recursive: true }).length : 0
    check('推送后清理云端浏览器剖面（Login Data / Cookies 不再留在网盘）',
      pr.deleted.length === 2 && profLeft === 0
      && existsSync(join(davRoot, 'dsh-config-sync', 'profile', 'package.json')),
      `deleted=${JSON.stringify(pr.deleted)} left=${profLeft} errors=${JSON.stringify(pr.errors)}`)
  }

  // 4c) 历史 session.lock：老版本连运行期锁一起传了，铺回另一台机器会变成陈旧锁
  {
    const { purgeStaleLocksFromCloud } = await import('../runtime/webdav.mjs')
    const sessDir = join(davRoot, 'dsh-config-sync', 'conversations', 'sessions', '--ws-1--', 's1')
    mkdirSync(sessDir, { recursive: true })
    writeFileSync(join(sessDir, 'session.lock'), '12345')
    writeFileSync(join(sessDir, 'session.v4.jsonl.zstd'), 'log')
    const lr = await purgeStaleLocksFromCloud(w)
    check('推送后清理云端历史 session.lock（陈旧锁不该铺回另一台机器）',
      lr.deleted.length === 1 && !existsSync(join(sessDir, 'session.lock'))
      && existsSync(join(sessDir, 'session.v4.jsonl.zstd')),
      `deleted=${JSON.stringify(lr.deleted)} errors=${JSON.stringify(lr.errors)}`)
  }

  // 5) 同长度不同内容也必须重传（etag 是 size+mtime 拼的，不信它）
  put(repoA, 'prompt/AGENTS.md', '# agents v2\n') // 与 v1 等长
  const up3 = await uploadRepo(w, repoA)
  const cloud2 = treeOf(join(davRoot, 'dsh-config-sync'))
  check('同长度改动：按 sha256 判出差异并重传', up3.uploaded.includes('prompt/AGENTS.md'), up3.uploaded.join(', '))
  check('同长度改动：云端内容真的变了',
    String(cloud2.get('prompt/AGENTS.md')) === '# agents v2\n',
    JSON.stringify(String(cloud2.get('prompt/AGENTS.md'))))

  // 6) 下载到另一台机器：铺开、跳过同名同内容、冲突留底
  const repoB = join(stage, 'repoB')
  mkdirSync(repoB, { recursive: true })
  const down1 = await downloadRepo(w, repoB)
  check('下载无错误', down1.ok === true && down1.errors.length === 0, down1.errors.join('; '))
  check('下载：云端有的都落地',
    existsSync(join(repoB, 'skills/demo/SKILL.md')) && existsSync(join(repoB, 'profile/package.json')))
  check('下载：本机没有的多余文件不会被凭空造出来', down1.conflicts.length === 0)

  // 本机改一处 → 再下载 → 旧版本留成 .conflict-*，落盘用云端版
  put(repoB, 'prompt/AGENTS.md', '# local edit\n')
  const down2 = await downloadRepo(w, repoB)
  const backups = readdirSync(join(repoB, 'prompt')).filter((n) => n.startsWith('AGENTS.md.conflict-'))
  check('冲突：两边都改过时被记进 conflicts', down2.conflicts.includes('prompt/AGENTS.md'), down2.conflicts.join(', '))
  check('冲突：本机那份留底成 .conflict-*（不静默丢用户的改动）', backups.length === 1, backups.join(', '))
  check('冲突：落盘的是云端版本',
    String(readFileSync(join(repoB, 'prompt/AGENTS.md'), 'utf8')) === '# agents v2\n')

  // 7) 幂等下载：刚下完再下一次，什么都不该写
  const down3 = await downloadRepo(w, repoB)
  check('再下一遍：全部跳过', down3.downloaded.length === 0 && down3.conflicts.length === 0,
    `downloaded=${down3.downloaded.length}`)

  // 8) 云端目录还不存在时：下载应报「空」而不是报错，上传应能自己建出来
  const w2 = normalizeWebdav({ webdavUrl: dav.url, webdavDir: 'nope-deep/fresh', syncMode: 'webdav' })
  const empty = await downloadRepo(w2, join(stage, 'repoC'))
  check('云端空目录：下载返回 empty 而不是失败', empty.ok === true && empty.empty === true, JSON.stringify(empty.errors))
  const upFresh = await uploadRepo(w2, repoA)
  check('云端没有目录：上传自己建出来（含多级父目录）',
    upFresh.ok === true && existsSync(join(davRoot, 'nope-deep/fresh/prompt/AGENTS.md')),
    upFresh.errors.join('; '))

  // 9) 不可达服务器：要明确报错，不能假装成功
  const bad = normalizeWebdav({ webdavUrl: 'http://127.0.0.1:1/dav', syncMode: 'webdav' })
  process.env.DSH_SYNC_ALLOW_INSECURE = '1'
  const badRes = await downloadRepo(bad, join(stage, 'repoD'))
  check('连不上时就报错（不当成空云端）',
    badRes.ok === false && badRes.errors.length > 0, JSON.stringify(badRes.errors))
} catch (e) {
  check('WebDAV 自检未抛异常', false, String((e && e.stack) || e))
} finally {
  delete process.env.DSH_SYNC_ALLOW_INSECURE
  await dav.close()
  if (failed === 0 && !KEEP) rmSync(stage, { recursive: true, force: true })
  else console.log(`  [i] 现场保留在 ${stage}`)
}

console.log('')
console.log(failed === 0 ? `结论：WebDAV 通道全部通过（${ok} 项）` : `结论：${failed} 项失败（${ok} 项通过）`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}`)
}
void HERE
process.exit(failed === 0 ? 0 : 1)