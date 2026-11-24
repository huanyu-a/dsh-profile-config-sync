# dsh-profile-config-sync 0.4.0：多端通用 + WebDAV

0.4.0 把插件从「仅限 Windows」改成 **Windows / macOS / Linux 通用**，并新增 **WebDAV** 作为第二种同步通道。
0.3.x 的 Windows 用户**不需要改任何配置**：默认行为、仓库格式、面板布局都保持原样。

---

## 一、为什么没有「按客户端分备份」

需求里问：同步云端时要不要自动按客户端创建备份？结论是**不要**，理由是可验证的：

| 内容 | 是否与操作系统有关 | 分叉后果 |
|---|---|---|
| `profile/package.json` 的 `dsh.profile.bundles` | 无关（用户意图） | 改一个插件要改 N 份，必然漂移 |
| `settings/*.json`（13 项白名单） | 无关 | 同上 |
| `skills/` `presets/` `prompt/AGENTS.md` | 无关 | 同上 |
| `conversations/`（会话历史） | 无关（路径是占位符） | 用户失去跨机会话 |
| `workspace/`（工作区资料） | 无关 | 同上 |
| `link:` 目标、会话 cwd | **有关** | 已经是 `{{APP_ROOT}}` 等占位符，落地时展开 |

真正因平台而异的只有最后一项，而它**已经用占位符解决了**。所以分叉的收益是 0，成本是 N 份配置漂移。

**采用的方案：一个仓库 + 每客户端一份身份记录。**

```
仓库（一份，跨端共享）
├── profile/                 # 共享：package.json / cordis.patch.yml / host-contract.json
├── settings/ skills/ presets/ prompt/
├── conversations/ workspace/
└── machines/                # 【0.4.0 新增】每台机器一份身份
    └── <machineId>.json     #   os / arch / dshVersion / 本机根 / 最后同步时间
```

`machineId` 由「平台族 + 主机名 + 用户名 hash」组成，**同机重启不变**（不是随机），
落盘前清洗路径字符，写不进仓库外。

`host-contract.json` 增加三个字段（旧仓库没有也能跑）：

```json
{
  "appVersion": "0.2.2-rc.5",
  "electronVersion": "44.7.0",
  "platforms": ["darwin", "win32"],   // 被哪些平台验证过（并集，不是"最后是谁推的"）
  "platformFamily": "posix",
  "os": "darwin",
  "arch": "arm64"
}
```

`platforms` 取**并集**：Windows 推完 macOS 再推，两个平台都在，谁拉都不被误判。

---

## 二、跨端怎么实现的

### 2.1 平台差异收敛到一处

新增 `runtime/platform.mjs`。**业务代码里不允许再出现 `process.platform` 分支**，
只消费它的结论：

| 能力 | Windows | macOS / Linux |
|---|---|---|
| 客户端根候选 | 注册表 InstallLocation + `LOCALAPPDATA` + 盘符扫描 | `/Applications/*.app`、`~/Applications`、`/opt` |
| resources 位置 | `<root>/resources` | `<root>/Contents/Resources`（.app bundle） |
| Node 运行时 | `resources/runtime/.../node/bin/node.exe` | 同相对位置，无 `.exe` |
| git / ssh | Git for Windows 系统级 + 用户级 | `/usr/bin`、`/opt/homebrew/bin`、PATH |
| 链接判定 | junction（`Dirent.isSymbolicLink()` 为 true，实测） | symlink |

两个实测踩到的坑（已修）：

- `statSync('app.asar')` 在 Electron 主进程里报 **目录**，只写 `isFile()` 会让真实客户端永远认不出自己的根；
- 打包版读版本时 `resources/app.asar/dsh/package.json` 在普通 node 里**读不到**（只有 Electron 挂载了 asar），
  必须直接按 asar 二进制头解析。

### 2.2 执行层：Node 重写，PowerShell 保留

| 平台 | 执行体 | 脚本外壳 |
|---|---|---|
| Windows | `runtime/*.ps1`（0.3.x 原样保留） | `同步-推送.cmd` 等 |
| macOS / Linux | `runtime/sync-engine.mjs`（新增） | `同步-推送.sh` 等 |

