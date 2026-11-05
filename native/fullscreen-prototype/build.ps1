param([Parameter(Mandatory=$true)][string]$Compiler)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$flags = @('--config=x86_64-w64-windows-gnu.cfg','-O2','-Iminhook/include','-Iminhook/src')
foreach ($source in @('buffer','hook','trampoline','hde/hde64')) {
  $out = [System.IO.Path]::GetFileName($source) + '.o'
  & $Compiler @flags -c "minhook/src/$source.c" -o $out
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& $Compiler @flags -x c++ -c notice-hook.cpp -o notice-hook.o
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $Compiler --config=x86_64-w64-windows-gnu.cfg -shared -o notice-hook.dll notice-hook.o buffer.o hook.o trampoline.o hde64.o -luser32
exit $LASTEXITCODE
