# 字段、接口与实现细节

> README 只写「怎么用、行为是什么」。这一份是给它留细节的地方：字段级语义、接口形状、路径解析顺序、排障对照表。
> 历史演进见 [HISTORY.md](HISTORY.md)，验证记录见 [CHANGELOG.md](CHANGELOG.md)。

<a id="files"></a>

## 包含什么

| 路径 | 说明 |
|---|---|
| `index.js` | 宿主半身：`/config-sync/status`、`prepare`、`settings`、`auto`、`update`、`scope`、`extra-config`、`conflict` 路由 |
| `client.js` | 浏览器半身：侧栏行、面板、设置摘要行 |
| `cordis.patch.yml` | bundle 补丁层（`id: config-sync`） |
| `runtime/` | 执行体：7 个 PowerShell 脚本（`capture` / `apply` / `sync` / `restore` / `post-exit` / `common` / 自更新）+ Node 引擎 `sync-engine.mjs`（macOS/Linux）+ `conversations.mjs`（会话记录组）+ `webdav.mjs`（WebDAV 传输）+ `extra-rules.mjs`（插件数据 / 额外路径的规则，面板与引擎共用一份）+ `tools/`（会话 seq 护栏、cwd 修正等，随包发布） |
| `tools/` | `selftest.mjs`、`clientcheck.mjs`、`pack-plugin.ps1`（**只在源码仓库**，不进安装包） |
| `version.json` / `releases/` | 自更新清单与安装包（同样只在仓库） |

`tools/` 不在安装副本里，所以 `node tools\selftest.mjs` 这类自检要在仓库里跑；插件运行时也不需要它们（`version.json` 从 GitHub raw 读）。

<a id="slots"></a>

## 入口挂在哪（细节）

| 入口 | slot | 说明 |
|---|---|---|
| 左侧栏一行 | `sidebar.panellist`（`id: config-sync`） | 标题「配置备份与同步」/ 英文 Config Backup & Sync，与「插件 / 自动任务 / 技能市场 / 记忆系统」同列 |
| 点开的面板 | `main`（`key: config-sync`） | 两条 register 必须在**嵌套 inject** 里成对完成：只 inject `main` 时向 `sidebar.panellist` register 无效 |
| 设置摘要行 | `settings.general.item` | 一行四态 chip + 展开（仓库、远端、私钥） |

<a id="fromscratch"></a>

## 从零跑通的细节

### 源机器 A：初始化推送做了什么

面板 → 「本机仓库」填空目录或已有仓库 → 「云端仓库」填远端 → 点「初始化推送」。它依次：

`git init` → 补 `origin` → 把 runtime 的 6 个执行体（`apply.ps1` / `capture.ps1` / `sync.ps1` / `restore.ps1` / `post-exit.ps1` / `dsh-sync-common.ps1`）+ `tools\fix-session-cwd.mjs` 拷进仓库根 → 写 `profile\host-contract.json`（本机客户端版本）→ `capture` 抓配置 → 提交 → `push -u origin main`。

隔离环境首次推送的真实产物（15 个文件、commit `3fa3780`）：

```
apply.ps1  capture.ps1  dsh-sync-common.ps1  post-exit.ps1  restore.ps1  sync.ps1  tools/fix-session-cwd.mjs
profile/package.json  profile/cordis.patch.yml  profile/host-contract.json
settings/dsh-workspaces.json
workspace/workspace-registry.json  workspace/default-workspace/notes.md
conversations/session-index.json  conversations/session_projcache/s1.json
```

### 目标机器 B：首次拉取的检查项

1. 装**同版本**客户端并**启动一次**（只为生成 `profiles\desktop`，可马上关）。
2. 装插件，填「本机仓库」（空目录即可）与「云端仓库」（同一远端）。
3. 点「拉取」：先列出「本机领先几个提交 / 几项未提交」，确认才动手（会用仓库版本覆盖本机配置）。
4. 起来后检查三件事：工作区列表有、点开历史会话能回原工作区、插件页依赖齐全。

首次拉取的真实输出（`pull_rc=0`）：