`sync-engine.mjs` 提供 `capture` / `apply` / `status` / `restore` 与命令行入口，
参数与 PowerShell 版同形：

```sh
node sync-engine.mjs push   -RepoRoot <dir> -DshHome <dir> [-AppRoot <dir>] [-Message "..."]
node sync-engine.mjs pull   -RepoRoot <dir> -DshHome <dir>
node sync-engine.mjs status -RepoRoot <dir> -DshHome <dir>
```

`.sh` 与 `.cmd` 的差异**如实写进面板**，不掩盖：进程守护用 `pgrep -f`（不是 tasklist）、
无 chcp（UTF-8 默认）、还原依赖仓库快照目录（与 Windows 同语义）。

### 2.3 仓库识别兼容

`isRepoDir` 从「必须有 `apply.ps1`」改成「有 `profile/package.json` 且（`apply.ps1` 或 `sync-engine.mjs`）」；
`repoPhase` 的「空目录」判据同时认 `同步-*.cmd` 与 `同步-*.sh`。
否则在非 Windows 上生成过脚本的目录会被判 `unusable`，面板再也不给「拉取」按钮。

---

## 三、WebDAV 同步方式

### 3.1 定位

与 git **共用同一份仓库格式**，只换传输层：云端目录 = 本地仓库内容原样上传。
所以 `capture` / `apply` 逻辑完全复用，不存在第二套同步语义。

### 3.2 一致性模型（重要）

WebDAV 没有提交历史，**没有三方合并**。语义是「最后写入者胜」，按文件粒度：

- 上传：本机有云端没有的 → 新增；两边都有且不同 → 覆盖云端；云端多余**不删**（可能是另一台推的）
- 下载：对称
- **冲突（两边都有且不同）→ 本机那份留底为 `<文件>.conflict-<时间戳>`**，不静默覆盖

### 3.3 安全

- 密码只存本机 `dsh-config-sync.json`，**任何响应都不回显**（面板只显示「已设置/未设置」）；
- 非 https 地址默认拒绝；确需 http 要本机显式设 `DSH_SYNC_ALLOW_INSECURE=1`；
- 证书校验不可关闭。

### 3.4 配置

面板「跨端与同步方式」区 → WebDAV 卡：

| 字段 | 说明 |
|---|---|
| 同步模式 | `git`（默认）/ `webdav` / `auto`（配了地址就用 WebDAV） |
| WebDAV 地址 | 如 `https://dav.example.com/remote.php/dav/files/me` |
| 用户名 / 密码 | 密码留空 = 不改 |
| 远端目录 | 默认 `dsh-config-sync` |

「测试连接 / 立即上传 / 立即下载」三个按钮直接可用。

---

## 四、验证状态

| 项 | 结果 |
|---|---|
| `node --check` × 7 文件 | 全部通过 |
| `tools/clientcheck.mjs` | 全部通过 |
| `tools/selftest.mjs` | 12 项失败，**与 0.3.93 基线完全一致**（都是本机环境依赖，非本次引入） |
| WebDAV 真实服务器端到端 | 36 项断言全通过（上传/下载/幂等/冲突留底/删除/安全策略） |
| Node 引擎 capture→apply 往返 | 通过，`link:` 目标与会话路径正确展开 |
| 真实 UI 目视 | **未验证**（需重启客户端；面板改动要重建 web 产物） |

### 未验证 / 边界

- macOS / Linux **实机未跑**（当前只有 Windows 环境）；POSIX 分支的逻辑由代码审查 + Node 引擎测试覆盖，
  首次在 Mac 上使用时建议先跑一次 `status` 确认平台识别正确。
- Windows 专属动作（junction 修复、孤儿链接清理、pnpm 安装）在 Node 版里是空操作，
  Windows 用户仍走 PowerShell 版，不受影响。

---

## 五、升级说明

0.3.x → 0.4.0：

1. 直接覆盖安装，**无需改配置**；`syncMode` 默认 `git`，行为与 0.3.x 相同。
2. 仓库无需迁移：`machines/` 首次推送时自动创建，`host-contract.json` 新字段自动补。
3. 想在 Mac 上用：装同版本客户端 → 装本插件 → 「本机仓库」指向同一云端地址 → 拉取。
   首次拉取后重启一次客户端，让 `pnpm install` 处理原生模块。