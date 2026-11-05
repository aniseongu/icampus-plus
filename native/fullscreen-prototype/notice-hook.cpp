#include <windows.h>
#include "MinHook.h"

typedef BOOL (WINAPI *ShowWindowFn)(HWND, int);
static ShowWindowFn original_show = nullptr;
static SRWLOCK state_lock = SRWLOCK_INIT;
static bool initialized = false;
static bool enabled = false;
static unsigned long long generation = 0;

struct Watcher {
  HANDLE process;
  unsigned long long generation;
};

static DWORD WINAPI WatchHost(void* value) {
  Watcher* watcher = static_cast<Watcher*>(value);
  const DWORD wait = WaitForSingleObject(watcher->process, INFINITE);
  AcquireSRWLockExclusive(&state_lock);
  if ((wait == WAIT_OBJECT_0 || wait == WAIT_FAILED) && watcher->generation == generation && enabled &&
      MH_DisableHook(MH_ALL_HOOKS) == MH_OK) enabled = false;
  ReleaseSRWLockExclusive(&state_lock);
  CloseHandle(watcher->process);
  HeapFree(GetProcessHeap(), 0, watcher);
  return 0;
}

static BOOL WINAPI intercept_show(HWND window, int command) {
  if (command != SW_HIDE) {
    const LONG style = GetWindowLongW(window, GWL_STYLE);
    const LONG extra = GetWindowLongW(window, GWL_EXSTYLE);
    const LONG mask = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TRANSPARENT;
    if ((style & WS_POPUP) && !(style & WS_SYSMENU) && (extra & mask) == mask) {
      wchar_t name[64] = {};
      if (GetClassNameW(window, name, 64) && lstrcmpW(name, L"Chrome_WidgetWin_1") == 0) return TRUE;
    }
  }
  return original_show(window, command);
}

extern "C" __declspec(dllexport) DWORD WINAPI StartNoticeHook(void* host_value) {
  AcquireSRWLockExclusive(&state_lock);
  DWORD result = 0;
  const DWORD host_pid = static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(host_value));
  HANDLE host = host_pid ? OpenProcess(SYNCHRONIZE, FALSE, host_pid) : nullptr;
  if (host_pid && !host) result = 4;
  if (!result && !initialized) {
    if (MH_Initialize() != MH_OK) result = 1;
    else if (MH_CreateHookApi(L"user32", "ShowWindow", (void*)intercept_show, (void**)&original_show) != MH_OK) {
      MH_Uninitialize();
      result = 2;
    } else initialized = true;
  }
  if (!result && !enabled) {
    if (MH_EnableHook(MH_ALL_HOOKS) != MH_OK) result = 3;
    else enabled = true;
  }
  if (!result) ++generation;
  if (!result && host) {
    Watcher* watcher = static_cast<Watcher*>(HeapAlloc(GetProcessHeap(), 0, sizeof(Watcher)));
    if (!watcher) result = 5;
    else {
      watcher->process = host;
      watcher->generation = generation;
      HANDLE thread = CreateThread(nullptr, 0, WatchHost, watcher, 0, nullptr);
      if (!thread) { HeapFree(GetProcessHeap(), 0, watcher); result = 5; }
      else { CloseHandle(thread); host = nullptr; }
    }
    if (result && enabled && MH_DisableHook(MH_ALL_HOOKS) == MH_OK) enabled = false;
  }
  if (host) CloseHandle(host);
  ReleaseSRWLockExclusive(&state_lock);
  return result;
}
extern "C" __declspec(dllexport) DWORD WINAPI StopNoticeHook(void*) {
  AcquireSRWLockExclusive(&state_lock);
  DWORD result = 0;
  ++generation;
  if (enabled) {
    if (MH_DisableHook(MH_ALL_HOOKS) != MH_OK) result = 1;
    else enabled = false;
  }
  // Keep the trampoline allocated: a thread already in the callback can still
  // need it after the entry hook is disabled. The process releases it on exit.
  ReleaseSRWLockExclusive(&state_lock);
  return result;
}
extern "C" __declspec(dllexport) DWORD WINAPI NoticeHookStatus(void*) {
  AcquireSRWLockShared(&state_lock);
  DWORD result = enabled ? 1 : 0;
  ReleaseSRWLockShared(&state_lock);
  return result;
}
BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) { return TRUE; }