```
[OK] 宿主版本一致（app = 0.2.2）
[OK] 已还原工作区「default-workspace」→ <B>\app\workspace\SquadLink（1 个文件，字节保真）
[OK] 工作区登记表已按 ID 合并 → <B>\home\storages\workspace.json（1 个工作区）
[OK] 会话 projcache 的 cwd 已对齐本机路径：修正 1 个
[OK] 会话数据全量还原：写入/更新 1 个文件、备份 1 个
[OK] 全部 0 个插件依赖已就位
```

`-SkipInstall` 跳过 `pnpm install`（隔离/离线必须加）；`-Force` 跳过「检测到 DSH 在运行」的保护（真机请先退出，别用）。

### 最容易踩的五个点

| 现象 | 原因 | 办法 |
|---|---|---|
| `参数里的 -AppRoot 对不上，已自动改用：D:\DeepSeekHarness` | `Resolve-DshAppRoot` 只认目录里有 `resources\app.asar` 或 `resources\app\package.json`；假客户端/绿色版少了这两个就退回注册表里的真实安装 | 显式传 `-AppRoot` 时确保该目录有这两者之一 |
| `[X] 已停止（未抓取、未提交）` | 检测到 `DeepSeek Harness.exe` 在跑，怕抓到写了一半的 `cordis.patch.yml` | 完全退出（含托盘）后重跑，或加 `-Force` |
| `目标 profile 不存在` | 新机器的 `.dsh` 还没被客户端初始化过 | 先装同版本客户端并启动一次 |
| `本机没有可用的内置运行时` | `<AppRoot>` 下没有 node.exe / 客户端本体 | 装完整客户端；否则会话 cwd 不会被改写、会话列表为空 |
| 工作区资料到了，但 `~\.dsh\settings.json` 里的自定义键没同步 | 插件配置是**白名单制**（13 项逐个文件），不整份搬 `settings.json` | 确认要同步的键属于白名单（见 README「插件配置跟得走」） |

<a id="extra"></a>

## `config-sync-extra.json` 字段

| 字段 | 含义 |
|---|---|
| `pluginData.enabled` | 插件数据整组开关（与「同步内容」里那一行联动） |
| `pluginData.maxFileBytes` | 单文件上限，**硬顶 104857600（100 MB，GitHub 单文件硬限）**，填大了也按 100 MB 算 |
| `pluginData.exclude` | 排除名单，通配、一行一条，**整份替换**（清空就真的不排除任何文件） |
| `pluginData.skipDirs` | 自动枚举时跳过的一级目录名，同样整份替换 |
| `extra.enabled` / `extra.paths[]` | 额外路径整组开关与路径清单（`{id,src,label}`，src 必须绝对路径） |

完整默认排除名单（62 条）：

`*.db` `*.db-*` `*.sqlite*` `*.db-shm` `*.db-wal` · `*.node` `*.exe` `*.dll` `*.asar` `*.pak` `*.bin` `*.img` `*.iso` · `*.zip` `*.7z` `*.rar` `*.tar` `*.gz` `*.tgz` · `*.mp4` `*.mkv` `*.avi` · `*.log` `*.log.*` · `*.tmp` `*.bak` `*.bak-*` `*.old` `*.orig` `*.swp` · `api-key` `*.pem` `*.key` `*.p12` `*.pfx` `*.crt` · `*cache*` `*token*` `*secret*` `*credential*` `*password*` · `*vault*` · `node_modules` `.git` `.cache` `__pycache__` `.venv` · `browser-profiles` `User Data` `Login Data` `Cookies` `Web Data` `Local State`

**为什么排掉缓存/令牌/数据库**：`*cache*` / `*token*` 这类「每次运行都变」的文件会让每次推送都有 diff；`.db` 常被插件自己锁着写，跨机器还原容易坏。

