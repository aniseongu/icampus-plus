$ErrorActionPreference = 'Stop'
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$started = $false
$browserPid = 0
function Reply($message) {
  $bytes = $utf8.GetBytes(($message | ConvertTo-Json -Compress))
  $length = [BitConverter]::GetBytes([uint32]$bytes.Length)
  $outputStream.Write($length, 0, 4)
  $outputStream.Write($bytes, 0, $bytes.Length)
  $outputStream.Flush()
}
function ReadExact([int]$count) {
  $bytes = New-Object byte[] $count
  $offset = 0
  while ($offset -lt $count) {
    $read = $inputStream.Read($bytes, $offset, $count - $offset)
    if ($read -eq 0) { return $null }
    $offset += $read
  }
  return ,$bytes
}
function FindBrowser {
  $current = $PID
  for ($i = 0; $i -lt 12 -and $current -gt 0; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current"
    if (-not $proc) { break }
    if ($proc.Name -ieq 'whale.exe' -and $proc.CommandLine -notmatch '(?:^|\s)--type=') {
      return [int]$proc.ProcessId
    }
    $current = [int]$proc.ParentProcessId
  }
  throw 'browser-not-found'
}
try {
  while ($true) {
    $lengthBytes = ReadExact 4
    if ($null -eq $lengthBytes) { break }
    $length = [BitConverter]::ToUInt32($lengthBytes, 0)
    if ($length -gt 4096) { throw 'message-too-large' }
    $body = ReadExact ([int]$length)
    if ($null -eq $body) { throw 'incomplete-message' }
    $message = $utf8.GetString($body) | ConvertFrom-Json
    if ($message.action -eq 'check') {
      $null = FindBrowser
      if (-not (Test-Path (Join-Path $PSScriptRoot 'notice-hook.dll'))) { throw 'module-not-found' }
      Reply @{ ok = $true }
      break
    } elseif ($message.action -eq 'start') {
      if (-not $started) {
        $browserPid = FindBrowser
        $result = & (Join-Path $PSScriptRoot 'operate.ps1') -BrowserPid $browserPid -Action start -HostPid $PID
        if ($result -ne 'status=0') { throw 'hook-start-failed' }
        $started = $true
      }
      Reply @{ ok = $true; active = $true }
    } elseif ($message.action -eq 'stop') {
      if ($started) {
        $result = & (Join-Path $PSScriptRoot 'operate.ps1') -BrowserPid $browserPid -Action stop
        if ($result -ne 'status=0') { throw 'hook-stop-failed' }
        $started = $false
      }
      Reply @{ ok = $true; active = $false }
      break
    } else { throw 'invalid-action' }
  }
} catch {
  try { Reply @{ ok = $false; error = 'native-host-failed' } } catch {}
} finally {
  if ($started) {
    try { & (Join-Path $PSScriptRoot 'operate.ps1') -BrowserPid $browserPid -Action stop | Out-Null } catch {}
  }
}
