/**
 * 无 UI 环境下的宿主半身自检：
 *   node tools/selftest.mjs [repoPath]
 *
 * 用一个假 ctx 拉起 index.js 的 apply()，验证：
 *   1. 13 条路由都注册上了；
 *   2. GET /config-sync/status 返回合法 JSON（结构字段齐全）；
 *   3. POST /config-sync/prepare 能在仓库根生成脚本，且带进程检查与正确参数。
 *
 * 0.6.49：**不再写用户的真实 ~/.dsh**。原来这个自检直接跑在真 DSH_HOME 上，
 * 靠"先备份再还原"兜底 —— 一旦中途崩了，用户的 dsh-config-sync.json / scope /
 * 冲突清单就留在测试值上（本机就踩过：scope 与设置被写成夹具内容）。
 * 现在默认在临时目录里造一份隔离的 DSH_HOME + 仓库夹具；想连真机跑要显式传 --in-place。
 * 平台相关断言按 process.platform 分支：Windows 生成 .cmd，POSIX 生成 .sh。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply } from '../index.js'

const IS_WIN = process.platform === 'win32'
const argv = process.argv.slice(2)
const inPlace = argv.includes('--in-place')
// 脚本后缀与文件名随平台（0.6.49：POSIX 生成 .sh，原来断言写死 .cmd，macOS 上必然失败）
const SCRIPT_EXT = IS_WIN ? '.cmd' : '.sh'
const FILE_NAME = {
  push: `同步-推送${SCRIPT_EXT}`,
  pull: `同步-拉取${SCRIPT_EXT}`,
  restore: `同步-还原${SCRIPT_EXT}`,
}

// ---- 隔离环境：临时 DSH_HOME + 仓库夹具 ----
// 不设 DSH_HOME 时（--in-place）才用真机目录；默认一律隔离。
const sandbox = inPlace ? null : mkdtempSync(join(tmpdir(), 'cfg-sync-selftest-'))
const dshHomeArg = sandbox ? join(sandbox, 'home') : (process.env.DSH_HOME || join(process.env.HOME || '', '.dsh'))
if (sandbox) {
  mkdirSync(dshHomeArg, { recursive: true })
  process.env.DSH_HOME = dshHomeArg
  // 造一份 profile 快照当夹具：status 的「备份快照地址」断言才有可验证的对象。
  // 不造的话它在任何干净机器上都红 —— 而那并不是代码错，只是这台机器还没备份过。
  const snap = join(dshHomeArg, 'backups', 'config-20260101-000000', 'profile')
  mkdirSync(snap, { recursive: true })
  writeFileSync(join(snap, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-desktop', version: '0.0.0', dsh: { profile: { bundles: [] } } }, null, 2), 'utf8')
  writeFileSync(join(snap, 'cordis.patch.yml'), '# fixture\n', 'utf8')
}

const repoArg = argv.find((x) => !x.startsWith('--'))
  || (sandbox ? join(sandbox, 'repo') : (IS_WIN ? 'D:\\dsh-config' : join(process.env.HOME || '', 'dsh-config')))
if (sandbox) mkdirSync(repoArg, { recursive: true })
const routes = new Map()

// 自检会真的调用「保存云端仓库设置」，而保存另一个地址时会 git remote set-url —— 那是在改
// 用户/夹具仓库的远端。先记下原值，最后原样还原（0.6.49：之前跑一次自检就把夹具仓库的
// origin 改成了 example.invalid，后续 push 全部失败）。
const originalOrigin = (() => {
  const r = spawnSync('git', ['-C', repoArg, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 15000 })
  return r.status === 0 ? String(r.stdout || '').trim() : ''
})()
const restoreOrigin = () => {
  if (!originalOrigin) return
  const cur = spawnSync('git', ['-C', repoArg, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 15000 })
  const now = cur.status === 0 ? String(cur.stdout || '').trim() : ''
  if (now !== originalOrigin) {
    spawnSync('git', ['-C', repoArg, 'remote', 'set-url', 'origin', originalOrigin], { encoding: 'utf8', timeout: 15000 })
    console.log(`  [i] 已把仓库 origin 还原成 ${originalOrigin}`)
  }
}

// prepare 写的是仓库根固定文件名。若那里已经有给用户用的真文件，先记下内容，断言完原样还原。
const backup = new Map()
for (const action of ['pull', 'push', 'restore']) {
  const file = join(repoArg, FILE_NAME[action])
  if (existsSync(file)) backup.set(file, readFileSync(file, 'utf8'))
}

const registered = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('apply() 没有注册任何路由（webServer 未被 inject？）')), 5000)
  const ctx = {
    inject: (names, cb) => {
      const scoped = {
        effect: (fn) => fn(),
        webServer: {
          register: (route) => {
            routes.set(route.path, route.handler)
            clearTimeout(timer)
            resolve(true)
            return () => { }
          },
        },
        logger: { warn: () => { } },
      }
      cb(scoped)
    },
  }
  try { apply(ctx, { repoPath: repoArg, profileName: 'desktop' }) } catch (e) { reject(e) }
})

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader: (k, v) => { res.headers[k] = v },
    end: (chunk) => { if (chunk) res.body += chunk },
    destroy: () => { },
  }
  return res
}

function fakeReq({ method = 'GET', headers = {}, body = '' } = {}) {
  const handlers = {}
  const req = {
    method,
    headers,
    destroy: () => { },
    on: (event, fn) => { handlers[event] = fn; return req },
  }
  setImmediate(() => {
    if (body) handlers.data?.(body)
    handlers.end?.()
  })
  return req
}

function call(path, init) {
  const handler = routes.get(path)
  if (!handler) throw new Error(`路由未注册：${path}`)
  const res = fakeRes()
  const req = fakeReq(init)
  return new Promise((resolve) => {
    const done = () => resolve(res)
    const origEnd = res.end
    res.end = (chunk) => { origEnd(chunk); done() }
    handler(req, res)
  })
}

let failures = 0
function check(label, cond, detail = '') {
  if (cond) console.log(`  [OK] ${label}`)
  else { failures++; console.log(`  [X] ${label}${detail ? ' — ' + detail : ''}`) }
}

console.log('== dsh-profile-config-sync 宿主半身自检 ==')
check('apply() 注册了路由', routes.size === 13 && routes.has('/config-sync/update') && routes.has('/config-sync/scope') && routes.has('/config-sync/extra-config') && routes.has('/config-sync/conflict') && routes.has('/config-sync/roots') && routes.has('/config-sync/feedback') && routes.has('/config-sync/cache-guard') && routes.has('/config-sync/workspace-view') && routes.has('/config-sync/webdav'), `实际 ${routes.size} 条：${[...routes.keys()].join(', ')}`)

const status = await call('/config-sync/status', { headers: { host: 'localhost:3080' } })
const body = JSON.parse(status.body || '{}')
check('status 返回 200', status.statusCode === 200, String(status.statusCode))
check('status.ok === true', body.ok === true, status.body.slice(0, 160))
check('含 repo / version / bundles / deps / advice',
  Boolean(body.repo && body.version && body.bundles && body.deps && Array.isArray(body.advice)))
// 仓库可能正处在「本机还没有内容」的合法状态（0.3.35 起：等拉取 / 等初始化推送）。
// 这类状态下依赖仓库内容的断言没有验证意义，明确标 SKIP，别把环境状态当成代码失败。
const repoReady = Boolean(body.repo?.exists)
if (repoReady) check('repo 探测到仓库', true)
else console.log(`  [SKIP] repo 探测到仓库 — 本机仓库还没有内容（${body.repo?.path || '?'}，mode=${body.repo?.mode || '?'}）`)
check('版本契约两个字段都读到',
  typeof body.version?.local === 'string' && typeof body.version?.contract === 'string',
  `${body.version?.local} / ${body.version?.contract}`)
check('bundle 数量与解析结果都在',
  typeof body.bundles?.total === 'number' && Array.isArray(body.bundles?.unresolved))
check('依赖缺失是数组', Array.isArray(body.deps?.missing))
check('status 带回备份快照地址', Boolean(body.backup && body.backup.latest), body.backup && body.backup.latest)
check('备份快照目录在本机真实存在', Boolean(body.backup && body.backup.latest && existsSync(body.backup.latest)), body.backup && body.backup.root)
console.log('  建议：' + (body.advice || []).join(' | '))
const latestSnapshot = (body.backup && body.backup.latest) || ''

function restoreCmd(file) {
  const before = backup.get(file)
  if (before === undefined) unlinkSync(file)
  else writeFileSync(file, before, 'utf8')
}

if (repoReady) {
for (const action of ['pull', 'push', 'restore']) {
  const prepared = await call('/config-sync/prepare', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const payload = JSON.parse(prepared.body || '{}')
  check(`prepare(${action}) 返回 /sh OK 且 ok`.replace('/sh', SCRIPT_EXT), prepared.statusCode === 200 && payload.ok === true, prepared.body.slice(0, 160))
  check(`prepare(${action}) 写出了脚本`, existsSync(payload.path || ''), payload.path || '(无路径)')
  check(`prepare(${action}) 的文件名是中文`, new RegExp(`[\\\\/][^\\\\/]*[\u4e00-\u9fa5][^\\\\/]*\\${SCRIPT_EXT}$`).test(payload.path || ''), payload.path || '(无路径)')
  if (existsSync(payload.path || '')) {
    // prepare 会就地覆盖仓库根的 同步-推送/拉取/还原.cmd —— 那是给人用的真文件，
    // 自检只借用这条路径做断言，结束后必须还原成原样（没有过就删掉）。
    const text = readFileSync(payload.path, 'utf8')
    check(`${SCRIPT_EXT} 里带进程检查`, IS_WIN ? /DeepSeek Harness\.exe/.test(text) : /pgrep|DeepSeek Harness/.test(text))
    // GIT_SSH_COMMAND 的第一个词必须是可执行程序/完整命令，绝不能以 -i 这种参数开头。
    // 踩过的坑：探测不到 ssh.exe 时拼出 `-i "key" -o …`，git 交给 sh 直接 invalid option。
    if (action !== 'restore' && /GIT_SSH_COMMAND=/.test(text)) {
      const line = text.split(/\r?\n/).find((l) => l.includes('GIT_SSH_COMMAND=')) || ''
      const value = line.slice(line.indexOf('GIT_SSH_COMMAND=') + 'GIT_SSH_COMMAND='.length).trim()
      check(`GIT_SSH_COMMAND 以程序/命令开头（不是裸参数）`,
        !/^-/.test(value.replace(/^\s+/, '')),
        value.slice(0, 120))
    }
    if (action === 'restore') {
      if (IS_WIN) {
        check('还原 cmd 先 DryRun 再确认再真跑', /-DryRun/.test(text) && /set \/p GO=/.test(text) && text.includes('restore.ps1'))
        check('还原 cmd 里写着快照地址', Boolean(latestSnapshot) && text.includes(latestSnapshot), latestSnapshot || '(status 没给快照)')
        check('还原 cmd 把 -BackupDir 明写出来', text.includes(`-BackupDir "${latestSnapshot}"`), latestSnapshot || '(无)')
      } else {
        check('还原 sh 先 dry-run 再确认再真跑', /--[Dd]ry[Rr]un|dryRun|DryRun/.test(text) && /read -r/.test(text) && /sync-engine\.mjs/.test(text), text.slice(0, 200))
        check('还原 sh 里写着快照地址', Boolean(latestSnapshot) && text.includes(latestSnapshot), latestSnapshot || '(status 没给快照)')
        check('还原 sh 把 -BackupDir 明写出来', text.includes(`-BackupDir '${latestSnapshot}'`) || text.includes(`-BackupDir "${latestSnapshot}"`), latestSnapshot || '(无)')
      }
      check('prepare(restore) 响应里带快照字段', Boolean(payload.backup && payload.backup.dir), JSON.stringify(payload.backup || null))
    } else {
      check(`脚本里调的是引擎 ${action}`, IS_WIN
        ? new RegExp(`sync\\.ps1".*${action}`).test(text)
        : new RegExp(`sync-engine\\.mjs"?.*${action}`).test(text), text.slice(0, 200))
      if (action === 'pull') {
        // pull 会覆盖本机配置，脚本必须在真跑之前要一次 y 确认
        check('pull 脚本里有确认守卫', IS_WIN ? /set \/p GO=/.test(text) : /read -r/.test(text))
        check('pull 脚本说明"会覆盖本机配置"', text.includes('覆盖本机配置'))
        // warnings 至少要有「拉取会覆盖本机配置」那条；「本机领先 N 个提交」只在真的领先时才该有
        check('prepare(pull) 返回 warnings（提示拉取会覆盖本机配置）',
          Array.isArray(payload.warnings) && payload.warnings.some((w) => /覆盖/.test(String(w))),
          JSON.stringify(payload.warnings || null))
        if (Number(body.repo?.ahead) > 0) {
          check('本机领先时 warnings 里点名「领先 N 个提交」',
            (payload.warnings || []).some((w) => /领先/.test(String(w))),
            JSON.stringify(payload.warnings || null))
        } else {
          console.log('  [SKIP] 本机领先的 warning — 当前仓库没有未推送提交（ahead=0）')
        }
            } else {
        check(`prepare(${action}) 不需要确认守卫`, IS_WIN ? !/set \/p GO=/.test(text) : !/read -r/.test(text))
      }
      check(`prepare(${action}) 给了中文标签`, typeof payload.label === 'string' && /[\u4e00-\u9fa5]/.test(payload.label), payload.label || '(无)')
      check(`${action} 脚本用中文写动作名`,
        text.includes(action === 'push' ? '推送' : '拉取'),
        action)
    }
    check(IS_WIN ? 'cmd 用的是 CRLF' : 'sh 用的是 LF', IS_WIN ? text.includes('\r\n') : !text.includes('\r\n'))
    restoreCmd(payload.path)
  }
}

// 一键生成三个：一次 POST 写出三份，且各自内容正确
const allRes = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'all' }),
})
const allPayload = JSON.parse(allRes.body || '{}')
check('prepare(all) 返回 200 且 ok', allRes.statusCode === 200 && allPayload.ok === true, allRes.body.slice(0, 160))
check('prepare(all) 一次写出三份脚本', Array.isArray(allPayload.built) && allPayload.built.length === 3, String(allPayload.built && allPayload.built.length))
check('prepare(all) 覆盖 push/pull/restore',
  Array.isArray(allPayload.built) && ['push', 'pull', 'restore'].every((a) => allPayload.built.some((b) => b.action === a)),
  JSON.stringify((allPayload.built || []).map((b) => b.action)))
check('prepare(all) 三份文件都真实存在',
  Array.isArray(allPayload.built) && allPayload.built.every((b) => existsSync(b.path || '')),
  JSON.stringify((allPayload.built || []).map((b) => existsSync(b.path || ''))))
check('prepare(all) 里 restore 那份带快照地址',
  Array.isArray(allPayload.built) && allPayload.built.some((b) => b.action === 'restore' && b.backup && b.backup.dir),
  JSON.stringify((allPayload.built || []).filter((b) => b.action === 'restore').map((b) => b.backup)))
for (const b of (allPayload.built || [])) restoreCmd(b.path)
} else {
  // 本机还没有仓库内容：prepare 的正确预期不是「必定写出脚本」，而是「按云端空不空分流」——
  // 云端也空 → 只生成推送（那次就是初始化推送）；云端有内容 → 拒绝推送、只放行拉取。
  //
  // 0.6.49：还有第三种真实状态 —— **云端根本探不到**（新机器没配地址、断网、凭据没配）。
  // 那时 prepare 会明确报「连不上云端仓库」，不是代码错。旧断言把它当成「云端有内容」，
  // 于是任何一台刚装好、还没配远端的机器跑自检都必然红一片。这里单独分出来。
  // 没配远端 / 探不到：remote.configured=false，或 remoteHeads 为 null
  const cloudUnknown = body.remote?.configured !== true || body.repo?.remoteHeads == null
  const cloudEmpty = body.repo?.remoteEmpty === true
  const pPush = await call('/config-sync/prepare', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'push' }),
  })
  const pushPayload = JSON.parse(pPush.body || '{}')
  if (cloudEmpty) {
    check('两边都空：prepare(push) 放行（走初始化推送）', pPush.statusCode === 200 && pushPayload.ok === true, pPush.body.slice(0, 160))
    check('两边都空：生成的推送脚本带初始化提示',
      existsSync(pushPayload.path || '') && readFileSync(pushPayload.path, 'utf8').match(IS_WIN ? /sync\.ps1/ : /sync-engine\.mjs/),
      pushPayload.path || '(无路径)')
    if (existsSync(pushPayload.path || '')) restoreCmd(pushPayload.path)
  } else if (cloudUnknown) {
    check('云端探不到时：prepare(push) 明确报「连不上云端」而不是放行',
      pPush.statusCode === 400 && /连不上云端/.test(pushPayload.error || ''),
      pPush.body.slice(0, 160))
  } else {
    check('云端有内容：prepare(push) 被拒，并指向「先拉取」',
      pPush.statusCode === 400 && /云端仓库已经有内容/.test(pushPayload.error || ''),
      pPush.body.slice(0, 160))
  }
  const pPull = await call('/config-sync/prepare', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pull' }),
  })
  const pullPayload = JSON.parse(pPull.body || '{}')
  if (cloudUnknown) {
    check('云端探不到时：prepare(pull) 明确报「连不上云端」而不是生成脚本',
      pPull.statusCode === 400 && /连不上云端/.test(pullPayload.error || ''),
      pPull.body.slice(0, 160))
  } else if (cloudEmpty) {
    check('两边都空：prepare(pull) 被拒（没有东西可拉）',
      pPull.statusCode === 400 && /连不上云端|云端仓库已经有内容|空/.test(pullPayload.error || ''),
      pPull.body.slice(0, 160))
  } else {
    check('云端有内容：prepare(pull) 放行', pPull.statusCode === 200 && pullPayload.ok === true, pPull.body.slice(0, 160))
    if (existsSync(pullPayload.path || '')) {
      const pullText = readFileSync(pullPayload.path, 'utf8')
      check('pull 脚本里有确认守卫', IS_WIN ? /set \/p GO=/.test(pullText) : /read -r/.test(pullText))
      check(IS_WIN ? 'cmd 用的是 CRLF' : 'sh 用的是 LF', IS_WIN ? pullText.includes('\r\n') : !pullText.includes('\r\n'))
      restoreCmd(pullPayload.path)
    }
  }
  const pAll = await call('/config-sync/prepare', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'all' }),
  })
  const allP = JSON.parse(pAll.body || '{}')
  const acts = (allP.built || []).map((b) => b.action)
  if (cloudUnknown) {
    check('云端探不到时：prepare(all) 明确拒绝并说清原因',
      pAll.statusCode === 400 && /连不上云端|还没有配置云端仓库地址/.test(allP.error || ''),
      pAll.body.slice(0, 160))
  } else {
    check('prepare(all) 按状态组合脚本（两边空→推送+还原；否则→拉取+还原）',
      pAll.statusCode === 200
      && (cloudEmpty ? acts.includes('push') && !acts.includes('pull') : acts.includes('pull') && !acts.includes('push')),
      JSON.stringify(acts))
  }
  if (!cloudUnknown) {
    check('prepare(all) 带上 initPush 标记（面板据此显示「初始化推送」）',
      Boolean(allP.bootstrap) && allP.bootstrap.initPush === cloudEmpty,
      JSON.stringify(allP.bootstrap && { initPush: allP.bootstrap.initPush }))
  }
  for (const b of (allP.built || [])) restoreCmd(b.path)
}

const cross = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', origin: 'https://evil.example', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'push' }),
})
check('跨站请求被拒（403）', cross.statusCode === 403, String(cross.statusCode))

const bad = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'delete-everything' }),
})
check('非法 action 被拒（400）', bad.statusCode === 400, String(bad.statusCode))

// --- 云端仓库设置：展示字段 + 保存校验（只写本机设置文件，不动 git remote） ---
check('status 带回远端地址与私钥字段',
  Boolean(body.remote && typeof body.remote.url === 'string' && typeof body.remote.sshKey === 'string' && body.remote.settingsPath),
  JSON.stringify(body.remote && { url: body.remote.url, key: body.remote.sshKey, from: body.remote.sshKeyFrom }))
check('status 说得出云端仓库是否已配置', Boolean(body.remote) && typeof body.remote.configured === 'boolean', String(body.remote && body.remote.configured))
check('status 的私钥来源可解释', Boolean(body.remote && ['settings', 'default', 'none'].includes(body.remote.sshKeyFrom)), body.remote && body.remote.sshKeyFrom)

const settingsFile = body.remote.settingsPath
const prevSettings = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null
const putSettings = (payload) => call('/config-sync/settings', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})

// 非法地址
const badUrl = await putSettings({ remoteUrl: 'ftp://x/y', sshKey: body.remote.sshKey })
check('非法远端地址被拒（400）', badUrl.statusCode === 400, String(badUrl.statusCode))

// 不存在的私钥（路径用本平台的写法，否则测的是「路径形状」而不是「文件不存在」）
const badKey = await putSettings({ remoteUrl: body.remote.url, sshKey: IS_WIN ? 'C:\\nope\\no.key' : '/nope/no.key' })
check('不存在的私钥被拒（400）', badKey.statusCode === 400, String(badKey.statusCode))

// 合法保存：沿用当前地址（若当前走 WebDAV 没设 remoteUrl，则借用合法占位 URL），不会触发 git remote set-url
//
// 注意：验证器只认 git@host:path / ssh:// / https:// 三种写法。仓库若挂的是本地裸库
// （file:// 或 /path/to/bare.git，自检夹具就是这么造的），沿用它会 400 —— 那是校验在工作，
// 不是保存坏了。这种情况改用占位 URL 继续验证「保存 + 落盘」这条链路。
const SUPPORTED_URL = /^(git@[^:]+:.+|ssh:\/\/.+|https:\/\/.+)$/
const currentUrlUsable = SUPPORTED_URL.test(String(body.remote.url || ''))
const testRemoteUrl = currentUrlUsable ? body.remote.url : 'https://example.invalid/dsh-config.git'
const okSave = await putSettings({ remoteUrl: testRemoteUrl, sshKey: body.remote.sshKey })
const okPayload = JSON.parse(okSave.body || '{}')
check('合法设置保存成功', okSave.statusCode === 200 && okPayload.ok === true, okSave.body.slice(0, 160))
// 只有「存的就是当前地址」时才该 gitRemoteSet=false；存了另一个地址本来就要 set-url
if (currentUrlUsable) {
  check('保存后不回写非当前地址（gitRemoteSet=false，自检不动仓库）', okPayload.gitRemoteSet === false, String(okPayload.gitRemoteSet))
} else {
  check('存另一个地址时会改写 git remote（并把结果如实报出）', typeof okPayload.gitRemoteSet === 'boolean', String(okPayload.gitRemoteSet))
}
check('保存后设置文件落盘', existsSync(settingsFile), settingsFile)
check('设置文件含 remoteUrl 字段', existsSync(settingsFile) && readFileSync(settingsFile, 'utf8').includes('remoteUrl'))

// 保存后再生成一次 push，确认私钥被接进脚本（此时设置文件里的 sshKey 已生效）
const again = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'push' }),
})
const againPayload = JSON.parse(again.body || '{}')
if (repoReady) {
  check('保存后再生成 push 成功', again.statusCode === 200 && againPayload.ok === true, again.body.slice(0, 160))
  if (existsSync(againPayload.path || '')) {
    const text = readFileSync(againPayload.path, 'utf8')
    const keyInFile = okPayload.remote && okPayload.remote.sshKey
    // 没配私钥时脚本里本来就不该有 GIT_SSH_COMMAND（认证交给 .ssh\config 或 Git 凭据管理器）——
    // 旧断言不分情况一律要求它存在，在没配私钥的机器上必然失败。
    if (keyInFile) {
      check('push 脚本带 GIT_SSH_COMMAND', text.includes('GIT_SSH_COMMAND'))
      check('push 脚本里的私钥路径与设置一致', text.includes(keyInFile), keyInFile)
    } else {
      check('没配私钥时不注入 GIT_SSH_COMMAND（认证交给 .ssh\\config）', !text.includes('GIT_SSH_COMMAND'))
    }
    restoreCmd(againPayload.path)
  }
} else {
  check('本机无内容时：保存设置后 push 仍按云端状态分流（不会因为改了设置就放行）',
    (again.statusCode === 200 && againPayload.ok === true)
      || (again.statusCode === 400 && (/云端仓库已经有内容/.test(againPayload.error || '') || (!body.remote.url && /连不上云端/.test(againPayload.error || '')))),
    again.body.slice(0, 160))
  if (existsSync(againPayload.path || '')) restoreCmd(againPayload.path)
}

// 设置里留着一条已失效的路径（目录被移走）时：必须报 exists=false 且不静默回退到自动探测
{
  const dead = mkdtempSync(join(tmpdir(), 'cfg-sync-dead-'))
  const currentRaw = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null
  let prev = {}
  try { prev = currentRaw ? JSON.parse(currentRaw) : {} } catch { prev = {} }
  writeFileSync(settingsFile, JSON.stringify({ ...prev, repoPath: dead }, null, 2), 'utf8')
  const st = JSON.parse((await call('/config-sync/status', { headers: { host: 'localhost:3080' } })).body || '{}')
  check('失效路径下 exists=false（不假装仓库在）', st.repo && st.repo.exists === false, JSON.stringify(st.repo && { path: st.repo.path, exists: st.repo.exists, source: st.repo.source }))
  check('失效路径不会被静默换成自动探测的仓库', st.repo && st.repo.source === 'settings', String(st.repo && st.repo.source))
  const blocked = await call('/config-sync/prepare', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore' }),
  })
  // 路径不存在/还是空目录时按设计是允许生成的（新机器第一步 pull 会自动克隆），
  // 但必须带 bootstrap 说明，不能静默当作仓库已就绪。
  const blockedPayload = JSON.parse(blocked.body || '{}')
  check('失效路径下生成带 bootstrap 提示', blockedPayload.ok === true && Boolean(blockedPayload.bootstrap), blocked.body.slice(0, 160))
  if (currentRaw === null) { try { unlinkSync(settingsFile) } catch { } } else writeFileSync(settingsFile, currentRaw, 'utf8')
  rmSync(dead, { recursive: true, force: true })
}

// 还原设置文件（保存动作会覆盖它，用户可能本来就有内容）
if (prevSettings === null) { try { unlinkSync(settingsFile) } catch { } }
else writeFileSync(settingsFile, prevSettings, 'utf8')

// --- 仓库路径：可配置、默认只读、非法路径要拦、没配就生成不了 ---
check('status 带回仓库路径来源', Boolean(body.repo && ['settings', 'config', 'env', 'auto', 'none'].includes(body.repo.source)), body.repo && body.repo.source)
check('status 说得出仓库是否已配置', Boolean(body.repo) && typeof body.repo.configured === 'boolean', String(body.repo && body.repo.configured))

// 0.6.49：路径用例必须按平台取。原来写死 'C:\\nope\\not-a-repo'，在 macOS 上
// 现在会被 repoPathProblem 明确判成「Windows 盘符形状」而拒（这是修好的行为，不是回归），
// 旧断言却要求 200 —— 一条断言同时测了两件相反的事。
const badRepoPath = IS_WIN ? 'C:\\nope\\not-a-repo' : '/nope/not-a-repo'
const badRepo = await putSettings({ repoPath: badRepoPath })
// 新机器上仓库还没克隆时，这个路径本来就不存在 —— 允许保存（等着首次拉取去克隆），不再当错误拦。
check('不存在的仓库路径可以保存（待克隆目标）', badRepo.statusCode === 200, `${badRepoPath} → ${badRepo.statusCode} ${badRepo.body.slice(0, 120)}`)

// 平台形状不对的路径必须当场拒（本项目真实踩过：POSIX 上存了 D:\\dsh-config，
// mkdir 在工作目录里建出一个同名目录，同步目标从此错位）
{
  const wrongShape = IS_WIN ? '/Users/x/dsh-config' : 'D:\\dsh-config'
  const r = await putSettings({ repoPath: wrongShape })
  check(`跨平台形状的路径被拒（${IS_WIN ? '/posix' : 'D:\\ 盘符'}）`,
    r.statusCode === 400 && /绝对路径|盘符/.test(JSON.parse(r.body || '{}').error || ''),
    `${wrongShape} → ${r.statusCode} ${r.body.slice(0, 140)}`)
  const r2 = await putSettings({ repoPath: IS_WIN ? 'relative\\dsh-config' : 'relative/dsh-config' })
  check('相对路径被拒', r2.statusCode === 400, `${r2.statusCode} ${r2.body.slice(0, 140)}`)
}

// 「像仓库的子目录」（有内容但不是仓库）必须被拒；仓库为空时那个子目录可能压根不存在，
// 不存在的路径按设计允许保存（等首次拉取去建），这时只做 SKIP，不当失败。
const notRepoDir = body.repo.path ? body.repo.path + '\\profile' : 'C:\\Windows'
const notRepo = await putSettings({ repoPath: notRepoDir })
if (existsSync(notRepoDir)) {
  check('不像仓库的目录被拒（400）', notRepo.statusCode === 400, String(notRepo.statusCode))
} else {
  console.log(`  [SKIP] 不像仓库的目录被拒 — ${notRepoDir} 不存在（非空目录才该被拒）`)
}

const okRepo = await putSettings({ repoPath: body.repo.path })
const okRepoPayload = JSON.parse(okRepo.body || '{}')
check('合法仓库路径保存成功', okRepo.statusCode === 200 && okRepoPayload.ok === true, okRepo.body.slice(0, 160))
check('保存后设置文件里出现 repoPath', existsSync(settingsFile) && readFileSync(settingsFile, 'utf8').includes('repoPath'))

// 还原设置文件（保存动作会覆盖它，用户可能本来就有内容）
if (prevSettings === null) { try { unlinkSync(settingsFile) } catch { } }
else writeFileSync(settingsFile, prevSettings, 'utf8')

// --- 同步内容勾选（scope）：默认全勾；勾选落盘到本机 config-sync-scope.json（不进仓库） ---
// 这里会真的写用户的 scope 文件，所以先备份、断言完原样还原（和上面设置文件同一套做法）。
const dshHomeDir = dirname(settingsFile)
const scopeFile = join(dshHomeDir, 'config-sync-scope.json')
const prevScope = existsSync(scopeFile) ? readFileSync(scopeFile, 'utf8') : null
const scopeGet = await call('/config-sync/scope', { headers: { host: 'localhost:3080' } })
const scopeBody = JSON.parse(scopeGet.body || '{}')
check('scope 返回 200', scopeGet.statusCode === 200, String(scopeGet.statusCode))
check('scope 列出十二组同步内容', Array.isArray(scopeBody.groups) && scopeBody.groups.length === 12, `${(scopeBody.groups || []).length} 组`)
check('scope 每组都带标题 / 说明 / 明细项',
  (scopeBody.groups || []).every((g) => g && typeof g.title === 'string' && typeof g.desc === 'string' && Array.isArray(g.items)),
  (scopeBody.groups || []).map((g) => g.id).join(', '))
// 本机可能早就存过自定义勾选（比如给「会话记录 / 工作区」关了同步）：
// 那种情况下不能要求「全勾」，否则这条断言只是把用户自己的配置判成失败。
if (prevScope === null) {
  check('没配过时默认全勾（组与明细都参与同步）', (scopeBody.groups || []).every((g) => g.enabled === true))
} else {
  let prevDoc = {}
  try { prevDoc = JSON.parse(prevScope) || {} } catch { prevDoc = {} }
  const offInFile = Object.entries(prevDoc.groups || {})
    .filter(([, v]) => v && v.enabled === false).map(([g]) => g).sort()
  const offRead = (scopeBody.groups || []).filter((g) => g.enabled === false).map((g) => g.id).sort()
  check('已存的 scope 勾选被如实读出（本机关掉的组仍为关）',
    offInFile.join(',') === offRead.join(','), `文件 [${offInFile.join(',')}] / 读出 [${offRead.join(',')}]`)
}
check('deleteCloud 默认关闭（取消勾选不删云端副本）', scopeBody.deleteCloud === false)
check('scope 带回本机文件路径（面板要显示出来）', Boolean(scopeBody.path && scopeBody.path.endsWith('config-sync-scope.json')), scopeBody.path || '(空)')

// 挑一个「本机真实存在、且允许单独排除」的明细项来测组内排除（不能用编出来的名字：
// 服务端会把不存在的排除项清掉，否则以后勾不回来——那反而会被判失败）
const exTarget = (scopeBody.groups || [])
  .filter((g) => g.id !== 'skills')
  .map((g) => ({ group: g.id, item: (g.items || []).find((i) => i.excludable !== false) }))
  .find((x) => Boolean(x.item)) || null
const groupsPayload = { skills: { enabled: false, excluded: [] } }
if (exTarget) groupsPayload[exTarget.group] = { enabled: true, excluded: [exTarget.item.id] }
const scopePost = await call('/config-sync/scope', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ deleteCloud: true, groups: groupsPayload }),
})
const scopePostBody = JSON.parse(scopePost.body || '{}')
check('scope 保存返回 ok', scopePost.statusCode === 200 && scopePostBody.ok === true, scopePost.body.slice(0, 160))
check('scope 落盘到本机 config-sync-scope.json', existsSync(scopeFile), scopeFile)
check('落盘记住取消的组、组内排除项与 deleteCloud',
  existsSync(scopeFile) && (() => {
    try {
      const o = JSON.parse(readFileSync(scopeFile, 'utf8'))
      const okGroup = o.deleteCloud === true && o.groups?.skills?.enabled === false
      const okItem = !exTarget || (Array.isArray(o.groups?.[exTarget.group]?.excluded) && o.groups[exTarget.group].excluded.includes(exTarget.item.id))
      return okGroup && okItem
    } catch { return false }
  })(), scopeFile)
check('全勾的组不写进文件（默认就是全勾，文件只留差异）',
  existsSync(scopeFile) && !readFileSync(scopeFile, 'utf8').includes('"storages-record"'), scopeFile)
check('不存在的排除项会被清掉（免得以后看不见却一直挡着同步）',
  existsSync(scopeFile) && (() => {
    try {
      const o = JSON.parse(readFileSync(scopeFile, 'utf8'))
      const ids = []
      for (const [id, g] of Object.entries(o.groups || {})) for (const x of (g.excluded || [])) ids.push(`${id}:${x}`)
      const real = new Set()
      for (const g of (scopeBody.groups || [])) for (const i of (g.items || [])) real.add(`${g.id}:${i.id}`)
      return ids.every((x) => real.has(x))
    } catch { return false }
  })(), scopeFile)
const scopeAfter = JSON.parse((await call('/config-sync/scope', { headers: { host: 'localhost:3080' } })).body || '{}')
check('读回来的状态与保存的一致',
  (scopeAfter.groups || []).some((g) => g.id === 'skills' && g.enabled === false)
  && (!exTarget || (scopeAfter.groups || []).some((g) => g.id === exTarget.group && g.items.some((i) => i.id === exTarget.item.id && i.enabled === false))),
  (scopeAfter.groups || []).map((g) => `${g.id}:${g.enabled}`).join(', '))
if (prevScope === null) { try { unlinkSync(scopeFile) } catch { } } else writeFileSync(scopeFile, prevScope, 'utf8')

// --- 同步冲突清单：pull 被本机文件挡住时，脚本写清单、面板读清单、用户逐项选 ---
const conflictFile = join(dshHomeDir, 'sync-conflicts.json')
const prevConflict = existsSync(conflictFile) ? readFileSync(conflictFile, 'utf8') : null
// 真机上可能正躺着一份待处理的清单（那是用户的数据）：先挪开再测，finally 原样放回
if (prevConflict !== null) { try { unlinkSync(conflictFile) } catch { } }
try {
  const confEmpty = JSON.parse((await call('/config-sync/conflict', { headers: { host: 'localhost:3080' } })).body || '{}')
  check('冲突接口：没有清单时 exists=false，不报错', confEmpty.ok === true && confEmpty.exists === false,
    `exists=${confEmpty.exists}`)

  // 备份目录：本机 / 云端两份副本分目录存，同一相对路径一一对应
  const backupRoot = join(dshHomeDir, 'backups', 'conflict-selftest-拉取冲突-Pull-conflict')
  mkdirSync(join(backupRoot, '本机-Local', 'mnemon'), { recursive: true })
  mkdirSync(join(backupRoot, '云端-Cloud', 'mnemon'), { recursive: true })
  mkdirSync(join(backupRoot, '本机-Local', '__selftest-probe__'), { recursive: true })
  mkdirSync(join(backupRoot, '云端-Cloud', '__selftest-probe__'), { recursive: true })
  writeFileSync(join(backupRoot, '本机-Local', 'mnemon', 'a.json'), 'LOCAL-COPY')
  writeFileSync(join(backupRoot, '云端-Cloud', 'mnemon', 'a.json'), 'CLOUD-COPY')
  writeFileSync(join(backupRoot, '本机-Local', '__selftest-probe__', 'probe.txt'), 'FROM-LOCAL')
  writeFileSync(join(backupRoot, '云端-Cloud', '__selftest-probe__', 'probe.txt'), 'FROM-CLOUD')
  writeFileSync(join(backupRoot, '说明-README.txt'), 'DSH 配置同步 —— 拉取冲突备份\r\n', 'utf8')
  const probeDst = join(repoArg, '__selftest-probe__', 'probe.txt')

  writeFileSync(conflictFile, JSON.stringify({
    at: '2026-11-12 20:05:00',
    repo: repoArg,
    head: 'aaaaaaa',
    remoteHead: 'bbbbbbb',
    backupDir: backupRoot,
    items: [
      { path: 'mnemon/data/a.json', kind: 'untracked', localSize: 12, remoteSize: 20, binary: false, localPreview: 'L1', remotePreview: 'R1', localSaved: true, cloudSaved: true, choice: '' },
      { path: '__selftest-probe__/probe.txt', kind: 'modified', localSize: 10, remoteSize: 10, binary: false, localPreview: 'LP', remotePreview: 'RP', localSaved: true, cloudSaved: true, choice: '' },
    ],
  }, null, 2), 'utf8')

  const confGet = JSON.parse((await call('/config-sync/conflict', { headers: { host: 'localhost:3080' } })).body || '{}')
  check('冲突清单：GET 带回条目、两侧预览、备份目录与两份副本标记',
    confGet.ok === true && confGet.exists === true && (confGet.items || []).length === 2
    && confGet.items[0].localPreview === 'L1' && confGet.items[0].remotePreview === 'R1'
    && confGet.items[0].localSaved === true && confGet.items[0].cloudSaved === true
    && String(confGet.backupDir || '').endsWith('拉取冲突-Pull-conflict'),
    `${(confGet.items || []).length} 项`)

  const confPost = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ path: 'mnemon/data/a.json', choice: 'cloud' }] }),
  })).body || '{}')
  check('冲突清单：POST 保存选择（只覆盖传进来的项）',
    confPost.ok === true && confPost.total === 2 && confPost.chosen === 1 && confPost.pending === 1,
    `total=${confPost.total} chosen=${confPost.chosen} pending=${confPost.pending}`)
  const confOnDisk = JSON.parse(readFileSync(conflictFile, 'utf8'))
  check('冲突清单：选择落盘，未传的项保持原值',
    confOnDisk.items[0].choice === 'cloud' && confOnDisk.items[1].choice === '')

  const confUnknown = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ path: 'not/in/list.txt', choice: 'cloud' }] }),
  })).body || '{}')
  check('冲突清单：清单外的 path 被忽略（不让面板往 JSON 里塞任意路径）',
    confUnknown.ok === true && confOnDisk.items.every((it) => it.path !== 'not/in/list.txt')
    && JSON.parse(readFileSync(conflictFile, 'utf8')).items.length === 2)

  // 两份副本都能单独还原：写回的是同一相对路径，来源按 side 选
  const restoreLocal = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore', path: '__selftest-probe__/probe.txt', side: 'local' }),
  })).body || '{}')
  check('冲突清单：还原本机副本（side=local，写回工作区）',
    restoreLocal.ok === true && restoreLocal.side === 'local'
    && existsSync(probeDst) && readFileSync(probeDst, 'utf8') === 'FROM-LOCAL',
    restoreLocal.error || '')

  const restoreCloud = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore', path: '__selftest-probe__/probe.txt', side: 'cloud' }),
  })).body || '{}')
  check('冲突清单：还原云端副本（side=cloud，写回工作区）',
    restoreCloud.ok === true && restoreCloud.side === 'cloud'
    && existsSync(probeDst) && readFileSync(probeDst, 'utf8') === 'FROM-CLOUD',
    restoreCloud.error || '')

  const restoreMissing = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore', path: 'mnemon/data/a.json', side: 'cloud' }),
  })).body || '{}')
  check('冲突清单：备份里缺某一侧副本时明确报错，不假装成功',
    restoreMissing.ok === false && /云端副本/.test(String(restoreMissing.error || '')))

  const confReset = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reset' }),
  })).body || '{}')
  check('冲突清单：放弃清单会删掉文件', confReset.ok === true && confReset.cleared === true && !existsSync(conflictFile))

  const statusConf = JSON.parse((await call('/config-sync/status', { headers: { host: 'localhost:3080' } })).body || '{}')
  check('status 带回冲突概要（面板据此决定是否显示这张卡）',
    statusConf.conflicts && statusConf.conflicts.exists === false && typeof statusConf.conflicts.total === 'number',
    JSON.stringify(statusConf.conflicts || null))
} finally {
  if (prevConflict === null) { try { unlinkSync(conflictFile) } catch { } } else writeFileSync(conflictFile, prevConflict, 'utf8')
  try { rmSync(join(repoArg, '__selftest-probe__'), { recursive: true, force: true }) } catch { }
  try { rmSync(backupRoot, { recursive: true, force: true }) } catch { }
}
// --- 必需组：profile 是 apply 的前置条件（缺了直接 Die），所以不许取消勾选 ---
const reqPost = await call('/config-sync/scope', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ deleteCloud: false, groups: { profile: { enabled: false, excluded: ['package.json'] } } }),
})
check('必需组不能取消：POST 关掉 profile 也不落盘',
  reqPost.statusCode === 200
  && (!existsSync(scopeFile) || !readFileSync(scopeFile, 'utf8').includes('"profile"')),
  existsSync(scopeFile) ? readFileSync(scopeFile, 'utf8').slice(0, 120) : '(文件不存在)')
const reqAfter = JSON.parse((await call('/config-sync/scope', { headers: { host: 'localhost:3080' } })).body || '{}')
const profileGroup = (reqAfter.groups || []).find((g) => g.id === 'profile') || {}
check('回读里 profile 仍是勾选、并标了 required',
  profileGroup.enabled === true && profileGroup.required === true,
  `enabled=${profileGroup.enabled} required=${profileGroup.required}`)
check('其余组没有 required 标记（只有真正会报错的那组被钉死）',
  (reqAfter.groups || []).filter((g) => g.id !== 'profile').every((g) => g.required !== true))
if (prevScope === null) { try { unlinkSync(scopeFile) } catch { } } else writeFileSync(scopeFile, prevScope, 'utf8')
// D:\dsh-config，所以这里退一步做静态断言——宿主源码里确实有这道守卫，且提示指向面板。
{
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'index.js'), 'utf8')
  check('宿主在没仓库时拒绝生成（有守卫）', src.includes('还没有配置仓库目录'), 'index.js')
  check('守卫提示指向面板「本机仓库」卡，而不是让人去改 cordis.patch.yml',
    /还没有配置仓库目录[\s\S]{0,160}本机仓库/.test(src), 'index.js')
  check('云端仓库没配时也拒绝生成推送/拉取（有守卫）', src.includes('还没有配置云端仓库地址'), 'index.js')
  check('还原不受云端仓库影响（守卫排除 restore）', /action !== 'restore'/.test(src), 'index.js')
  check('仓库没有 origin 时会 remote add（而不是 set-url 失败）', /'remote', 'add', 'origin'/.test(src), 'index.js')
  // 「只装了插件、仓库还没克隆」也要能生成脚本：执行体退回插件自带的 runtime。
  check('生成脚本时执行体有 runtime 兜底', /pluginRoot\(\)[\s\S]{0,80}'runtime'/ .test(src) || /'runtime', name/.test(src), 'index.js')
  check('仓库未克隆时返回 bootstrap 提示', src.includes('bootstrap'), 'index.js')
  // 同一份 selftest 会跑在两种布局里：发布仓库（<root>\tools\ + <root>\runtime\）
  // 和配置仓库里的 plugin\dsh-config-sync\tools\（<root>\sync.ps1 + <root>\tools\）。
  // 所以这里按实际文件探测，而不是写死向下几层。
  const pluginRoot = existsSync(join(here, '..', 'package.json')) ? join(here, '..') : join(here, '..', '..')
  const repoRoot = join(here, '..', '..', '..')
  const packScript = [join(pluginRoot, 'tools', 'pack-plugin.ps1'), join(repoRoot, 'tools', 'pack-plugin.ps1')].find((p) => existsSync(p)) || ''
  check('打包脚本会把 ps1 打进 runtime', Boolean(packScript), packScript || 'tools/pack-plugin.ps1')
  const syncScript = [join(pluginRoot, 'runtime', 'sync.ps1'), join(pluginRoot, 'sync.ps1'), join(repoRoot, 'runtime', 'sync.ps1')].find((p) => existsSync(p)) || ''
  check('sync.ps1 支持首次自动初始化仓库', Boolean(syncScript) && readFileSync(syncScript, 'utf8').includes('Initialize-RepoIfNeeded'), syncScript || 'sync.ps1')
  // 冲突备份要「两份副本 + 中英文说明」，面板才能对哪一份都执行还原
  const syncSrc = syncScript ? readFileSync(syncScript, 'utf8') : ''
  check('冲突备份：本机/云端两份副本分目录（目录名带中英文）',
    syncSrc.includes('本机-Local') && syncSrc.includes('云端-Cloud'), syncScript || 'sync.ps1')
  check('冲突备份：云端副本按字节落盘（cat-file blob + cmd 重定向，不过 PowerShell 转码）',
    syncSrc.includes('Save-BlobToFile') && /cat-file blob/.test(syncSrc), 'sync.ps1')
  check('冲突备份：目录名写明用途（拉取冲突 / Pull conflict）',
    syncSrc.includes('拉取冲突-Pull-conflict'), 'sync.ps1')
  check('冲突备份：附中英双语说明文件与清单快照',
    syncSrc.includes('说明-README.txt') && syncSrc.includes('清单-Conflicts.json'), 'sync.ps1')
  check('冲突备份：每项都记录两份副本是否备份成功（面板据此置灰按钮）',
    syncSrc.includes('localSaved') && syncSrc.includes('cloudSaved'), 'sync.ps1')
  // 0.3.42：初始化推送的两个拦路虎（都是实测撞出来的，不能让它们再回来）
  check('初始化推送不会被自己刚写进去的内容挡住（认识同步仓库的标志文件）',
    syncSrc.includes('$isSyncRepo') && syncSrc.includes("Join-Path $RepoRoot 'dsh-sync-common.ps1'"),
    'sync.ps1 的 stray 判据又只认空目录了')
  const captureScript42 = [join(pluginRoot, 'runtime', 'capture.ps1'), join(pluginRoot, 'capture.ps1'), join(repoRoot, 'capture.ps1')].find((p) => existsSync(p)) || ''
  const cap43 = captureScript42 ? readFileSync(captureScript42, 'utf8') : ''
  check('根外路径体检里没有漏写 $ 的变量（(v.Replace 会被当成命令执行）',
    Boolean(cap43) && !/\(\s*v\.Replace\(/.test(cap43) && cap43.includes('($v.Replace('),
    captureScript42 || 'capture.ps1')
  // 重启客户端必须脱离进度窗口的控制台/作业，否则手动关窗口会把刚重启的客户端一起带走。
  const postExit = [join(pluginRoot, 'runtime', 'post-exit.ps1'), join(pluginRoot, 'post-exit.ps1'), join(repoRoot, 'post-exit.ps1')].find((p) => existsSync(p)) || ''
  const postExitSrc = postExit ? readFileSync(postExit, 'utf8') : ''
  check('重启客户端走 explorer 代启（不被进度窗口连坐）',
    postExitSrc.includes('function Start-Detached') && /explorer\.exe/.test(postExitSrc) && postExitSrc.includes('Start-Detached $exe'),
    postExit || 'post-exit.ps1')

  // 进度窗口的收尾：推送/拉取完成后窗口留着等用户自己关（不自动消失），
  // 且客户端是在这之前由 explorer 拉起来的 —— 所以点 × 关掉窗口不会把客户端带走。
  // 0.3.64 起改成「展示 6 分钟后自动关窗」：远程桌面/无焦点时 ReadKey 会一直卡住，
  // 用户要的是别让窗口永远挡在前面。所以断言改成盯 Start-Sleep 而不是 ReadKey。
  check('推送/拉取完成后进度窗口保留一段时间再自动关闭（不再卡在 ReadKey）',
    postExitSrc.includes("if ($Mode -eq 'pull' -or $Mode -eq 'push'") && /\[int\]\$HoldSeconds = 360/.test(postExitSrc) && /Start-Sleep -Seconds \$HoldSeconds/.test(postExitSrc) && !postExitSrc.includes('RawUI.ReadKey'),
    postExit || 'post-exit.ps1')
  check('插件更新完成后窗口同样留着（不与同步窗口两套行为）',
    /-eq 'pull'.*?-eq 'push'.*?-eq 'update'/.test(postExitSrc) && postExitSrc.includes('插件更新已完成'),
    postExit || 'post-exit.ps1')
  check('客户端在窗口开始等待之前就已拉起（关窗口不影响它）',
    postExitSrc.indexOf('if ($Restart) { RestartClient }') > 0
      && postExitSrc.indexOf('if ($Restart) { RestartClient }') < postExitSrc.lastIndexOf('Finish 0'),
    postExit || 'post-exit.ps1')

  // 执行体优先级：仓库里那份 sync.ps1 是随配置仓库同步来的副本，插件升级后可能还是旧版；
  // 旧版没有冲突清单/exit 6，会把 pull 退回「直接 git pull + 失败回滚」——
  // 真实故障：面板 18 项全选「用云端」，清单读都没读就被旧执行体覆盖回滚。
  check('执行体选择：插件 runtime 优先、仓库副本兜底',
    postExitSrc.includes('function Find-PluginScript')
      && postExitSrc.indexOf('function Find-PluginScript') < postExitSrc.indexOf("$sync = Find-PluginScript 'sync.ps1'"),
    postExit || 'post-exit.ps1')
  check('仓库 sync.ps1 只作兜底（不得排在插件前面）',
    postExitSrc.indexOf("$sync = Find-PluginScript 'sync.ps1'") > 0
      && postExitSrc.indexOf("$sync = Find-PluginScript 'sync.ps1'") < postExitSrc.indexOf('if (-not $sync -and $RepoRoot)'),
    postExit || 'post-exit.ps1')

  // 更新源自检（0.6.47 起：更新检查只查 npm，不再读 GitHub 清单）
  //
  // 旧断言盯的是「清单带 gh-proxy / ghfast 实时反代，raw 兜底」——那是读 GitHub 仓库根
  // version.json 的年代。用户明确要求「插件更新只检查 npm，不检查 GitHub」，所以整条线退休：
  // 更新检查读 npm 的 dist-tags + 单版本文档，校验值取 registry 自己的 dist.integrity / dist.shasum。
  const indexSrc = readFileSync(join(pluginRoot, 'index.js'), 'utf8')
  // 0.6.49：插件数据 / 额外路径的规则已挪进 runtime/extra-rules.mjs（engine 也要用同一份）
  const extraRulesSrc = readFileSync(join(pluginRoot, 'runtime', 'extra-rules.mjs'), 'utf8')
  // 负向断言只看**代码**：这些名字经常在注释里被提到（"原来叫 UPDATE_MANIFEST_MIRRORS，已删"），
  // 直接 includes() 会把「解释为什么删掉」判成「还在用」。
  const stripComments = (src) => String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
  const indexCode = stripComments(indexSrc)
  // 0.6.49：地址不再是一个写死的常量（NPM_DIST_TAGS_URL），而是 npmUrls(registry) 现算 ——
  // 断言跟着改成「有 npmUrls + distTags + registry 可换」，否则它会永远判红，
  // 让人以为「只查 npm」这条策略失效了。
  check('更新检查只查 npm（dist-tags + 单版本文档），不再读 GitHub 清单',
    indexCode.includes('function npmUrls(') && indexCode.includes('distTags:') &&
    indexCode.includes('async function fetchNpmLatest') &&
    !indexCode.includes('async function fetchManifestAuto') && !indexCode.includes('UPDATE_MANIFEST_MIRRORS') &&
    !indexCode.includes('gh-proxy.com') && !indexCode.includes('raw.githubusercontent.com/' + 'huanyu-a'),
    'index.js')
  check('更新校验用 registry 的 integrity / shasum（与被校验物同源）',
    indexSrc.includes('function verifyDownloadedPackage') && indexSrc.includes('dist.integrity') &&
    /function verifyDownloadedPackage[\s\S]{0,900}integrity/.test(indexSrc), 'index.js')
  check('清单超时放宽到 30 秒（慢链路 10 秒会假失败）',
    indexSrc.includes('UPDATE_FETCH_TIMEOUT = 30 * 1000'), 'index.js')
  // 0.3.7：更新拆成「只下载」和「退出后安装」两段。
  // 为什么：DSH 开着的时候覆盖插件目录，宿主会重新同步插件树、把「配置同步」面板卸载掉 ——
  // 用户看到的就是"更新到一半页面自己跳走，还得点回来才能按重启"。所以覆盖必须留到退出之后。
  check('宿主有「只下载」动作（prepare → update-staging，不碰插件目录）',
    indexSrc.includes("action === 'prepare'") && indexSrc.includes('async function downloadPackage') &&
    indexSrc.includes('update-staging'), 'index.js')
  check('只下载会按候选地址逐个试并校验 sha256',
    // 窗口别卡太死：函数体已经有 1300+ 字节，1200 的窗口会在正常改动后假失败（实测 1354 字节就失败）
    /function downloadPackage[\s\S]{0,2600}createHash\('sha256'\)/.test(indexSrc), 'index.js')
  check('宿主有「装并重启」动作（install-restart，把本地包交给退出后的脚本）',
    indexSrc.includes("action === 'install-restart'") &&
    /action === 'install-restart'[\s\S]{0,900}-UpdateTgz/.test(indexSrc), 'index.js')
  check('退出后的安装直接吃已下好的本地包（不重复下载）',
    postExitSrc.includes('Test-Path -LiteralPath $UpdateTgz -PathType Leaf'),
    postExit || 'post-exit.ps1')
  check('运行中静默安装仍保留给 CLI/兼容（界面不用它）',
    indexSrc.includes("action === 'install-live'") && indexSrc.includes('function runInstallPlugin'), 'index.js')
  check('只重启走 relaunch（不碰仓库也不装插件）',
    indexSrc.includes("mode: 'relaunch'") && postExitSrc.includes("'relaunch'"), postExit || 'post-exit.ps1')
  const installer = [join(pluginRoot, 'runtime', 'install-plugin.ps1'), join(pluginRoot, 'install-plugin.ps1')].find((p) => existsSync(p)) || ''
  const installerSrc = installer ? readFileSync(installer, 'utf8') : ''
  check('安装器存在并自报结果（RESULT: 行）', Boolean(installer) && installerSrc.includes('RESULT:'), installer || 'runtime/install-plugin.ps1')
  check('安装器覆盖前先备份、写坏能回滚',
    installerSrc.includes('function Restore-Backup') && installerSrc.includes('plugin-{0}-{1}'),
    installer || 'runtime/install-plugin.ps1')
  check('安装器按候选地址逐个下载', installerSrc.includes("-split '\\|'"), installer || 'runtime/install-plugin.ps1')
  const clientSrc = readFileSync(join(pluginRoot, 'client.js'), 'utf8')
  check('面板按钮走「下载更新 → 重启并安装」，不再运行中安装',
    clientSrc.includes("action: 'prepare'") && clientSrc.includes("action: 'install-restart'") &&
    !clientSrc.includes("action: 'install-live'") &&
    clientSrc.includes('重启并安装') && clientSrc.includes('Restart & install'), 'client.js')
  check('面板会展示「已下载，待安装」这一态',
    clientSrc.includes('preparedReady') && clientSrc.includes('已下载，待安装'), 'client.js')

  // 0.3.8：同步内容勾选 —— 面板写 <DshHome>\config-sync-scope.json，capture/apply 读同一个文件。
  // 关键契约：默认全勾、未勾选一律跳过、deleteCloud 默认关（关着时绝不删云端副本）。
  const pickRuntime = (name) => [join(pluginRoot, 'runtime', name), join(pluginRoot, name)].find((p) => existsSync(p)) || ''
  const commonSrc = pickRuntime('dsh-sync-common.ps1') ? readFileSync(pickRuntime('dsh-sync-common.ps1'), 'utf8') : ''
  const captureSrc = pickRuntime('capture.ps1') ? readFileSync(pickRuntime('capture.ps1'), 'utf8') : ''
  const applySrc = pickRuntime('apply.ps1') ? readFileSync(pickRuntime('apply.ps1'), 'utf8') : ''
  const pickTool = (name) => [join(pluginRoot, 'runtime', 'tools', name), join(pluginRoot, 'tools', name)].find((p) => existsSync(p)) || ''
  const helperSrc = pickTool('fix-session-cwd.mjs') ? readFileSync(pickTool('fix-session-cwd.mjs'), 'utf8') : ''
  // 执行体没跑起来时 PowerShell 只喷红字、$LASTEXITCODE 还是上一条命令残留的 0，
  // 整次同步就被当成成功（写 ok:true + 刷分水岭），本机改动静默滞留。三道锁缺一不可。
  check('调用执行体前压哨兵值，且终止错误被捕获后一律判失败',
    postExitSrc.includes('$LASTEXITCODE = -1')
      && postExitSrc.includes('$invokeOk = $false')
      && /catch \{[\s\S]{0,400}执行体调用异常/.test(postExitSrc)
      && /if \(-not \$invokeOk\)[\s\S]{0,260}\$code = 1/.test(postExitSrc),
    'post-exit.ps1')
  check('调用执行体前确认文件仍存在（安装覆盖到一半也能拦住）',
    /\$sync = Find-PluginScript 'sync\.ps1'[\s\S]{0,1200}Test-Path -LiteralPath \$sync/.test(postExitSrc),
    'post-exit.ps1')
  check('同步失败时不刷新同步分水岭（免得失败变成静默漏推）',
    postExitSrc.includes('RestartClient -SkipWatermark:$failed')
      && postExitSrc.includes('function RestartClient([switch]$SkipWatermark)')
      && /if \(-not \$SkipWatermark\)/.test(postExitSrc),
    'post-exit.ps1')

  const SCOPE_GROUPS = ['profile', 'prompt', 'skills', 'presets', 'storages-record', 'settings', 'mnemon', 'local-plugins', 'plugin-data', 'extra', 'workspace', 'conversations']
  check('公共脚本提供 scope 读取与判断函数',
    ['Get-SyncScope', 'Test-SyncGroupEnabled', 'Test-SyncItemEnabled', 'Test-SyncDeleteCloud', 'Skip-SyncGroup', 'Skip-SyncItem']
      .every((n) => commonSrc.includes(`function ${n}`)), 'dsh-sync-common.ps1')
  check('scope 文件不存在时按全勾处理（老机器行为不变）',
    commonSrc.includes('config-sync-scope.json') && /function Get-SyncScope[\s\S]{0,700}Test-Path/.test(commonSrc),
    'dsh-sync-common.ps1')
  check('capture 十组都按勾选判断',
    SCOPE_GROUPS.every((g) => captureSrc.includes(`Test-SyncGroupEnabled $Scope '${g}'`)),
    SCOPE_GROUPS.filter((g) => !captureSrc.includes(`Test-SyncGroupEnabled $Scope '${g}'`)).join(', ') || 'capture.ps1')
  const EXCLUDABLE = ['skills', 'presets', 'settings', 'local-plugins', 'prompt', 'storages-record', 'plugin-data', 'extra', 'workspace', 'conversations']
  check('capture 组内还能单独排除（skills / presets / settings / local-plugins / prompt / 台账 / 插件数据 / 额外路径 / 工作区 / 会话）',
    EXCLUDABLE.every((g) => captureSrc.includes(`Test-SyncItemEnabled $Scope '${g}'`)),
    EXCLUDABLE.filter((g) => !captureSrc.includes(`Test-SyncItemEnabled $Scope '${g}'`)).join(', ') || 'capture.ps1')
  check('apply 十组都按勾选跳过（未勾选的不还原）',
    SCOPE_GROUPS.every((g) => applySrc.includes(`Test-SyncGroupEnabled $Scope '${g}'`)),
    SCOPE_GROUPS.filter((g) => !applySrc.includes(`Test-SyncGroupEnabled $Scope '${g}'`)).join(', ') || 'apply.ps1')
  check('deleteCloud 默认关：关着时跳过就只是跳过，不删云端副本',
    /function Skip-SyncGroup[\s\S]{0,400}Test-SyncDeleteCloud/.test(commonSrc)
    && commonSrc.includes('if (-not (Test-SyncDeleteCloud $Scope)) { return }'), 'dsh-sync-common.ps1')
  check('apply 的 -PruneSkills 不会删掉被排除的本机 Skill',
    applySrc.includes("(Test-SyncItemEnabled $Scope 'skills' $_.Name)"), 'apply.ps1')
  check('会话按工作区过滤，且未勾选的会话不会被铺回本机',
    captureSrc.includes('$skipSessDirs') && applySrc.includes('$skipConvDirs'), 'capture/apply')

  // 0.3.51：插件数据（自动枚举）与额外路径（用户自选），规则落在 config-sync-extra.json
  check('两组 id 进了公共脚本、capture、apply 与面板',
    commonSrc.includes("'plugin-data', 'extra'")
    && captureSrc.includes("Test-SyncGroupEnabled $Scope 'plugin-data'")
    && applySrc.includes("Test-SyncGroupEnabled $Scope 'plugin-data'")
    && indexSrc.includes("id: 'plugin-data'") && indexSrc.includes("id: 'extra'"), 'all')
  check('规则文件：config-sync-extra.json + 排除名单整份替换（空数组也要能生效）',
    commonSrc.includes('config-sync-extra.json')
    && commonSrc.includes("if ($j.pluginData.PSObject.Properties['exclude']) { $pd.exclude = @("), 'dsh-sync-common.ps1')
  check('单文件上限卡在 GitHub 硬限 100MB（配置调大也压回来）',
    commonSrc.includes('$SyncExtraHardMaxBytes = 104857600') && commonSrc.includes('[Math]::Min([int64]$v, [int64]$SyncExtraHardMaxBytes)'), 'dsh-sync-common.ps1')
  check('插件数据按 dav 目录枚举，系统/已覆盖目录进默认 skipDirs',
    commonSrc.includes('function Get-PluginDataSlots') && commonSrc.includes("'profiles', 'skills', '.agent-presets', 'storages'"), 'dsh-sync-common.ps1')
  check('抓取写 manifest（路径占位符化，方便另一台展开）',
    captureSrc.includes("Join-Path $pdDst 'manifest.json'") && captureSrc.includes("src  = (ConvertTo-TokenText $slot.src $pdRoots)"), 'capture.ps1')
  check('写回先展开占位符、再逐文件合并并留底',
    /Copy-TreeInto \$slotSrc \$dst \$bk/.test(applySrc) && applySrc.includes('$miss = @(Get-MissingTokens $expanded)'), 'apply.ps1')
  check('面板有 /config-sync/extra-config 接口与规则卡',
    indexSrc.includes("const ROUTE_EXTRA_CONFIG = '/config-sync/extra-config'")
    && indexSrc.includes('async function handleExtraConfig')
    && clientSrc.includes("fetch('/config-sync/extra-config'") && clientSrc.includes('function ExtraCard'), 'index/client')
  check('凭据文件默认不进仓库：*vault* 在名单里，且抓取前按内容嗅探再拦一道',
    commonSrc.includes("'*vault*'") && extraRulesSrc.includes("'*vault*'")
    && indexSrc.includes("from './runtime/extra-rules.mjs'")
    && commonSrc.includes('function Test-SyncExtraSecret') && commonSrc.includes('$SyncExtraSecretMarkers')
    && captureSrc.includes('Get-SyncExtraSecretSkips'), 'common/index/capture')
  check('符号链接/junction 不跟进（插件目录常把外部数据链进来）',
    commonSrc.includes('[IO.FileAttributes]::ReparsePoint'), 'dsh-sync-common.ps1')
  check('「插件数据与额外路径」卡先只读，点「修改」才能改、点「保存」才落盘',
    clientSrc.includes('readOnly: !editing')
    && clientSrc.includes('disabled: !editing')
    && /const \[editing, setEditing\] = react\.useState\(false\)[\s\S]{0,1200}setEditing\(false\)/.test(clientSrc)
    && clientSrc.includes('M(\'取消\', \'Cancel\')'), 'client.js')
  const rmIdx = clientSrc.indexOf('() => removePath')
  const rmBefore = rmIdx >= 0 ? clientSrc.slice(rmIdx - 180, rmIdx) : ''
  check('额外路径的「移除」按钮只在编辑态出现（只读时整行只剩名字和路径）',
    rmBefore.includes("editing ? h('button'") && !rmBefore.includes('disabled: !editing'), 'client.js')
  check('工作区登记表也跟着过滤（不会「数据跳过了、登记表还写着」）',
    captureSrc.includes("$entries = @($entries | Where-Object { Test-SyncItemEnabled $Scope 'workspace' $_.Id })")
    && applySrc.includes("$plan = @($plan | Where-Object { Test-SyncItemEnabled $Scope 'workspace' $_.Id })"),
    'capture/apply')

  // apply 的非零退出码等同于「拉取失败」，post-exit 会据此回滚；
  // 所以「没有 pnpm」这种环境差异不能让整次拉取失败 —— 只要 node_modules 在，依赖就是好的。
  check('依赖已就绪时 apply 不因缺少 pnpm 而失败退出',
    applySrc.includes("Join-Path $ProfileDir 'node_modules'")
      && applySrc.includes('$skipBecauseReady'), 'apply.ps1')
  check('node_modules 不存在时仍然明确报错（不静默放过）',
    /if \(Test-Path -LiteralPath \$nodeModules\)[\s\S]{0,300}exit 1/.test(applySrc), 'apply.ps1')

  // 登记表：同一路径撞了两台机器各自建的 ID 时，必须保留当前机器在用的 ID，
  // 否则 defaultWorkspaceId 悬空、整张表校验不过（工作区列表空、会话读不出）。
  check('登记表同路径冲突时保留本机 ID（不是仓库 ID）',
    applySrc.includes('$localIdSet')
      && applySrc.indexOf('Where-Object { $localIdSet.ContainsKey($_) }')
         < applySrc.indexOf('Where-Object { $mfIdSet.ContainsKey($_) }'),
    'apply.ps1')
  check('defaultWorkspaceId 以本机为准（原值还在表里就不动）',
    applySrc.includes('$localDefault')
      && applySrc.includes('$ids -contains $localDefault')
      && applySrc.includes("$localGlobal['defaultWorkspaceId'] = $ids[0]"),
    'apply.ps1')

  // 会话还原的前提：能展开 {{APP_ROOT}} 占位符。做不到就别铺 —— 铺了 DSH 一个都不登记，
  // 用户看到的就是「工作区还在、会话全没了」（真实事故）。
  check('node 探测覆盖常见安装位置（不只有 PATH）',
    commonSrc.includes("nodejs\\node.exe")
      && commonSrc.includes('function Get-HostNodeExe'),
    'dsh-sync-common.ps1')
  check('找不到 Node 时跳过会话还原而不是铺坏文件',
    /if \(\$cwdMap\.Count -gt 0 -or \$projMap\.Count -gt 0\) \{[\s\S]{0,400}跳过会话还原[\s\S]{0,200}return/.test(applySrc),
    'apply.ps1')
  check('会话还原用的是统一探测到的执行器（Node 或客户端 Electron）',
    applySrc.includes('$nodeRunner = Get-HostNodeRunner $AppRoot')
      && applySrc.includes('$nodeRunner.Electron')
      && commonSrc.includes('function Get-HostNodeRunner'),
    'apply.ps1')
  // 客户端 Electron 是 GUI 子系统，stdout 抓不到 —— 结果必须落文件，否则面板/日志永远报失败
  check('会话头部修正的结果写成文件（Electron 跑时 stdout 抓不到）',
    helperSrc.includes('const outPath = process.argv[3]')
      && helperSrc.includes('emit(result)')
      && applySrc.includes('$resultPath'),
    'fix-session-cwd.mjs')
  check('面板有「同步内容」卡：逐组勾选 + 展开明细 + deleteCloud 开关',
    clientSrc.includes('function ScopeCard') && clientSrc.includes('callScope(')
    && clientSrc.includes('同步内容') && clientSrc.includes('Sync content')
    && clientSrc.includes('取消勾选时顺手删掉云端副本'), 'client.js')
  // 必需组（profile）三处钉死：脚本侧判断、宿主保存、面板复选框
  check('必需组在脚本侧钉死（手改 JSON 关掉也按开启处理）',
    commonSrc.includes('$SyncRequiredGroups')
    && /function Test-SyncGroupEnabled[\s\S]{0,260}Test-SyncRequiredGroup/.test(commonSrc),
    'dsh-sync-common.ps1')
  check('必需组在宿主侧钉死（保存时拒绝写入关闭状态）',
    indexSrc.includes('SCOPE_REQUIRED_GROUPS')
    && /for \(const \[id, g\] of Object\.entries\(groupsIn\)\)[\s\S]{0,260}scopeGroupRequired\(id\)\) continue/.test(indexSrc),
    'index.js')
  check('必需组在面板上不可勾掉（复选框禁用 + 标注）',
    clientSrc.includes('g.required === true') && clientSrc.includes('必需内容'), 'client.js')
  // 只读优先：不做「勾一下就写盘」，要先点「修改」、再点「保存」
  check('面板默认只读：勾选前必须先点「修改」',
    clientSrc.includes('const [editing, setEditing]')
    && clientSrc.includes("disabled: busy || !editing")
    && clientSrc.includes("M('修改', 'Edit')")
    && /onClick: \(\) => save\(state\)/.test(clientSrc), 'client.js')
  // 展开/收起改成点整行，单独的「明细」按钮要消失
  check('取消「明细」按钮：展开收起靠点当前行',
    !clientSrc.includes("M('明细', 'Details')")
    && clientSrc.includes('onClick: canExpand')
    && clientSrc.includes("expanded ? '▾' : '▸'"), 'client.js')
  check('同步内容卡与问题反馈卡挂在页面最下面（其后不再有别的 Section）', (() => {
    // 顺序：概览 → 同步目标 → 自动化与插件更新 → 退出后执行 → 还原备份 → 同步内容 → 问题反馈；
    // 判据是「顺序」而不是写死紧跟，中间还会插卡（本机路径就插在同步目标之前）。
    const order = ["概览", "同步目标", "自动化与插件更新", "退出后执行", "还原备份", "同步内容", "问题反馈"]
      .map((k) => ({ k, at: clientSrc.indexOf(`Section(M('${k}'`) }))
    if (order.some((p) => p.at < 0)) return false
    if (!order.every((p, i) => (i === 0 ? true : p.at > order[i - 1].at))) return false
    // 问题反馈必须是最后一个 Section
    const tail = clientSrc.slice(order[order.length - 1].at + 1)
    return !/Section\(M\(/.test(tail)
  })(), 'client.js')
  // 「还原备份」卡：地址可改（留空=默认）、列出快照、点「立即还原」先出确认框再排队
  check('控件：还原备份卡有备份目录、快照列表与立即还原',
    clientSrc.includes('backupRoot') && clientSrc.includes('backup.snapshots')
    && clientSrc.includes("M('立即还原', 'Restore now')") && clientSrc.includes("M('还原备份', 'Restore backup')"), 'client.js')
  check('控件：还原先弹确认（差异预览）再排队，不是点了就动手',
    clientSrc.includes("action: 'restore-preview'") && clientSrc.includes("action: 'restore-now'")
    && clientSrc.includes('askRestore') && clientSrc.includes('doRestore')
    && clientSrc.includes('pvRemovePlugins') && clientSrc.includes('pvRemoveFiles'), 'client.js')
  check('控件：快照行显示相对时间、类型徽章与内容摘要',
    clientSrc.includes('const rel = (at)') && clientSrc.includes('kindBadge') && clientSrc.includes('snapSummary'), 'client.js')
  check('控件：三类备份各有还原入口，认不出类型的给手动还原指引（不留死路）',
    clientSrc.includes("kindOf(s) === 'plugin' ? M('回滚插件'") && clientSrc.includes("M('还原会话', 'Restore sessions')")
    && clientSrc.includes("M('手动还原', 'How to restore')") && clientSrc.includes('manualTargets'), 'client.js')

  // 0.3.25 起「还原」与「立即拉取」共用一条流水线：面板排队 → 客户端退出 → 可见进度窗口执行 → 自动重启
  const restoreScript = [join(pluginRoot, 'runtime', 'restore.ps1'), join(repoRoot, 'restore.ps1')].find((p) => existsSync(p)) || ''
  const restoreSrc = restoreScript ? readFileSync(restoreScript, 'utf8') : ''
  check('post-exit 有 restore 分支：执行体是 restore.ps1，profile 带 -RollbackToPoint、其它类型带 -SnapshotKind',
    postExitSrc.includes("if ($Mode -eq 'restore')")
    && postExitSrc.includes("Find-PluginScript 'restore.ps1'")
    && postExitSrc.includes('RollbackToPoint')
    && postExitSrc.includes("$rargs['SnapshotKind'] = $SnapshotKind"), postExit || 'post-exit.ps1')
  check('post-exit 的 restore 分支沿用同一套返回码判据（哨兵 -1 + 没跑完即失败）',
    /if \(\$Mode -eq 'restore'\)[\s\S]{0,3000}?\$LASTEXITCODE = -1/.test(postExitSrc)
    && /if \(\$Mode -eq 'restore'\)[\s\S]{0,3500}?执行体没有正常跑完/.test(postExitSrc),
    'post-exit.ps1')
  check('post-exit 的 restore 分支有专属收尾文案',
    postExitSrc.includes('完成（已还原）') && postExitSrc.includes('还原失败'), 'post-exit.ps1')
  check('restore.ps1 提供 -RollbackToPoint 时点回退',
    restoreSrc.includes('[switch]$RollbackToPoint') && restoreSrc.includes('3.5 时点回退'), 'restore.ps1')
  check('时点回退：撤走的插件只删 junction 链接（不穿进去删目标）',
    /if \(\$item\.LinkType\)[\s\S]{0,220}\[IO\.Directory\]::Delete/.test(restoreSrc.replace(/\r/g, '')), 'restore.ps1')
  check('时点回退：写 rollback-manifest.json（可再还原，不留糊涂账）',
    restoreSrc.includes('rollback-manifest.json') && restoreSrc.includes('rollback\\files'), 'restore.ps1')
  check('时点回退：相对路径基准先归一成完整路径（避免 8.3 短名算错）',
    restoreSrc.includes('(Get-Item -LiteralPath $ProfileDir -Force).FullName'), 'restore.ps1')
  check('备份列表带插件数（面板要显示 N 个插件）',
    indexSrc.includes('plugins = Object.keys(pkg?.dependencies') && indexSrc.includes('plugins: x.plugins'), 'index.js')
  check('技能市场台账的勾选项 id 用文件名，不是整个 {id,src} 对象（否则落盘成 [object Object]）',
    /items: ledger\.map\(\(f\) => \(\{ id: f\.id, label: f\.id \}\)\)/.test(indexSrc), 'index.js')
  check('restore-now 复用 spawnWatcher，并把快照目录与类型带进执行体',
    /action === 'restore-now'[\s\S]{0,1200}?spawnWatcher\(\{[\s\S]{0,240}?mode: 'restore'/.test(indexSrc)
    && indexSrc.includes("const extraArgs = ['-BackupDir', snap.dir]")
    && indexSrc.includes("extraArgs.push('-SnapshotKind', snap.kind)")
    && indexSrc.includes("extraArgs.push('-PluginDir', PLUGIN_ROOT)"), 'index.js')
  check('restore.ps1 支持 -SnapshotKind 三型（profile / plugin / session）',
    restoreSrc.includes("ValidateSet('profile', 'plugin', 'session')")
    && restoreSrc.includes("$SnapshotKind -eq 'plugin'")
    && restoreSrc.includes("$SnapshotKind -eq 'session'")
    && restoreSrc.includes('function Copy-Tree'), 'restore.ps1')
  check('快照分类不能只看 package.json（profile 也带 dsh 字段）',
    indexSrc.includes('function classifySnapshot') && indexSrc.includes('/^dsh-profile-/i.test(pkgName)')
    && indexSrc.includes("pkgName === PACKAGE_ID"), 'index.js')
  check('restore-preview 与 prepare 共用同一套快照校验（口径不漂移）',
    indexSrc.includes('function resolveSnapshotDir')
    && (indexSrc.match(/resolveSnapshotDir\(dshHome, body\.backupDir\)/g) || []).length >= 2, 'index.js')
  check('还原不需要仓库也能排队（只动本机快照）',
    /const isRestore = action === 'restore-now'/.test(indexSrc) && /if \(!repo && !isRestore\) throw/.test(indexSrc), 'index.js')
}

// 提交说明：面板里填的那句要进 push 脚本，时间由 sync.ps1 执行时追加
const noted = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'push', message: '修 侧栏入口 "和" 特殊字符' }),
})
const notedPayload = JSON.parse(noted.body || '{}')
if (repoReady) {
  check('prepare(push) 接受提交说明', noted.statusCode === 200 && notedPayload.ok === true, noted.body.slice(0, 160))
  check('提交说明进了脚本（-Message）', existsSync(notedPayload.path || '') && readFileSync(notedPayload.path, 'utf8').includes('-Message'))
  check('提交说明里的双引号被清洗掉',
    Boolean(notedPayload.message) && !notedPayload.message.includes('"'),
    notedPayload.message || '(无)')
  if (existsSync(notedPayload.path || '')) restoreCmd(notedPayload.path)
} else if (body.repo?.remoteEmpty === true) {
  // 两边都空：这次带说明的 push 就是初始化推送，放行；说明字段照样要清洗
  check('两边都空：带说明的 push 放行（走初始化推送）',
    noted.statusCode === 200 && notedPayload.ok === true, noted.body.slice(0, 160))
  check('提交说明里的双引号被清洗掉',
    Boolean(notedPayload.message) && !notedPayload.message.includes('"'),
    notedPayload.message || '(无)')
  if (existsSync(notedPayload.path || '')) restoreCmd(notedPayload.path)
  check('提交说明清洗在源码里（去双引号）',
    /\$\{.*message.*\}/.test(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8'))
    || /replace\(\/\["\\r\\n\]/.test(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8')),
    'index.js')
} else {
  // 仓库还没内容、云端已有内容时，带说明的 push 同样该被拒；说明字段的清洗逻辑用静态断言兜住
  check('本机无内容时：带说明的 push 仍被拒（不被说明字段绕过门禁）',
    noted.statusCode === 400 && /云端仓库已经有内容|连不上云端/.test(notedPayload.error || ''),
    noted.body.slice(0, 160))
  check('提交说明清洗在源码里（去双引号）',
    /\$\{.*message.*\}/.test(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8'))
    || /replace\(\/\["\\r\\n\]/.test(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8')),
    'index.js')
}
const pullNote = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'pull', message: '不该进拉取脚本' }),
})
const pullNotePayload = JSON.parse(pullNote.body || '{}')
if (pullNote.statusCode === 400) {
  // 两边都空：拉取直接被拒（没有内容可拉），说明字段自然也进不了脚本
  check('两边都空时带说明的拉取同样被拒（说明字段绕不过门禁）',
    /没有内容可拉|连不上云端/.test(pullNotePayload.error || ''), pullNotePayload.error || '(无错误)')
} else {
  check('拉取脚本不吃提交说明',
    existsSync(pullNotePayload.path || '') && !readFileSync(pullNotePayload.path, 'utf8').includes('不该进拉取脚本'),
    pullNotePayload.path || '(无)')
  if (existsSync(pullNotePayload.path || '')) restoreCmd(pullNotePayload.path)
}

// 配置仓库根目录那 6 个执行体，是「插件还没装 / 正在升级」时的兜底副本。
// 它们一直靠人工同步，结果漂成半新半旧：sync/apply/common/post-exit 已升到 0.3.23，
// capture/restore 还停在两天前的旧版 —— 平时不显形，只有 pull 真正走进「仓库副本」
// 那条兜底路才会跑到旧逻辑。所以按字节比对，漂了就报，不再指望人记得。
console.log('')
console.log('== 配置仓库执行体副本一致性 ==')
const execNames = ['apply.ps1', 'capture.ps1', 'dsh-sync-common.ps1', 'post-exit.ps1', 'restore.ps1', 'sync.ps1']
// 两种布局都认：发布仓库（<root>\runtime）与配置仓库里的 plugin\ 镜像（<root>\runtime）
const hereSelf = dirname(fileURLToPath(import.meta.url))
const pluginRootSelf = existsSync(join(hereSelf, '..', 'package.json')) ? join(hereSelf, '..') : join(hereSelf, '..', '..')
const pluginRuntime = join(pluginRootSelf, 'runtime')
if (!existsSync(repoArg) || !existsSync(pluginRuntime) || !repoReady) {
  console.log(`  [SKIP] 没有配置仓库内容（${repoArg}，mode=${body.repo?.mode || '?'}）或没有插件 runtime，跳过逐字节比对`)
  console.log('         （初始化推送会把这几份副本一起写进仓库，届时断言自动恢复）')
} else {
  for (const name of execNames) {
    const mirror = join(repoArg, name)
    const source = join(pluginRuntime, name)
    let same = false
    let detail = ''
    // 仓库里还没有这份副本时不要判失败：副本是「初始化推送」写进去的，
    // 没推过的新仓库/只放了配置的仓库本来就没有它。真漂移（有副本但内容不同）才算失败。
    if (!existsSync(mirror)) {
      console.log(`  [SKIP] 配置仓库还没有 ${name}（初始化推送会写入）`)
      continue
    }
    if (!existsSync(source)) detail = `插件 runtime 没有 ${name}`
    else {
      same = readFileSync(mirror).equals(readFileSync(source))
      if (!same) detail = `副本 ${readFileSync(mirror).length}B / 正本 ${readFileSync(source).length}B，从 runtime/tools/ 逐字节覆盖`
    }
    check(`执行体副本与插件 runtime 逐字节一致：${name}`, same, detail)
  }
  // tools\fix-session-cwd.mjs 同样是随仓库同步的副本，改了插件忘了同步会静默跑旧逻辑
  const mirrorTool = join(repoArg, 'tools', 'fix-session-cwd.mjs')
  const sourceTool = join(pluginRuntime, 'tools', 'fix-session-cwd.mjs')
  if (!existsSync(mirrorTool)) {
    console.log('  [SKIP] 配置仓库还没有 tools/fix-session-cwd.mjs（初始化推送会写入）')
  } else {
    const toolSame = existsSync(sourceTool) && readFileSync(mirrorTool).equals(readFileSync(sourceTool))
    check('执行体副本与插件 runtime 逐字节一致：tools/fix-session-cwd.mjs', toolSame,
      existsSync(sourceTool) ? '内容已漂移，从 runtime/tools/ 逐字节覆盖' : '插件 runtime 没有 tools/fix-session-cwd.mjs')
  }
  for (const tname of ['session-log-guard.mjs', 'session-log-lib.mjs', 'bili-state.mjs']) {
    const m = join(repoArg, 'tools', tname)
    const s = join(pluginRuntime, 'tools', tname)
    if (!existsSync(m)) {
      console.log(`  [SKIP] 配置仓库还没有 tools/${tname}（初始化推送会写入）`)
      continue
    }
    const ok = existsSync(s) && readFileSync(m).equals(readFileSync(s))
    check(`执行体副本与插件 runtime 逐字节一致：tools/${tname}`, ok,
      existsSync(s) ? '内容已漂移，从 runtime/tools/ 逐字节覆盖' : `插件 runtime 没有 tools/${tname}`)
  }
}

// 内置运行时链接修复（0.3.24）：客户端升级会清空 resources\runtime，
// 装卸插件的 pnpm 调用随即报 MODULE_NOT_FOUND（真正运行时在 ~\.dsh\dsh-runtimes 下）。
// apply 每次落地幂等补回 junction，这 4 条断言盯住「函数在、被调用、不覆盖、探针对」。
console.log('')
console.log('== 内置运行时链接修复 ==')
{
  const commonPath = join(pluginRuntime, 'dsh-sync-common.ps1')
  const applyPath = join(pluginRuntime, 'apply.ps1')
  const commonText = existsSync(commonPath) ? readFileSync(commonPath, 'utf8') : ''
  const applyText = existsSync(applyPath) ? readFileSync(applyPath, 'utf8') : ''
  check('common 提供 Repair-PrimaryRuntimeLink 函数',
    /function\s+Repair-PrimaryRuntimeLink\s*\(/.test(commonText),
    '插件 runtime 的 dsh-sync-common.ps1 里没有该函数')
  check('apply.ps1 落地时调用该函数（不靠人手补链接）',
    /Repair-PrimaryRuntimeLink\s+\$AppRoot\s+\$DshHome/.test(applyText),
    'apply.ps1 里找不到调用点，升级后链接不会自动补回')
  check('已有真实运行时目录时绝不覆盖（只告警不重建）',
    /LinkType/.test(commonText) && /客户端自带运行时目录存在/.test(commonText) && /本次不动/.test(commonText),
    '缺少 LinkType 判据：可能把客户端自带的真实目录当成链接处理')
  check('探针落在 pnpm.mjs 本身，不是只看目录存在',
    /dependencies\\pnpm\\bin\\pnpm\.mjs/.test(commonText),
    '探针路径不是 pnpm.mjs，运行时缺文件时会被误判为已就绪')
}

// 空白本机仓库 → 只允许拉取（0.3.26）：新机器把路径指到一个空目录不是错误，
// 而是「等着从云端拉」的正常状态。断言盯四件事：状态判定、不报异常、push 全线拦住、pull 放行。
console.log('')
console.log('== 空白本机仓库：只允许拉取 ==')
{
  const indexNew = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const clientNew = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  const syncNew = existsSync(join(pluginRuntime, 'sync.ps1')) ? readFileSync(join(pluginRuntime, 'sync.ps1'), 'utf8') : ''
  check('index.js 提供 repoPhase 四态判定（ok/empty/missing/unusable）',
    /function repoPhase\(dir\)/.test(indexNew) && /return others\.length === 0 \? 'empty' : 'unusable'/.test(indexNew),
    'repoPhase 缺失或 empty 判据变了：空目录会被当成「不像仓库」继续报异常')
  check('只有插件自己生成的 同步-*.cmd 与隐藏项算「空」',
    /同步-\[\\s\\S\]\*\\?\.cmd/i.test(indexNew) || /同步-\[/i.test(indexNew),
    'empty 判据没有排除 同步-*.cmd：生成过脚本之后就会被误判成 unusable')
  check('status 暴露 phase / remoteFiles / pushAllowed / pullAllowed',
    /phase,\s*\n\s*empty: phase === 'empty'/.test(indexNew)
    && /remoteFiles,/.test(indexNew) && /remoteEmpty: remoteFiles === 0/.test(indexNew)
    && /pushAllowed: phase === 'ok' \|\| \(phase === 'empty' && remoteFiles === 0\)/.test(indexNew)
    && /pullAllowed: phase === 'ok' \|\| \(\(phase === 'empty' \|\| phase === 'missing'\) && remoteFiles !== 0\)/.test(indexNew),
    'status 没有暴露新门禁字段（remoteFiles / pushAllowed / pullAllowed），面板只能靠分支数猜')
  check('仓库三态 mode（ok / await-pull / await-init）按文件数算',
    /mode: phase === 'ok'[\s\S]{0,120}?remoteFiles === 0 \? 'await-init' : 'await-pull'/.test(indexNew),
    'mode 还在看分支数：远端只剩空分支时会被判成 await-pull，拉取只能拉到空目录、死循环')
  check('远端探测先数分支、再数分支树里的文件（有超时，不写本地 refs）',
    /function probeRemote\(/.test(indexNew)
    && /function remoteFileCount\(/.test(indexNew)
    && /ls-remote --heads/.test(indexNew)
    && /'ls-tree', '-r', '--name-only', 'FETCH_HEAD'/.test(indexNew)
    && /timeout: 15000/.test(indexNew),
    'probeRemote / remoteFileCount 缺失：判据退回分支数，「有分支但空树」又会被当成有内容')
  check('空目录的 advice 分「初始化推送」与「执行拉取」两支',
    /本机仓库\$\{where\}，云端仓库也还没有任何内容/.test(indexNew) || /云端仓库也还没有任何内容/.test(indexNew),
    'advice 没区分「两边都空」与「本机空但云端有内容」')
  check('advice 单独说明「云端只剩空分支（历史被删空）」',
    /云端仓库只有分支、里面一个文件都没有/.test(indexNew),
    '远端只剩空分支时没有专门说法：用户会以为「云端有内容」而反复点拉取')
  check('check 在非 ok 状态短路，不去撞空目录的 git',
    /if \(phase !== 'ok'\) \{[\s\S]{0,220}?autoState\.checking = false/.test(indexNew),
    'check 仍会对空目录跑 fetch/drift：lastCheckError 会被填成「读不到远端」')
  check('push-now 在空目录先探云端：有文件拒绝，判不了或没文件放行',
    /mode === 'push' && repoPhase\(repo\) !== 'ok'/.test(indexNew)
    && /probe\.files === null/.test(indexNew)
    && /云端仓库已经有内容（\$\{probe\.files\} 个文件）/.test(indexNew),
    'handleAuto 的 push-now 没按「云端文件数」分流（分支数会把空分支当有内容）')
  check('prepare 按云端文件数组合脚本（两边都空只生成推送 + 还原）',
    /action === 'push' && phase !== 'ok'/.test(indexNew)
    && /cloudEmptyForPrepare \? \['push', 'restore'\] : \['pull', 'restore'\]/.test(indexNew)
    && /initPush: phase !== 'ok' && cloudEmptyForPrepare/.test(indexNew),
    'prepare 仍会为空目录生成拉取脚本，或没有 initPush 标记')
  check('sync.ps1 的 push 分支按「云端文件数」分流，并能覆盖空分支',
    /function Get-RemoteFileCount/.test(syncNew)
    && /function Initialize-EmptyRepo/.test(syncNew)
    && /云端仓库已经有内容（\$remoteFiles 个文件）/.test(syncNew)
    && /--force-with-lease/.test(syncNew)
    && /Initialize-EmptyRepo \$remoteUrlForPush/.test(syncNew),
    'sync.ps1 push 仍按分支数拒绝，或空分支覆盖时没有 --force-with-lease（会被 non-fast-forward 拒）')
  check('初始化推送会写仓库骨架与版本契约',
    /apply\.ps1', 'capture\.ps1', 'sync\.ps1', 'restore\.ps1', 'post-exit\.ps1', 'dsh-sync-common\.ps1'/.test(syncNew)
    && /host-contract\.json/.test(syncNew),
    '初始化推送只推 settings，远端会变成「没有执行体」的半截仓库')
  check('面板：空目录不算「必须设置」，徽标不标红',
    /const missing = Boolean\(props\.data\) && !repo\.exists && !repo\.empty/.test(clientNew)
    && /if \(repo\.empty \|\| repo\.phase === 'missing'\) \{/.test(clientNew)
    && /const canPush = Boolean\(data && data\.repo && data\.repo\.pushAllowed === true\)/.test(clientNew),
    'panel 仍把空目录当成未配置（强制编辑态 + 红色错误）')
  check('面板：推送/拉取按钮都吃后端门禁，「初始化推送」单独有说法',
    /const pushAllowed = repo\.pushAllowed === true/.test(clientNew)
    && /const canPullNow = repo\.pullAllowed === true/.test(clientNew)
    && /const initMode = repo\.mode === 'await-init'/.test(clientNew)
    && /初始化推送（会关闭 DSH）/.test(clientNew)
    && /const canPull = Boolean\(data && data\.repo && data\.repo\.pullAllowed === true\)/.test(clientNew),
    '面板的按钮门禁没跟后端对齐，或没有「初始化推送」文案')
  check('面板：待初始化徽标有独立文字与配色',
    /if \(kind === 'init'\) return M\('待初始化', 'To initialize'\)/.test(clientNew)
    && /init: 'var\(--dsw-alias-state-warn-tertiary\)'/.test(clientNew),
    'kind=init 没有 chipLabel / chipStyle，徽标会掉进「未检测」')
}

// 0.3.36：判据从「云端有几个分支」换成「分支树里有几个文件」，外加推送/拉取两条体检报告。
// 这一段不依赖配置仓库内容，仓库是空目录也照跑。
console.log('')
console.log('== 0.3.36：空分支判据 / 根外路径清单 / 覆盖体检 ==')
{
  const idx = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const cli = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  const syn = existsSync(join(pluginRuntime, 'sync.ps1')) ? readFileSync(join(pluginRuntime, 'sync.ps1'), 'utf8') : ''
  const cap = existsSync(join(pluginRuntime, 'capture.ps1')) ? readFileSync(join(pluginRuntime, 'capture.ps1'), 'utf8') : ''
  const app = existsSync(join(pluginRuntime, 'apply.ps1')) ? readFileSync(join(pluginRuntime, 'apply.ps1'), 'utf8') : ''
  check('remoteFileCount 用临时 bare 仓库浅取、只要树对象、探完就删',
    /function remoteFileCount\(/.test(idx)
    && /mkdtempSync|init --bare --quiet/.test(idx)
    && /'--filter=blob:none'/.test(idx)
    && /'ls-tree', '-r', '--name-only', 'FETCH_HEAD'/.test(idx)
    && /rmSync/.test(idx),
    'remoteFileCount 没有走临时目录 / 浅取 / 清理，判定会拖慢面板或留下垃圾目录')
  check('sync.ps1 有 Get-RemoteFileCount，且「有分支但 0 文件」时用 --force-with-lease',
    /function Get-RemoteFileCount/.test(syn)
    && /\$remoteHadEmptyBranch/.test(syn)
    && /--force-with-lease/.test(syn)
    && /不丢数据/.test(syn),
    '空分支覆盖没有 force-with-lease（会被 non-fast-forward 拒），或没有「不丢数据」的说明')
  check('capture.ps1 推送后写根外绝对路径清单',
    /function Write-OutsideRootReport/.test(cap)
    && /config-sync-absolute-paths\.json/.test(cap)
    && /Write-OutsideRootReport/.test(cap.split('function Write-OutsideRootReport')[1] || ''),
    'capture 没有根外路径体检：换机器拉取才发现路径是死的')
  check('apply.ps1 覆盖本机配置前比对并写覆盖清单',
    /\$overwriteItems/.test(app)
    && /config-sync-overwrite\.json/.test(app)
    && /本机改动已先备份/.test(app)
    && /先「推送」再「拉取」/.test(app),
    'apply 整份覆盖前不比对：本机未推送的改动会被静默盖掉')
  check('roots 接口带回 absolutePaths 与 overwrite 两份报告',
    /absolutePathsPathOf/.test(idx) && /overwritePathOf/.test(idx)
    && /absolutePaths: \(/.test(idx) && /overwrite: \{/.test(idx),
    'GET /config-sync/roots 没带体检报告，面板无从提示')
  check('面板在本机路径卡下渲染两条告警，并给「用探测值」回填',
    /data\.absolutePaths && data\.absolutePaths\.total/.test(cli)
    && /data\.overwrite && data\.overwrite\.total/.test(cli)
    && /用探测值/.test(cli)
    && /改动只影响之后的推送\/拉取/.test(cli),
    '面板没有渲染根外路径 / 覆盖告警，或没有「用探测值」回填按钮')
}

// 任意 git 托管平台（0.3.27）：远端地址只校验写法，认证自检提示按 origin 的真实主机名现算，
// 不再写死 git@gitee.com —— 否则用 GitHub/GitLab 的人照着提示敲会连到错的主机。
console.log('')
console.log('== 任意 git 托管平台：提示不写死 gitee ==')
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const commonNew = readFileSync(join(root, 'runtime', 'dsh-sync-common.ps1'), 'utf8')
  const syncNew = readFileSync(join(root, 'runtime', 'sync.ps1'), 'utf8')
  const clientNew = readFileSync(join(root, 'client.js'), 'utf8')
  check('common 提供 Get-RemoteHost（认 git@host / ssh:// / https://）',
    commonNew.includes('function Get-RemoteHost') && commonNew.includes('^ssh://(?:[^@/]+@)?([^/:]+)'),
    'common 里没有主机名解析')
  check('common 提供 Get-RemoteAuthHint（https 给 ls-remote，ssh 给 ssh -T）',
    commonNew.includes('function Get-RemoteAuthHint') && commonNew.includes('ls-remote --heads origin') && commonNew.includes('ssh -T git@'),
    'https 与 ssh 两种认证没有分开提示')
  check('sync.ps1 的自检提示不再写死 git@gitee.com',
    !syncNew.includes('ssh -T git@gitee.com') && (syncNew.match(/Get-RemoteAuthHint/g) || []).length >= 3,
    '仍有 gitee 硬编码或提示没接上')
  check('面板占位与说明不再只暗示 Gitee',
    clientNew.includes('git@<host>:you/dsh-config.git')
      && clientNew.includes('git@github.com:you/dsh-config.git')
      && clientNew.includes('自建 Gitea'),
    '面板还只提 Gitee')
}

// 默认工作区校正（0.3.28）：重启客户端之前把 workspace.json 的 defaultWorkspaceId 校正到
// default-workspace，否则重启后新开的那条会话会落在「上次用的工作区」上。
// 断言只盯结构与时机，不真写用户的 workspace.json。
console.log('')
console.log('== 默认工作区校正 ==')
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const post = readFileSync(join(root, 'runtime', 'post-exit.ps1'), 'utf8')
  const host = readFileSync(join(root, 'index.js'), 'utf8')
  check('post-exit 提供 Set-DefaultWorkspace',
    post.includes('function Set-DefaultWorkspace'),
    '没有默认工作区校正函数')
  const callMatch = post.match(/^ {4}Set-DefaultWorkspace\r?\n/m)
  check('校正发生在重启之前（RestartClient 里、启动之前调用）',
    Boolean(callMatch) && callMatch.index < post.indexOf('$how = Start-Detached $exe'),
    '调用点不在 Start-Detached 之前')
  check('默认目标认 default-workspace（标题或路径）且可被设置覆盖或关闭',
    post.includes("$title -eq 'default-workspace'")
      && post.includes('deepseek-harness\\default-workspace')
      && post.includes("defaultWorkspace")
      && post.includes('off|none'),
    '目标匹配或 off 开关缺失')
  check('写前备份、写后回读校验（值 + 工作区条数）',
    post.includes(".bak-' + $stamp") && post.includes('countAfter -ne $countBefore'),
    '缺少备份或回读校验')
  check('设置字段 defaultWorkspace 进 read/write 与保存白名单',
    host.includes('defaultWorkspace: typeof raw.defaultWorkspace')
      && host.includes('defaultWorkspace: s.defaultWorkspace ||')
      && host.includes("has('defaultWorkspace')"),
    'index.js 没带该字段')
}

// 跨机路径占位符（0.3.30）：仓库里不写死盘符，落地时按本机根展开；展开不掉的记 pending 让用户确认。
// 只做只读断言（不写真实的 roots.json / 不提交仓库），写入路径留给手工验证。
console.log('')
console.log('== 跨机路径占位符与问题反馈 ==')
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const common = readFileSync(join(root, 'runtime', 'dsh-sync-common.ps1'), 'utf8')
  const captureSrc = readFileSync(join(root, 'runtime', 'capture.ps1'), 'utf8')
  const applySrc = readFileSync(join(root, 'runtime', 'apply.ps1'), 'utf8')
  const host = readFileSync(join(root, 'index.js'), 'utf8')
  const cli = readFileSync(join(root, 'client.js'), 'utf8')

  check('common 提供路径根读写与占位符双向转换',
    common.includes('function Get-SyncRoots') && common.includes('function Save-SyncRoots')
      && common.includes('function ConvertTo-TokenText') && common.includes('function Expand-TokenText')
      && common.includes('function Get-MissingTokens'),
    '缺占位符函数')
  check('common 覆盖四种路径写法（原样 / 双反斜杠 / 正斜杠 / 转义斜杠）',
    common.includes('function Get-PathVariants') && common.includes("$p.Replace($bs, '/')"),
    '变体列表不全')
  check('占位符按根长度降序替换（workspaceHome 在 appRoot 之下不会替换错位）',
    common.includes('Sort-Object { $_.Value.Length } -Descending'),
    '没有按长度排序')
  check('capture 写仓库前把本机根换成占位符',
    captureSrc.includes('ConvertTo-TokenText $txt $roots') && captureSrc.includes('Get-SyncRoots $DshHome $AppRoot $WorkspaceHome'),
    'capture 没做归一')
  check('capture 首次自动落一份 config-sync-roots.json',
    captureSrc.includes('Save-SyncRoots $DshHome $roots'),
    '没写 roots 文件')
  // 0.6.18 起清单只有一份：dsh-sync-common.ps1 的 Get-SyncSettingsMap。
  // 旧的「capture 里数 Repo = 'settings\ 字面量」检查会永远数到 0，属于检查自己过期。
  const settingsCount = (common.match(/Repo = 'settings\\/g) || []).length
  check('settings 清单单源在 common（capture/apply 都用 Get-SyncSettingsMap）',
    captureSrc.includes('Get-SyncSettingsMap') && applySrc.includes('Get-SyncSettingsMap'),
    '有一侧还在自己拼清单')
  check('settings 覆盖到各插件自己的配置（不止 4 个）', settingsCount >= 11, `实际 ${settingsCount} 项`)
  check('apply 用的就是同一份清单（不各写一份）',
    applySrc.includes('Get-SyncSettingsMap $DshHome $ProfileName'),
    'apply 传参不一致')
  check('apply 展开占位符，缺值的跳过不写并记 pending',
    applySrc.includes('Expand-TokenText $txt $roots') && applySrc.includes('Write-PendingPaths $DshHome $pendingItems')
      && applySrc.includes('continue'),
    'apply 没按缺失跳过')
  check('workspace.json（DSH 工作区登记）进了同步范围',
    captureSrc.includes("storages\\workspace.json") && applySrc.includes("storages\\workspace.json"),
    '工作区登记表没同步')
  check('workspace-archives.v1.json（工作区隐藏/归档状态）进了同步范围',
    common.includes('settings\\workspace-archives.json') && common.includes('dsh-session-manager\\workspace-archives.v1.json'),
    '工作区隐藏状态没纳入 settingsMap（A 机隐藏的工作区会带到 B 机显示）')
  check('面板有「本机路径」卡：只读展示 + 「修改」进编辑 + 保存',
    cli.includes("M('本机路径', 'Local paths')") && cli.includes("M('修改', 'Edit')")
      && cli.includes('callRoots') && cli.includes('setCustom') && cli.includes('addCustom'),
    'client.js 缺本机路径卡的修改态')
  check('本机路径卡默认只读（值用等宽字展示，token 作灰字说明）',
    cli.includes('const isEditing = editing || forced') && cli.includes('{{ROOT:${k}}}'),
    '只读态/自选目录没渲染')
  check('面板会列出待确认项（token + 文件 + 说明）',
    cli.includes('data.missing') && cli.includes('m.token'),
    '待确认清单没渲染')
  check('面板有「问题反馈」卡：提交 + 列表 + 连接状态 + 令牌入口',
    cli.includes("M('问题反馈', 'Feedback')") && cli.includes('callFeedback')
      && cli.includes('st.connected') && cli.includes("query: { action: 'token' }")
      && cli.includes("query: { action: 'flush' }"),
    'client.js 缺反馈卡')
  check('反馈走 GitHub Issue：建 issue + 列表 + 关单 + 离线队列',
    host.includes('GH_FEEDBACK_LABEL') && host.includes('/repos/${repo}/issues')
      && host.includes('labels: [GH_FEEDBACK_LABEL]')
      && host.includes('config-sync-feedback-outbox.json') && host.includes("action === 'flush'")
      && host.includes("method: 'PATCH'"),
    'index.js 没走 Issue')
  check('令牌自动从本机 git 凭据取，落到本机私有文件',
    host.includes('tokenFromGitCredential') && host.includes('config-sync-gh.json')
      && host.includes('credential') && host.includes('fill'),
    '缺自动取令牌')
  check('反馈正文自动附环境块（版本/机器/时间）',
    host.includes('### 环境 / Environment') && host.includes('issueBodyOf'),
    '没附环境信息')
  check('读不需要令牌：带令牌失败自动退回匿名',
    host.includes("const attempts = g.token ? [g.token, ''] : ['']") && host.includes('readAnon'),
    '没有匿名降级')
  check('关单只有仓库所有者能点（服务端挡别人的令牌）',
    host.includes('ownerOf') && host.includes('onlyCloseByOwner'.replace('onlyCloseByOwner', 'canClose'))
      && host.includes("login.toLowerCase() !== owner.toLowerCase()"),
    '服务端没校验所有者')
  check('无令牌时提交不失败，给浏览器预填链接',
    host.includes('newIssueUrl') && host.includes('issues/new?') && host.includes('needToken'),
    '没有无令牌降级')
  check('面板按权限置灰关单按钮',
    cli.includes('!st.canClose') && cli.includes("M('仅所有者', 'Owner only')") && cli.includes('fallbackUrl'),
    '面板没做权限态')
  check('反馈列表可按状态筛选 + 关键词搜索',
    cli.includes("seg('open'") && cli.includes("seg('closed'") && cli.includes("seg('all'")
      && cli.includes('setKw') && cli.includes('st.counts'),
    '没有筛选/查询')

  const rootsGet = await call('/config-sync/roots', { headers: { host: 'localhost:3080' } })
  const rootsBody = JSON.parse(rootsGet.body || '{}')
  check('GET /config-sync/roots 返回本机根 + 探测值 + 待确认清单',
    rootsBody.ok === true && rootsBody.roots && typeof rootsBody.roots.appRoot === 'string'
      && rootsBody.detected && Array.isArray(rootsBody.missing),
    '结构不全')
  check('roots 的待确认项带人话说明（不是只给 token）',
    rootsBody.missing.every((m) => typeof m.token === 'string' && typeof m.hint === 'string'),
    '缺 hint')

  const fbGet = await call('/config-sync/feedback', { headers: { host: 'localhost:3080' } })
  const fbBody = JSON.parse(fbGet.body || '{}')
  check('GET /config-sync/feedback 返回连接状态 + Issue 列表 + 待发队列',
    fbBody.ok === true && Array.isArray(fbBody.items) && typeof fbBody.connected === 'boolean'
      && typeof fbBody.repo === 'string' && Array.isArray(fbBody.outbox) && typeof fbBody.ghFile === 'string'
      && typeof fbBody.canClose === 'boolean' && typeof fbBody.owner === 'string',
    JSON.stringify(fbBody).slice(0, 400))
  check('GET /config-sync/feedback 同时给出 open/closed/total 计数',
    fbBody.counts && typeof fbBody.counts.open === 'number' && typeof fbBody.counts.closed === 'number'
      && typeof fbBody.counts.total === 'number',
    JSON.stringify(fbBody.counts))
  check('跨站请求被拒（roots）', await (async () => {
    const r = await call('/config-sync/roots', {
      method: 'POST',
      headers: { host: 'localhost:3080', origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: '{}',
    })
    return r.statusCode === 403
  })(), '没拦住')
}

// 0.3.37：本机路径区默认不进页面，入口只有一个标题行按钮
console.log('')
console.log('== 0.3.37：本机路径区默认不进页面 ==')
{
  const index37 = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const client37 = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  check('status 给出三个计数 + 告警数（面板据此决定按钮要不要变橙）',
    /localPaths: \(\(\) => \{/.test(index37)
    && /const total = pending \+ absolute \+ overwrite/.test(index37)
    && /alert: total, total/.test(index37),
    'status 没给 localPaths 计数/告警数：面板只能把整张卡摊在页面上当提示')
  check('本机路径区只由标题行按钮控制（组件不再自己 return null）',
    /const rootsCard = showRoots \? h\(RootsCard, \{ onRootsSaved: refresh \}\) : null/.test(client37)
    && !/props\.forceShow/.test(client37),
    '显示条件不在父层：组件 return null 时 Section 仍会渲染空标题')
  const st37 = JSON.parse((await call('/config-sync/status', { headers: { host: 'localhost:3080' } })).body || '{}')
  check('status 运行时真的带 localPaths 计数与告警数（面板按钮靠它变橙）',
    Boolean(st37.localPaths) && typeof st37.localPaths.total === 'number'
    && typeof st37.localPaths.pending === 'number' && typeof st37.localPaths.alert === 'number',
    JSON.stringify(st37.localPaths))
}

console.log('')
console.log('== 0.3.41：status 提速（不再递归统计备份） ==')
{
  const index41 = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const client41 = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  check('备份列表不再递归数文件/体积（92 份快照 4.8 万文件曾要 7.7 秒）',
    /files: null, bytes: null, hasProfile, plugins, bundles/.test(index41)
    && !/bytes \+= statSync\(p\)\.size/.test(index41),
    'inspectBackup 仍在逐个 statSync 统计每个快照')
  check('远端探测带预算 + 启动预热（status 不再等满一次 ls-remote）',
    /function probeRemoteQuick\(url, settings, budgetMs\)/.test(index41)
    && /function warmRemoteProbe\(config\)/.test(index41)
    && /await probeRemoteQuick\(remoteProbeUrl, settings, 2500\)/.test(index41),
    '缺 probeRemoteQuick / warmRemoteProbe / 调用处')
  check('远端探测缓存拉长到 5 分钟', /REMOTE_PROBE_TTL = 300000/.test(index41))
  check('前端 status 请求有超时与 3 次重试', /new AbortController\(\)/.test(client41)
    && /已自动重试 3 次/.test(client41))
  const t41 = Date.now()
  const st41 = JSON.parse((await call('/config-sync/status', { headers: { host: 'localhost:3080' } })).body || '{}')
  const ms41 = Date.now() - t41
  check('status 实测在 3 秒内答完（当天首次含一次远端探测预算）',
    st41.ok === true && ms41 < 3000, `${ms41}ms`)
  check('备份快照列表仍可用：给名字/时间/插件数，体积字段为空',
    Boolean(st41.backup) && (st41.backup.count === 0 || (Array.isArray(st41.backup.snapshots)
      && st41.backup.snapshots.every((s) => s.files === null && s.bytes === null))),
    JSON.stringify(st41.backup && { count: st41.backup.count, first: st41.backup.snapshots && st41.backup.snapshots[0] }))
}

console.log('')
console.log('== 0.3.43：根外路径清单只在「配置来自别的机器」时提示 ==')
{
  const src43 = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const client43 = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  const cap43 = existsSync(join(pluginRootSelf, 'runtime', 'capture.ps1')) ? readFileSync(join(pluginRootSelf, 'runtime', 'capture.ps1'), 'utf8') : ''
  check('报告归属判定：记录机器名 + 只在别的机器写的清单才算告警',
    src43.includes('function localMachineName') && src43.includes('function sameMachine')
    && src43.includes('absFromOtherMachine') && src43.includes('const absolute = absFromOther'), 'index.js 的 localPaths 计数')
  check('推荐地址：先按对方根映射，再按同名目录兜底，都没有就说没有',
    src43.includes('function suggestLocalPathFor') && src43.includes("kind: 'root'")
    && src43.includes("kind: 'namesake'") && src43.includes("kind: 'none'")
    && src43.includes('function candidateParentDirs'), 'index.js 的推荐算法')
  check('清单只扫配置类文件（会话/工作区/记忆不参与）',
    Boolean(cap43) && cap43.includes('$confTop')
    && cap43.includes("'local-plugins'") && cap43.includes("$rel0 -notmatch 'node_modules'"),
    'capture.ps1 的扫描范围')
  check('报告带 machine 与当时的根值，供本机映射用',
    Boolean(cap43) && cap43.includes('machine = $machine') && cap43.includes('roots = [ordered]@'),
    'capture.ps1 的报告结构')
  check('协议头误匹配被过滤（s://1v3... 不再当成盘符）',
    Boolean(cap43) && cap43.includes("if ($p -match '://') { continue }"), 'capture.ps1')
  const client43x = client43
  check('面板：只在 fromOtherMachine 时渲染跨机清单，并给「采纳」按钮',
    client43x.includes('data.absolutePaths.fromOtherMachine') && client43x.includes('adoptAbsolute')
    && client43x.includes('adoptAbsolute(it)'), 'client.js')
  check('面板不再用旧文案「仓库里有 N 处绝对路径不在任何已确认根下」',
    !client43.includes('仓库里有 ${data.absolutePaths.total} 处绝对路径'), 'client.js')
}

console.log('')
console.log('== 0.3.44：工作区与会话的路径也按本机落点推断 ==')
{
  const cap44 = readFileSync(join(pluginRootSelf, 'runtime', 'capture.ps1'), 'utf8')
  const app44 = readFileSync(join(pluginRootSelf, 'runtime', 'apply.ps1'), 'utf8')
  const hel44 = readFileSync(join(pluginRootSelf, 'runtime', 'tools', 'fix-session-cwd.mjs'), 'utf8')
  const cli44 = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  const idx44 = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  check('报告分两类：配置类 + 工作区/会话记录，各自限额',
    cap44.includes('$dataTop') && cap44.includes("'workspace', 'conversations'")
    && cap44.includes('totalData = $nData') && cap44.includes('$scope = if ($dataTop')
    && cap44.includes('$nData -ge 30') && cap44.includes('$nConf -ge 50'), 'capture.ps1 的扫描范围')
  check('清单项带 scope，面板才能分两组列',
    idx44.includes("scope: String(it.scope || 'config')"), 'index.js 的 items 结构')
  check('apply 用登记表的 sessionIds 反查本机工作区路径，并交给 helper 改写 projcache',
    app44.includes('$projMap') && app44.includes('foreach ($sid in @($w.sessionIds))')
    && app44.includes('projcache = $projMap') && app44.includes('$cwdMap.Count -gt 0 -or $projMap.Count -gt 0'),
    'apply.ps1 没把 projcache 的 cwd 对齐')
  check('helper 只替换 identity.cwd 那一个字符串，且幂等',
    hel44.includes('spec.projcache') && hel44.includes('result.projFixed')
    && hel44.includes('record.identity.cwd !== target')
    && hel44.includes('if (cur === target) { result.projAlreadyOk++'),
    'fix-session-cwd.mjs 的 projcache 处理')
  check('面板把配置与「工作区与会话记录」分两组显示',
    cli44.includes("it.scope === 'data'") && cli44.includes('工作区与会话记录里的路径'),
    'client.js 没分组')
}

console.log('')
console.log('== 0.3.54：三处纯性能改动（行为不变） ==')
{
  const cap54 = readFileSync(join(pluginRootSelf, 'runtime', 'capture.ps1'), 'utf8')
  const sync54 = readFileSync(join(pluginRootSelf, 'runtime', 'sync.ps1'), 'utf8')
  check('capture 有 -DeepVerify，且深校验开关走 $script:CmpDeep',
    /\[switch\]\$DeepVerify/.test(cap54) && cap54.includes('$script:CmpDeep')
    && cap54.includes('function Test-TreeFileChanged'), 'capture.ps1 的深校验开关')
  check('快筛只比 Length / LastWriteTimeUtc，不一致才 Get-NormalizedHash',
    cap54.includes('$srcInfo.Length') && cap54.includes('$srcInfo.LastWriteTimeUtc')
    && cap54.includes('Get-NormalizedHash'), 'capture.ps1 的比较逻辑')
  check('批量 FileInfo + 字典比对，不再逐文件 Test-Path 父目录',
    cap54.includes('function Get-TreeCmpSummary') && cap54.includes('$dstRels')
    && cap54.includes('$madeDirs'), 'capture.ps1 的批量比对')
  check('sync 把 DeepVerify 透传给 capture', sync54.includes("$captureArgs['DeepVerify'] = $true"))
  check('历史扫描按提交缓存：commit 相同或是 HEAD 祖先就跳过',
    sync54.includes('sync-history-scan.json') && sync54.includes('$needHistoryScan')
    && sync54.includes('merge-base --is-ancestor'), 'sync.ps1 的历史扫描缓存')
  check('有 -ScanHistory 强制全量，推送被拒时也补一次全量',
    /\[switch\]\$ScanHistory/.test(sync54) && sync54.includes('$historyFullyScanned'),
    'sync.ps1 的扫描强制/补扫')
  check('拉取改成 fetch + merge --ff-only（不再 git pull 的第二次往返）',
    sync54.includes("merge --ff-only origin/' + $branch") && sync54.includes('$fetchedThisRun')
    && !sync54.includes('" pull --ff-only'), 'sync.ps1 的拉取命令')
  check('空扫描结果不写成 `,$res`（否则空仓库误报 1 个超限文件 0.0 MB）',
    sync54.includes('function Get-OversizedHistory') && !/^\s*return ,\$res\b/m.test(sync54),
    'Get-OversizedHistory 的返回值')
}

console.log('== 0.3.68：会话投影缓存守卫（agent-busy 自动清缓存） ==')
{
  const guardSrc = readFileSync(join(pluginRootSelf, 'runtime', 'tools', 'session-cache-guard.mjs'), 'utf8')
  const indexSrc = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const clientSrc = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')

  check('守卫库导出 runGuard / clearSessionCaches / appendGuardLog / scanSessionCaches',
    /export function runGuard/.test(guardSrc) && /export function clearSessionCaches/.test(guardSrc)
    && /export function appendGuardLog/.test(guardSrc) && /export function scanSessionCaches/.test(guardSrc))
  check('判定同时要求：缓存标空 + 日志里有对话 + 日志比缓存新',
    guardSrc.includes('if (rec.blank !== true) continue')
    && guardSrc.includes('const progressed = head.hasTurn || head.hasUser')
    && guardSrc.includes('head.tailSeq <= rec.maxSeq'), '守卫的三重判据')
  check('清理只挪走不改内容：写备份目录、全程不 unlink',
    guardSrc.includes("'session-cache-guard-backup'") && guardSrc.includes('renameSync')
    && !guardSrc.includes('unlinkSync'), '只 rename 到备份目录')
  check('宿主导入守卫库并注册 /config-sync/cache-guard',
    indexSrc.includes("from './runtime/tools/session-cache-guard.mjs'")
    && indexSrc.includes("const ROUTE_CACHE_GUARD = '/config-sync/cache-guard'")
    && indexSrc.includes('handleCacheGuard'), 'index.js 的接线')
  check('设置里有 cacheGuard 开关（默认开：raw.cacheGuard !== false）',
    indexSrc.includes('cacheGuard: raw.cacheGuard !== false')
    && indexSrc.includes('cacheGuard: s.cacheGuard !== false'), 'readSettings / writeSettings')
  check('启动后挂定时扫描，且受开关控制',
    indexSrc.includes('function scheduleCacheGuard(config)')
    && indexSrc.includes('scheduleCacheGuard(config)')
    && indexSrc.includes("readSettings(dshHomeOf(config)).cacheGuard === false"), 'scheduleCacheGuard')
  check('status 里带 cacheGuard 状态快照',
    indexSrc.includes('cacheGuard: cacheGuardSnapshot(config)'), 'inspect() 的返回体')
  check('四种 action：scan / sweep / clear / busy',
    indexSrc.includes("action === 'scan'") && indexSrc.includes("action === 'sweep'")
    && indexSrc.includes("action === 'clear'") && indexSrc.includes("action === 'busy'"), 'handleCacheGuard 的分支')
  check('客户端包了 sessions.create，撞 agent-busy 才介入',
    clientSrc.includes('function guardSessionCreate(sessions)')
    && clientSrc.includes('sessions.create = async function patchedCreate')
    && clientSrc.includes("const BUSY_RE = /session\\/agent-busy"), 'client.js 的守卫')
  check('重试前去掉旧 sessionId（否则会再撞同一堵墙）',
    clientSrc.includes('delete retry.sessionId'), 'patchedCreate 的重试参数')
  check('客户端把 sessionId 上报给宿主',
    clientSrc.includes("action: 'busy', sessionId: sessionId || ''"), 'reportAgentBusy')

  const gGet = await call('/config-sync/cache-guard', { headers: { host: 'localhost:3080' } })
  const gBody = JSON.parse(gGet.body || '{}')
  check('GET /config-sync/cache-guard 返回 200 且只读',
    gGet.statusCode === 200 && gBody.ok === true && typeof gBody.scanned === 'number'
    && Array.isArray(gBody.stale) && typeof gBody.staleCount === 'number', gGet.body.slice(0, 200))
  check('GET 不动手：applied=false 且 removed 为空',
    gBody.applied === false && Array.isArray(gBody.removed) && gBody.removed.length === 0, gGet.body.slice(0, 200))
  const gCross = await call('/config-sync/cache-guard', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ action: 'sweep' }),
  })
  check('跨站 POST 被 403 挡住', gCross.statusCode === 403, String(gCross.statusCode))
  const gClear = await call('/config-sync/cache-guard', {
    method: 'POST',
    headers: { host: 'localhost:3080' },
    body: JSON.stringify({ action: 'clear', ids: [] }),
  })
  const gClearBody = JSON.parse(gClear.body || '{}')
  check('clear 不给 ids 时 400 且 ok=false',
    gClear.statusCode === 400 && gClearBody.ok === false, gClear.body.slice(0, 160))
}

console.log('')
console.log('== billion-context 压缩状态跨机搬运 ==')
{
  // DSH 原生 compaction 被 bili 接管后，真正的压缩记录在 bili 自己的 SQLite 里；
  // 只带会话日志会让另一台机器把未压缩的全量 surface 发出去并报 CONTEXT_WINDOW_EXCEEDED。
  const toolPath = join(pluginRootSelf, 'tools', 'bili-state.mjs')
  const toolRuntime = join(pluginRuntime, 'tools', 'bili-state.mjs')
  check('提供 tools/bili-state.mjs', existsSync(toolPath), toolPath)
  check('runtime/tools 下也有同一份（tgz 只打 runtime 时也在包里）',
    existsSync(toolRuntime) && existsSync(toolPath) && readFileSync(toolRuntime).equals(readFileSync(toolPath)))
  const biliSrc = existsSync(toolPath) ? readFileSync(toolPath, 'utf8') : ''
  check('支持 export / import / sync / probe 四个子命令',
    ["'export'", "'import'", "'sync'", "'probe'"].every((k) => biliSrc.includes(`cmd === ${k}`)))
  check('导出默认不带 messages 正文（体积可控）',
    biliSrc.includes("omitted: ['messages'") || biliSrc.includes('omitted: [\'messages\''), 'export 的 omitted 字段')
  check('导出不写 metadata_json（2.4MB 级缓存，且 NOT NULL 会炸）',
    biliSrc.includes('delete row.metadata_json'))
  check('本机没有 bili 时静默跳过（noBili 而不是报错）',
    biliSrc.includes('noBili'))
  check('BILI_DATA_DIR 指到哪就用哪，不回头猜用户主目录',
    biliSrc.includes('显式指定即视为权威') || biliSrc.includes('return null\r\n  }'))

  const commonText2 = existsSync(join(pluginRuntime, 'dsh-sync-common.ps1')) ? readFileSync(join(pluginRuntime, 'dsh-sync-common.ps1'), 'utf8') : ''
  const captureText2 = existsSync(join(pluginRuntime, 'capture.ps1')) ? readFileSync(join(pluginRuntime, 'capture.ps1'), 'utf8') : ''
  const applyText2 = existsSync(join(pluginRuntime, 'apply.ps1')) ? readFileSync(join(pluginRuntime, 'apply.ps1'), 'utf8') : ''
  check('common 提供 Invoke-BiliStateSync / Write-BiliStateSyncReport',
    /function\s+Invoke-BiliStateSync\s*\{/.test(commonText2) && /function\s+Write-BiliStateSyncReport\s*\(/.test(commonText2))
  check('capture 推送时导出压缩状态（否则 B 机拿不到）',
    /Invoke-BiliStateSync\s+-Mode\s+'export'/.test(captureText2))
  check('apply 拉取时导入压缩状态',
    /Invoke-BiliStateSync\s+-Mode\s+'import'/.test(applyText2))
  check('apply 只在仓库里有该目录时才导入（首次导出前为空属正常）',
    /Test-Path\s+-LiteralPath\s+\$biliRepo/.test(applyText2))
  check('压缩状态按会话导出，不是整库拷贝',
    captureText2.includes('$touchedSids') && captureText2.includes(`'billion_context'`))
}

console.log('')
console.log('== 同步清单的两类新提示 ==')
{
  const commonText3 = existsSync(join(pluginRuntime, 'dsh-sync-common.ps1')) ? readFileSync(join(pluginRuntime, 'dsh-sync-common.ps1'), 'utf8') : ''
  const applyText3 = existsSync(join(pluginRuntime, 'apply.ps1')) ? readFileSync(join(pluginRuntime, 'apply.ps1'), 'utf8') : ''
  const postText3 = existsSync(join(pluginRuntime, 'post-exit.ps1')) ? readFileSync(join(pluginRuntime, 'post-exit.ps1'), 'utf8') : ''
  const indexText3 = existsSync(join(pluginRootSelf, 'index.js')) ? readFileSync(join(pluginRootSelf, 'index.js'), 'utf8') : ''
  const clientText3 = existsSync(join(pluginRootSelf, 'client.js')) ? readFileSync(join(pluginRootSelf, 'client.js'), 'utf8') : ''
  check('common 的 byKind 收 plugin-missing / context-state',
    commonText3.includes("'plugin-missing'") && commonText3.includes("'context-state'"))
  check('apply 记 plugin-missing（插件没装好要能看见）',
    /Add-SyncNotice\s+-Kind\s+'plugin-missing'/.test(applyText3))
  check('压缩状态缺失记 context-state（压缩状态没跟过来要能看见）',
    /Add-SyncNotice\s+-Kind\s+'context-state'/.test(commonText3))
  check('post-exit 汇总里带这两类标题',
    postText3.includes('plugin-missing') && postText3.includes('context-state'))
  check('index.js 白名单含这两类（否则会被降级成 skipped）',
    indexText3.includes("'plugin-missing'") && indexText3.includes("'context-state'"))
  check('client.js 给这两类中文文案',
    clientText3.includes("'plugin-missing'") && clientText3.includes("'context-state'"))
}

console.log('')

console.log('')
console.log('== 工作区显示状态卡片 ==')
{
  const wvTool = join(pluginRootSelf, 'runtime', 'tools', 'workspace-view.mjs')
  const wvSrc = existsSync(wvTool) ? readFileSync(wvTool, 'utf8') : ''
  check('workspace-view 工具模块存在且导出三函数',
    wvSrc.includes('export function readView') && wvSrc.includes('export function setWorkspaceState') && wvSrc.includes('export function setSessionState'), 'runtime/tools/workspace-view.mjs')
  const idxSrc = existsSync(join(pluginRootSelf, 'index.js')) ? readFileSync(join(pluginRootSelf, 'index.js'), 'utf8') : ''
  check('宿主导入 workspace-view 并注册 /config-sync/workspace-view',
    idxSrc.includes("from './runtime/tools/workspace-view.mjs'")
    && idxSrc.includes("const ROUTE_WORKSPACE_VIEW = '/config-sync/workspace-view'")
    && idxSrc.includes('handleWorkspaceView'), 'index.js 的接线')
  const cliSrc = existsSync(join(pluginRootSelf, 'client.js')) ? readFileSync(join(pluginRootSelf, 'client.js'), 'utf8') : ''
  check('客户端有 WorkspaceViewCard 且三态与会话独立操作都接到路由',
    cliSrc.includes('function WorkspaceViewCard()')
    && cliSrc.includes("fetch('/config-sync/workspace-view'")
    && cliSrc.includes("action: 'workspace'") && cliSrc.includes("action: 'session'")
    && cliSrc.includes("M('归档工作区', 'Archive workspace')") && cliSrc.includes("M('隐藏会话', 'Sessions hidden')")
    && cliSrc.includes('workspaceViewCard'), 'client.js 的卡片')
  check('面板新增「工作区显示」分区', cliSrc.includes("Section(M('工作区显示', 'Workspace visibility')"), '分区装配')
}

console.log('')
console.log('== 0.3.82：工作区显示卡片折叠智能体 + 隐藏/显示即时生效 ==')
{
  const wvSrc = existsSync(join(pluginRootSelf, 'runtime', 'tools', 'workspace-view.mjs')) ? readFileSync(join(pluginRootSelf, 'runtime', 'tools', 'workspace-view.mjs'), 'utf8') : ''
  const idxSrc = existsSync(join(pluginRootSelf, 'index.js')) ? readFileSync(join(pluginRootSelf, 'index.js'), 'utf8') : ''
  const cliSrc = existsSync(join(pluginRootSelf, 'client.js')) ? readFileSync(join(pluginRootSelf, 'client.js'), 'utf8') : ''

  // 1) 智能体折叠：标题提取同时给出 origin，readView 支持 includeAgents 过滤
  check('智能体折叠：titleFromFile 同时返回 origin',
    wvSrc.includes("let result = { title: '', origin: '', blank: false }")
    && wvSrc.includes('if (!origin && ev.type === \'session\')')
    && wvSrc.includes('origin,'), 'workspace-view.mjs 的头事件解析')
  check('智能体折叠：readView 默认过滤 origin=subagent 并回报 agentHidden',
    wvSrc.includes('const includeAgents = options.includeAgents === true')
    && wvSrc.includes("agent: meta.origin === 'subagent'")
    && wvSrc.includes('let sessions = includeAgents ? all : all.filter((s) => !s.agent)')
    && wvSrc.includes('agentHidden: totalAgents'), 'workspace-view.mjs 的 readView')
  check('智能体折叠：卡片默认不显示、可勾选「显示智能体」',
    cliSrc.includes('const [showAgents, setShowAgents] = react.useState(false)')
    && cliSrc.includes("M('显示智能体', 'Show agents')")
    && cliSrc.includes("q.push('agents=1')"), 'client.js 的勾选框')

  // 2) 即时生效：走 workspaceRegistry 而不是直接改文件
  check('即时生效：workspace-view 导出实时通道两函数',
    wvSrc.includes('export async function setWorkspaceStateLive')
    && wvSrc.includes('export async function setSessionStateLive')
    && wvSrc.includes('registry.archiveSession(sessionId, { stopActivity: false })')
    && wvSrc.includes('registry.unarchiveSession(sessionId)'), 'workspace-view.mjs 的实时通道')
  check('即时生效：宿主惰性取 workspaceRegistry',
    idxSrc.includes('let ctxRef = null')
    && idxSrc.includes('function workspaceRegistryOf()')
    && idxSrc.includes("ctx.get('workspaceRegistry')")
    && idxSrc.includes('ctxRef = ctx || null'), 'index.js 的 registry 取用')
  check('即时生效：路由改用 Live 版本并透传 registry',
    idxSrc.includes("import { setWorkspaceStateLive, setSessionStateLive } from './runtime/tools/workspace-view.mjs'")
    && idxSrc.includes('await setWorkspaceStateLive(') && idxSrc.includes('await setSessionStateLive(')
    && idxSrc.includes('{ registry, includeAgents: withAgents, includeBlank: withBlank }'), 'index.js 的 handleWorkspaceView')
  check('即时生效：registry 拿不到时退回文件写法并标记 live:false',
    wvSrc.includes('return { ...setWorkspaceState(dshHome, workspaceId, state), live: false }')
    && wvSrc.includes("live: false, fallbackFrom: 'registry'"), 'workspace-view.mjs 的降级')
  check('即时生效：卡片按 live 给不同提示（不再说「重启后生效」）',
    cliSrc.includes("d.live === true") && cliSrc.includes("M('已更新，会话列表已同步', 'Updated — the session list is in sync')")
    && !cliSrc.includes('重启或刷新会话列表后生效'), 'client.js 的提示措辞')
}

console.log('')
console.log('== 配置同步页面 5 点调整 ==')
{
  const cliSrc = existsSync(join(pluginRootSelf, 'client.js')) ? readFileSync(join(pluginRootSelf, 'client.js'), 'utf8') : ''
  const wvSrc = existsSync(join(pluginRootSelf, 'runtime', 'tools', 'workspace-view.mjs')) ? readFileSync(join(pluginRootSelf, 'runtime', 'tools', 'workspace-view.mjs'), 'utf8') : ''
  // 1) 会话名称：工具侧读 session/title 并在 readView 里带 title 字段；卡片侧显示 s.title
  check('会话名称：工具从 session 日志提取 title 并随 readView 返回',
    wvSrc.includes('zstdDecompressSync') && wvSrc.includes('buildSessionLogIndex')
    && wvSrc.includes("'session/title'") && wvSrc.includes('title: rec.title || wsId')
    && wvSrc.includes("const meta = log ? titleFromFile(log) : { title: '', origin: '', blank: false }"), 'workspace-view.mjs 的标题提取')
  check('会话名称：与 DSH 面板一致——优先 provider 正式标题，不再取第一条 fallback',
    wvSrc.includes('providerTitle') && wvSrc.includes("kind === 'provider'")
    && wvSrc.includes('cleanTitle(providerTitle) || cleanTitle(fallbackTitle)')
    && !wvSrc.includes('if (lastTitle) break'), '标题演进：provider > fallback > 无来源 > 首条消息')
  check('会话名称：卡片显示 s.title || s.id', cliSrc.includes('s.title || s.id'), 'client.js 卡片')
  // 2) 修改按钮：全卡片只有一个「修改」，进入编辑态后三态 select 与每行的隐藏/显示按钮一起出现
  check('修改按钮：整卡一个「修改」，编辑态才显示三态 select 与会话隐藏按钮',
    cliSrc.includes('// 整张卡片只有一个「修改」按钮')
    && cliSrc.includes("M('修改', 'Edit')") && cliSrc.includes("M('完成', 'Done')")
    // 工作区行不再各带一个编辑按钮
    && !cliSrc.includes('const edit = !!editing[w.workspaceId]')
    && !cliSrc.includes('setEditing(v => ({ ...v, [w.workspaceId]: !edit }))')
    // 编辑态由整卡开关控制，且行内下拉与行内按钮都存在
    && cliSrc.includes('onClick: () => setEditing(v => !v)')
    && cliSrc.includes('changeWorkspace(w.workspaceId, e.target.value)')
    && cliSrc.includes('changeSession(s.id, !s.hidden)')
    // 编辑态只靠顶部按钮本身表达状态，不再额外插入强调色说明条
    && !cliSrc.includes('editBanner') && !cliSrc.includes("M('编辑中', 'Editing')"), 'client.js 编辑态')
  // 3) 点工作区整行即展开，不再单独展开按钮
  check('点工作区即展开（整行 onClick，无独立展开按钮）',
    cliSrc.includes("onClick: () => setExpanded(e => ({ ...e, [w.workspaceId]: !open }))")
    && !cliSrc.includes("open ? '▾' : '▸', 'Expand sessions'"), 'client.js 展开交互')
  // 4) 工作区显示卡片排在问题反馈前
  const wvPos = cliSrc.indexOf("Section(M('工作区显示', 'Workspace visibility')")
  const fbPos = cliSrc.indexOf("Section(M('问题反馈', 'Feedback')")
  check('工作区显示卡片移到问题反馈前', wvPos > 0 && fbPos > 0 && wvPos < fbPos, '分区顺序')
  // 5) 标题固定 + 快速跳转 tab：Section 支持 id 锚点、页头在滚动区之外、tab 点击 scrollIntoView
  check('标题固定：页头在滚动区之外（两段式布局，不再 sticky）',
    cliSrc.includes('pageHeaderWrap:') && cliSrc.includes('pageBody:')
    && !cliSrc.includes("position: 'sticky'"), 'pageHeader 两段式')
  check('快速跳转 tab：Section 带锚点 id', cliSrc.includes('function Section(title, hint, cards, id)') && cliSrc.includes("sync-section-' + id"), 'Section id')
  check('快速跳转 tab：点击后平滑滚动到对应卡片',
    cliSrc.includes("getElementById('sync-section-' + sid)")
    && cliSrc.includes("scrollIntoView({ behavior: 'smooth', block: 'start' })")
    && cliSrc.includes("['feedback', M('问题反馈', 'Feedback')]"), 'tab 跳转')
  // 6) tab 顺序 = 卡片渲染顺序：workspace 在 extra 之后、feedback 之前（不再是第 2 位）
  const tabBlock = cliSrc.slice(cliSrc.indexOf("['overview', M('概览', 'Overview')]"), cliSrc.indexOf('.map((pair) =>'))
  const tabOrder = ['overview', 'workspace', 'targets', 'automation', 'actions', 'restore', 'scope', 'extra', 'feedback']
    .filter((k) => k !== 'workspace' && k !== 'feedback')  // 下面单独校验位置
  const tabIdx = (s) => tabBlock.indexOf("['" + s + "',")
  check('快速跳转 tab 顺序与卡片顺序一致：workspace 在 extra 后、feedback 前',
    tabIdx('extra') > 0 && tabIdx('feedback') > tabIdx('extra')
    && tabBlock.indexOf("['workspace',") > tabIdx('extra')
    && tabBlock.indexOf("['workspace',") < tabIdx('feedback'), 'tab 顺序')
  // 7) 条件区（同步冲突/本机路径）按卡片是否存在动态出现在 tab
  check('快速跳转 tab：条件区 conflict/roots 动态过滤',
    cliSrc.includes('...(conflictCard ?') && cliSrc.includes('...(showRoots ?'), 'tab 条件区')
  // 8) 滚动区从标题下方开始：页头不滚动、内容区独立 overflow 且落点是固定 8px
  check('滚动落点在标题下方：内容区独立滚动 + 固定 scrollMarginTop',
    /pageBody:\s*\{[^}]*overflowY: 'auto'/.test(cliSrc)
    && /pageBody:\s*\{[^}]*minHeight: 0/.test(cliSrc)
    && cliSrc.includes("scrollMarginTop: '8px'")
    && !cliSrc.includes('headerRef.current ? headerRef.current.offsetHeight'), '滚动遮挡')
}
console.log('')
console.log('== 0.3.86：本机数据挪进待办 + 会话显示会话名 + 按同步内容分组 ==')
{
  const idxSrc = existsSync(join(pluginRootSelf, 'index.js')) ? readFileSync(join(pluginRootSelf, 'index.js'), 'utf8') : ''
  const cliSrc = existsSync(join(pluginRootSelf, 'client.js')) ? readFileSync(join(pluginRootSelf, 'client.js'), 'utf8') : ''
  // 1) 宿主：按同步内容分组归类 + 从投影缓存取会话标题
  check('本机数据按同步内容分组归类（pendingGroupOf + PENDING_GROUP_LABEL）',
    idxSrc.includes('const PENDING_GROUP_LABEL = {')
    && idxSrc.includes('conversations: [\'会话记录\', \'Conversations\']')
    && idxSrc.includes('function pendingGroupOf(')
    && idxSrc.includes('const gid = pendingGroupOf(')
    && idxSrc.includes('groupCount.set(gid, (groupCount.get(gid) || 0) + 1)'), 'index.js 分组统计')
  check('本机数据样本里会话显示会话标题（sessionTitleOf）',
    idxSrc.includes('function sessionTitleOf(')
    && idxSrc.includes('record.rows.title.val')
    && idxSrc.includes("if (gid === 'conversations')")
    && idxSrc.includes('if (title) label = title')
    && idxSrc.includes('if (sample.length < 3) sample.push(label)'), 'index.js 会话标题')
  check('localPending 返回 groups（zh/en/count）',
    idxSrc.includes('const groups = [...groupCount.entries()]')
    && idxSrc.includes('zh: PENDING_GROUP_LABEL[id]?.[0]')
    && idxSrc.includes('groups,')
    && idxSrc.includes('sample: [], groups: []'), 'index.js localPending 返回值')
  // 2) 客户端：待办去掉「本机数据」字眼，按分组可展开看具体名称
  const localDataHits = cliSrc.split("M('本机数据', 'Local data')").length - 1
  check('待办去掉「本机数据」字眼（0.3.90）',
    localDataHits === 0, 'client.js 无 Local data 文案')
  check('待办装配：localBlock 挂到待办卡',
    cliSrc.includes('const localBlock = data && data.local && data.local.known')
    && cliSrc.includes('pendingDetailOpen ? localBlock'), 'client.js 待办装配')
  check('待办按同步内容分组、点分组展开具体名称（会话名/profile 文件）',
    cliSrc.includes('langIsZh() ? g.zh : g.en')
    && cliSrc.includes('g.count')
    && cliSrc.includes('const items = Array.isArray(g.items) ? g.items : []')
    && cliSrc.includes('setPendingOpen')
    && cliSrc.includes('还有 ${g.count - items.length} 项未列出'), 'client.js 分组展开')
  check('待办卡有展开/收起总开关（默认展开）',
    cliSrc.includes('const [pendingDetailOpen, setPendingDetailOpen] = react.useState(true)')
    && cliSrc.includes('pendingDetailOpen ? localBlock'), 'client.js 待办总开关')
  check('顶部跳转按钮跟随当前分区高亮（0.3.90）',
    cliSrc.includes('const [activeSection, setActiveSection] = react.useState')
    && cliSrc.includes('const active = activeSection === sid')
    && cliSrc.includes("querySelectorAll('[id^=\"sync-section-\"]')")
    && cliSrc.includes('ref: bodyRef'), 'client.js 跳转高亮')
  check('分组标签与同步内容一致（会话记录/技能/插件数据/记忆数据）',
    idxSrc.includes("conversations: ['会话记录', 'Conversations']")
    && idxSrc.includes("skills: ['Skills', 'Skills']")
    && idxSrc.includes("'plugin-data': ['插件数据', 'Plugin data']")
    && idxSrc.includes("mnemon: ['记忆数据', 'Memory data']"), '分组口径')
}
console.log('')
console.log('== 0.3.93：点 × 关闭时判一次并排队自动拉取/推送 ==')
{
  const idxSrc = existsSync(join(pluginRootSelf, 'index.js')) ? readFileSync(join(pluginRootSelf, 'index.js'), 'utf8') : ''
  // 1) 新增退出前排队函数：读开关 / 复用在途 watcher / 空仓只拉 / 拉取优先 / 判据同 scheduleAutoStart
  check('退出前排队函数存在且读 autoPull/autoPush 开关',
    /async function triggerAutoSyncOnClose\(config\)/.test(idxSrc)
    && /if \(!settings\.autoPull && !settings\.autoPush\) return/.test(idxSrc), 'index.js triggerAutoSyncOnClose')
  check('已有在途 watcher 时复用、不重复拉起',
    /autoState\.pending[\s\S]{0,200}isProcessAlive\(autoState\.pending\.watcherPid\)[\s\S]{0,120}reused: true/.test(idxSrc), 'index.js 复用守卫')
  check('本机仓库为空时仅 autoPull 可排队初始化',
    /phase !== 'ok'[\s\S]{0,320}settings\.autoPull && phase === 'empty'/.test(idxSrc), 'index.js 空仓分支')
  check('退出前拉取优先：云端领先就排 pull（且不弹确认框）',
    /settings\.autoPull && drift\.behind > 0[\s\S]{0,420}mode: 'pull'/.test(idxSrc)
    && /退出前检查：云端领先/.test(idxSrc), 'index.js 拉取优先')
  check('退出前 push 判据与 scheduleAutoStart 一致（领先/未提交/本机待同步）',
    /const shouldPush = drift\.ahead > 0 \|\| dirty > 0 \|\| \(lp\.known && lp\.pending > 0\)/.test(idxSrc)
    && /if \(shouldPush\)/.test(idxSrc), 'index.js push 判据')
  check('退出前排队的 restart 语义统一为 autoRestart !== false',
    /function triggerAutoSyncOnClose[\s\S]{0,2600}settings\.autoRestart !== false/.test(idxSrc)
    && !/function triggerAutoSyncOnClose[\s\S]{0,2600}settings\.autoRestart === true/.test(idxSrc), 'index.js autoRestart')
  // 2) 关闭钩子：接 config、quit 之前 await 排队、再 quit；apply 内传 config
  check('关闭钩子接住 config（installQuitWhenAllWindowsClosed(ctx, config)）',
    /function installQuitWhenAllWindowsClosed\(ctx, config\)/.test(idxSrc)
    && /installQuitWhenAllWindowsClosed\(ctx, config\)/.test(idxSrc), 'index.js 钩子签名与调用点')
  check('点 × 无可见窗口时先 await 退出前排队、再 app.quit()',
    /await triggerAutoSyncOnClose\(config\)[\s\S]{0,600}el\.app\.quit\(\)/.test(idxSrc), 'index.js 排队先于 quit')
  check('排队成功写日志：退出后立即执行',
    /退出前已排队 \$\{r\.mode\}（自动同步）/.test(idxSrc), 'index.js 排队日志')
}
console.log('')
console.log('== 0.4.1：空格路径传参修复 + WebDAV 接入拉取/推送流水线 + 文案对齐 ==')
{
  const idxSrc = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const cliSrc = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  const postSrc = readFileSync(join(pluginRuntime, 'post-exit.ps1'), 'utf8')
  const syncSrc = readFileSync(join(pluginRuntime, 'sync.ps1'), 'utf8')
  const davSrc = readFileSync(join(pluginRuntime, 'webdav.mjs'), 'utf8')
  const engSrc = readFileSync(join(pluginRuntime, 'sync-engine.mjs'), 'utf8')
  check('spawnWatcher 与 post-exit 中继对含空格参数加内层双引号',
    idxSrc.includes('function psWinArg(')
    && idxSrc.includes('psQuote(psWinArg(a))')
    && postSrc.includes('function Quote-WinArg(')
    && postSrc.includes('$quotedRelay'),
    'Start-Process -ArgumentList 空格路径仍会拆包')
  check('去掉过时的「点『设置路径』」误导文案',
    !idxSrc.includes('点「设置路径」'),
    'index.js 仍残留点「设置路径」提示')
  check('webdav.mjs MKCOL 兼容 nginx 尾斜杠并支持 CLI 子命令',
    davSrc.includes('mkcolOne')
    && davSrc.includes('runWebdavCli'),
    'webdav.mjs 缺 mkcolOne 或 runWebdavCli')
  check('index.js / sync.ps1 / sync-engine.mjs 均接入 WebDAV 探测与同步',
    idxSrc.includes('async function probeWebdavRemote(')
    && syncSrc.includes('Test-WebdavActive')
    && syncSrc.includes('Invoke-WebdavAction')
    && engSrc.includes('webdavActive('),
    'WebDAV 未完整接入主机/PS/Node 执行链')
  check('client.js WebDAV 模式不误报缺失 git 远端',
    cliSrc.includes('const webdavOn = Boolean(data.webdav && data.webdav.active)')
    && cliSrc.includes("drift.transport === 'webdav'"),
    'client.js 仍把 WebDAV 模式当未配置远端')
}
console.log('')
console.log('== 0.4.2：Job Object 脱离 + 在线推送（不关 DSH）+ 待办直达锚文本按钮 ==')
{
  const idxSrc = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const cliSrc = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  const postSrc = readFileSync(join(pluginRuntime, 'post-exit.ps1'), 'utf8')
  check('spawnWatcher 优先用 Shell.Application.ShellExecute 脱离 DSH Job Object，并保留 Start-Process 兜底',
    idxSrc.includes('Shell.Application')
    && idxSrc.includes('.ShellExecute(')
    && idxSrc.includes("'-PidFile'")
    && postSrc.includes('[string]$PidFile'),
    'spawnWatcher 仍只用 Start-Process，DSH 退出时等待进程会被 Job Object 连杀')
  check('宿主支持不关闭 DSH 的在线推送（action=push-live + livePush 状态）',
    idxSrc.includes("action === 'push-live'")
    && idxSrc.includes('function startLivePush(')
    && idxSrc.includes('livePush: { ...autoState.livePush }'),
    'index.js 缺 push-live 接口或 livePush 状态')
  check('面板 AutoCard 提供「不关 DSH」推送主按钮与实时状态框',
    cliSrc.includes("act('push-live')")
    && cliSrc.includes('初始化推送（不关 DSH）')
    && cliSrc.includes('立即推送（不关 DSH）')
    && cliSrc.includes('auto.livePush'),
    'client.js AutoCard 缺在线推送按钮或状态显示')
  check('面板「待办」Advice 配备直达锚文本按钮并复用 jumpToSection',
    cliSrc.includes('function adviceTarget(')
    && cliSrc.includes('onNavigate: jumpToSection')
    && cliSrc.includes('前往初始化推送 →'),
    'client.js 待办列表缺少锚文本跳转按钮')
}
console.log('')
console.log('== 0.5.x 回归守卫：PS5.1 BOM + jumpToSection 参数解包 + 在线推送进度与报错 ==')
{
  const idxSrc = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const cliSrc = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  const davSrc = readFileSync(join(pluginRuntime, 'webdav.mjs'), 'utf8')
  const psFiles = [
    ...['apply.ps1', 'capture.ps1', 'dsh-sync-common.ps1', 'install-plugin.ps1', 'post-exit.ps1', 'restore.ps1', 'sync.ps1'].map((n) => join(pluginRuntime, n)),
    join(pluginRootSelf, 'tools', 'pack-plugin.ps1'),
  ]
  const noBom = psFiles.filter((p) => {
    const b = readFileSync(p)
    return !(b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF)
  })
  check('所有 .ps1 脚本均带 UTF-8 BOM（防 Windows PowerShell 5.1 乱码 ParseException）',
    noBom.length === 0, noBom.join(', '))
  check('Advice 与 jumpToSection 正确解包 target.section 且直接滚动 bodyRef',
    cliSrc.includes('onNav(target.section, target)')
    && cliSrc.includes('sidOrTarget.section')
    && cliSrc.includes('body.scrollTo('),
    'client.js 仍可能把 target 对象拼进 sync-section-[object Object]')
  check('client.js jsonHeaders 为动态函数（不锁死模块加载瞬间的 accept-language）',
    cliSrc.includes('const jsonHeaders = () =>')
    && cliSrc.includes('headers: jsonHeaders()'),
    'jsonHeaders 仍是静态对象')
  check('startLivePush 捕获 PowerShell $? / try-catch / CLIXML 错误并保留请求语言',
    idxSrc.includes('if (-not $?)')
    && idxSrc.includes('sawFatalOutput')
    && idxSrc.includes('const reqLang = langStore.getStore()'),
    'startLivePush 仍可能把 ParseException 当成 exit 0 成功')
  check('AutoCard 实时进度框含步骤进度与最近日志行',
    cliSrc.includes('liveSteps')
    && cliSrc.includes('livePush.recent')
    && davSrc.includes('onProgress'),
    '缺少分步进度或实时日志展示')
}
console.log('')
console.log('== 0.5.1：环境变量读取令牌 + 防令牌/凭据推入仓库 ==')
{
  const idxSrc = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const cliSrc = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  const commonSrc = readFileSync(join(pluginRuntime, 'dsh-sync-common.ps1'), 'utf8')
  const captureSrc = readFileSync(join(pluginRuntime, 'capture.ps1'), 'utf8')
  const syncSrc = readFileSync(join(pluginRuntime, 'sync.ps1'), 'utf8')
  const davSrc = readFileSync(join(pluginRuntime, 'webdav.mjs'), 'utf8')
  const eng = await import(pathToFileURL(join(pluginRuntime, 'sync-engine.mjs')).href)

  check('Feedback / Update 支持从本机环境变量动态读取令牌且不把环境变量值写盘',
    idxSrc.includes('GH_TOKEN_ENV_CANDIDATES')
    && idxSrc.includes('parseEnvTokenRef')
    && idxSrc.includes('getEnvValue')
    && idxSrc.includes("saveFields = { token: '', tokenEnv: envName, repo }")
    && idxSrc.includes('authHeadersForUrl')
    && !/withAccessToken[\s\S]{0,200}gh-proxy\.com/.test(idxSrc),
    'index.js 环境变量解析或代理防泄漏逻辑缺失')

  check('FeedbackCard 展示令牌来源并支持绑定环境变量与清除已存明文令牌',
    cliSrc.includes('st.tokenSource')
    && cliSrc.includes('st.envCandidates')
    && cliSrc.includes('clearToken: true')
    && cliSrc.includes('$GITHUB_TOKEN'),
    'client.js 缺少环境变量交互')

  // 0.6.47：UpdateCard 的更新源固定是 npm，旧的「更新清单 / 更新令牌」两栏撤掉，
  // 面板上要写明来源是 npm（不能让人以为还在查 GitHub）。
  check('UpdateCard 标明更新源是 npm，且不再有清单地址 / 令牌输入框',
    cliSrc.includes('npm') && !cliSrc.includes('gh-proxy / ghfast / GitHub raw') &&
    !cliSrc.includes("M('更新清单', 'Manifest')"),
    'client.js 的更新卡仍显示旧的清单/令牌配置')

  check('capture / sync / webdav 全链路包含私密文件名黑名单与 GitHub 令牌防泄漏门禁',
    commonSrc.includes('Test-PrivateSecretFileName')
    && commonSrc.includes('SyncGitHubTokenPattern')
    && captureSrc.includes('Test-SyncExtraSecret $m.Src $DshHome')
    && !captureSrc.includes('本次仍按你的设置抓取')
    && syncSrc.includes('安全拦截：发现含令牌或本机私有凭据的文件')
    && syncSrc.includes('安全拦截：检测到本机私有凭据或 GitHub 令牌')
    && davSrc.includes('isSecretLeakCandidate'),
    '同步/上传链路防令牌泄漏门禁缺失')

  // 运行时实测：sync-engine.mjs copyWithTokens 必须拦截 config-sync-gh.json 与含 GitHub 令牌的文本
  const leakTmp = mkdtempSync(join(tmpdir(), 'dsh-sync-leak-'))
  try {
    const srcD = join(leakTmp, 'src')
    const dstD = join(leakTmp, 'dst')
    mkdirSync(srcD, { recursive: true })
    writeFileSync(join(srcD, 'config-sync-gh.json'), '{"repo":"a/b","token":"plain"}', 'utf8')
    writeFileSync(join(srcD, 'notes.txt'), 'token=ghp_1234567890abcdefghij1234567890\n', 'utf8')
    writeFileSync(join(srcD, 'ok.txt'), 'hello world\n', 'utf8')
    eng.copyWithTokens(srcD, dstD, { appRoot: '', dshHome: '', workspaceHome: '' })
    check('运行时实测：copyWithTokens 自动跳过 config-sync-gh.json 与含 ghp_ 令牌的文件',
      !existsSync(join(dstD, 'config-sync-gh.json'))
      && !existsSync(join(dstD, 'notes.txt'))
      && existsSync(join(dstD, 'ok.txt')),
      '存在未被拦截的敏感文件')
  } finally {
    rmSync(leakTmp, { recursive: true, force: true })
  }

  check('默认反馈仓库从 package.json 解析并自动迁移旧上游 QcWyGm 仓库名',
    idxSrc.includes('LEGACY_UPSTREAM_REPOS')
    && idxSrc.includes('function normalizeGhRepo(')
    && idxSrc.includes('huanyu-a/dsh-profile-config-sync'),
    'index.js 缺少旧上游仓库自动迁移')
  check('ghApi 网络异常不抛 500、支持 gh auth token 兜底并传递 tokenPresent 与 credLogin',
    idxSrc.includes('networkError: true')
    && idxSrc.includes('function tokenFromGhCli(')
    && idxSrc.includes('credFromGitCredential')
    && idxSrc.includes('tokenPresent: Boolean(g.token)')
    && cliSrc.includes('st.tokenPresent')
    && cliSrc.includes("st.tokenSource === 'gh-cli'"),
    'index.js 或 client.js 缺少网络容错或本机登录态识别')
}

/* ==================== 0.6.48：issue #7/#8/#9 修复回归 ====================
 * #7/#8：第三方 WebDAV 连不上 —— 既没有 UA 配置项，失败也只有一句
 *        「连不上或认证失败（PROPFIND 无响应）」，用户无从下手。
 * #9  ：问题反馈带不了图片/视频。
 * 这一节盯三件事：UA 真的发出去、失败原因按状态码分开、附件真的上传并引进正文。
 */
