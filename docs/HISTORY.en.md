# Historical detail (0.2 – 0.6)

> `README.md` / `README.en.md` document **current behaviour only**. This file keeps the per-version evolution notes.
> The full verification log is in [CHANGELOG.md](CHANGELOG.md).

## The 0.3.x panel / workspace evolution

### Hidden/archived workspaces no longer reappear on the other machine (0.3.75)

Workspaces and sessions you hide/archive from the config-sync panel used to show up again on machine B after a pull. Cause: DSH stores that state separately in `<DshHome>\dsh-session-manager\workspace-archives.v1.json` (`archived:true` plus the related `sessionIds`), which was never part of the sync set; the workspace registry is merged by ID (union), so a locally hidden record gets merged back in.

Since 0.3.75 this file is part of the `settings` sync: a push writes it to the repo as `settings\workspace-archives.json`, and a pull restores it to the same path on B. When B starts, DSH reads `archived:true` workspaces and filters them out of the workspace list; their sessions move to the archived group and stop showing. This is whole-file replace semantics — machine A is authoritative. Hiding is not deletion: the workspace/session files remain and can be restored by un-hiding in DSH.

### New "Workspace visibility" card in the panel (0.3.76)

A new **Workspace visibility** section brings both native DSH hiding mechanisms into one card:

| Action | Effect | Backing file |
|---|---|---|
| Visible | Workspace shown normally, all sessions visible | Drop the archive record; remove sessions from `archivedSessionIds` |
| Hide sessions | Workspace stays in the list, its sessions go to Archived | Sessions written to `global.archivedSessionIds` in `<DshHome>\storages\workspace.json` |
| Archive workspace | Workspace disappears from the list, sessions kept | `<DshHome>\dsh-session-manager\workspace-archives.v1.json` gets `archived:true` and its sessions hidden too |

Each workspace switches between the three states independently; expanding it lets you hide/show a single session without touching others (a session toggle changes only that one `archivedSessionIds` entry, never the workspace archive record). Changes do not call the session-manager Web API (it needs a DSH connection-owner credential the plugin route does not have) — they go through the host `workspaceRegistry`, which persists and pushes the session-list update, so toggles apply immediately (see 0.3.82). Since 0.3.75 the archive file is synced, so these states travel with push/pull too.

### Panel: session names, Edit button, click-to-expand and quick jump (0.3.77)

Five interaction refinements on top of the 0.3.76 "Workspace visibility" card:

1. **Session names**: each expanded session shows a readable title (from the `session/title` event, falling back to the first user message text); hover for the full session ID. Titles are cached and rebuilt from the local logs on each machine.
2. **Edit button**: the state dropdown and per-session Hide/Show buttons stay hidden until you click Edit on that workspace; click Done to leave edit mode, so states cannot be changed by accident. (From 0.3.84 there is a single Edit button for the whole card — see below.)
3. **Click to expand**: click anywhere on a workspace row to expand/collapse its sessions; no separate expand button.
4. **Card position**: the Workspace visibility card moved just above Feedback, as the last configuration step.
5. **Sticky title + quick jump**: the panel title bar is sticky, with shortcut tabs below it (Overview / Workspaces / Targets / Automation / Scripts / Restore / Content / Plugin data / Feedback); clicking one smoothly scrolls to that section.

Title reading and state changes stay self-contained in this plugin and do not call the session-manager Web API.

### Quick-jump order matches the cards; scrolling no longer hides behind the title (0.3.78)

Two display fixes on top of 0.3.77:

1. **Jump order matches section order**: the quick-jump tabs now follow the exact render order of the sections (Overview / Sync conflicts [when present] / Local paths [when expanded] / Targets / Automation & updates / Scripts / Restore / Content / Plugin data / Workspace visibility / Feedback). The two conditional sections (conflicts, local paths) appear in the tabs only when their cards are shown.
2. **Scroll lands below the title**: the sticky title bar now uses an opaque background (same fill as panel cards), so content no longer shows through it; jumping to a tab sets the scroll offset from the title bar's actual height, so the target section lands fully below the title instead of being covered.

### Plugin update falls back to two npm sources (0.3.89)

The "Plugin update" card now shows an **npm download URL** line with the actual fallback addresses (domestic mirror `registry.npmmirror.com` + official `registry.npmjs.org`). When the GitHub release download is unreachable (common in mainland China), the update package automatically falls back to npm. It is still verified against the authoritative sha256 in `version.json` — switching source never relaxes verification. The two sources back each other up: the mirror can briefly 404 during its first-sync window, and the official source takes over. The npm tarball is byte-identical to the GitHub release tgz (same sha256).