**额外路径放标准根下更稳**：在 `~\.dsh\`、客户端目录、工作区根之下会被归一成占位符；放在别处（如 `D:\tmp\xxx`）只能按同一绝对路径铺，对方机器没这个路径就跳过并 `[!]` 提示。清单里的路径若展开后仍有未配置的占位符，apply 跳过该槽并提示，不会把 `{{DSH_HOME}}` 原样写进插件配置。

`restore.ps1 -FromCommit` 的范围**只有提交里的 `profile\`**（脚本第一行就写「来源：git 提交 … 的 profile\」）：`profile\package.json`、`cordis.patch.yml`、`host-contract.json` 这些决定客户端能不能起来的东西。`prompt\AGENTS.md`、`skills\`、`settings\` **不在范围**，要全量请用 `sync.ps1 pull`。

<a id="checks"></a>

## 两条体检的明细

**推送之后（capture 末尾）**：扫仓库里的**配置类文件**（`settings\*.json`、`profile\*.json`、`skills\`、`presets\`、`prompt\`、顶层 json；`conversations/workspace/mnemon/storages-record` 是会话与运行时数据，换机本就不该一致，不参与），把**不属于任何已确认根**的绝对路径抓出来，写 `~\.dsh\config-sync-absolute-paths.json`（带 `machine` 与写它时各根的值），控制台 `Warn` 一句。**不拦提交**。

**这份清单只对「接收方」有意义**（0.3.43）：清单是推送时写的，本机推出去的路径在本机当然都在，摊在本机面板上只会让人以为出问题（实测 50 条里 40 多条是 `conversations\session_projcache`）。面板先比清单里的 `machine` 与本机机器名：

- 清单来自本机 → 不显示、不计入告警数（`status.localPaths.absolute` 归 0）。
- 清单来自另一台机器 → 显示「这份配置是 `<机器名>` 推送的」，并**逐条给推荐目录**：先拿报告里记着的对方根值做前缀映射（`F:\DSH\SquadLink` → 本机 `<APP_ROOT>\SquadLink`，保留原大小写）；没有根可映射就按最后一级目录名在本机几个根、用户主目录、桌面、各盘根下找同名目录；都没有就明说「本机没有等价目录」。
- 每行一个「采纳」：点一下把推荐目录记进本机自选目录（`{{ROOT:<key>}}`），下次推送起变成占位符；已采纳的行显示「已采纳」。
- 顺带过滤正则误匹配：`s://1v3.apiipu.com/...` 以前被当成 `s:` 盘符，现在含 `://` 直接跳过。

**拉取之前（apply 写 settings 前）**：铺配置是整份 `WriteAllText` 覆盖，改完路径没推送就点拉取，改动会被静默盖回去。所以覆盖前先比一次：本机现状（归一化成占位符、CRLF 拉平成 LF、`our-free-model.json` 的 `catalogSyncedAt/reloadedAt/reloadCount` 一起置 0）与仓库版本不一样，就记进 `~\.dsh\config-sync-overwrite.json`，面板提示「有 N 份配置被仓库版本覆盖（本机改动已先备份）」。想保住本机改动：**先推送，再拉取**。

**「本机路径」卡**：平时整块不渲染，入口只有标题行按钮；三类都算告警（待确认路径、仓库里有根外绝对路径、上次拉取覆盖了本机配置），`status.localPaths.alert` 给合计，按钮变橙显示「本机路径 · N 项告警」。默认只读，点「修改」才变输入框；编辑态多三件事：每个根右边「用探测值」、每个自选目录右边「删除」、底部「新增目录」（键名只接受字母数字 `_ . -`）。这一卡的值**优先级最高**：保存过的根压过脚本探测值，填错不是「没生效」而是真的按错值展开成死路径。

<a id="api"></a>

## 接口与路径

