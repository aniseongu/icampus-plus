param(
  [Parameter(ParameterSetName='Install',Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
  [Parameter(ParameterSetName='Install',Mandatory=$true)][string]$Compiler,
  [Parameter(ParameterSetName='Uninstall',Mandatory=$true)][switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'WhaleExtentions\IcampusFullscreenHost'
$key = 'HKCU:\Software\Naver\Naver Whale\NativeMessagingHosts\kr.aniseongu.icampus_fullscreen'
if ($Uninstall) {
  if (Test-Path $key) {
    $installed = (Get-Item $key).GetValue('')
    if (-not $installed.StartsWith(($root + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw '다른 위치의 등록은 삭제하지 않아요.' }
    Remove-Item -Path $key
  }
  Write-Output '보조 프로그램 연결을 지웠어요. 남은 파일은 웨일을 종료한 뒤 직접 지울 수 있어요.'
  exit 0
}
$directory = Join-Path $root ([DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))
New-Item -ItemType Directory -Path $directory -Force | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'minhook') -Destination $directory -Recurse
foreach ($file in @('notice-hook.cpp','operate.ps1','host.ps1','host.cmd','build.ps1')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $directory
}
& (Join-Path $directory 'build.ps1') -Compiler $Compiler
if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $directory 'notice-hook.dll'))) { throw '보조 프로그램을 빌드하지 못했어요.' }
$manifest = [ordered]@{
  name = 'kr.aniseongu.icampus_fullscreen'
  description = '아캠 플러스 전체화면 보조 프로그램'
  path = (Join-Path $directory 'host.cmd')
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestPath = Join-Path $directory 'manifest.json'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifestPath
Write-Output '보조 프로그램을 설치했어요.'