### Clicking × to close DSH now checks once for auto pull/push immediately (0.3.93)

With "Pull on startup" or "Push on exit" enabled, the only queues used to be the 8-second startup check and the 2-minute re-check. If you made changes between two re-checks and then clicked the top-right × to close DSH, no watcher was waiting for the exit at that moment, so nothing ran after closing. A quit hook now covers it: when the last visible window closes (the × click), the plugin checks once and queues the watcher **before** the client exits; once the DSH processes are gone the watcher runs the pull/push immediately.

1. **Check once on exit**: when no visible windows remain, call `triggerAutoSyncOnClose(config)`, which reads the `autoPull`/`autoPush` switches; an in-flight watcher is reused rather than relaunched; with an empty local repo only autoPull can queue (first clone).
2. **Same criteria as the re-check**: pull takes priority (behind > 0 → queue pull, no confirmation dialog on the close path); push queues when any of "commits ahead / uncommitted changes / local data newer than last sync" hits; `autoRestart` semantics unified to `!== false` (relaunch by default).
3. **Queue before quit**: the queue must be awaited **before** `app.quit()` — the plugin dies with the main process, so checking after quit is too late. With both switches off / nothing to sync the function returns quickly and does not slow down closing; a successful queue logs "queued pull/push before exit …: runs right after DSH exits".

### Remote "uncommitted" now includes local pending changes + Refresh really fetches (0.3.92)

Root cause found by measurement for "remote info still not updating": the git-level behind/ahead really is 0 (local HEAD matches the gitee cloud), while what the user means by "not updated" is the runtime-generated changes on this machine not yet captured into the repo. Two substantive fixes:

1. **"Uncommitted" = git work-tree changes + local pending**: the status `repo` object gains `pending` (local session/config changes not yet synced) and `uncommitted` (`dirty + pending`). Both "Remote" Kv rows in the panel use `uncommitted` for the uncommitted figure and append "(N pending on this machine)" when there are pending items. New local sessions/config changes show up immediately without waiting for DSH exit + capture.
2. **"Refresh" button actually fetches**: the summary-row "Refresh" button previously only re-read status (no git fetch, so behind/ahead stayed the same). It now runs `refreshRemoteNow`: first `/config-sync/auto {action:'check'}` to trigger `git fetch` and refresh remote refs, then refresh the snapshot. The 30-second auto-refresh while expanded shares the same chain.

### Settings → General → Config Sync: live remote info + Pull/Push now buttons (0.3.91)

Two adjustments to the "Settings → General → Config Sync" summary row:

1. **Remote info no longer stale**: expanding the row first requests the `check` action on `/config-sync/auto` (triggering `git fetch` to refresh `@{upstream}`) and then refreshes status, so "behind X · ahead Y · uncommitted Z" shows the latest cloud figures instead of stale ones; it refreshes every 30 seconds while expanded and stops when collapsed. Root cause: the behind/ahead counts from `@{upstream}` only update after a fetch — a plain status read never triggers one.
2. **Buttons replaced with Pull/Push now**: the four "Generate scripts / push only / pull only / restore only" buttons are replaced by two — **Pull now (closes DSH)** and **Push now (closes DSH)** — sharing the same `pull-now` / `push-now` queue as the main panel's Automation card: clicking queues the action, which runs after DSH exits. Buttons are gated by backend permissions (`pullAllowed` / `pushAllowed`) with hints (empty repo → push first; empty cloud → pull first), and queued/result states give Chinese feedback. The script-generation entry remains on the main panel and is no longer duplicated in the summary row.

### To-do and jump-tab display cleanup (0.3.90)

Four display adjustments to the panel:

1. **Jump tabs highlight the current position**: the quick-jump tabs now auto-highlight the topmost visible section in the scroll region (primary fill + primary text), so "where am I" is obvious at a glance; clicking a tab also lights it up immediately.
2. **"Local data" label removed from To-do**: the old subheading-like "Local data / 本机数据" row is gone; the To-do card presents its stats and details directly without the redundant title.
3. **To-do expands to concrete names**: each group (Conversations / Local profile / Skills …) is one row; click it to reveal the concrete names — sessions show the session title (or `<sessionId> (session)` when unavailable), and the local profile shows file names like `package.json`, `cordis.patch.yml`; each group is de-duplicated and capped at 50 items. The To-do card title row has an Expand / Collapse toggle, expanded by default so details are visible on entry.
4. **Overview description synced**: changed to "Versions, dependencies, snapshots and to-do at a glance".

