# 历史版本细节（0.2 – 0.6）

> README 只写**当前行为**；这里存放按版本记录的演进细节：某张卡片当时长什么样、某次修复改了什么、坑怎么绕过去。
> 完整验证记录见 [CHANGELOG.md](CHANGELOG.md)。

## 0.3.x 面板与工作区的演进

### 隐藏/归档的工作区不再带到另一台机显示（0.3.75）

在「配置备份与同步」面板里「隐藏/归档」的工作区与会话，之前推送到 B 机后仍会原样显示。原因：DSH 把隐藏状态单独存在 `<DshHome>\dsh-session-manager\workspace-archives.v1.json`（记录 `archived:true` 与对应 `sessionIds`），这个文件不在同步清单里；工作区登记表又是按 ID 并集合并，本机被隐藏的记录会被并回来。

0.3.75 起把这份状态纳入 `settings` 同步：推送时写进仓库 `settings\workspace-archives.json`，拉取时还原到 B 机同名文件。B 机 DSH 启动后读到 `archived:true` 的工作区，会在工作区列表里过滤掉，它名下的会话也一并归到「已归档」，不再显示。整份覆盖语义——A 机的隐藏状态为准；这是「隐藏」不是删除，工作区与会话文件仍在，随时可以在 DSH 里取消隐藏恢复。

### 配置同步面板新增「工作区显示」卡片（0.3.76）

面板新增一个**工作区显示**分区，把 DSH 原生两套隐藏机制放进同一张卡里直接操作：

| 操作 | 作用 | 落点 |
|---|---|---|
| 显示 | 工作区正常可见，会话全显示 | 清掉归档记录；会话移出 `archivedSessionIds` |
| 隐藏会话 | 工作区留在列表，名下会话进「已归档」 | 会话写进 `<DshHome>\storages\workspace.json` 的 `global.archivedSessionIds` |
| 归档工作区 | 整个工作区从列表消失，会话保留 | `<DshHome>\dsh-session-manager\workspace-archives.v1.json` 写 `archived:true` + 会话一并按隐藏处理 |

每个工作区可独立切三态；展开后还能对单个会话单独「隐藏 / 显示」，两者互不影响（会话操作只动那一条 `archivedSessionIds`，不改工作区归档记录）。改动不调 session-manager 的 Web API（那套 API 需要 DSH connection owner 凭证，插件路由拿不到），而是经宿主 `workspaceRegistry` 落盘并推送会话列表更新，切换后立刻生效（详见 0.3.82）。0.3.75 已把归档文件纳入同步，所以这里改的隐藏 / 归档状态也会跟着 push/pull 到另一台机。

### 配置同步面板：会话名称、修改按钮、点行展开与快速跳转（0.3.77）

在 0.3.76「工作区显示」卡片之上做了五点交互调整：

1. **会话名称**：工作区展开后每条会话显示可读标题（从 `session/title` 事件提取，取不到时回退到首条用户消息文本），鼠标悬停可看完整会话 ID；标题提取带缓存，换机器后按新机器日志重建。
2. **修改按钮**：三态下拉与会话的「隐藏 / 显示」按钮默认不出现，点该工作区的「修改」才进入编辑态，点「完成」退出，避免误改。（0.3.84 起改为**整卡一个**「修改」按钮，见下文。）
3. **点行展开**：点工作区整行即可展开 / 收起会话，不再单独点展开按钮。
4. **卡片位置**：工作区显示卡片移到「问题反馈」前，作为配置调整的最后一步。
5. **固定标题 + 快速跳转**：面板标题栏吸顶；标题下方增加快捷标签（概览 / 工作区显示 / 同步目标 / 自动化 / 生成脚本 / 还原备份 / 同步内容 / 插件数据 / 问题反馈），点击平滑滚动到对应分区。

会话标题读取与三态读写都在本插件内自包含完成，不依赖 session-manager 的 Web API。

### 快速跳转顺序与卡片对齐、滚动不再被标题遮挡（0.3.78）

0.3.77 的两处显示问题已修：

