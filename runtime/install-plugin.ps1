<#
  运行中把插件新版本装进插件目录（**不退出** DSH）。

  由宿主的 install-live 动作调用：
    powershell -NoProfile -ExecutionPolicy Bypass -File install-plugin.ps1 `
        -PluginDir <AppRoot>\dsh-config-sync-<ver> -Version 0.3.4 -Sha256 <hex> `
        -TgzUrls "https://cdn.jsdelivr.net/.../0.3.4.tgz|https://raw.githubusercontent.com/.../0.3.4.tgz" `
        -DshHome C:\Users\xx\.dsh

  要点
    - 下载地址是**候选列表**（| 分隔），按顺序试，哪个先成功就用哪个：国内直连 raw.githubusercontent.com
      经常不通，CDN 兜在前面才不至于"检查能过、下载过不去"。
    - 校验 sha256 → 解包 → 比对包里的 version 与清单一致，三步都过才动插件目录。
    - 动手前整目录备份到 <DshHome>\backups\plugin-<旧版本>-<时间戳>；覆盖失败就把它拷回去。
    - 不重启、不关 DSH：覆盖的是磁盘文件，进程里跑的还是旧代码，所以要提示"重启生效"。
    - 结果固定打一行 RESULT:{json} 给宿主解析（ok / version / backup / log / error）。
#>
param(
  [Parameter(Mandatory = $true)][string]$PluginDir,
  [string]$Version = '',
  [string]$Sha256 = '',
  # 0.6.47：npm registry 的权威校验值（integrity = SRI sha512-base64，sha1 = dist.shasum）
  [string]$Integrity = '',
  [string]$Sha1 = '',
  # 候选下载地址，用 | 分隔
  [string]$TgzUrls = '',
  # 已经下好的本地包（有就不用下载）
  [string]$TgzFile = '',
  [string]$DshHome = $(Join-Path $env:USERPROFILE '.dsh'),
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not $LogFile) {
  $logDir = Join-Path $DshHome 'logs'
  if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $LogFile = Join-Path $logDir ("plugin-install-{0}.log" -f $stamp)
}
# ---------- 环境自愈：模块被别的 PowerShell 版本抢走时，这一步决定后面还能不能跑 ----------
# 实测：DSH 从 pwsh（PowerShell 7）里启动时，子进程 powershell.exe 5.1 继承了 PS7 的 PSModulePath，
# 自动加载先撞上 PS7 的 Microsoft.PowerShell.Utility（7.0.0.0，5.1 装不进去），于是
# Get-FileHash / Invoke-WebRequest 直接「无法识别」——更新流程把空 hash 当校验失败，永远装不上。
try {
  if ($PSVersionTable -and $PSVersionTable.PSEdition -ne 'Core') {
    $selfModules = Join-Path $PSHOME 'Modules'
    if ($selfModules -and (Test-Path -LiteralPath $selfModules)) {
      $cur = [string]$env:PSModulePath
      $rest = @($cur -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $selfModules.TrimEnd('\')) })
      $env:PSModulePath = (@($selfModules) + $rest) -join ';'
    }
  }
} catch { }

# Get-FileHash 的 .NET 等价实现：模块加载失败时也别让一个 cmdlet 决定整条链路生死
if (-not (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
  function Get-FileHash {
    param(
      [Parameter(Mandatory = $true)][string]$LiteralPath,
      [ValidateSet('SHA256', 'SHA1', 'MD5')][string]$Algorithm = 'SHA256'
    )
    $algo = [System.Security.Cryptography.HashAlgorithm]::Create($Algorithm)
    $fs = [System.IO.File]::Open($LiteralPath, 'Open', 'Read', 'ReadWrite')
    try { $bytes = $algo.ComputeHash($fs) } finally { $fs.Dispose(); $algo.Dispose() }
    [pscustomobject]@{
      Algorithm = $Algorithm
      Hash      = (($bytes | ForEach-Object { $_.ToString('X2') }) -join '')
      Path      = $LiteralPath
    }
  }
}

# 下载兜底：Invoke-WebRequest 不可用（或被策略挡掉）时直接用 .NET，带上同样的头与超时
function Save-UrlToFile {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [hashtable]$Headers = @{},
    [int]$TimeoutSec = 180
  )
  # 这个兜底实现（HttpWebRequest）在 5.1 里会把 Authorization 头吃掉（实测：头存进对象但发不出去），
  # 所以带令牌的下载宁可直接报错并给出办法，也不让用户对着一个没头没脑的 401 猜。
  foreach ($hk in @($Headers.Keys)) {
    if ([string]$hk -ieq 'Authorization') {
      throw '当前 PowerShell 环境不支持带令牌下载（模块被别的 PowerShell 版本占用了）：请在面板里用「更新」，或从开始菜单/桌面重新启动 DSH 后重试'
    }
  }
  $req = [System.Net.HttpWebRequest]::Create($Uri)
  $req.Timeout = $TimeoutSec * 1000
  $req.ReadWriteTimeout = $TimeoutSec * 1000
  $req.UserAgent = 'dsh-profile-config-sync'
  foreach ($k in @($Headers.Keys)) {
    $v = [string]$Headers[$k]
    if ($k -eq 'User-Agent') { $req.UserAgent = $v } else { $req.Headers[$k] = $v }
  }
  $resp = $req.GetResponse()
  try {
    $in = $resp.GetResponseStream()
    $out = [System.IO.File]::Create($OutFile)
    try { $in.CopyTo($out) } finally { $out.Dispose() }
  } finally { $resp.Close() }
}

# 统一下载入口：优先 cmdlet，缺失时自动走 Save-UrlToFile
function Invoke-DownloadFile {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [hashtable]$Headers = @{},
    [int]$TimeoutSec = 180
  )
  Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
  # 注意：Get-Command 只表示「命令能被发现」，不代表能执行 —— PS7 的模块目录排在 PSModulePath 前面时，
  # Invoke-WebRequest 会被解析到装不进 5.1 的版本，调用当场抛装配错误（实测）。所以必须 try/catch 兜底，
  # 而不是只看命令在不在。
  if (Get-Command Invoke-WebRequest -ErrorAction SilentlyContinue) {
    try {
      Invoke-WebRequest -Uri $Uri -Headers $Headers -OutFile $OutFile -UseBasicParsing -TimeoutSec $TimeoutSec
      return
    } catch {
      Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
    }
  }
  Save-UrlToFile -Uri $Uri -OutFile $OutFile -Headers $Headers -TimeoutSec $TimeoutSec
}
function Log([string]$text) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8 } catch { }
}

function EmitResult([bool]$ok, [string]$errorText, [string]$backupPath) {
  $obj = [ordered]@{
    ok      = $ok
    version = $Version
    backup  = $backupPath
    log     = $LogFile
    error   = $errorText
  }
  # 宿主只认这一行，别把它混进进度输出里
  Write-Output ("RESULT:" + ($obj | ConvertTo-Json -Compress -Depth 3))
  exit 0
}

# 失败时用备份把插件目录恢复成动手前的样子
function Restore-Backup([string]$backup, [string]$target) {
  if (-not $backup -or -not (Test-Path -LiteralPath $backup)) { return $false }
  try {
    foreach ($it in @(Get-ChildItem -LiteralPath $target -Force)) {
      Remove-Item -LiteralPath $it.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    foreach ($it in @(Get-ChildItem -LiteralPath $backup -Force)) {
      Copy-Item -LiteralPath $it.FullName -Destination $target -Recurse -Force
    }
    return $true
  } catch {
    Log ("回滚失败：{0}" -f $_.Exception.Message)
    return $false
  }
}

Log ("==== 安装插件 {0} 到 {1} ====" -f $Version, $PluginDir)

if (-not (Test-Path -LiteralPath $PluginDir)) { EmitResult $false ("找不到插件目录：" + $PluginDir) '' }

$currentVersion = ''
try { $currentVersion = (Get-Content -LiteralPath (Join-Path $PluginDir 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version } catch { }
Log ("当前版本：{0}" -f $currentVersion)

$tmp = Join-Path $env:TEMP ("dsh-plugin-live-{0}-{1}.tgz" -f $Version, $stamp)
$pkgPath = ''
if ($TgzFile -and (Test-Path -LiteralPath $TgzFile)) {
  $pkgPath = $TgzFile
  Log ("使用本地包：{0}" -f $pkgPath)
} else {
  $urls = @($TgzUrls -split '\|' | Where-Object { $_ -and $_.Trim() })
  if ($urls.Count -eq 0) { EmitResult $false '没有给下载地址，也没有本地包' '' }
  $errors = @()
  foreach ($u in $urls) {
    Log ("尝试下载：{0}" -f $u)
    try {
      Invoke-DownloadFile -Uri $u.Trim() -OutFile $tmp -TimeoutSec 90
      if ((Test-Path -LiteralPath $tmp) -and ((Get-Item -LiteralPath $tmp).Length -gt 0)) {
        $pkgPath = $tmp
        Log ("下载成功：{0:N0} 字节" -f (Get-Item -LiteralPath $tmp).Length)
        break
      }
      $errors += ("{0}：文件没有落盘" -f $u)
    } catch {
      $errors += ("{0}：{1}" -f $u, $_.Exception.Message)
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $pkgPath) {
    $msg = '下载安装包失败（每个地址都试过了）：' + ($errors -join '；')
    Log $msg
    EmitResult $false $msg ''
  }
}

# ---------- 校验安装包 ----------
# 0.6.47 起权威校验值来自 npm registry 自己的 dist.integrity（SRI，sha512-base64）/ dist.shasum（sha1），
# 与被校验物同源。旧路径用打包时的 sha256 —— npm tarball 与 GitHub release 资产不是同一份字节流，
# 那个校验对 npm 下载必然失败。优先 integrity，其次 sha1，最后 sha256（兼容老路径）。
if ($Integrity) {
  $algo = ''
  $expectedB64 = ''
  foreach ($part in ($Integrity -split '\s+' | Where-Object { $_ })) {
    $dash = $part.IndexOf('-')
    if ($dash -le 0) { continue }
    $a = $part.Substring(0, $dash).ToLower()
    if ($a -notin @('sha256', 'sha384', 'sha512')) { continue }
    $algo = $a
    $expectedB64 = $part.Substring($dash + 1)
    break
  }
  if (-not $algo) {
    EmitResult $false '更新源给的 integrity 格式无法解析' ''
  }
  $sha = switch ($algo) {
    'sha256' { [System.Security.Cryptography.SHA256]::Create() }
    'sha384' { [System.Security.Cryptography.SHA384]::Create() }
    'sha512' { [System.Security.Cryptography.SHA512]::Create() }
  }
  $gotB64 = ''
  try {
    $bytes = [System.IO.File]::ReadAllBytes($pkgPath)
    # 0.7.1 修复：TransformBlock 第一参要 byte[]，旧写法传 FileStream 在 PowerShell 7 直接异常。
    $sha.TransformBlock($bytes, 0, $bytes.Length, $bytes, 0) | Out-Null
    $sha.TransformFinalBlock([byte[]]::new(0), 0, 0) | Out-Null
    $gotB64 = [Convert]::ToBase64String($sha.Hash)
  } catch {
    EmitResult $false ('本机 PowerShell 无法计算安装包 ' + $algo) ''
  }
  Log ("integrity（{0}）：{1}" -f $algo, $gotB64)
  if ($gotB64 -ne $expectedB64) {
    Log 'integrity 与更新源不一致，放弃安装'
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    EmitResult $false '安装包 integrity 校验不通过（没下载全或被改动）' ''
  }
  Log 'integrity 校验通过'
} elseif ($Sha1) {
  $hash = ''
  try { $hash = [string]((Get-FileHash -LiteralPath $pkgPath -Algorithm SHA1).Hash) } catch { $hash = '' }
  $hash = $hash.Trim().ToLower()
  Log ("sha1：{0}" -f $(if ($hash) { $hash } else { '（算不出来）' }))
  if (-not $hash) {
    EmitResult $false '本机 PowerShell 无法计算安装包 sha1' ''
  }
  if ($hash -ne $Sha1.ToLower()) {
    Log 'sha1 与更新源不一致，放弃安装'
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    EmitResult $false '安装包 sha1 校验不通过（没下载全或被改动）' ''
  }
  Log 'sha1 校验通过'
} elseif ($Sha256) {
  $hash = ''
  try { $hash = [string]((Get-FileHash -LiteralPath $pkgPath -Algorithm SHA256).Hash) } catch { $hash = '' }
  $hash = $hash.Trim().ToLower()
  Log ("sha256：{0}" -f $(if ($hash) { $hash } else { '（算不出来）' }))
  if (-not $hash) {
    EmitResult $false '本机 PowerShell 无法计算安装包 sha256（Get-FileHash 不可用且 .NET 回退也失败）' ''
  }
  if ($hash -ne $Sha256.ToLower()) {
    Log 'sha256 与清单不一致，放弃安装'
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    EmitResult $false '安装包 sha256 校验不通过（没下载全或被改动）' ''
  }
  Log 'sha256 校验通过'
}

$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tar)) { $tar = 'tar.exe' }
$stage = Join-Path $env:TEMP ("dsh-plugin-live-stage-" + $stamp)
$payload = ''
try {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  & $tar -xzf $pkgPath -C $stage *> $null
  if ($LASTEXITCODE -ne 0) { throw ("解包失败，退出码 {0}" -f $LASTEXITCODE) }
  $payload = Join-Path $stage 'package'
  if (-not (Test-Path -LiteralPath $payload)) { throw '安装包结构不对（里面没有 package 目录）' }
  $newVersion = (Get-Content -LiteralPath (Join-Path $payload 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version
  Log ("包内版本：{0}" -f $newVersion)
  if ($Version -and $newVersion -ne $Version) { throw ("安装包里的版本是 {0}，与清单 {1} 不一致" -f $newVersion, $Version) }
} catch {
  Log ("解包/校验失败：{0}" -f $_.Exception.Message)
  if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  EmitResult $false ('安装包有问题：' + $_.Exception.Message) ''
}

# 整目录备份：写坏了能手动拷回去，也能自动回滚
$backup = Join-Path (Join-Path $DshHome 'backups') ("plugin-{0}-{1}" -f $(if ($currentVersion) { $currentVersion } else { 'unknown' }), $stamp)
$backupOk = $false
try {
  New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
  Copy-Item -LiteralPath $PluginDir -Destination $backup -Recurse -Force
  $backupOk = $true
  Log ("旧版已备份：{0}" -f $backup)
} catch {
  Log ("备份失败（继续安装，出问题就没有自动回滚了）：{0}" -f $_.Exception.Message)
}

Log '覆盖安装…'
$installError = ''
try {
  foreach ($it in @(Get-ChildItem -LiteralPath $payload -Force)) {
    Copy-Item -LiteralPath $it.FullName -Destination $PluginDir -Recurse -Force
  }
  $installed = (Get-Content -LiteralPath (Join-Path $PluginDir 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version
  Log ("安装完成，插件目录现在指向版本 {0}" -f $installed)
} catch {
  $installError = $_.Exception.Message
}

if ($installError) {
  $restored = Restore-Backup $(if ($backupOk) { $backup } else { '' }) $PluginDir
  $note = if ($restored) { '已用备份回滚到安装前的状态' } else { '没能自动回滚，手动把 ' + $backup + ' 拷回去' }
  Log ("写入失败：{0}（{1}）" -f $installError, $note)
  if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  EmitResult $false ("写入失败：" + $installError + '（' + $note + '）') $(if ($backupOk) { $backup } else { '' })
}

if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
EmitResult $true '' $(if ($backupOk) { $backup } else { '' })