### Local data moved into To-do, grouped by sync content, sessions shown by name (0.3.86)

The "Local data" row in the "Local repo" card moved into "Overview → To-do", with its presentation reorganised:

1. **Location**: the old "Local data" line at the bottom of the "Local repo" card is gone. The To-do card now shows even when nothing else is wrong — it starts with local data (last sync time / pending count / mode) and then the existing to-do suggestions. "How much is still unsynced" and "what to do about it" sit together.
2. **Grouped by sync content**: pending files are counted by the same twelve groups as "Sync content" — Conversations / Skills / Plugin data / Memory data / Local profile / Global prompts / Agent presets / Plugin settings & workflows / Workspace files / Extra paths, etc. Each group is a chip with a count, sorted by count descending; no more bare single total.
3. **Sessions shown by name**: in the "Recently changed" sample, session files show the projected session title (matching the DSH panel, e.g. "列出工作区下的文件夹") instead of a `session-xxx/session.v4.jsonl.zstd` directory id; non-session items with no title still show their parent directory / file name.

### Workspace visibility card: one Edit button for the whole card, sessions paired with their toggles (0.3.84 / 0.3.85)

The edit interaction of the "Workspace visibility" card was rebuilt:

1. **A single Edit button for the entire card** (0.3.84): previously every workspace row carried its own Edit/Done button, and once there were several rows the buttons no longer lined up with the sessions. Now there is one button on the right of the header row — "Edit" when idle, switching to "Done" (primary colour, same position) once you are editing — and it unlocks every workspace tri-state plus every session toggle at once; clicking again leaves edit mode. The per-row button is gone.
2. **Session/button pairing made concrete** (0.3.84): each session gets its own row with a divider between rows; in edit mode the whole row gets a background and rounded corners, framing "this session" together with "its button". The toggle sits at the end of that row with a fixed width, so a wrap never puts it next to a different session. The word and colour distinguish Hide (red) from Show (green), the `title` carries the session name, and hidden sessions get a struck-through, dimmed name (the separate "Hidden" label was dropped).
3. **No tinted explanation banner** (0.3.85): edit mode no longer inserts a yellow-bordered hint row above the list; whether you are editing is read from the header button alone.

### Workspace visibility card: blank sessions and idle-review parents are collapsed too (0.3.83)

On top of 0.3.82's "collapse agent child sessions by default", two more kinds of noise are folded away:

1. **Blank sessions**: entries that were created but never used — no message, no turn (empty `origin` in the session header, and the log only holds permission / sandbox / approval / session-end-seed events, no `turn/start` and no `user/message`).
2. **Mnemon idle-review parents**: `mnemon-review-owner-v1-*`, which carry only a `subagent/catalog` event — the actual content lives in the `mnemon-review-v1-*` child session they point at.

Both naturally satisfy the same "blank" test, so one rule folds them away; no name matching is needed. A "Show blank" checkbox in the header row brings them back, and the footer reports how many blank and how many agent sessions were collapsed. On this machine the default view drops from 99 entries to 10.

### Workspace visibility card: agent sessions collapsed by default + instant hide/show (0.3.82)

Two changes to the "Workspace visibility" card:

1. **Agent (subagent) sessions are collapsed by default**: the card lists only your own sessions. A "Show agents" checkbox in the header row reveals agent child sessions and reports how many were folded away. 80 of the 99 registered sessions on this machine were agent sessions (mnemon reviews and delegated tasks each leave one behind), flooding the list so you could not find your own.
2. **Hide/show takes effect immediately**: toggling the workspace tri-state or a single session used to only rewrite the on-disk state file, leaving the host's in-memory `archivedSessionIds` stale — a client restart or session-list refresh was required. It now goes through the host `workspaceRegistry` (`archiveSession` / `unarchiveSession`), which persists and pushes the session-list update, so toggles apply the moment you click. If the host service is unavailable it falls back to the previous file-based write and the card hint says which path was used.

Reading the owning workspace and the session title stays self-contained; the session-manager Web API is not used.

### Workspace visibility card session names now match the DSH panel (0.3.81)

Fixes session names in the "Workspace visibility" card differing from the DSH session panel.

DSH session titles evolve: a fallback title (truncated first message) is created first, then a provider title is generated by the model. The card previously stopped at the first fallback; it now picks the latest title by priority — provider > fallback > untagged title > first user message — matching the DSH panel exactly.