| 接口 | 说明 |
|---|---|
| `GET /config-sync/status` | 体检 JSON（`repo.*`（`source/configured/phase/empty/remoteHeads/remoteFiles/pushAllowed/pullAllowed`）、`remote.*`、`backup.*`、`local.{lastSyncAt,pending}`、`auto.lastResult`、`auto.pullPrompt`、`auto.livePush`、`conflicts`、`localPaths`） |
| `POST /config-sync/prepare` | `{action:'push'\|'pull'\|'restore'\|'restore-backup'\|'all', message?, backupDir?}`；空目录上按云端文件数分流 |
| `POST /config-sync/settings` | 校验 → 写设置 →（地址变了才动 git），失败回滚并 400 |
| `POST /config-sync/auto` | `{action:'check'\|'pull-now'\|'push-now'\|'push-live'\|'restore-preview'\|'restore-now'\|'cancel'}`，都不带 `/F` 关闭客户端（走正常退出，配置能存下来）。`push-live` 是**不关闭 DSH** 的后台推送，进度走 `status.auto.livePush`（`phase` / `message` / `recent[]` / `log`）；可选 `{confirmed:true}` 跳过宿主侧的确认框（只有面板会带，宿主对非面板调用仍走原生确认） |
| `GET/POST /config-sync/update` | `{action:'check'\|'install-live'\|'restart'\|'apply'}` |
| `GET/POST /config-sync/scope` | 十二组同步范围读写 |
| `GET/POST /config-sync/extra-config` | 规则读写（`{config:{pluginData:{enabled,maxFileBytes,exclude,skipDirs},extra:{enabled,paths[]}}}`，id 去重、路径必须绝对、上限按 100 MB 压；GET 另带 `defaults` 供「恢复默认」） |
| `GET/POST /config-sync/conflict` | GET 读清单（每项带 `localSaved`/`cloudSaved`）；POST `{items:[{path,choice}]}` 存选择、`{action:'restore',path,side}` 单项还原、`{action:'reset'}` 放弃清单。还原按清单记录的 `repo` 路径写，改过 `repoPath` 也不会写错仓库 |
| `GET/POST /config-sync/webdav` | GET 回显当前配置（`url`/`user`/`dir`/`userAgent`/`mode`/`hasPassword`/`secure`）与连通性探测结果（`probe`，含 `error`、`status`、`userAgent`）；POST `{action:'save'\|'test'\|'upload'\|'download', url?, user?, pass?, dir?, mode?, userAgent?}`。`userAgent` 非法（换行 / 非 ASCII / 超 200 字符）直接 400，不静默存成空 |
| `GET/POST/PATCH /config-sync/feedback` | GET 读 Issue 列表与连接状态；POST 提交（`{title, body, attachments?}`，附件为 `{name, type, data(base64)}`）、存令牌（`?action=token`）、补发队列（`?action=flush`）；PATCH 改状态（`?number=`）。附件先传成仓库 release assets，再把 URL 引进正文 |

跨站请求 403。客户端只 `fetch` 这几条，不 import 任何 `@deepseek-ai/dsh-client-*`，样式只用 `--dsw-alias-*` token。

**路径解析**：仓库按 README 的优先级；客户端根 `config.appRoot` 优先，留空由插件自身位置推出，换机不用改；`.dsh` 为 `config.dshHome` → `%DSH_HOME%` → `~\.dsh`。

