<#
  一键安装 dsh-purge-flash
  ------------------------------------------------------------------
  只做三件事，不碰 DSH 安装目录里的任何文件：
    1. 在 <DSH_HOME>/profiles/<名字>/package.json 里登记 link: 依赖与 bundles 条目
    2. 把本仓库复制到 <profile>/node_modules/dsh-purge-flash
    3. 校验 JSON 还能解析，不能就还原备份

  用法：双击 install.bat
  可选：install.bat -Profile <名字> -DshHome <路径> -DryRun
#>

[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$Pkg  = 'dsh-purge-flash'

function Test-JsonText($t) {
  # ConvertFrom-Json 对尾逗号是宽容的（PS7 直接放过），所以不能只靠它。
  # 这里补三类最容易被手改出来的问题：尾逗号、括号不配平、解析失败。
  $problems = @()
  if ($t -match ',\s*[}\]]') { $problems += "有尾逗号（,} 或 ,]）" }
  $ob = ([regex]::Matches($t, '\{')).Count
  $cb = ([regex]::Matches($t, '\}')).Count
  $os = ([regex]::Matches($t, '\[')).Count
  $cs = ([regex]::Matches($t, '\]')).Count
  if ($ob -ne $cb) { $problems += "大括号不配平（$ob / $cb）" }
  if ($os -ne $cs) { $problems += "方括号不配平（$os / $cs）" }
  try { $null = $t | ConvertFrom-Json } catch { $problems += "ConvertFrom-Json 解析失败" }
  return $problems
}

function Say($t) { Write-Host $t }
function Ok($t)  { Write-Host "  [ok] $t" -ForegroundColor Green }
function Warn($t){ Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Die($t) {
  Write-Host ""
  Write-Host "  [x]  $t" -ForegroundColor Red
  Write-Host ""
  Write-Host "  没装成。配置没有被破坏（改过的话已经还原）。"
  Write-Host "  把上面几行连同下面这段一起发给作者："
  Write-Host "  --- 8< ---"
  Write-Host "  repo    : $Repo"
  Write-Host "  home    : $DshHome"
  Write-Host "  profile : $Profile"
  Write-Host "  ps      : $($PSVersionTable.PSVersion)"
  Write-Host "  os      : $([Environment]::OSVersion.VersionString)"
  Write-Host "  --- 8< ---"
  Write-Host ""
  exit 1
}

Say ""
Say "  dsh-purge-flash 安装器"
Say "  ---------------------"
Say "  仓库位置：$Repo"

if ($Repo -match '\s') {
  Warn "路径里有空格（$Repo）。能装，但装完没生效的话，先把整个文件夹挪到没有空格的路径再跑一次。"
}

# ---------- 1. 找 DSH_HOME ----------
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
  elseif ($env:USERPROFILE) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
if (-not $DshHome -or -not (Test-Path $DshHome)) {
  Die "找不到 DSH 数据目录。先启动一次 DeepSeek Harness 让它自己建出来，或者用 -DshHome 指定。"
}
Say "  DSH 数据目录：$DshHome"

# ---------- 2. 找 profile ----------
$ProfilesDir = Join-Path $DshHome 'profiles'
$ProfDir     = Join-Path $ProfilesDir $Profile
$PkgPath     = Join-Path $ProfDir 'package.json'

if (-not (Test-Path $PkgPath)) {
  if (Test-Path $ProfilesDir) {
    $cands = Get-ChildItem $ProfilesDir -Directory |
             Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
             Select-Object -ExpandProperty Name
    if ($cands) {
      Warn "profile「$Profile」不存在。这台机器上有：$($cands -join ', ')"
      Die "用 install.bat -Profile <名字> 指定其中一个重跑。"
    }
  }
  Die "找不到 $PkgPath。先启动一次 DSH。"
}
Say "  目标 profile：$ProfDir"

# ---------- 3. 改 package.json ----------
$text = Get-Content $PkgPath -Raw -Encoding UTF8
$linkVal = 'link:' + ($Repo -replace '\\', '/')

$mDep = [regex]::Match($text, '"dependencies"\s*:\s*\{([\s\S]*?)\}')
if (-not $mDep.Success) { Die "package.json 里没有 dependencies 段，版本可能太老。" }
$hasDep = $mDep.Groups[1].Value -match [regex]::Escape("`"$Pkg`"")

$mBun = [regex]::Match($text, '"bundles"\s*:\s*\[([\s\S]*?)\]')
if (-not $mBun.Success) { Die "package.json 里没有 dsh.profile.bundles 段，版本可能太老。" }
$hasBun = $mBun.Groups[1].Value -match [regex]::Escape("`"$Pkg`"")

if ($hasDep -and $hasBun) {
  Ok "package.json 里已经登记过了，跳过"
} else {
  $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
  $Backup = "$PkgPath.bak-before-flash-$stamp"
  if (-not $DryRun) { Copy-Item $PkgPath $Backup -Force; Say "  备份：$Backup" }

  if (-not $hasDep) {
    $open = [regex]::Match($text, '"dependencies"\s*:\s*\{')
    $at = $open.Index + $open.Length
    # 空的 dependencies 不能带尾逗号：{"a":"b",} 是非法 JSON。
    # 有内容时插到最前面，尾逗号由后面那一条兜住。
    if ($mDep.Groups[1].Value.Trim() -eq '') {
      $text = $text.Insert($at, "`r`n    `"$Pkg`": `"$linkVal`"`r`n  ")
    } else {
      $text = $text.Insert($at, "`r`n    `"$Pkg`": `"$linkVal`",")
    }
    Ok "加依赖 → $linkVal"
  } else {
    Ok "依赖已存在"
  }

  if (-not $hasBun) {
    $mBun2 = [regex]::Match($text, '"bundles"\s*:\s*\[([\s\S]*?)\]')
    $innerStart = $mBun2.Groups[1].Index
    $trimmed = $mBun2.Groups[1].Value.TrimEnd()
    if ($trimmed.Length -gt 0) {
      $text = $text.Insert($innerStart + $trimmed.Length, ",`r`n        `"$Pkg`"")
    } else {
      $text = $text.Insert($innerStart, "`r`n        `"$Pkg`"`r`n      ")
    }
    Ok "加 bundles 条目"
  } else {
    Ok "bundles 已存在"
  }

  if ($DryRun) {
    # DryRun 也要校验：不然会拿一份非法 JSON 告诉你「模拟安装成功」。
    $problems = @(Test-JsonText $text)
    $valid = ($problems.Count -eq 0)
    Say ""
    Say "  --- DryRun：下面是改完的样子（没落盘） ---"
    Say $text
    Say ""
    if ($valid) {
      Ok "DryRun 校验：改完的 JSON 合法"
      exit 0
    }
    Warn ("DryRun 校验：改完的 JSON 有问题 —— " + ($problems -join '；'))
    Warn "真跑会拦下来并还原备份，不会写坏你的配置。"
    exit 2
  }

  $problems = @(Test-JsonText $text)
  if ($problems.Count -gt 0) {
    Copy-Item $Backup $PkgPath -Force
    Die ("改完的 JSON 有问题（" + ($problems -join '；') + "），已还原。这份 package.json 本身可能有格式问题，建议先手动修好再装。")
  }
  [System.IO.File]::WriteAllText($PkgPath, $text, (New-Object System.Text.UTF8Encoding $false))
  Ok "package.json 已写入并校验通过"
}

# ---------- 4. 复制到 node_modules ----------
$NmDir  = Join-Path $ProfDir 'node_modules'
$Target = Join-Path $NmDir $Pkg
if (-not (Test-Path $NmDir)) { New-Item -ItemType Directory -Path $NmDir | Out-Null }

$doCopy = $true
if (Test-Path $Target) {
  $item = Get-Item $Target -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Ok "node_modules\$Pkg 已是一个链接，跳过复制"
    $doCopy = $false
  } else {
    Remove-Item $Target -Recurse -Force
  }
}

if ($doCopy) {
  $skip = @('.git', 'node_modules', 'posters')
  New-Item -ItemType Directory -Path $Target -Force | Out-Null
  Get-ChildItem $Repo -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
    Copy-Item $_.FullName -Destination $Target -Recurse -Force
  }
  Ok "已复制到 node_modules\$Pkg"
}

# ---------- 5. 操作稿：没有就补一份起步模板 ----------
# issue #4：装完 `/flash light` 只报「操作稿 ! 空」，用户手上没有任何可抄的结构。
# 这里在安装阶段就把模板落下去，让第一次 /flash light 直接是 ✓ on。
$opFile = Join-Path $DshHome "prompt-inject.md"
$opSeeded = $false
if (Test-Path $opFile) {
  Ok "操作稿已存在，没动它：$opFile"
} else {
  try {
    New-Item -ItemType Directory -Path $DshHome -Force | Out-Null
    Copy-Item (Join-Path $Repo "lib\operator-template.md") -Destination $opFile -Force
    $opSeeded = $true
    Ok "已生成起步操作稿：$opFile"
  } catch {
    Warn "操作稿模板没写成（$($_.Exception.Message)）。之后可以跑 /flash init 或 node bin/armor.mjs init"
  }
}

# ---------- 6. 完 ----------
Say ""
Say "  装好了。还差一步："
Say ""
Say "    1. 完全退出 DeepSeek Harness（关窗口不算，要从托盘或任务管理器退进程）"
Say "    2. 重新打开，发一条消息"
Say "    3. 输入 /flash light，看到「内核 ✓ on」就成了"
Say ""
Say "  如果 status 全是一行行 —：确认重启了、profile 名对不对。"
if ($opSeeded) {
  Say "  操作稿是刚生成的模板：把里面的 <操作者> / <使用者> / <助手名> 换成你自己的。"
  Say "  它是强度的主要来源，模板只是骨架 —— 换成自己的话才有用。"
} else {
  Say "  如果「操作稿」那行是「! 空」：$opFile 是空文件，用 /flash init --force 重写一份。"
}
Say ""