console.log('')
console.log('== 0.6.48：WebDAV User-Agent + 可诊断失败 + 反馈附件（issue #7/#8/#9）==')
{
  const idxSrc = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const cliSrc = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  const eng2 = await import(pathToFileURL(join(pluginRuntime, 'webdav.mjs')).href)

// --- UA：归一化 / 非法值拒收 / 真的进请求头 ---
{
  const w = eng2.normalizeWebdav({
    webdavUrl: 'https://dav.example.com/dav', webdavUser: 'u', webdavPass: 'p',
    webdavDir: 'dsh', webdavUserAgent: 'davfs2/1.6.1',
  })
  check('normalizeWebdav 带出自定义 UA', w.ua === 'davfs2/1.6.1', String(w.ua))
  check('normalizeWebdav 的诊断字段不进 JSON（lastError / lastStatus 不外露）',
    !/lastError|lastStatus/.test(JSON.stringify(w)),
    JSON.stringify(w))

  const bad = [
    ['CRLF 注入', 'davfs2\r\nX-Evil: 1'],
    ['中文', '中文客户端'],
    ['制表符', 'davfs2\t1'],
    ['超长', 'a'.repeat(300)],
  ]
  for (const [label, value] of bad) {
    check(`UA 非法值被拒（${label}）→ 退回不发`, eng2.sanitizeUserAgent(value) === '', JSON.stringify(eng2.sanitizeUserAgent(value)))
  }
  check('UA 留空 = 不发 User-Agent', eng2.sanitizeUserAgent('') === '' && eng2.sanitizeUserAgent(undefined) === '')

  // 真发一次：本地起个 HTTP 服务，把收到的 user-agent 头回显出来。
  // 这是唯一能证明「配置项不是摆设」的办法 —— 只读源码断言会被「字段存了但没用」骗过去。
  const { createServer } = await import('node:http')
  const seen = []
  const srv = createServer((req, res) => {
    seen.push(req.headers['user-agent'] === undefined ? '(none)' : String(req.headers['user-agent']))
    res.statusCode = 207
    res.setHeader('content-type', 'application/xml; charset=utf-8')
    res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    const withUa = eng2.normalizeWebdav({ webdavUrl: `http://127.0.0.1:${port}/dav`, webdavDir: 'dsh', webdavUserAgent: 'MyDAV/1.0' })
    const r1 = await eng2.listRemote(withUa, '')
    check('自定义 UA 真的发给了服务端', r1 && seen[0] === 'MyDAV/1.0', `收到 ${seen[0]}`)
    const noUa = eng2.normalizeWebdav({ webdavUrl: `http://127.0.0.1:${port}/dav`, webdavDir: 'dsh' })
    await eng2.listRemote(noUa, '')
    check('UA 留空时服务端收不到 User-Agent 头', seen[1] === '(none)', `收到 ${seen[1]}`)
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

// --- 失败原因按状态码分开，且不再是那句笼统的「连不上或认证失败」 ---
{
  const { createServer } = await import('node:http')
  // 本地测试服是 http：testConnection 会按「明文传密码有风险」拒掉非 https 地址，
  // 这里显式放行（只在这个测试进程里生效，且连的是 127.0.0.1）。
  const prevInsecure = process.env.DSH_SYNC_ALLOW_INSECURE
  process.env.DSH_SYNC_ALLOW_INSECURE = '1'
  const cases = [[401, '认证失败（401）'], [403, '被拒绝（403）'], [405, '不支持 PROPFIND']]
  try {
    for (const [status, expect] of cases) {
      const srv = createServer((req, res) => { res.statusCode = status; res.end('nope') })
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      const port = srv.address().port
      try {
        const w = eng2.normalizeWebdav({ webdavUrl: `http://127.0.0.1:${port}/dav`, webdavDir: 'dsh' })
        const probe = await eng2.testConnection(w)
        check(`PROPFIND ${status} 的失败原因说得清（${expect}）`,
          probe.ok === false && String(probe.error).includes(expect),
          String(probe.error))
        check(`PROPFIND ${status} 不再落到笼统文案`,
          !/连不上或认证失败（PROPFIND 无响应）/.test(String(probe.error)),
          String(probe.error))
        check(`PROPFIND ${status} 报出状态码`, Number(probe.status) === status, String(probe.status))
      } finally {
        await new Promise((r) => srv.close(r))
      }
    }
    // 404 是「目录还不存在」的合法首次同步：探测不算失败，只是空的
    {
      const srv = createServer((req, res) => { res.statusCode = 404; res.end('nope') })
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      const port = srv.address().port
      try {
        const w = eng2.normalizeWebdav({ webdavUrl: `http://127.0.0.1:${port}/dav`, webdavDir: 'dsh' })
        const probe = await eng2.testConnection(w)
        check('404 视为「云端还是空的」而不是失败', probe.ok === true && probe.exists === false, JSON.stringify(probe))
      } finally {
        await new Promise((r) => srv.close(r))
      }
    }
  } finally {
    if (prevInsecure === undefined) delete process.env.DSH_SYNC_ALLOW_INSECURE
    else process.env.DSH_SYNC_ALLOW_INSECURE = prevInsecure
  }
}

// --- 整条 WebDAV 通路实测（0.6.48 换了 HTTP 客户端，必须有回归护栏） ---
// 为什么单独起一个假服务器：上传/下载涉及 PROPFIND / PUT / GET / MKCOL 四种方法，
// 路径基准、Content-Length、重定向方法保持这些细节，只有真跑一遍才看得见。
{
  const { createServer } = await import('node:http')
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const store = new Map()
  const seenUa = []
  const methods = []
  const esc = (s) => String(s).replace(/&/g, '&amp;')
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const key = u.pathname
    methods.push(req.method)
    seenUa.push(req.headers['user-agent'] === undefined ? '(none)' : String(req.headers['user-agent']))
    if (req.method === 'PROPFIND') {
      const base = key.replace(/\/$/, '')
      const kids = [...store.keys()].filter((k) => k.startsWith(base + '/') && !k.slice(base.length + 1).includes('/'))
      const body = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
        + `<d:response><d:href>${esc(base)}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`
        + kids.map((k) => `<d:response><d:href>${esc(k)}</d:href><d:propstat><d:prop><d:getcontentlength>${store.get(k).length}</d:getcontentlength><d:etag>x</d:etag></d:prop></d:propstat></d:response>`).join('')
        + '</d:multistatus>'
      res.statusCode = 207
      res.setHeader('content-type', 'application/xml')
      res.end(body)
      return
    }
    if (req.method === 'PUT') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => { store.set(key, Buffer.concat(chunks)); res.statusCode = 201; res.end() })
      return
    }
    if (req.method === 'GET') {
      if (store.has(key)) { res.statusCode = 200; res.end(store.get(key)) } else { res.statusCode = 404; res.end() }
      return
    }
    if (req.method === 'MKCOL') { res.statusCode = 201; res.end(); return }
    res.statusCode = 405
    res.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const prevInsecure2 = process.env.DSH_SYNC_ALLOW_INSECURE
  process.env.DSH_SYNC_ALLOW_INSECURE = '1'
  try {
    const w = eng2.normalizeWebdav({ webdavUrl: `http://127.0.0.1:${port}/dav`, webdavDir: 'dsh', webdavUserAgent: 'RoundTripUA/1' })
    const probe = await eng2.testConnection(w)
    check('WebDAV 实测：探测连通并回显实际 UA', probe.ok === true && probe.userAgent === 'RoundTripUA/1', JSON.stringify(probe))
    check('WebDAV 实测：请求里带的是自定义 UA', seenUa.every((u) => u === 'RoundTripUA/1'), seenUa.join(','))

    const local = mkdtempSync(join(tmpdir(), 'dsh-dav-up-'))
    writeFileSync(join(local, 'a.txt'), 'hello dav', 'utf8')
    const up = await eng2.uploadRepo(w, local)
    check('WebDAV 实测：上传成功', up.ok === true && up.uploaded.includes('a.txt'), JSON.stringify(up.errors))
    const up2 = await eng2.uploadRepo(w, local)
    check('WebDAV 实测：内容相同则跳过（不重复传）', up2.ok === true && up2.uploaded.length === 0 && up2.skipped.includes('a.txt'), JSON.stringify({ u: up2.uploaded, s: up2.skipped }))

    const local2 = mkdtempSync(join(tmpdir(), 'dsh-dav-down-'))
    const dn = await eng2.downloadRepo(w, local2)
    check('WebDAV 实测：下载成功且内容一致',
      dn.ok === true && dn.downloaded.includes('a.txt') && readFileSync(join(local2, 'a.txt'), 'utf8') === 'hello dav',
      JSON.stringify({ d: dn.downloaded, e: dn.errors }))
    check('WebDAV 实测：确实用了 PROPFIND / PUT / GET 三种方法',
      methods.includes('PROPFIND') && methods.includes('PUT') && methods.includes('GET'),
      [...new Set(methods)].join(','))
  } finally {
    if (prevInsecure2 === undefined) delete process.env.DSH_SYNC_ALLOW_INSECURE
    else process.env.DSH_SYNC_ALLOW_INSECURE = prevInsecure2
    await new Promise((r) => srv.close(r))
  }
}

// --- 反馈附件：上传两步（找/建 release → 传字节）与正文引用 ---
{
  check('附件用 release assets 接口（GitHub 的 /repos/{o}/{r}/uploads 已下线）',
    idxSrc.includes('/releases/tags/')
    && idxSrc.includes('`/repos/${repo}/releases`')
    && !idxSrc.includes('`/repos/${repo}/uploads`'),
    'index.js 未走 release assets 接口')
  check('附件挂在一个草稿 release 上（不出现在 Releases 页面）',
    idxSrc.includes('draft: true')
    && idxSrc.includes('feedback-assets'),
    'index.js 没用草稿 release 存附件')
  check('upload_url 的 {?name,label} 整段被替换成真实查询串',
    idxSrc.includes('replace(/\\{\\?[^}]*\\}/g, \'\')')
    && idxSrc.includes("'name=' + encodeURIComponent(safe)"),
    'index.js 的 upload_url 处理不对')
  check('附件上传走 POST 到 upload_url 且带 Content-Length',
    idxSrc.includes("fetch(target, { method: 'POST'")
    && idxSrc.includes("'Content-Length': String(buf.length)"),
    'index.js 附件上传方法/头不对')
  check('附件正文引用图片用 Markdown 图片语法',
    idxSrc.includes("return /^image\\//.test(String((item && item.type) || ''))"),
    'index.js 附件引用格式不对')
}

// --- 面板与设置：UA 字段贯通 ---
check('index.js 设置里读写 webdavUserAgent（读 / 写 / 回显）',
  idxSrc.includes('webdavUserAgent: typeof raw.webdavUserAgent')
  && idxSrc.includes('webdavUserAgent: s.webdavUserAgent')
  && idxSrc.includes('userAgent: w.ua')
  && idxSrc.includes('sanitizeUserAgent'),
  'index.js 的 UA 设置没贯通')
check('保存非法 UA 明确报错（不静默存成空）',
  /User-Agent 只能是一行可见 ASCII/.test(idxSrc),
  'index.js 缺少 UA 校验文案')
check('UA 校验的抛错在 try 里（否则整个路由抛出、连 400 都回不来）',
  // 取 save 分支这一段：校验必须在 writeSettings 之前、且被 try 包住
  (() => {
    const seg = idxSrc.slice(idxSrc.indexOf("if (action === 'save') {"))
    if (seg < 0) return false
    const block = seg.slice(0, seg.indexOf("\n    return\n"))
    const tryAt = block.indexOf('try {')
    const throwAt = block.indexOf('throw new Error(t(')
    const writeAt = block.indexOf('writeSettings(dshHome, next)')
    return tryAt >= 0 && throwAt > tryAt && writeAt > throwAt
  })(),
  'index.js 的 UA 校验抛错位置不对')
check('面板有 User-Agent 输入框并随保存提交',
  cliSrc.includes("M('User-Agent', 'User-Agent')")
  && cliSrc.includes('userAgent: wdUa'),
  'client.js 缺少 UA 输入或没提交')

// --- #9 反馈附件 ---
check('反馈附件走仓库 assets（不借道第三方图床）',
  idxSrc.includes('uploadFeedbackAsset')
  && idxSrc.includes('/uploads')
  && idxSrc.includes('browser_download_url'),
  'index.js 缺少附件上传实现')
check('附件类型白名单 + 单文件 20MB + 最多 4 个',
  idxSrc.includes('FEEDBACK_ATTACH_MIME')
  && idxSrc.includes('FEEDBACK_MAX_ATTACH_BYTES')
  && idxSrc.includes('FEEDBACK_MAX_ATTACH_COUNT'),
  'index.js 缺少附件限制常量')
check('附件引用进正文（图片用 ![]()，其它用链接）',
  idxSrc.includes('feedbackAttachMarkdown')
  && idxSrc.includes('### 附件 / Attachments'),
  'index.js 缺少附件正文引用')
check('没令牌时明确告知附件没上传（不静默丢弃）',
  idxSrc.includes('pendingAttachments')
  && /附件（.*）没能上传/.test(idxSrc),
  'index.js 缺少无令牌时的附件提示')
check('面板可选图片/视频并随提交发送',
  cliSrc.includes("type: 'file'")
  && cliSrc.includes('accept:')
  && cliSrc.includes('attachments = files.map(')
  && cliSrc.includes('callFeedback({ title, body: text, attachments })')
  && cliSrc.includes('addFiles'),
  'client.js 缺少附件选择或提交')
check('反馈请求体上限放宽到 160MB（否则附件必被 64KB 拦掉）',
  idxSrc.includes('ROUTE_FEEDBACK_MAX_BODY')
  && /readBody\(req, ROUTE_FEEDBACK_MAX_BODY\)/.test(idxSrc)
  && /function readBody\(req, maxBytes = 64 \* 1024\)/.test(idxSrc),
  'index.js 的 body 上限没放宽')
}
// --- #10 平台层（0.6.49 macOS 支持）---
// 这一组是这次 macOS 适配的回归护栏。每条都对应一个真实踩过的坑：
//   - isAppRoot 只认 <root>/resources，于是 macOS 上 AppRoot 恒为空 → 面板「定位不到客户端根目录」；
//   - 版本/Electron 版本写死 <root>/resources 与 <root>/version，macOS 上恒为空；
//   - 仓库路径候选只有 Windows 盘符，macOS 上自动探测永远失败；
//   - 执行体只找 post-exit.ps1 / install-plugin.ps1，macOS 上退出后同步与自更新整条链路死掉。
{
  const repoRootOfTools = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pf = await import(pathToFileURL(join(repoRootOfTools, 'runtime', 'platform.mjs')).href)
  const appRoot = pf.appRootCandidates().find((c) => pf.isAppRoot(c)) || ''
  check('平台识别（IS_WIN / IS_MAC 与 process.platform 一致）',
    pf.IS_WIN === IS_WIN && pf.IS_MAC === (process.platform === 'darwin'),
    `IS_WIN=${pf.IS_WIN} IS_MAC=${pf.IS_MAC} platform=${process.platform}`)
  if (appRoot) {
    check('能定位客户端根（isAppRoot 认得出）', pf.isAppRoot(appRoot), appRoot)
    const layout = pf.appRootLayout(appRoot)
    check('resources 目录随平台归一（macOS 在 Contents/Resources）',
      Boolean(layout.resources) && existsSync(layout.resources), layout.resources)
    check('能读到客户端 app 版本', Boolean(pf.readAppVersion(appRoot)), pf.readAppVersion(appRoot) || '(空)')
    check('能读到 Electron 版本', Boolean(pf.readElectronVersion(appRoot)), pf.readElectronVersion(appRoot) || '(空)')
    check('app.asar 路径落在归一后的 resources 下',
      Boolean(pf.asarPath(appRoot)) && pf.asarPath(appRoot).startsWith(layout.resources), pf.asarPath(appRoot))
  } else {
    console.log('  [SKIP] 客户端根相关断言 — 这台机器上找不到已安装的客户端（appRootCandidates 全不匹配）')
  }
  const defRepo = pf.defaultRepoPath()
  check('默认仓库路径是当前平台的绝对路径',
    defRepo.startsWith(IS_WIN ? '' : '/') && (IS_WIN ? /^[A-Za-z]:\\/.test(defRepo) : !/^[A-Za-z]:/.test(defRepo)),
    defRepo)
  // 形状校验：本平台该拒的必须拒、该放的必须放
  const wrong = IS_WIN ? '/Users/x/dsh-config' : 'D:\\dsh-config'
  check('跨平台形状的路径被 repoPathProblem 拒掉',
    pf.repoPathProblem(wrong).ok === false, JSON.stringify(pf.repoPathProblem(wrong)))
  check('本平台的合法绝对路径被 repoPathProblem 放行',
    pf.repoPathProblem(defRepo).ok === true, JSON.stringify(pf.repoPathProblem(defRepo)))
  check('相对路径被 repoPathProblem 拒掉',
    pf.repoPathProblem(IS_WIN ? 'dsh-config' : 'dsh-config').ok === false)
  // 执行体：两个平台各有一套，缺一个就等于该平台的自动同步/自更新全程失效
  const runtimeDir = join(repoRootOfTools, 'runtime')
  check('退出后执行体名随平台', pf.postExitScriptName() === (IS_WIN ? 'post-exit.ps1' : 'post-exit.mjs'), pf.postExitScriptName())
  check('当前平台的退出后执行体在包里', existsSync(join(runtimeDir, pf.postExitScriptName())), pf.postExitScriptName())
  if (!IS_WIN) {
    check('POSIX 自带插件安装器（install-plugin.mjs）', existsSync(join(runtimeDir, 'install-plugin.mjs')))
    // post-exit.mjs 的参数校验：-Mode 不合法必须当场退出 2，不去等客户端
    const probe = spawnSync(process.execPath, [join(runtimeDir, 'post-exit.mjs'), '-Mode', 'bogus'], { encoding: 'utf8', timeout: 8000 })
    check('post-exit.mjs 拒绝非法 -Mode（退出码 2）', probe.status === 2, `status=${probe.status} ${String(probe.stderr || '').slice(0, 120)}`)
  }
  // 进程判据：踩过的坑 —— 按进程名模糊匹配会命中我们自己的 Node 执行体
  // （命令行里带着 /Applications/DeepSeek Harness.app/Contents/Resources/.../node post-exit.mjs），
  // 于是「客户端已退出」永远判成「还在运行」，退出后同步一直等到超时；pkill 更会自杀。
  const fakeNodeLine = join(appRoot || '/Applications/DeepSeek Harness.app', 'Contents', 'Resources', 'runtime',
    'primary-runtime', 'dependencies', 'node', 'bin', 'node') + ' post-exit.mjs -Mode push'
  check('进程判据：客户端本体命令行算「在运行」',
    pf.looksLikeClientProcess(pf.clientExecutable(appRoot) || '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', appRoot) === true)
  check('进程判据：自己的 Node 执行体不算「客户端在运行」',
    pf.looksLikeClientProcess(fakeNodeLine, appRoot) === false, fakeNodeLine)
  check('进程判据：能列出当前客户端进程（数组或 null）',
    Array.isArray(pf.listClientProcesses(appRoot, process.pid)) || pf.listClientProcesses(appRoot, process.pid) === null)
  check('pgrep 用的模式里带可执行文件路径（不是光秃秃的进程名）',
    /Contents.*MacOS|DeepSeek Harness/.test(pf.clientProcessPattern(appRoot)), pf.clientProcessPattern(appRoot))

  const hostSrc = readFileSync(join(repoRootOfTools, 'index.js'), 'utf8')

  // ── 会话记录（conversations 组）：0.6.49 起 Node 引擎也做，跨机往返要能对上 ──
  {
    const conv = await import(pathToFileURL(join(repoRootOfTools, 'runtime', 'conversations.mjs')).href)
    // 编码：POSIX 绝对路径要丢掉开头那个 `/`，否则会多出一根横线（`---Users-…--`），
    // DSH 自己的目录名是 `--Users-…--` —— 差这一个字符，工作区映射全线对不上（实测 0/5 命中）。
    check('会话目录编码：POSIX 绝对路径不多出前导横线',
      conv.sessionDirName('/Users/huanyu/projects/x') === '--Users-huanyu-projects-x--',
      conv.sessionDirName('/Users/huanyu/projects/x'))
    check('会话目录编码：Windows 盘符路径与 PowerShell 版一致',
      conv.sessionDirName('D:\\DeepSeekHarness\\SquadLink') === '--D-DeepSeekHarness-SquadLink--',
      conv.sessionDirName('D:\\DeepSeekHarness\\SquadLink'))
    check('仓库稳定目录名：--ws-<id>-- / --im-- / 原名穿透',
      conv.repoSessionDirName('ws', 'abc-123', 'local') === '--ws-abc-123--'
      && conv.repoSessionDirName('im', '', 'local') === '--im--'
      && conv.repoSessionDirName('', '', 'local') === 'local')
    check('默认工作区判定', conv.isDefaultWorkspaceDir('--x-default-workspace--') === true
      && conv.isDefaultWorkspaceDir('--Users-x--') === false)
    // 真实文件名长这样：session.v4.jsonl.zstd / session.v12.jsonl（`session-<uuid>` 是**目录名**，不是文件）
    check('会话日志文件名判定只认 session[.vN].jsonl(.zstd)',
      conv.isSessionLogFile('s/session.v4.jsonl.zstd') === true
      && conv.isSessionLogFile('s/session.v12.jsonl') === true
      && conv.isSessionLogFile('s/notes.md') === false
      && conv.isSessionLogFile('s/session.v4.jsonl.bak') === false)

    // 端到端：A 机抓取 → B 机（工作区路径不同）铺回
    const stage = mkdtempSync(join(tmpdir(), 'cfg-sync-conv-'))
    const homeA = join(stage, 'homeA'), homeB = join(stage, 'homeB'), repoC = join(stage, 'repo')
    const wsA = '/Users/alpha/projects/demo'
    const wsB = '/Users/beta/work/demo'
    mkdirSync(join(homeA, 'storages'), { recursive: true })
    writeFileSync(join(homeA, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { 'ws-1': { path: wsA } } } }))
    mkdirSync(join(homeA, 'sessions', conv.sessionDirName(wsA), 's1'), { recursive: true })
    writeFileSync(join(homeA, 'sessions', conv.sessionDirName(wsA), 's1', 'session.v4.jsonl'), '{"seq":1}\n{"seq":2}\n')
    mkdirSync(join(homeA, 'sessions', '--Users-alpha-Documents-default-workspace--', 's2'), { recursive: true })
    writeFileSync(join(homeA, 'sessions', '--Users-alpha-Documents-default-workspace--', 's2', 'session.v4.jsonl'), '{"seq":1}\n')
    mkdirSync(join(homeA, 'attachments', 's1'), { recursive: true })
    writeFileSync(join(homeA, 'attachments', 's1', 'shot.png'), 'png\n')
    const cap = conv.captureConversations({ repoRoot: repoC, dshHome: homeA })
    check('会话抓取：默认工作区不入库、已登记工作区用稳定名',
      cap.ok === true && existsSync(join(repoC, 'conversations', 'sessions', '--ws-ws-1--', 's1', 'session.v4.jsonl'))
      && !JSON.stringify(readdirSync(join(repoC, 'conversations', 'sessions'))).includes('default-workspace'),
      JSON.stringify(cap.notes))
    check('会话抓取：写出 session-index.json（记 workspaceId）',
      JSON.parse(readFileSync(join(repoC, 'conversations', 'session-index.json'), 'utf8')).entries
        .some((e) => e.dir === '--ws-ws-1--' && e.workspaceId === 'ws-1'))
    const cap2 = conv.captureConversations({ repoRoot: repoC, dshHome: homeA })
    check('会话抓取幂等（内容没变不重写）', cap2.files === 0, `files=${cap2.files}`)
    mkdirSync(join(homeB, 'storages'), { recursive: true })
    writeFileSync(join(homeB, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { 'ws-1': { path: wsB } } } }))
    const guardScript = conv.resolveGuardScript([join(repoRootOfTools, 'runtime', 'tools', 'session-log-guard.mjs')])
    const app = conv.applyConversations({ repoRoot: repoC, dshHome: homeB, guardScript, backupRoot: join(homeB, 'backups', 'apply-test') })
    check('会话铺回：按本机工作区路径重新编码目录名',
      app.ok === true && existsSync(join(homeB, 'sessions', conv.sessionDirName(wsB), 's1', 'session.v4.jsonl')),
      JSON.stringify(app.errors))
    // 护栏是 CLI 调用的（与 PowerShell 侧同一条路）：位置要能找到，坏档要返回 corrupt 而不是抛异常
    check('会话护栏：能在 runtime/tools 找到（发布包里那份）',
      guardScript.endsWith(join('runtime', 'tools', 'session-log-guard.mjs')))
    {
      const junkA = join(stage, 'junk-a.jsonl'), junkB = join(stage, 'junk-b.jsonl')
      writeFileSync(junkA, '{"seq":1}\n')
      writeFileSync(junkB, '{"seq":9}\n')
      const verdict = conv.decideViaGuardCli(guardScript, junkA, junkB)
      // 非 zstd 的源会被判「无法解析」→ keep_dst（不许覆盖），这正是我们要的保守行为
      check('会话护栏：读不懂的源判 keep_dst（不覆盖），且不抛异常',
        verdict && verdict.action === 'keep_dst' && verdict.ok === false,
        String(verdict && verdict.detail).slice(0, 80))
    }
    check('会话铺回：内容字节一致 + 附件一起回来',
      readFileSync(join(homeB, 'sessions', conv.sessionDirName(wsB), 's1', 'session.v4.jsonl'), 'utf8')
        === readFileSync(join(homeA, 'sessions', conv.sessionDirName(wsA), 's1', 'session.v4.jsonl'), 'utf8')
      && existsSync(join(homeB, 'attachments', 's1', 'shot.png')))
  }

  // ── 插件数据 / 额外路径（0.6.49 起 Node 引擎也做；规则在 runtime/extra-rules.mjs，面板与引擎共用）──
  {
    const rules = await import(pathToFileURL(join(repoRootOfTools, 'runtime', 'extra-rules.mjs')).href)
    const rulesHome = mkdtempSync(join(tmpdir(), 'cfg-sync-rules-'))
    const cfg = rules.readExtraConfig(rulesHome)
    check('规则模块：缺配置时用默认名单（含 *vault* / browser-profiles）',
      cfg.pluginData.exclude.includes('*vault*') && cfg.pluginData.skipDirs.includes('browser-profiles')
      && !cfg.pluginData.missingMandatory)
    // 用户把安全必需项删掉：读的时候必须补回来，并且说出来补了什么（不静默改用户口径）
    writeFileSync(join(rulesHome, 'config-sync-extra.json'), JSON.stringify({
      version: 1, pluginData: { enabled: true, maxFileBytes: 104857600, exclude: ['*.tmp'], skipDirs: ['logs'] },
    }))
    const cfg2 = rules.readExtraConfig(rulesHome)
    check('规则模块：用户删掉的安全必需项会被补回并记下',
      cfg2.pluginData.skipDirs.includes('browser-profiles')
      && cfg2.pluginData.exclude.includes('Login Data')
      && cfg2.pluginData.missingMandatory.skipDirs.includes('browser-profiles')
      && cfg2.pluginData.exclude.includes('*.tmp')
      && cfg2.pluginData.exclude.includes('*vault*') === false)
    check('规则模块：单文件超限 / 通配排除 / 正常放行',
      rules.extraSkipReason('a/x.json', 200 * 1024 * 1024, cfg) === 'too-big'
      && rules.extraSkipReason('a/x.db', 10, cfg) === 'excluded'
      && rules.extraSkipReason('a/x.json', 10, cfg) === '')
  }

  // ── 插件设置与工作流（settings 组）+ 凭据嗅探（0.6.49 起 Node 引擎也做）──
  {
    const rules = await import(pathToFileURL(join(repoRootOfTools, 'runtime', 'extra-rules.mjs')).href)
    const secStage = mkdtempSync(join(tmpdir(), 'cfg-sync-sec-'))
    const put = (name, content) => { const p = join(secStage, name); writeFileSync(p, content); return p }
    check('凭据：名字与内容两道门都生效（.env / 私钥名 / apiKey / GH 令牌 / PEM 头）',
      rules.looksSecretFile(put('.env', 'A=1'), '.env') === true
      && rules.looksSecretFile(put('id_rsa', 'x'), 'id_rsa') === true
      && rules.looksSecretFile(put('s1.json', '{"apiKey":"sk-1"}'), 's1.json') === true
      && rules.looksSecretFile(put('s2.json', '{"t":"ghp_abcdefghijklmnopqrstuvwxyz"}'), 's2.json') === true
      && rules.looksSecretFile(put('s3.txt', '-----BEGIN OPENSSH PRIVATE KEY-----'), 's3.txt') === true
      && rules.looksSecretFile(put('ok.json', '{"theme":"dark"}'), 'ok.json') === false)
    const src = await import(pathToFileURL(join(repoRootOfTools, 'runtime', 'settings-sources.mjs')).href)
    {
      const hostText = readFileSync(join(repoRootOfTools, 'index.js'), 'utf8')
      check('设置源清单 14 项，且与面板共用一份', src.SETTINGS_SOURCES.length === 14
        && hostText.includes("from './runtime/settings-sources.mjs'")
        && hostText.includes('const SYNC_SETTINGS_SOURCES = SETTINGS_SOURCES'))
    }
    check('易变计数清零只动数字', src.zeroVolatileFields('{"reloadCount": 42, "catalogSyncedAt": 1734567890, "keep": 7}', 'our-free-model.json')
      === '{"reloadCount": 0, "catalogSyncedAt": 0, "keep": 7}')
  }

  // profile 组要带上「哪些插件开着」：cordis.yml 丢了，换台机器就不是同一套插件
  {
    const engText = readFileSync(join(repoRootOfTools, 'runtime', 'sync-engine.mjs'), 'utf8')
    check('引擎抓取 profile 文件含 cordis.yml / pnpm-workspace.yaml',
      engText.includes("copy(join(profileDir, 'cordis.yml'), 'profile/cordis.yml')")
      && engText.includes("copy(join(profileDir, 'pnpm-workspace.yaml'), 'profile/pnpm-workspace.yaml')")
      && engText.includes("pull('profile/cordis.yml', join(profileDir, 'cordis.yml'))"))
  }

  // 同步范围卡必须按平台说实话：非 Windows 只同步四组，其余八组要在 GET /scope 里
  // 带 supported:false，面板据此禁用勾选 —— 让人勾着却永不生效是最糟的「看起来能用」。
  // 直接用字符串包含比正则稳（这行里有 ? : . ( ) 五类元字符，写正则容易自己咬自己）
  check('scope GET 按引擎能力给出 supported（非 Windows 只认四组）',
    hostSrc.includes('supported: ENGINE_SYNCED_GROUPS ? ENGINE_SYNCED_GROUPS.has(g.id) : true')
    && hostSrc.includes('engineGroups: ENGINE_SYNCED_GROUPS ? [...ENGINE_SYNCED_GROUPS] : null'))
  check('面板：不支持的组禁用勾选并写明原因',
    readFileSync(join(repoRootOfTools, 'client.js'), 'utf8').includes('!supported')
    && readFileSync(join(repoRootOfTools, 'client.js'), 'utf8').includes('此平台暂不支持'))

  // 符号链接形式的仓库路径（macOS 实测）：/var 与 /tmp 都指向 /private/...，git 报真实路径，
  // 只比字面量会把用户填的路径判成「不是仓库根」，面板「立即推送」直接失败。
  if (!IS_WIN) {
    const linkStage = mkdtempSync(join(tmpdir(), 'cfg-sync-link-'))
    const realRepo = join(linkStage, 'real-repo')
    const linkRepo = join(linkStage, 'link-repo')
    mkdirSync(join(realRepo, 'profile'), { recursive: true })
    writeFileSync(join(realRepo, 'profile', 'package.json'), '{"name":"dsh-profile-desktop"}', 'utf8')
    const g = (...a) => spawnSync('git', a, { encoding: 'utf8', timeout: 20000 })
    g('init', '-q', '-b', 'main', realRepo)
    g('-C', realRepo, 'add', '-A')
    g('-C', realRepo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed')
    symlinkSync(realRepo, linkRepo, 'dir')
    const linkHome = join(linkStage, 'home')
    mkdirSync(join(linkHome, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(linkHome, 'profiles', 'desktop', 'package.json'), '{"name":"dsh-profile-desktop"}', 'utf8')
    // capture 会把引擎模块写进仓库根，所以这里只需要一个能跑的目录
    const r = spawnSync(process.execPath, [join(runtimeDir, 'sync-engine.mjs'), 'push', '-RepoRoot', linkRepo, '-DshHome', linkHome], { encoding: 'utf8', timeout: 120000 })
    const out = String(r.stdout || '') + String(r.stderr || '')
    check('符号链接路径的仓库不被误判成「不是仓库根」',
      !/不是仓库根/.test(out), out.split('\n').filter((l) => l.trim()).slice(-3).join(' | '))
    // 没有 origin 是这套夹具的预期（不该为此伪造远端）：认的是「没被路径判据挡住」，
    // 也就是走到了 git 那一步才失败，而不是一进门就报「不是仓库根」。
    check('符号链接路径下 push 能走到 git 那一步（只差 origin）',
      (r.status === 0 || /origin|远程仓库|not configured|没有/.test(out)) && !/不是仓库根/.test(out),
      `exit=${r.status} stdout=${String(r.stdout || '').length}B stderr=${String(r.stderr || '').length}B`)
    rmSync(linkStage, { recursive: true, force: true })
  } else {
    console.log('  [SKIP] 符号链接夹具 — Windows 上用 junction，语义不同，另测')
  }

  // 后台自动拉取（启动时那条）在 macOS 上不能弹原生框：那条路径没有请求也没有面板，
  // osascript 的 display dialog 常被窗口挡住 → 用户看不见、自动拉取永不发生（实测踩过）。
  // 现在 POSIX 只挂 status.auto.pullPrompt + 日志，由面板一键接手；Windows 保持原样。
  check('后台自动拉取：只在 Windows 弹原生确认框',
    /if \(IS_WIN\) \{\s*\r?\n\s*yes = await askConfirm\(title, text\)/.test(hostSrc),
    'index.js 的 scheduleAutoStart 分支没有按平台区分确认方式')
  check('后台自动拉取：POSIX 挂 pullPrompt 并写日志（面板可接手）',
    hostSrc.includes('autoState.pullPrompt = { behind: drift.behind')
    && hostSrc.includes('auto-sync-pull-prompt.log'))
  check('status 暴露 auto.pullPrompt（否则面板无从提示）',
    /pullPrompt: autoState\.pullPrompt \|\| null/.test(hostSrc))
  check('排队拉取后清掉 pullPrompt（不然提示一直挂着）',
    /autoState\.pullPrompt = null/.test(hostSrc))

  // 私钥判据必须两处共用同一份正则（webdav 上传侧 + capture 侧），否则一边加了
  // id_ed25519、另一边照旧放行 —— 用户把 ~/.ssh 加进额外路径就会漏传私钥。
  const engineSrc = readFileSync(join(runtimeDir, 'sync-engine.mjs'), 'utf8')
  const webdavSrc = readFileSync(join(runtimeDir, 'webdav.mjs'), 'utf8')
  check('私钥判据：webdav.mjs 导出 SSH_KEY_NAME_RE / PRIVATE_KEY_BODY_RE',
    /export const SSH_KEY_NAME_RE/.test(webdavSrc) && /export const PRIVATE_KEY_BODY_RE/.test(webdavSrc))
  check('私钥判据：sync-engine 引用同一份正则（不是各写一份）',
    /SSH_KEY_NAME_RE/.test(engineSrc) && /PRIVATE_KEY_BODY_RE/.test(engineSrc)
    && /from '\.\/webdav\.mjs'/.test(engineSrc))
  check('WebDAV 通道自检存在（tools/webdav-selftest.mjs，离线、可被 CI 跑）',
    existsSync(join(repoRootOfTools, 'tools', 'webdav-selftest.mjs')))

  // POSIX 自更新链路的参数名必须是安装器那套（-TgzFile / -TgzUrls）。
  // 实测踩过：post-exit.mjs 把自己的 -UpdateTgz 直接转给安装器，安装器不认 → 更新永远
  // 报「没有可用的下载地址」，而面板显示「正在安装」。
  const postExitSrc = readFileSync(join(runtimeDir, 'post-exit.mjs'), 'utf8')
  check('post-exit 传给安装器的是 -TgzFile（不是它自己的 -UpdateTgz）',
    postExitSrc.includes("'-TgzFile'") && !/-TgzFile'?,\s*updateTgz/.test(''), 'post-exit.mjs')
  check('安装器同时接受 -TgzFile 与 -TgzUrls',
    readFileSync(join(runtimeDir, 'install-plugin.mjs'), 'utf8').includes("a.TgzFile")
    && readFileSync(join(runtimeDir, 'install-plugin.mjs'), 'utf8').includes("a.TgzUrls"))
  // 执行体优先级：插件自带优先（旧顺序把仓库那份老引擎排前面，新参数会被当未知参数忽略）
  check('post-exit 优先用插件自带引擎', postExitSrc.indexOf("join(SELF_DIR, 'sync-engine.mjs')") < postExitSrc.indexOf("repoRoot ? join(repoRoot, 'sync-engine.mjs')"))

  // 真跑一次安装器（只在本机能 tar 打包时）：正确 sha256 装成功、错误 sha256 拒绝且不动目标
  const tarOk = spawnSync('tar', ['--version'], { encoding: 'utf8' }).status === 0
    || spawnSync('tar', ['-h'], { encoding: 'utf8' }).status === 0
  if (!IS_WIN && tarOk) {
    const stage = mkdtempSync(join(tmpdir(), 'cfg-sync-pkg-'))
    const pkg = join(stage, 'package')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-profile-config-sync', version: '9.9.9' }), 'utf8')
    writeFileSync(join(pkg, 'index.js'), 'export function apply() {}\n', 'utf8')
    const tgz = join(stage, 'pkg.tgz')
    const packed = spawnSync('tar', ['-czf', tgz, '-C', stage, 'package'], { encoding: 'utf8' })
    const target = join(stage, 'plugin')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'old.txt'), 'keep', 'utf8')
    const home9 = join(stage, 'home')
    const runInstaller = (extra) => {
      const r = spawnSync(process.execPath, [
        join(runtimeDir, 'install-plugin.mjs'), '-PluginDir', target, '-Version', '9.9.9',
        '-TgzFile', tgz, '-DshHome', home9, ...extra,
      ], { encoding: 'utf8', timeout: 60000 })
      const line = String(r.stdout || '').split(/\r?\n/).filter((l) => l.startsWith('RESULT:')).pop()
      try { return JSON.parse(String(line).slice('RESULT:'.length)) } catch { return { ok: false, error: String(r.stderr || '').slice(0, 200) } }
    }
    const good = runInstaller([])
    check('安装器：不带校验值也能装上（本地包）', good.ok === true, JSON.stringify(good))
    check('安装器：覆盖后旧文件被清掉（不留旧版本残留）', !existsSync(join(target, 'old.txt')))
    // 换回一个旧文件，再用错误 sha256 试：必须拒绝且目标目录原样
    writeFileSync(join(target, 'marker.txt'), 'keep', 'utf8')
    const bad = runInstaller(['-Sha256', 'deadbeef'])
    check('安装器：sha256 不匹配时拒绝安装', bad.ok === false && /sha256 不匹配/.test(bad.error || ''), JSON.stringify(bad))
    check('安装器：拒绝时目标目录没被动过', existsSync(join(target, 'marker.txt')))
    rmSync(stage, { recursive: true, force: true })
  } else {
    console.log('  [SKIP] 安装器真跑夹具 — 这台机器没有可用的 tar（或 Windows）')
  }

  // 面板/宿主文案里不该再出现 macOS 上跑不通的 .ps1 硬编码
  const idxSrc2 = readFileSync(join(repoRootOfTools, 'index.js'), 'utf8')
  check('宿主不再无条件调 powershell 生成执行体（按平台分支）',
    idxSrc2.includes('postExitScriptName()') && idxSrc2.includes("if (!IS_WIN)"),
    'index.js 缺少平台分支')
}

try { restoreOrigin() } catch { /* 还原失败不该改变自检结论 */ }
process.exit(failures === 0 ? 0 : 1)