**本机私有文件**（都在 `~\.dsh\`，不进仓库）：`config-sync-roots.json`、`config-sync-pending-paths.json`、`config-sync-absolute-paths.json`、`config-sync-overwrite.json`、`config-sync-scope.json`、`config-sync-extra.json`、`config-sync-state.json`、`dsh-config-sync.json`（仓库/远端/私钥/备份根）、`sync-conflicts.json`、`auto-sync-result.json`、`auto-sync.lock`、`config-sync-gh.json`（反馈令牌）。

## 问题反馈的机制

1. 填标题 + 详情 → `POST /repos/huanyu-a/dsh-profile-config-sync/issues`，label `feedback`，正文末尾自动附环境块（插件版本、机器名、时间、平台、安装目录、配置仓库路径）。
2. 列表直接读 Issue（`state=all&labels=feedback`），点标题去 GitHub 网页；「已解决」→ `PATCH issue {state:'closed'}`。
3. 顶上连接状态三态：`已用 xxx 登录` / `令牌不属于所有者（只能读和提交）` / `匿名读取（提交走浏览器）`。
4. **读不需要令牌**（公开仓匿名 60 次/小时·每 IP；有令牌 5000）；**没令牌也能提交**（预填 GitHub 新建页，浏览器登录着点 Submit）。
5. **关单只有仓库所有者能点**：先 `GET /user` 认令牌归属，`login` 与仓库所有者不一致就 403。
6. **令牌不用手填**：默认从 `git credential fill` 取一次，存 `<dshHome>\config-sync-gh.json`（本机私有）；取不到才粘一次，粘完立刻用 `/repos/{repo}` 验一遍。
7. **断网不丢**：建 Issue 失败进 `config-sync-feedback-outbox.json`，联网后点「补发」逐条建，成功自动出队。
8. 列表头「未解决 / 已解决 / 全部」+ 搜索框（编号、标题、作者、正文、环境块都参与），筛选全在本地做，不占匿名限额。

## `dsh-config-sync.json` 里的 WebDAV 字段

本机私有设置文件 `~\.dsh\dsh-config-sync.json`（不进仓库，POSIX 上 0600）：

| 字段 | 说明 |
|---|---|
| `syncMode` | `git`（默认）/ `webdav` / `auto`（配了 WebDAV 就用它） |
| `webdavUrl` | WebDAV 根地址（如 `https://dav.example.com/dav`） |
| `webdavUser` / `webdavPass` | Basic 认证账号与密码（密码永不明文回显到面板） |
| `webdavDir` | 远端子目录（相对根，默认 `dsh-config-sync`） |
| `webdavUserAgent` | **0.6.48 新增**：自定义 User-Agent。留空 = 完全不发这个头。只接受单行可见 ASCII（≤ 200 字符，不含换行 / 中文 / 制表符），非法值在保存时直接 400 |

Windows 的 PowerShell 与 macOS/Linux 的 Node 引擎都读这一份文件、都把整份传给 `runtime/webdav.mjs`，所以 UA 在两条路径上行为一致。

## 反馈附件的机制（0.6.48）
1. 面板选文件（图片 / 视频 / 日志，最多 4 个、单个 ≤ 20 MB），读成 base64 随提交一起发（该路由的请求体上限单独放宽到 160 MB，其余路由仍是 64 KB）。
2. 服务端先校验（类型白名单 / 体积 / 可读性），不合格的**逐条报错**，不静默丢弃。
3. GitHub 只有 **release** 有 asset 接口（Issue 没有），所以先按 tag `feedback-assets` 找 release；没有就建一个**草稿** release（`draft: true`，不出现在 Releases 页面、不会被搜索引擎收录，但知道链接的人打得开 —— 反馈附件本来就不该公开发布）。该 release 的 id 与 `upload_url` 在进程内缓存，一次反馈不会反复查。
4. 往 `upload_url` POST 原始字节：`{?name,label}` 整段被替换成 `?name=<文件名>`，`Content-Type` 给真实类型，`Content-Length` 给实际字节数。
5. 拿到的 `browser_download_url` 引进正文：图片用 `![name](url)`，其它用 `- [name](url)`；环境块仍在最后一段。
6. **没有令牌时附件传不上去**：面板明确告知「附件没能上传，请手动拖进网页」，并在响应里带 `pendingAttachments`。
7. 建 Issue 失败但附件已传上去时，附件 URL 存进待发队列；「补发」直接引用，不重复上传（重复上传会在仓库里留下垃圾资产）。

## 卸载残留清理

宿主卸载插件时**不删 `profile\node_modules` 里那条 junction**。`apply.ps1` 每次落地巡检一遍，只删**三条同时成立**的链接：①`LinkType` 是 Junction/SymbolicLink；②所有 Target 都不存在；③不在 `package.json` 的 `dependencies` 里。用 `Directory.Delete` 只删链接本身、不顺着链接动目标。

**顺手清插件备份**：与在用版本**相同**的 `.bak-<时间戳>` 直接删；版本不同的只留最新一份；主目录已不存在的保留（可能是唯一回滚点）。部署判据比对归档内 `package.json` 的 version 与已部署目录的 version（之前比 mtime，被 `git checkout` 刷时间害得每轮误判「有新版本」）。

## 面板指标的细节

