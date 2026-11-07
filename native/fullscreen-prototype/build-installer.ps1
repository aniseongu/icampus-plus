param([Parameter(Mandatory=$true)][string]$Compiler)
$ErrorActionPreference = 'Stop'
$work = Join-Path $env:TEMP ('icampus-helper-build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'minhook') -Destination $work -Recurse
foreach ($file in @('build.ps1', 'notice-hook.cpp', 'host.ps1', 'host.cmd', 'operate.ps1', 'HelperInstaller.cs', 'Pretendard-Regular.subset.ttf', 'installer.manifest')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $work
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\..\fonts\LICENSE.txt') -Destination (Join-Path $work 'Pretendard.LICENSE')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'minhook\LICENSE.txt') -Destination (Join-Path $work 'MinHook.LICENSE')
& (Join-Path $work 'build.ps1') -Compiler $Compiler
if ($LASTEXITCODE -ne 0) { throw '보조 프로그램 빌드에 실패했어요.' }
Push-Location $work
try {
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  & $csc /nologo /target:winexe /platform:x64 /win32manifest:installer.manifest /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /reference:System.Drawing.dll '/resource:host.ps1,host.ps1' '/resource:host.cmd,host.cmd' '/resource:operate.ps1,operate.ps1' '/resource:notice-hook.dll,notice-hook.dll' '/resource:Pretendard-Regular.subset.ttf,Pretendard-Regular.subset.ttf' '/resource:Pretendard.LICENSE,Pretendard.LICENSE' '/resource:MinHook.LICENSE,MinHook.LICENSE' /out:IcampusHelper.exe HelperInstaller.cs
  if ($LASTEXITCODE -ne 0) { throw '설치 프로그램 빌드에 실패했어요.' }
  Copy-Item -LiteralPath (Join-Path $work 'IcampusHelper.exe') -Destination (Join-Path $PSScriptRoot 'IcampusHelper.exe') -Force
} finally { Pop-Location }
