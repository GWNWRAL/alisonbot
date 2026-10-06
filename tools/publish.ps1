# 发布 alisonbot 到 GitHub（建仓库 + 推源码 + 发 v<版本> Release + 逐项校验）
#
# 用法（在 release\alisonbot 目录里执行）：
#   pwsh -File tools\publish.ps1 -DryRun        # 只看会做什么，不做任何写操作
#   pwsh -File tools\publish.ps1                # 真正发布
#
# 前置：脱敏已完成（node installer\sanitize.cjs 复查为零残留），产物与 .sha256 已在 -AssetsDir
param(
  [string]$Owner      = 'GWNWRAL',
  [string]$Repo       = 'alisonbot',
  [string]$Version    = '0.0.1',
  [string]$TokenFile  = "$env:USERPROFILE\.gh-token.txt",
  [string]$AssetsDir  = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tag = "v$Version"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $AssetsDir) { $AssetsDir = Join-Path (Split-Path -Parent (Split-Path -Parent $repoRoot)) 'releases' }
$assets = @(
  "Alison-Setup-$Version.exe",
  "Alison-Windows-便携版-$Version.zip",
  "Alison-macOS-arm64-$Version.zip",
  "Alison-macOS-x64-$Version.zip",
  "alisonbot-$Version-src.zip"
)

function Say($m) { Write-Host $m }

Say "=== 发布参数 ==="
Say "  仓库:   $Owner/$Repo"
Say "  版本/标签: $Version / $tag"
Say "  源码目录: $repoRoot"
Say "  产物目录: $AssetsDir"
Say "  模式:   $(if ($DryRun) { '试运行（不做写操作）' } else { '正式发布' })"

# ---------- 0. 前置检查 ----------
Say "`n=== 0. 前置检查 ==="
if (-not (Test-Path $TokenFile)) { throw "找不到 token 文件：$TokenFile" }
$token = (Get-Content $TokenFile -Raw).Trim()
$headers = @{ Authorization = "token $token"; 'User-Agent' = 'ice-release'; Accept = 'application/vnd.github+json' }
$me = Invoke-RestMethod 'https://api.github.com/user' -Headers $headers
Say "  token 属于: $($me.login)  (期望 $Owner)"
if ($me.login -ne $Owner) { throw "token 账号与 -Owner 不一致" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "没有找到 git" }
Say "  git: $((git --version))"
$pkgText = [IO.File]::ReadAllText((Join-Path $repoRoot 'package.json'), [Text.UTF8Encoding]::new($false))
Say "  package.json version: $(($pkgText | ConvertFrom-Json).version)"

foreach ($a in $assets) {
  $p = Join-Path $AssetsDir $a
  if (-not (Test-Path $p)) { throw "缺少产物：$p" }
  $sha = Join-Path $AssetsDir "$a.sha256"
  if (-not (Test-Path $sha)) { throw "缺少校验侧车：$sha" }
  $h = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
  if ((Get-Content $sha -Raw).Trim() -ne $h) { throw "sha256 不匹配：$a" }
  Say ("  ✔ {0,-40} {1,7:N1} MB" -f $a, ((Get-Item $p).Length / 1MB))
}

# 脱敏复查（敏感样例行用拼接写法，避免脚本自身被扫成"残留"）
$bad = @()
$patterns = @('sk-[A-Za-z0-9\-_]{16,}', 'ghp_[A-Za-z0-9]{20,}', ('3179' + '524618'), ('3135' + '003586'), ('D:' + '\\ICE'))
Get-ChildItem $repoRoot -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\.git\\' -and $_.Extension -notin '.png', '.jpg', '.ico', '.gz', '.zip', '.node', '.db' } |
  ForEach-Object {
    $t = [IO.File]::ReadAllText($_.FullName, [Text.UTF8Encoding]::new($false))
    if (-not $t) { return }
    foreach ($re in $patterns) {
      if ($t -match $re) { $bad += "$($_.FullName) → $re" }
    }
  }