1. **跳转顺序对齐卡片**：快捷标签顺序改为与分区实际渲染顺序完全一致（概览 / 同步冲突[有冲突时] / 本机路径[展开时] / 同步目标 / 自动化与插件更新 / 生成脚本 / 还原备份 / 同步内容 / 插件数据 / 工作区显示 / 问题反馈）。同步冲突、本机路径两个条件分区只在卡片存在时才出现在标签里。
2. **滚动落点在标题下方**：标题栏改为不透明背景（面板卡片同色），滚动时内容不再从标题背后透出；点标签跳转时按标题栏实际高度设置滚动落点，目标分区完整显示在标题下方，不再被遮住。

### 插件更新支持 npm 双源兜底下载（0.3.89）

「插件更新」卡新增一行 **npm 下载路径**，直接显示实际兜底地址（国内镜像 `registry.npmmirror.com` + 官方 `registry.npmjs.org` 两个源）。GitHub release 整段不通时（国内常见），更新包会自动兜底从 npm 下载；仍按 `version.json` 里的权威 sha256 校验，换源不放宽校验。两个源互为备份：镜像首发同步窗口期会短暂 404，官方源随即兜上。实测 npm tarball 与 GitHub release tgz 是同一份产物、sha256 完全一致。

### 点 × 关闭 DSH 时立即判一次自动拉取/推送（0.3.93）

勾了「启动时自动拉取」或「退出时自动推送」后，原来只有启动后的 8 秒首检 + 每 2 分钟复查会排队。如果你在两次复查之间做了改动就点右上角 × 关闭，那一刻没有 watcher 在等退出，关闭后什么都不会执行。现在补上退出钩子：点 ×（最后一个可见窗口关闭）时插件先判一次并排好 watcher，再退出客户端；DSH 进程归零后 watcher 立刻执行拉取/推送。

1. **退出前判一次**：无可见窗口时调用 `triggerAutoSyncOnClose(config)`，读 `autoPull`/`autoPush` 开关；已有在途 watcher 就复用、不重复拉起；本机仓库为空时只有 autoPull 能排队（首次 clone）。
2. **判据与复查完全一致**：拉取优先（云端领先 > 0 就排 pull，关闭时不弹确认框）；推送按「领先提交 / 未提交改动 / 本机资料比上次同步新」三来源任一命中就排 push；`autoRestart` 语义统一为 `!== false`（默认重启）。
3. **排队先于 quit**：必须在 `app.quit()` 之前 `await` 排队——插件随主进程退出而消失，quit 后再判就来不及。开关都关 / 无待同步内容时该函数很快返回，不影响关闭速度；排队成功写日志「退出前已排队 …：DSH 退出后立即执行」。

### 远端「未提交」纳入本机待同步 + 刷新按钮真正 fetch（0.3.92）

针对「远端信息还是没更新」的实测根因：git 层的「落后/领先」确实是 0（本机 HEAD 与云端 gitee 一致），用户说的「没更新」其实是本机运行期新产生、还没 capture 进仓库的待同步数据。这次做两处实质性改动：

1. **「未提交」= git 工作树改动 + 本机待同步**：后端 status 的 `repo` 对象新增 `pending`（本机还没同步的会话/配置改动数）与 `uncommitted`（`dirty + pending`）两个字段。面板两处「远端」Kv 的「未提交」改用 `uncommitted`，并在有待同步项时追加「（本机待同步 N）」。这样本机有新会话/配置改动时数字立刻可见，不用等退出 DSH capture。
2. **「刷新」按钮真正 fetch**：原来摘要行的「刷新」只重读 status（不触发 git fetch，落后/领先数照旧）。现在刷新按钮走 `refreshRemoteNow`：先 `/config-sync/auto {action:'check'}` 触发 `git fetch` 更新远端引用，再刷新快照；展开时的 30 秒自动刷新统一复用这条链。

### 设置-通用-配置同步：远端信息自动刷新 + 立即拉取/推送按钮（0.3.91）

「设置 → 通用设置 → 配置备份与同步」摘要行两处调整：

1. **远端信息不再陈旧**：展开这一行时会先请求 `/config-sync/auto` 的 `check` 动作（触发 `git fetch` 更新 `@{upstream}`），再刷新状态，远端「落后 X · 领先 Y · 未提交 Z」显示的是云端最新值而非旧值；展开期间每 30 秒自动刷新一次，收起即停。根因是 `@{upstream}` 的落后/领先数只在 fetch 后才更新，单纯读 status 不会触发 fetch。
2. **按钮换成「立即拉取 / 立即推送」**：原来四个「生成脚本 / 只生成推送 / 只生成拉取 / 只生成还原」按钮换成两个 —— **立即拉取（会关闭 DSH）** 与 **立即推送（会关闭 DSH）**，和主面板「自动同步」卡走同一条 `pull-now` / `push-now` 队列：点击即排队、退出 DSH 后执行。按钮按后端门禁（`pullAllowed` / `pushAllowed`）置灰并给出提示（空仓库先推 / 云端为空先拉），排队中与结果都有中文反馈。原「生成脚本」入口保留在主面板，摘要行不再重复。