- **「待推送」不只看 git**：`git status` 干净时新会话/新资料可能还在 `~\.dsh` 里没 capture。`status` 按 mtime 比对 capture 真正会抓的 12 组——profile 文件、全局提示、Skills、Agent 预设、技能市场台账、插件设置与工作流（14 个源，与 PowerShell 的 `Get-SyncSettingsMap` 同一份清单）、记忆数据（`<AppRoot>\mnemon`）、本地源码插件包、插件数据槽、额外路径、工作区目录、会话记录，晚于上次同步的计入待推送；取消勾选的组/条目不计入。只看 mtime，上限 20000 文件 / 1.5 秒，便宜的配置类先扫、贵的（会话/工作区/插件数据）后扫，避免大目录把配置挤出去。
- **上次自动同步的结果**：`~\.dsh\auto-sync-result.json` 若在 15 分钟内，客户端启动即弹一条 5 秒浮层（成功/失败 + 原因 + 日志路径），同一份结果只弹一次。

## 自动同步的进程细节

**macOS / Linux（0.6.49 起）**：执行体是 `runtime/post-exit.mjs`（Node，替代 `post-exit.ps1`），安装是 `runtime/install-plugin.mjs`。
- 「客户端是否还在运行」按**可执行文件路径**匹配（`platform.mjs` 的 `listClientProcesses` / `clientProcessPattern`），
  不按进程名 —— 执行体自己的命令行里就带着 `DeepSeek Harness.app/...` 路径，按名字会把等待进程和自己一起算进去。
- 重启客户端：macOS 用 `open -a <AppRoot>`，Linux 起解包目录里的可执行文件（`clientExecutable`）。
- 关闭客户端：先 `app.quit()`；不行再 `osascript -e 'tell application "DeepSeek Harness" to quit'`；6 秒后仍在才 `pkill -f <exe 路径>`。
- **启动时的自动拉取不再弹原生框**（osascript 的 `display dialog` 常被窗口挡住 → 用户看不见就等于永不发生）：
  只写 `status.auto.pullPrompt` 与 `~/.dsh/logs/auto-sync-pull-prompt.log`，由面板的「立即拉取」接手。
- 仓库路径会先 `realpath` 再和 `git rev-parse --show-toplevel` 比：`/var`、`/tmp` 指向 `/private/...`，只比字面量会把正常路径判成「不是仓库根」。

**Windows**：

- 动手由插件拉起 `runtime\post-exit.ps1 -Phase wait`（**隐藏**）盯退出；真退了才用 `-WindowStyle Normal` 起 `-Phase run` 的**可见**窗口，标题「DSH 配置备份与同步 · 拉取/推送」。**排队期间不弹窗**。
- 仓库还没就位（含空目录）时首检直接跳过，且不记成「检查失败」。
- **拉起方式**：`detached: true` 起 powershell 在 Windows 上会当场退出（日志一行都没有），改成短命 powershell 用 `Start-Process -PassThru` 起独立进程；`spawn()` 失败是异步的，所以要等 launcher 退出码、拿不到 pid 就如实失败，并写 `~\.dsh\logs\auto-sync-launch.log`。
- **等退出不能只看 pid**（插件跑在子进程里）：改成按进程名；「点了关闭但进程赖着不走」（实测 7 个进程 `hwnd=0` 存活 1 分钟以上）也认——活过 60 秒、无可见窗口持续 16 秒 → 结束残留进程再同步。
- **一个时刻只跑一次**：`~\.dsh\auto-sync.lock` 记 pid，后来者读锁（同种复用，不同种先结束那个没开工的等待进程再改排）。
- **退出客户端用整族结束**：`taskkill /PID` 不带 `/F` 对 Electron 主进程无效，改 `/IM "DeepSeek Harness.exe"`，3.5 秒后再补 `/F`。
- **重启前清环境变量**：继承的 `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ATTACH_CONSOLE` / `NODE_OPTIONS` / `NODE_PATH` 会让客户端「起来就退」，清掉后一次成功；启动后数进程、没活等 8 秒重试，最多 3 次。
- **进度窗口收尾**：跑完不自动关闭，把「同步已完成 / 日志路径」留在屏幕上，按键或点 × 才退出。客户端是**在这之前**由 `explorer.exe` 代启的，没有父子关系，窗口留多久都不会带走客户端。