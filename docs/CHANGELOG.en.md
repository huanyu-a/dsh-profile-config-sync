# Test log (newest first, 22 entries)

> `README.en.md` keeps the most recent 8; the full English log lives here. The Chinese log (`docs/CHANGELOG.md`) has more recent entries and is the reference.

| Date | Version | Highlights |
|---|---|---|
| 2026-11-24 | 0.3.93 | Clicking × to close DSH now checks once for auto pull/push and queues the watcher immediately (no more waiting for the 2-minute window); autoRestart semantics unified to !== false |
| 2026-11-24 | 0.3.92 | Remote "uncommitted" now includes local pending data (pending); Refresh button really triggers git fetch; fixes "remote figures always 0" |
| 2026-11-24 | 0.3.91 | Settings summary row fetches before refreshing remote info (no longer stale, auto-refresh every 30s); four generate-script buttons replaced with Pull/Push now (closes DSH) sharing the automation queue |
| 2026-11-24 | 0.3.90 | Jump tabs highlight the current section; "Local data" label removed from To-do; To-do expands to concrete session names and local profile files |
| 2026-11-24 | 0.3.89 | Plugin update card shows an "npm download URL"; falls back to two npm sources (mirror + official) when GitHub release is unreachable, still verified against the authoritative sha256 |
| 2026-11-23 | 0.3.86 | Moved "Local data" into Overview / To-do, grouped pending files by the twelve sync-content groups, and show session names instead of session ids in the sample |
| 2026-11-23 | 0.3.85 | Removed the tinted banner above the workspace list in edit mode; edit state is read from the Edit/Done button in the header |
| 2026-11-23 | 0.3.84 | Workspace visibility card uses one Edit button for the whole card; each session row carries its own toggle with a background and divider, hidden names struck through |
| 2026-11-23 | 0.3.83 | Workspace visibility card also collapses blank sessions and Mnemon idle-review parents; default view on this machine 99 → 10 |
| 2026-11-23 | 0.3.82 | Workspace visibility card collapses agent sessions by default; hide/show goes through workspaceRegistry and applies instantly (no restart) |
| 2026-11-21 | 0.3.75 | Sync hidden/archived workspaces across machines (workspace-archives.v1.json into settings); hidden workspaces and sessions stay hidden on B after pull |
| 2026-11-19 | 0.3.69 | Carry billion-context compaction state across machines (bili-state.mjs); two new notice kinds (plugin-missing / context-state) |
| 2026-11-19 | 0.3.68 | Session projection-cache guard (fixes agent-busy session creation) |
| 2026-11-19 | 0.3.67 | Session log seq reconciliation guard (merge by seq, no more whole-file overwrite) |
| 2026-11-19 | 0.3.66 | .gitattributes silences LF/CRLF warnings |
| 2026-11-18 | 0.3.65 | Refresh button feedback (text changes to "Refreshing…") |
| 2026-11-18 | 0.3.64 | Backup restore fix (write back to original location) + failure summary + auto-close |
| 2026-11-18 | 0.3.63 | Push speed: Get-RelPath ~10x faster |
| 2026-11-18 | 0.3.62 | Pull speed: 341s → 109s (3.1×) |
| 2026-11-15 | 0.3.54 | Three speedups (fast-screen / history cache / single fetch), zero behaviour change |
| 2026-11-14 | — | Two machines from scratch (isolated); session log first-frame 4-byte leftover fix |
| 2026-11-11 | — | Single-machine isolated end-to-end (install → pull → push → restore) |
