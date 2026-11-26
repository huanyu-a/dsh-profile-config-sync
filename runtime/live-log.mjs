/**
 * 在线推送日志的清洗（从 index.js 抽出来单独放，便于自检直接跑样例）。
 *
 * 背景：Windows 上在线推送用 `powershell.exe -EncodedCommand` 跑 sync.ps1。
 * PowerShell 会把 `Write-Host` / `Write-Output` / 进度记录序列化成 CLIXML 打到 **stderr**，
 * stdout 里才是干净正文。stderr 是**按块**到达的，一个块常常从 XML 中间被切开
 * （实测片段形如 `2</U32><U32 N="ManagedThreadId">21</U32></Props></Obj>…`）。
 *
 * 0.5.0 的判定要求「整块以 #<CLIXML 或 <Objs 开头」，切开的块判定失败就被原样写进日志：
 * 一次推送写出 4.9 MB XML（3700 条「上传进度」各带一份完整记录），用户看到的最近日志全是乱码。
 *
 * 现在的规则：
 *   1. 只按标签抓消息文本（Error > Message > ToString），逐块抓、不依赖块边界；
 *   2. 抓到就只返回这些文本（去重、限条数）；
 *   3. 一块都抓不到且看着像 XML → 整块丢弃（真正的 PowerShell 错误一定带 <S S="Error"> 记录）；
 *   4. 不像 XML → 原样返回（git / pnpm 等原生程序的标准错误本来就是纯文本）。
 */

/** PowerShell CLIXML 的转义：实体（含数字实体）+ `_x000D_` / `_x000A_`。 */
export function decodeXmlText(input) {
  return String(input == null ? '' : input)
    .replace(/_x000[dD]_/g, '\n')
    .replace(/_x000[aA]_/g, '\n')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)) } catch { return '' }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)) } catch { return '' }
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 这段文本看起来像 CLIXML / 被切开的 CLIXML 片段吗？ */
export function looksClixml(text) {
  return /#<\s*CLIXML|<Objs\b|<Obj\b|<\/Obj>|RefId=|<TNRef|<ToString>|<Props>|<LST>/i.test(String(text || ''))
}

/**
 * 清洗一块子进程输出。
 * @param {string|Buffer} raw 原始输出块
 * @param {boolean} fromStderr 是否来自 stderr
 * @param {{maxLines?: number}} [opts]
 */
export function extractLiveLogText(raw, fromStderr, opts = {}) {
  const text = String(raw == null ? '' : raw)
  if (!fromStderr) return text
  if (!looksClixml(text)) return text
  const maxLines = Number(opts.maxLines) > 0 ? Number(opts.maxLines) : 40
  const picked = []
  const grab = (re) => {
    const r = new RegExp(re.source, re.flags)
    let m
    while ((m = r.exec(text)) !== null) picked.push(m[1])
  }
  grab(/<S\s+S="Error">([\s\S]*?)<\/S>/gi)
  grab(/<S\s+N="Message">([\s\S]*?)<\/S>/gi)
  if (!picked.length) grab(/<ToString>([\s\S]*?)<\/ToString>/gi)
  const seen = new Set()
  const out = []
  for (const p of picked) {
    const line = decodeXmlText(p).trim()
    if (!line || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  if (!out.length) return '' // 纯 XML 噪声（进度/information 记录）整块丢弃
  // 留**最后** maxLines 条：消息是按时间顺序来的，被截断的是开头的老进度；
  // 真正的报错总在最后，留前面的会把结论丢掉（面板「最近日志」同样看尾部）。
  if (out.length > maxLines) out.splice(0, out.length - maxLines)
  return out.join('\n')
}