### 待办与跳转按钮的显示梳理（0.3.90）

面板的四处显示调整：

1. **跳转按钮跟随当前位置高亮**：顶部快捷标签现在会按滚动区里最靠上的可见分区自动高亮（主色底 + 主色字），一眼看出「现在在哪一区」；点按钮跳转也会立即点亮对应标签。
2. **待办去掉「本机数据」字眼**：原本地位等同小标题的「本机数据 / Local data」行删掉，待办卡直接以统计与明细呈现，不再重复冠名。
3. **待办可展开具体名称**：每个分组（会话记录 / 本机 profile / Skills …）一行，点它展开看该组的具体名称 —— 会话显示会话记录标题（读不到时显示 `<sessionId>（会话）`），本机 profile 显示 `package.json`、`cordis.patch.yml` 等文件名，每项按组去重、最多列 50 条。待办卡标题行有「展开 / 收起」总开关，默认展开，进来即可见明细。
4. **概览说明同步**：分区说明改为「版本、依赖、快照与待办一眼看完」。

### 本机数据挪进待办 + 按同步内容分组 + 会话显示会话名（0.3.86）

把「本机仓库」卡里的「本机数据」行移到了「概览 → 待办」，并重新组织它的呈现：

1. **位置**：原先「本机仓库」卡底部那行「本机数据」删掉；现在待办卡在无其它异常时也照样出现，顶部先显示本机数据（上次同步时间 / 待推送数 / 模式），下面才是原来的待办建议。这样「本机还有多少没推」和「该做什么」在同一处看。
2. **按同步内容分组**：待推送文件按「同步内容」那套 12 组口径归类统计 —— 会话记录 / Skills / 插件数据 / 记忆数据 / 本机 profile / 全局提示 / Agent 预设 / 插件设置 / 工作区资料 / 额外路径 等，每组一个 chip 显示条数，按数量从多到少排；不再只报一个总数。
3. **会话显示会话名**：待办里「最近写入」的样本，会话文件显示投影缓存里的会话标题（和 DSH 面板一致，如「列出工作区下的文件夹」），不再是 `session-xxx/session.v4.jsonl.zstd` 这种目录 ID；取不到标题的非会话项仍显示父目录/文件名。

### 工作区显示卡片：整卡一个「修改」按钮，会话与开关一一对应（0.3.84 / 0.3.85）

「工作区显示」卡片的编辑交互重做：

1. **整张卡片只有一个「修改」按钮**（0.3.84）：以前每个工作区行各带一个「修改 / 完成」，按钮一多就和会话对不上。现在标题行右侧只有一个按钮 —— 非编辑态是「修改」，点进去变成「完成」（主色高亮，位置不动），所有工作区的三态下拉和所有会话的显隐开关一起解锁，再点一次统一退出。行内那个按钮已删除。
2. **会话与按钮的对应关系做实**（0.3.84）：每条会话独占一行，行间加分隔线；编辑态下整行加底色 + 圆角，把「这一行会话」和「这一行按钮」框在一起。开关贴在该行最右侧且等宽，换行也不会漂到别的会话旁边。按钮文案与颜色区分「隐藏」（红）/「显示」（绿），`title` 里带会话名，隐藏的会话名加删除线并变灰（原来那个单独的「已隐藏」小字去掉了）。
3. **不额外插强调色说明条**（0.3.85）：编辑态不再在列表上方插一条黄底提示，是否在编辑只看标题行那个按钮本身。

### 工作区显示卡片：连空会话与空闲审查父容器一起折叠（0.3.83）

在 0.3.82「默认折叠智能体子会话」之外，再默认折叠两类干扰条目：