### Fix cross-machine sync downgrading the installed plugin and rolling back pulls (0.3.80)

Fixes an issue where pulling on another machine replaced a newer locally installed plugin with an older archive from the config repo, turning the link into 0.0.0, failing bundle resolution, and rolling the pull back.

| Problem | Fix |
|---|---|
| An older archive was still deployed because versions merely differed | Version comparison is now semantic upgrade-only: the archive is deployed only when its version is higher than the installed one |
| Archive top-level folder mismatched the file name (e.g. a 0.3.70 package wrapping a 0.3.56 folder), producing nested folders and a broken link | capture now validates the archive top-level folder and version after packing; bad archives are deleted with a warning instead of being synced |
| Stale plugin keys caused repeated plugin-missing notices | Removed invalid legacy keys from localPluginMap and cleared stale notices |

The corrupted archive in the config repo was also repacked with correct 0.3.79 content.

### The panel is now a fixed header plus an independently scrolling body (0.3.79)

0.3.78 still kept the sticky header inside the same scroll container, so two cases leaked through: with a shorter panel, or with a header that wraps onto more lines, content brushed past the header's divider and even showed up in the padding above it; and the jump offset was computed from the header height, so it shifted whenever conditional sections appeared or disappeared.

0.3.79 splits the panel in two: the header (title, badges, meta line and section tabs) now sits **outside** the scroll area, pinned at the top of the panel; below it a separate `overflow-y:auto` region holds the notices and every section card. Three direct results:

1. **Structurally impossible to leak through**: the scrolling region starts 20px under the header divider, so however far you scroll, content stays inside it — never in the header area or above it.
2. **Jump targets are fixed**: a section tab now just scrolls to the top of the scrolling region plus 8px, with no header-height math, so header wrapping and conditional sections no longer move the landing point.
3. **No more header jitter**: the header does not scroll at all, so the shadow, translucent background and padding patches are gone; a single divider line is all that is left.

The change touches only the panel itself (`S.page` / `pageInner` are used nowhere else); the sidebar row and the settings summary row are unaffected.

### The non-ASCII path trap (0.3.48)

`git` keeps `core.quotepath=true` by default, so non-ASCII paths come back octal-escaped and wrapped in quotes (`"workspace/DSH\347\240\264\347\224\262/..."`). The 0.3.47 index precheck read that straight from `& $git ... diff --cached --name-only`, so `Test-Path -LiteralPath` hit the `"` and threw `路径中具有非法字符` (illegal characters in path) — the whole sync died before committing.

Fix: every path-consuming git query now goes through `Read-GitLines` (`-c core.quotepath=false` + cmd byte redirect + UTF-8 read), and each per-file `stat` sits inside `try/catch` so one bad name only skips the size check instead of killing the run. Measured on the real repo: 918 staged paths, 0 quoted and 0 stat failures; the history precheck parsed all 3222 `ls-tree -r -l` lines into path plus size.

Measured (2026-11-14, isolated repo + local bare remote + fake `pre-receive` hook): a 96 MB file was unstaged while the rest pushed fine and `sync-notices.json` recorded `too-large=1`; after the same file went into history the precheck reported `history=1`; a hook replaying GitHub's message (`File big.bin is 96.00 MB; this exceeds ...`) was classified as "1 file over the cap", not as a network problem; the window summary and the panel block read the same file.

## Using this repo as a market index source

The root `market-index.json` is a ready-to-use DSH market index (`format: 1`, `source.type: git` with a 40-character commit; installing fetches the package from this repo, no build). Index URL:

```
https://raw.githubusercontent.com/huanyu-a/dsh-profile-config-sync/main/market-index.json
```

In DSH go to **Plugins → Discover → Index sources**, paste the URL above, and "Config Sync" shows up in the list; installing pulls this repo at that commit.

