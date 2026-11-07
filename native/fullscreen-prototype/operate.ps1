param([Parameter(Mandatory=$true)][int]$BrowserPid,[Parameter(Mandatory=$true)][ValidateSet('start','stop','status')][string]$Action,[int]$HostPid = 0)
$ErrorActionPreference='Stop'
$proc=Get-Process -Id $BrowserPid
if ($proc.ProcessName -notin @('whale', 'chrome', 'msedge', 'brave', 'vivaldi', 'chromium')) { throw '지원하지 않는 브라우저입니다.' }
if (-not ('HookLoader' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Text;
public static class HookLoader {
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr a, UIntPtr n, uint type, uint protect);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool VirtualFreeEx(IntPtr p, IntPtr a, UIntPtr n, uint type);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteProcessMemory(IntPtr p, IntPtr a, byte[] b, UIntPtr n, out UIntPtr written);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string n);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeLibrary(IntPtr module);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateRemoteThread(IntPtr p, IntPtr attr, UIntPtr stack, IntPtr fn, IntPtr arg, uint flags, out uint id);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr obj, uint ms);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeThread(IntPtr t, out uint code);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 static void Check(bool ok, string stage) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),stage); }
 static uint Call(IntPtr p, IntPtr fn, IntPtr arg) {
  uint id,code; IntPtr t=CreateRemoteThread(p,IntPtr.Zero,UIntPtr.Zero,fn,arg,0,out id); Check(t!=IntPtr.Zero,"thread");
  try { uint wait=WaitForSingleObject(t,10000); if(wait==0x102) throw new TimeoutException("remote thread still running"); Check(wait==0,"wait"); Check(GetExitCodeThread(t,out code),"exit code"); return code; } finally {CloseHandle(t);}
 }
 public static string Run(int pid,string path,string action,int hostPid) {
  IntPtr p=OpenProcess(0x043A,false,(uint)pid); Check(p!=IntPtr.Zero,"open process");
  try {
   Process proc=Process.GetProcessById(pid); IntPtr remote=IntPtr.Zero;
   foreach(ProcessModule m in proc.Modules) if(string.Equals(m.FileName,path,StringComparison.OrdinalIgnoreCase)) {remote=m.BaseAddress;break;}
   if(action == "start" && remote==IntPtr.Zero) {
    byte[] data=Encoding.Unicode.GetBytes(path+"\0"); IntPtr mem=VirtualAllocEx(p,IntPtr.Zero,(UIntPtr)data.Length,0x3000,0x04); Check(mem!=IntPtr.Zero,"alloc");
    bool release=false;
    try {UIntPtr written; Check(WriteProcessMemory(p,mem,data,(UIntPtr)data.Length,out written) && written.ToUInt64()==(ulong)data.Length,"write");
     Call(p,GetProcAddress(GetModuleHandle("kernel32.dll"),"LoadLibraryW"),mem); release=true;
    } finally {if(release) VirtualFreeEx(p,mem,UIntPtr.Zero,0x8000);}
    proc.Refresh(); foreach(ProcessModule m in proc.Modules) if(string.Equals(m.FileName,path,StringComparison.OrdinalIgnoreCase)) {remote=m.BaseAddress;break;}
   }
   Check(remote!=IntPtr.Zero,"module"); IntPtr local=LoadLibraryEx(path,IntPtr.Zero,1); Check(local!=IntPtr.Zero,"local module");
   try {string name=action=="start"?"StartNoticeHook":action=="stop"?"StopNoticeHook":"NoticeHookStatus"; IntPtr f=GetProcAddress(local,name); Check(f!=IntPtr.Zero,"export"); IntPtr rf=new IntPtr(remote.ToInt64()+f.ToInt64()-local.ToInt64()); uint status=Call(p,rf,action=="start"?new IntPtr(hostPid):IntPtr.Zero); return "status="+status;}
   finally {FreeLibrary(local);}
  } finally {CloseHandle(p);}
 }
}
'@
}
$result = [HookLoader]::Run($BrowserPid, (Join-Path $PSScriptRoot 'notice-hook.dll'), $Action, $HostPid)
if ($Action -ne 'status' -and $result -ne 'status=0') { throw "후킹 $Action 실패: $result" }
$result