1. **空会话**：建了但从没发过消息、也没跑过 turn 的历史条目（会话头 `origin` 为空，日志里只有 permission / sandbox / approval / session-end-seed 这几条，没有 `turn/start`、没有 `user/message`）。
2. **Mnemon 空闲审查的父容器**：`mnemon-review-owner-v1-*`，它自己只有一条 `subagent/catalog` 事件，真正的内容都在它指向的 `mnemon-review-v1-*` 子会话里。

两类都天然满足「blank」判据，所以用同一条规则折掉，不需要单独写名字匹配。卡片标题行新增「显示空会话」勾选项，需要时可以放回来；footer 会分别说明折叠了多少条空会话和多少条智能体会话。本机默认视图从 99 条降到 10 条。

### 工作区显示卡片：默认折叠智能体会话 + 隐藏/显示即时生效（0.3.82）

「工作区显示」卡片两处改动：

1. **默认折叠智能体（subagent）子会话**：卡片只列你自己的会话，标题行新增「显示智能体」勾选项，需要时勾上才把智能体子会话一并列出，并显示被折叠的条数。本机 99 条登记会话里有 80 条是智能体子会话（mnemon 审查 / 派生任务都会留一条），一屏全是它们，自己的会话反而找不到。
2. **隐藏/显示即时生效**：之前切三态或单条会话只改磁盘上的状态文件，宿主内存里的 `archivedSessionIds` 不更新，必须重启客户端或刷新会话列表才看到变化。现在改走宿主的 `workspaceRegistry`（`archiveSession` / `unarchiveSession`），落盘的同时触发会话列表推送，面板上切完立刻生效。宿主服务取不到时自动退回原来的文件写法，并在卡片提示里说明走的是哪条路。

会话所属工作区与会话标题的读取仍然自包含，不依赖 session-manager 的 Web API。

### 工作区显示卡片的会话名称与 DSH 面板保持一致（0.3.81）

修复「工作区显示」卡片里会话名称与 DSH 会话面板显示不一致的问题。

DSH 的会话标题会演进：先产生 fallback 临时标题（首条消息截断），随后由大模型生成 provider 正式标题。之前卡片只读到第一条 fallback 就停止；现在改为按 provider 正式标题 > fallback > 无来源 title > 首条用户消息 的优先级取最新标题，与 DSH 面板完全一致。

### 修复跨机同步把新插件降级覆盖、拉取后被回滚（0.3.80）

修复跨机拉取时本地已安装的新版插件被配置仓库里的旧归档反向覆盖，进而导致 link 变成 0.0.0、插件 bundle 自检失败、拉取自动回滚的问题。

| 问题 | 修复 |
|---|---|
| 归档版本比本机旧时仍被当作新版本覆盖 | 版本比对由「不等即覆盖」改为语义化「只升不降」：只有归档版本高于本机版本才重新部署 |
| 归档内顶层目录名与文件名不符（如 0.3.70 包里套着 0.3.56 目录），解压出嵌套目录导致 link 失效 | capture 打包后强校验归档内顶层目录名与 version，异常归档直接删除并告警，不再同步到本机 |
| 残留的旧插件键导致每次拉取报 plugin-missing | 清理 localPluginMap 中的无效历史键与历史通知 |

同时修正配置仓库中损坏的插件归档，用正确的 0.3.79 内容重打包。

### 面板改成「页头固定 + 内容区独立滚动」的两段式布局（0.3.79）

0.3.78 仍是一个滚动容器里塞一个吸顶页头，遇到两种情况还是会露：面板变矮、或页头换行变高时，内容会擦着标题分隔线上沿过去，甚至从标题上方那圈留白里露出来；跳转落点按页头高度动态算，条件分区出现/消失时也会忽高忽低。

0.3.79 换成两段式：页头（标题 + 徽标 + 元信息 + 区标签）**整体移出滚动区**，固定在面板顶部；下方另起一块带 `overflow-y:auto` 的内容区，只装提示条和各分区卡片。带来三个直接效果：

1. **结构上不可能再穿过去**：内容区边界就在标题分隔线下方 20px，滚动再多也只在内容区里，不会出现在标题区或标题上方。
2. **跳转落点固定**：区标签跳转直接滚到内容区顶部 + 8px，不再按页头高度算偏移，页头怎么换行、条件分区在不在都不影响。
3. **页头不再抖动**：页头不参与滚动，滚动条、阴影、半透明背景那套补丁全部去掉，只留一条分隔线。

改造只动面板自己（`S.page` / `pageInner` 只在这一处用），侧栏行、设置页摘要行不受影响。

