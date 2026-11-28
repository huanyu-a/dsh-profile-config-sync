// 「插件设置与工作流」组的源文件清单 —— 面板（index.js）与引擎（sync-engine.mjs）共用一份。
//
// 一行一个源：`id` 是仓库里的文件名（`settings/<id>`），`rel` 相对 `<DshHome>`，
// `profileRel` 相对 `<DshHome>/profiles/<name>`。与 PowerShell 的 Get-SyncSettingsMap 同一份清单，
// 加新插件设置时**三个地方**都要跟着加（这里、PS 那份、面板只读这张表）。
//
// 为什么这组要单独列而不是整目录抓：这些文件散落在 <DshHome> 的树里，周围都是 .db / 缓存 / 会话，
// 整目录抓会顺带把几百 MB 的运行时数据搬进仓库。

import { join } from 'node:path'

export const SETTINGS_SOURCES = [
  { id: 'our-free-model.json', rel: ['our-free-model', 'settings.json'] },
  { id: 'comfyui-workflows.json', rel: ['data', 'dsh-comfyui', 'workflows.json'] },
  { id: 'dsh-pet-main-config.jsonc', rel: ['dsh-pet', 'main-config.jsonc'] },
  { id: 'dsh-market-state.json', profileRel: ['.dsh-market', 'state.json'] },
  { id: 'dsh-pet-memory.json', rel: ['dsh-pet', 'memory.json'] },
  { id: 'our-free-model-picks.json', rel: ['our-free-model', 'picks.json'] },
  { id: 'dsh-im-interface-language.json', rel: ['integrations', 'dsh-im', 'interface-language.json'] },
  { id: 'dsh-qq-config.json', rel: ['integrations', 'dsh-qq', 'config.json'] },
  { id: 'dsh-qq-workspaces.json', rel: ['integrations', 'dsh-qq', 'workspaces.json'] },
  { id: 'redteam-preset-declare.json', rel: ['redteam', 'preset-declare.json'] },
  { id: 'task-board-ledger.json', rel: ['task-board', 'ledger-v2.json'] },
  { id: 'task-board-scheduler.json', rel: ['task-board', 'scheduler-v2.json'] },
  { id: 'dsh-workspaces.json', rel: ['storages', 'workspace.json'] },
  { id: 'workspace-archives.json', rel: ['dsh-session-manager', 'workspace-archives.v1.json'] },
]

export function settingsSourcePath(dshHome, profileDir, entry) {
  return entry.profileRel ? join(profileDir, ...entry.profileRel) : join(dshHome, ...entry.rel)
}

/**
 * 只带语义的运行时计数要清零，否则每轮抓取都「有改动」：
 * our-free-model 的 settings.json 里这几个字段是插件自己每秒刷新的。
 */
export const SETTINGS_VOLATILE_FIELDS = { 'our-free-model.json': ['catalogSyncedAt', 'reloadedAt', 'reloadCount'] }

/** 把易变字段的数值抹成 0（只动数字，别的一个字节都不碰）。 */
export function zeroVolatileFields(text, id) {
  const fields = SETTINGS_VOLATILE_FIELDS[id]
  if (!fields || !text) return text
  let out = text
  for (const k of fields) out = out.replace(new RegExp(`("${k}"\\s*:\\s*)\\d+`, 'g'), '$10')
  return out
}