- **Prerequisite**: this is an index source for the **official Discover page** (`@deepseek-ai/dsh-plugin-market`), which needs the official `@deepseek-ai/dsh-experimental-plugin-market-bundle` enabled in the profile. Without it, neither the Discover page nor the index-source entry exists.
- **Not found in dshmarket is expected**: the third-party market plugin dshmarket lists only its own curated catalog (`awesome-dsh-plugin.com/plugins.json`, or the `dsh-plugin-catalog` npm package in China). Its source has no path for user-supplied indexes (`lib/registry.js` reads that single catalog per region on every call, `lib/sources.js` only parses entries of that catalog), and its installs are restricted to sources listed there — anything else is rejected. So a self-hosted index, however valid, never shows up in dshmarket's search. To appear there, open a PR against [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (its README says plainly: don't PR plugin entries against the market repo).
- **Fetching the index from China**: `raw.githubusercontent.com` comes and goes; prefix it with `https://gh-proxy.com/` or `https://ghfast.top/`, or use jsDelivr's `https://cdn.jsdelivr.net/gh/huanyu-a/dsh-profile-config-sync@main/market-index.json` — but jsDelivr caches branch aliases like `@main`, so a new release may take hours to appear there.
- **Just want it on your own machine**: no market needed — `dsh plugin add` with the tgz from the install section above is the shortest path.