### 中文路径的坑（0.3.48）

`git` 默认 `core.quotepath=true`，非 ASCII 路径会被转义成 `"workspace/DSH\347\240\264\347\224\262/..."`（**带双引号**）。0.3.47 的索引预检直接读 `& $git ... diff --cached --name-only` 的输出，于是 `Test-Path -LiteralPath` 撞上 `"` 报 `执行体调用异常：路径中具有非法字符`，整次同步在提交前就挂了。

修法：凡是要「按路径干活」的 git 查询一律走 `Read-GitLines`（内部 `-c core.quotepath=false` + cmd 字节重定向 + 按 UTF-8 读），并给逐个 stat 包一层 `try/catch` —— 单个坏名字只跳过体积检查，不再拖垮整次同步。实测真实仓库 918 条暂存路径：含引号 0 条、stat 失败 0 条；历史预检的 `ls-tree -r -l` 3222 条全部能按 `\t` 切出路径与体积。

实测（2026-11-14，隔离仓库 + 本地裸库 + 假 `pre-receive` hook）：96 MB 文件被剔除后其余照推成功、`sync-notices.json` 落盘 `too-large=1`；同一文件进历史后预检报 `history=1`；hook 回放 GitHub 报文（`File big.bin is 96.00 MB; this exceeds ...`）被正确归成「文件超限 1 个」而不是网络问题；窗口末尾汇总与面板区块读的是同一份清单。

## 生成器里已经堵掉的坑

新机器真跑一遍才暴露的坑：

| 坑 | 处理 |
|---|---|
| cmd 的 `echo` 吃 `< > \| & ^ %` | 动态文案全过 `echoSafe()`：`%`→`%%`，特殊符号前加 `^` |
| `chcp 65001` 后 `set /p` 读不到重定向输入 | `--yes` 免确认 + 无确认时明确回执 |
| 新机器分支没有 upstream，`git pull --ff-only` 报 *no tracking information*，PS 5.1 包成 NativeCommandError 后继续走 | 先探 upstream；0.3.54 起拉取改成 `fetch` + `merge --ff-only origin/<branch>`（一次网络往返），没有 upstream 就补 `set-upstream-to`；push 带 `-u` |
| `GIT_SSH_COMMAND` 少了 ssh.exe 本体 → `/usr/bin/sh: - : invalid option` | 四分支：有 `core.sshCommand` 照用；找到 `ssh.exe` 写完整命令；只有私钥就不设变量；无私钥交给 `.ssh\config` |
| 客户端 asar 打包时按路径找 AppRoot 全落空、bundle 全误报缺失 | `isAppRoot` 认 `app\package.json` **或** `app.asar`；版本与 bundle 从 asar 定向取（PS 5.1 `ConvertFrom-Json` 2 MB 上限，5.7 MB 头只能按 entry 偏移直读），判不了就当"不知道" |
| 插件目录已存在就跳过部署，tgz 更新了本机还是旧代码 | 比归档内 `package.json` version 与已部署目录 version（之前比 mtime，被 `git checkout` 刷时间害得每轮误判） |
| 开了"退出时自动推送"却什么都不发生 | 两个叠因：①排队判据只看 `ahead > 0` → 改成三个来源都算 + 每 2 分钟复查；②`spawn` 假成功 → 改 `Start-Process` + 等退出码 + 写日志 |
| 空目录被当成"仓库坏了"，推送按钮可点但必失败 | 按 `repo.phase` 分四态，三层都拦住 |
| 「云端有没有东西可拉」看分支数 → 树被删空了仍判「有内容」，初始化推送入口永不出现（实测 Gitee 98 个提交、最新树 0 文件） | 判据换成**分支树里的文件数**：`ls-remote --heads` 数分支，有分支才临时 bare `fetch --depth 1 --filter=blob:none` + `ls-tree -r`；`remoteFiles===0` 算「两边都空」，用 `--force-with-lease` 覆盖空分支 |
| 拉取整份覆盖 settings，改完没推送就拉取 → 被静默盖回 | 覆盖前比对（占位符归一 + CRLF 拉平 + `our-free-model.json` 三个时间戳置 0），不同就写 `config-sync-overwrite.json` 并提示 |
| 同步后**新建会话直接失败**：`failed to create session … corrupt Zstandard session log: invalid frame magic at byte 186` | DSH 写的首帧**带 4 字节 content checksum**（帧头描述符 FHD 的 bit2），二分找「最小可解前缀」时解压器对**去掉 checksum 的前缀**照样成功 → 帧尾算短 4 字节；写回把旧 checksum 留成垃圾，DSH 读第二帧就撞上。改成：按 FHD bit2 补 4 字节 → 再以「下一帧帧头」校正 → 写回前自检（首帧 cwd 生效 + 新首帧末尾必须是下一帧帧头），不过不落盘；遇到历史残留尾巴顺手丢掉自愈 |