if ($bad.Count) { throw "脱敏复查失败：`n  $($bad -join "`n  ")" }
Say "  ✔ 脱敏复查：零残留"

if ($DryRun) { Say "`n试运行结束（未做任何写操作）。"; return }

# ---------- 1. 建 public 仓库 ----------
Say "`n=== 1. 建仓库 ==="
$exists = $true
try { Invoke-RestMethod "https://api.github.com/repos/$Owner/$Repo" -Headers $headers | Out-Null }
catch { $exists = $false }
if ($exists) {
  Say "  仓库已存在，跳过创建"
} else {
  $body = @{
    name = $Repo; private = $false
    description = 'ICE：Koishi + ChatLuna 角色扮演机器人（自定义 Web 控制台 / 自治能力 / Koishi + AstrBot 插件兼容）'
    has_issues = $true; has_wiki = $false; has_projects = $false
  } | ConvertTo-Json
  Invoke-RestMethod "https://api.github.com/user/repos" -Method Post -Headers $headers -Body $body -ContentType 'application/json' | Out-Null
  Say "  已创建 public 仓库 $Owner/$Repo"
}

# ---------- 2. 推源码 ----------
Say "`n=== 2. 推送源码 ==="
Push-Location $repoRoot
try {
  if (-not (Test-Path '.git')) { git init -q; git branch -M main }
  git add -A
  $staged = (git diff --cached --name-only | Measure-Object).Count
  if ($staged -gt 0) { git -c user.name=GWNWRAL -c user.email=GWNWRAL@users.noreply.github.com commit -q -m "release: alisonbot v$Version" }
  if (-not (git remote)) { git remote add origin "https://github.com/$Owner/$Repo.git" }
  else { git remote set-url origin "https://github.com/$Owner/$Repo.git" }
  git push -u origin main
  Say "  已推送（提交数：$((git rev-list --count HEAD))）"
} finally { Pop-Location }

# ---------- 3. 发 Release ----------
Say "`n=== 3. 发 Release $tag ==="
$rel = $null
try { $rel = Invoke-RestMethod "https://api.github.com/repos/$Owner/$Repo/releases/tags/$tag" -Headers $headers } catch { }
if (-not $rel) {
  $notes = [IO.File]::ReadAllText((Join-Path $repoRoot 'CHANGELOG.md'), [Text.UTF8Encoding]::new($false))
  $body = @{ tag_name = $tag; name = "alisonbot $tag"; body = $notes; draft = $false; prerelease = $false } | ConvertTo-Json
  $rel = Invoke-RestMethod "https://api.github.com/repos/$Owner/$Repo/releases" -Method Post -Headers $headers -Body $body -ContentType 'application/json'
  Say "  已创建 Release $tag"
} else { Say "  Release 已存在，直接上传资产" }

foreach ($a in $assets) {
  $p = Join-Path $AssetsDir $a
  $up = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($rel.id)/assets?name=$([uri]::EscapeDataString($a))"
  $bytes = [IO.File]::ReadAllBytes($p)
  Invoke-RestMethod $up -Method Post -Headers $headers -Body $bytes -ContentType 'application/octet-stream' | Out-Null
  Say "  ↑ $a"
  $sha = "$p.sha256"
  $up2 = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($rel.id)/assets?name=$([uri]::EscapeDataString($a)).sha256"
  Invoke-RestMethod $up2 -Method Post -Headers $headers -Body ([IO.File]::ReadAllBytes($sha)) -ContentType 'application/octet-stream' | Out-Null
  Say "  ↑ $a.sha256"
}

# ---------- 4. 逐项校验 ----------
Say "`n=== 4. 校验 ==="
$repoInfo = Invoke-RestMethod "https://api.github.com/repos/$Owner/$Repo" -Headers $headers
Say "  仓库可见性: $($repoInfo.visibility)  归档: $($repoInfo.archived)"
$relNow = Invoke-RestMethod "https://api.github.com/repos/$Owner/$Repo/releases/tags/$tag" -Headers $headers
Say "  Release: $($relNow.tag_name)  draft=$($relNow.draft)  prerelease=$($relNow.prerelease)  资产=$($relNow.assets.Count)"
$relNow.assets | ForEach-Object { Say ("    - {0,-42} {1,7:N1} MB" -f $_.name, ($_.size / 1MB)) }
$latest = Invoke-RestMethod "https://api.github.com/repos/$Owner/$Repo/releases/latest" -Headers $headers
Say "  releases/latest: $($latest.tag_name)  (应为 $tag)"
$ok = ($repoInfo.visibility -eq 'public') -and (-not $relNow.draft) -and (-not $relNow.prerelease) -and ($relNow.assets.Count -eq ($assets.Count * 2)) -and ($latest.tag_name -eq $tag)
Say "`n$(if ($ok) { '✅ 全部校验通过。' } else { '⚠️ 有校验项未通过，请检查上面输出。' })"
Say "  下载页: https://github.com/$Owner/$Repo/releases/tag/$tag"