Release flow: change code → `pwsh -File tools\pack-plugin.ps1` to pack `releases/dsh-profile-config-sync-<version>.tgz` (it collects files from `package.json`'s `files` and writes the sha256 back into `version.json`) → bump `version` (and `notes`) in `version.json` → replace `version` and `commit` of the entry in `market-index.json` → push. The index only references a commit, so older versions stay installable. Run `node tools\selftest.mjs <repo path>` and `node tools\clientcheck.mjs` before releasing.

## Pitfalls already closed in the generator

All of them surfaced only by **actually running on a new machine**:

| Pitfall | Handling |
|---|---|
| cmd's `echo` swallows `< > \| & ^ %`, so `echo ... config-<timestamp>` became a redirect and printed nothing | every dynamic line goes through `echoSafe()`: `%`→`%%`, special characters prefixed with `^` |
| after `chcp 65001`, `set /p` cannot read redirected input: automation feeding `y` left `GO` empty, "finished" printed while nothing happened, exit code still 0 | `--yes` skips confirmation + an explicit receipt when there is none |
| a fresh machine has no upstream, `git pull --ff-only` says *There is no tracking information…*, PowerShell 5.1 wraps it as NativeCommandError and the script carried on | `sync.ps1` probes upstream first; since 0.3.54 a pull is `fetch` + `merge --ff-only origin/<branch>` (one network round trip), and a missing upstream is fixed with `set-upstream-to`; push uses `-u` |
| `GIT_SSH_COMMAND` without the ssh.exe program → `/usr/bin/sh: - : invalid option` | four branches: use `core.sshCommand` if set; write a full command when `ssh.exe` is found; **unset the variable** when only a key exists; hand it to `.ssh\config` when there is no key |
| with an asar build, AppRoot lookups by path all miss and every bundle is reported missing | `isAppRoot` accepts `app\package.json` **or** `app.asar`; version and bundle existence are read straight out of the asar (PowerShell 5.1 `ConvertFrom-Json` caps at 2 MB, a 5.7 MB header has to be read by entry offset), and anything undecidable is reported as "unknown" |
| plugin directory already present skips deployment, so a newer tgz leaves old code running | `apply.ps1` compares the tgz with the newest deployed file and, when newer, renames to `.bak-<timestamp>` and redeploys |
| "push on exit" was enabled yet nothing happened (no log, no result file) | two causes stacked: ① the queue predicate only looked at `ahead > 0`, which stays 0 until new sessions are captured → count all three sources + re-check every 2 minutes; ② `spawn` faked success (`detached` PowerShell exiting immediately / failures only on the `error` event) → start a separate process with `Start-Process`, await the launcher's exit code, and write `auto-sync-launch.log` |
| an empty folder was treated as "the repo is broken": red text plus an enabled push button that would always fail | since 0.3.26 `repo.phase` splits it into four states; an empty folder allows pull only, blocked at three layers: `prepare(push)`, `push-now`, and `sync.ps1 push` |
| "does the cloud have anything to pull" was answered by branch count → a remote whose `main` still exists but whose tree was emptied still read as "has content, pull only": pulling produced an empty folder, the state never changed and the initialize-push entry never appeared (a dead loop; verified on Gitee: 98 commits, the last 12 all "delete file", the newest tree has 0 files) | since 0.3.36 the criterion is **the file count inside the branch tree**: `ls-remote --heads` counts branches first (0 branches = empty, no fetch), and only when branches exist does it create a temporary bare repo, `fetch --depth 1 --filter=blob:none` and `ls-tree -r`, then delete it; `remoteFiles===0` always means "both sides empty" → push only, and `sync.ps1` overwrites that empty branch with `--force-with-lease` (the tree is empty, nothing is lost) |
| a pull rewrote settings wholesale: edit a path, pull before pushing and the edit was silently replaced (only a backup folder, no notice) | since 0.3.36 the overwrite is compared first (roots → placeholders, CRLF flattened, the three timestamp fields in `our-free-model.json` zeroed); every difference lands in `config-sync-overwrite.json` and the panel/console say "N files were overwritten, local edits backed up first" |
| after a sync, **creating a session failed outright**: `failed to create session … corrupt Zstandard session log: invalid frame magic at byte 186` | the first frame DSH writes carries a **4-byte content checksum** (frame header descriptor FHD bit2), and the decompressor happily succeeds on the prefix with that checksum trimmed, so the binary search for the "shortest decodable prefix" ended 4 bytes early; the rewritten file then kept the old checksum as garbage and DSH blew up on the second frame. Now: add 4 bytes per FHD bit2 → correct against "the next frame magic" → self-check before writing (cwd applied + new first frame is followed by a frame magic), refuse to write otherwise; leftover tails in already-broken files are dropped (self-healing) |

Session header `cwd`, empty-snapshot fallback and missing `Get-FileHash` are handled by `apply.ps1` / `restore.ps1` / `dsh-sync-common.ps1` in the config repo; see sections 5 and 10 of its root `README.md`.

## Performance (0.3.54): three speedups, zero behaviour change

All three change *how* things are computed, not *what* is computed: the files written to the repo, the commit contents and the failure decisions stay byte-identical to 0.3.53 — it just runs faster. Numbers come from a same-size synthetic repo (50,889 files / 416 MB) and against real Gitee:

| Step | Before | After | Why |
|---|---|---|---|
| capture deciding "does this file need rewriting" | two `Get-FileHash` per file (source + repo): 1.2 ms each → ~**120 s** for 50k files | two `Get-ChildItem` passes, one `FileInfo` each (Length / LastWriteTimeUtc already read by the enumeration) + an in-memory dictionary diff: **3.9 s**; hashes only for the few whose size or mtime differs | per-file `Test-Path` / `Get-Item` is *slower* (measured **37.8 s**, ~0.7 ms per cmdlet call), so bulk enumeration is the only sane way |
| push scanning history for oversized blobs | `git ls-tree -r -l HEAD` on every push: **20–23 s** on a 50k-file repo, for a history that barely changes | cached per commit in `.dsh\sync-history-scan.json` (`{commit, oversized, at}`): skipped when the commit matches or is an ancestor of HEAD; a full scan only on first push, after a remote rejection, or with `-ScanHistory` | newly added files are already caught by the index pre-check; the history scan only covers "an old commit already carries a huge blob" |
| pull | `git pull --ff-only` is fetch + merge internally, while the script had already fetched → **two network round trips** (SSH handshake measured ≈0.95 s) | `fetch origin --prune`, then `merge --ff-only origin/<branch>` → **one round trip**; `merge --ff-only` still refuses anything but a fast-forward, so a dirty tree or divergence fails exactly as before | when the run starts from a pending conflict list the earlier fetch was skipped, so one fetch is issued first to make the merge use fresh refs |

Two new switches on `sync.ps1`, both **off by default** — the default path behaves exactly like 0.3.53:

- `-DeepVerify`: forwarded to `capture.ps1`, ignoring the size/mtime fast path and **hashing every file**. Use it when you suspect drift where size and mtime both look unchanged (cost: back to 1.2 ms per file).
- `-ScanHistory`: ignores the history-scan cache and **always does a full** `ls-tree -r -l HEAD`. Use it after switching remotes, when the cache looks stale, or for a manual re-check.

```powershell
pwsh -File sync.ps1 push -DeepVerify
pwsh -File sync.ps1 push -ScanHistory
```

The log shows which path ran: `文件比较（快筛）：比对 N 个，深哈希 M 个` versus `文件比较（深校验开）：比对 N 个，深哈希 N 个`.

## Contents

| Path | Purpose |
|---|---|
| `index.js` | Host half: `/config-sync/status`, `/prepare`, `/settings`, `/auto`, `/update` routes |
| `client.js` | Browser half: sidebar row, panel, settings summary row |
| `cordis.patch.yml` | Bundle patch layer (`id: config-sync`) |
| `runtime/` | The six post-exit PowerShell scripts plus `fix-session-cwd.mjs`, shipped with the package so scripts can be generated right after install without cloning the config repo first |
| `tools/` | Self-test `selftest.mjs`, client structure check `clientcheck.mjs` |
| `version.json` / `releases/` | Self-update manifest and package |