## 性能（0.3.54）：零行为变化的三处提速

三处都只改「怎么算」，不改「算什么」：落到仓库的文件、提交内容、错误判定与 0.3.53 逐字节一致，只是更快。数据来自同规模假仓库（50889 文件 / 416MB，五万级）与真实 Gitee：

| 环节 | 改之前 | 改之后 | 为什么 |
|---|---|---|---|
| capture 判断「文件要不要重写」 | 每个文件算两次 `Get-FileHash`（源 + 仓库）：单文件 1.2ms → 5 万文件 ≈ **120s** | 两次 `Get-ChildItem` 各拿一次 `FileInfo`（Length / LastWriteTimeUtc 随枚举已读好）+ 纯内存字典比对 **3.9s**；只有 size 或 mtime 不一致才算哈希 | 逐文件 `Test-Path` / `Get-Item` 反而**更慢**（实测 37.8s，每次 cmdlet 调用约 0.7ms），批量枚举才是正路 |
| 推送前扫「历史里的大文件」 | 每次 push 都跑 `git ls-tree -r -l HEAD`：五万文件仓库 **20–23s**，而它查的历史几乎不变 | 按提交缓存到 `.dsh\sync-history-scan.json`（`{commit, oversized, at}`）：commit 相同、或是当前 HEAD 的祖先就跳过；只有首次、被远端拒绝、或显式 `-ScanHistory` 才全量扫 | 新增文件已经由索引预检挡住；历史扫描只负责「老提交里已经躺着一个大文件」这条死路 |
| 拉取 | `git pull --ff-only` 内部是 fetch + merge，而脚本前面已经 fetch 过 → **两次网络往返**（SSH 握手实测 ≈0.95s/次） | 先 `fetch origin --prune`，再 `merge --ff-only origin/<branch>` → **一次往返**；`merge --ff-only` 只认快进，本地有改动/非快进照样失败，语义完全不变 | 带冲突清单进来的那一轮会跳过一次 fetch，此时先补一次，保证 merge 用的是最新 refs |

两个新开关都在 `sync.ps1` 上，**默认关**，默认路径的行为与 0.3.53 相同：

- `-DeepVerify`：透传 `capture.ps1`，无视 size/mtime 快筛，**每个文件都算哈希**。怀疑出现「大小和时间都没变、内容却变了」的漂移时用（代价是回到 1.2ms/文件）。
- `-ScanHistory`：无视历史扫描缓存，**这次一定全量扫** `ls-tree -r -l HEAD`。换了远端、怀疑缓存过期、或想手工复核时用。

```powershell
pwsh -File sync.ps1 push -DeepVerify
pwsh -File sync.ps1 push -ScanHistory
```

输出上看得出来走了哪条路：`文件比较（快筛）：比对 N 个，深哈希 M 个` / `文件比较（深校验开）：比对 N 个，深哈希 N 个`。

## 作为插件市场的索引源

仓库根的 `market-index.json` 就是一份可直接用的 DSH 市场索引（`format: 1`，`source.type: git` + 40 位 commit）。索引地址：

```
https://raw.githubusercontent.com/huanyu-a/dsh-profile-config-sync/main/market-index.json
```

在 DSH「插件 → 发现 → 索引源」填入即可。**前提**：这是宿主官方发现页（`@deepseek-ai/dsh-plugin-market`）的索引源，需要 profile 启用官方 `@deepseek-ai/dsh-experimental-plugin-market-bundle`。

**dshmarket 里搜不到自建索引，是正常的**：dshmarket 的列表只来自它自己的精选目录（`awesome-dsh-plugin.com/plugins.json`，国内走 npm 的 `dsh-plugin-catalog`），源码里没有自定义索引源这条路，安装也被限定在「该目录列出的来源」。要出现在那里，只能向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR 收录。

> **收录后的可见性**（2026-11-13 实测）：PR `#14762` 已 MERGED，条目 `data/plugins/huanyu-a__dsh-config-sync.yml` 已进站点正本（`plugins.json`，`updated: 2026-11-13`，10974 条，含 `huanyu-a/dsh-profile-config-sync`）。但客户端取源顺序是「站点正本 → 地区 npm 源 → jsDelivr 兜底」：13.8 MB 正本下载超时后落到 jsDelivr 镜像，而镜像（`dsh-plugin-catalog` npm 包每天 UTC 05:19 重建一次）还停在 `2026-11-12` / 10778 条、**不含** huanyu-a。所以「收录完了却搜不到」＝**镜像滞后**，不是代码问题；等当天目录包重建 + 缓存失效，或重启客户端让它重读，就会出来。用 CLI 强制刷新可立刻验证：

```powershell
node ~\.dsh\.dsh-plugin-market\market-core.mjs catalog --profile desktop
# ok=true, source=official, fromCache=false, version=2026-11-13, count=10974
```

> 同名冲突提醒：目录里 `dsh-config-sync` 有两条——`huanyu-a`（`github:huanyu-a/dsh-profile-config-sync`，category git）与 `bxzfxl`（`@liangfengqi/dsh-config-sync`，category tools，downloads 843），搜索时会并排出现。

升级流程：改代码 → `pwsh -File tools\pack-plugin.ps1` 打包（自动把 sha256 回填 `version.json`）→ 改 `version.json` 的 `version` / `notes` → 把 `market-index.json` 里那条的 `version` 与 `commit` 换成新提交 → 推送。索引只引用 commit，旧版本随时能装回。打完包先跑 `node tools\selftest.mjs <仓库路径>` + `node tools\clientcheck.mjs`。

## 包含什么

| 路径 | 说明 |
|---|---|
| `index.js` | 宿主半身：`/config-sync/status`、`prepare`、`settings`、`auto`、`update`、`scope`、`conflict` 路由 |
| `client.js` | 浏览器半身：侧栏行、面板、设置摘要行 |
| `cordis.patch.yml` | bundle 补丁层（`id: config-sync`） |
| `runtime/` | 执行体：7 个 PowerShell 脚本（`capture` / `apply` / `sync` / `restore` / `post-exit` / `common` / 自更新）+ Node 引擎 `sync-engine.mjs`（macOS/Linux）+ `webdav.mjs`（WebDAV 传输），随包发布，装好即可生成脚本 |
| `tools/` | `selftest.mjs`、`clientcheck.mjs`、`pack-plugin.ps1` |
| `version.json` / `releases/` | 自更新清单与安装包 |

> `tools/`、`version.json`、`releases/` **只在源码仓库里**，不随 npm / 安装包发布（`package.json` 的 `files` 只含 `runtime/` 等运行必需件）。
> 所以 `node tools\selftest.mjs` 这类自检要在仓库里跑；装好的副本里没有 `tools/`，在那边执行会直接 `MODULE_NOT_FOUND`。
> 插件运行时也不需要它们：`version.json` 由插件从 GitHub raw 读取。

## 从零跑通的原始现场（2026-11-14，隔离环境两台假机 + 本地裸库）

首次推送的真实产物（15 个文件、commit `3fa3780`）：

```
apply.ps1  capture.ps1  dsh-sync-common.ps1  post-exit.ps1  restore.ps1  sync.ps1  tools/fix-session-cwd.mjs
profile/package.json  profile/cordis.patch.yml  profile/host-contract.json
settings/dsh-workspaces.json
workspace/workspace-registry.json  workspace/default-workspace/notes.md
conversations/session-index.json  conversations/session_projcache/s1.json
```

首次拉取的真实输出（`pull_rc=0`）：

```
[OK] 宿主版本一致（app = 0.2.2）
[OK] 已还原工作区「default-workspace」→ <B>\app\workspace\SquadLink（1 个文件，字节保真）
[OK] 工作区登记表已按 ID 合并 → <B>\home\storages\workspace.json（1 个工作区）
[OK] 会话 projcache 的 cwd 已对齐本机路径：修正 1 个
[OK] 会话数据全量还原：写入/更新 1 个文件、备份 1 个
[OK] 全部 0 个插件依赖已就位
```

