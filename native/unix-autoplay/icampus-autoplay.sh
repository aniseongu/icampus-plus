#!/usr/bin/env bash
# 아캠 플러스: 맥과 리눅스에서 강의 자동 재생을 허용하는 브라우저 정책(AutoplayAllowlist)을 켜고 끈다.
# Windows 보조 프로그램과 같은 정책이다. 아이캠퍼스(canvas)와 강의 영상(lcms) 주소만 허용 목록에 넣는다.
# macOS는 /Library/Managed Preferences/<앱 도메인>.plist 를 고친다(root 필요).
# 사용: sudo bash icampus-autoplay.sh install|uninstall|status [chrome|chromium|edge|brave]
#   브라우저를 안 고르면 이 컴퓨터에 설치된 것으로 보이는 모두에 적용한다. 적용 뒤 브라우저를 다시 열어야 한다.
# 시험용: ICAMPUS_POLICY_ROOT=/임시/폴더 를 주면 그 아래에만 쓴다(root 불필요).
set -euo pipefail

SITES=("https://canvas.skku.edu" "https://lcms.skku.edu")
FILE_NAME="icampus-plus-autoplay.json"
ROOT="${ICAMPUS_POLICY_ROOT:-}"
OS="$(uname -s)"
ACTION="${1:-status}"
ONLY="${2:-}"

# 이름|리눅스 정책 폴더|macOS 환경설정 도메인
BROWSERS=(
  "chrome|/etc/opt/chrome/policies/managed|com.google.Chrome"
  "chromium|/etc/chromium/policies/managed|org.chromium.Chromium"
  "edge|/etc/opt/edge/policies/managed|com.microsoft.Edge"
  "brave|/etc/brave/policies/managed|com.brave.Browser"
)

json() {
  printf '{\n  "AutoplayAllowlist": ['
  local first=1 site
  for site in "${SITES[@]}"; do
    [ "$first" = 1 ] || printf ','
    printf '\n    "%s"' "$site"
    first=0
  done
  printf '\n  ]\n}\n'
}

linux_installed() {  # 정책 폴더의 부모(policies)나 브라우저 실행 파일이 있으면 설치된 것으로 본다
  case "$1" in
    chrome) command -v google-chrome >/dev/null || command -v google-chrome-stable >/dev/null || [ -d "$ROOT/opt/google/chrome" ] ;;
    chromium) command -v chromium >/dev/null || command -v chromium-browser >/dev/null ;;
    edge) command -v microsoft-edge >/dev/null || command -v microsoft-edge-stable >/dev/null ;;
    brave) command -v brave-browser >/dev/null ;;
  esac
}

mac_installed() {
  case "$1" in
    chrome) [ -d "/Applications/Google Chrome.app" ] ;;
    chromium) [ -d "/Applications/Chromium.app" ] ;;
    edge) [ -d "/Applications/Microsoft Edge.app" ] ;;
    brave) [ -d "/Applications/Brave Browser.app" ] ;;
  esac
}

touched=0
for entry in "${BROWSERS[@]}"; do
  IFS='|' read -r name dir domain <<<"$entry"
  [ -z "$ONLY" ] || [ "$ONLY" = "$name" ] || continue
  if [ -z "$ROOT" ] && [ -z "$ONLY" ]; then
    if [ "$OS" = Darwin ]; then mac_installed "$name" || continue; else linux_installed "$name" || continue; fi
  fi
  if [ "$OS" = Darwin ] && [ -z "$ROOT" ]; then
    # 관리형 환경설정(MDM이 쓰는 자리)의 plist 파일을 직접 고친다. `defaults write`는 이 폴더에서 조용히 무시돼서 쓰지 않는다.
    plist="/Library/Managed Preferences/$domain.plist"
    pb=/usr/libexec/PlistBuddy
    case "$ACTION" in
      install)
        mkdir -p "/Library/Managed Preferences"
        "$pb" -c "Delete :AutoplayAllowlist" "$plist" >/dev/null 2>&1 || true
        "$pb" -c "Add :AutoplayAllowlist array" "$plist" >/dev/null
        i=0
        for site in "${SITES[@]}"; do "$pb" -c "Add :AutoplayAllowlist:$i string $site" "$plist" >/dev/null; i=$((i + 1)); done
        # 정말 들어갔는지 읽어서 확인한다. 안 들어갔으면 성공이라고 하지 않는다.
        if "$pb" -c "Print :AutoplayAllowlist" "$plist" 2>/dev/null | grep -q "${SITES[0]}"; then echo "허용했어요: $name"
        else echo "허용하지 못했어요: $name ($plist)" >&2; exit 1; fi ;;
      uninstall) "$pb" -c "Delete :AutoplayAllowlist" "$plist" >/dev/null 2>&1 && echo "되돌렸어요: $name" || echo "추가한 설정이 없어요: $name" ;;
      status) "$pb" -c "Print :AutoplayAllowlist" "$plist" 2>/dev/null | grep -q "${SITES[0]}" && echo "허용됨: $name" || echo "허용 안 됨: $name" ;;
      *) echo "install, uninstall, status 중 하나를 써 주세요" >&2; exit 2 ;;
    esac
  else
    target="$ROOT$dir/$FILE_NAME"
    case "$ACTION" in
      install) mkdir -p "$ROOT$dir"; json >"$target"; chmod 644 "$target"; echo "허용했어요: $name ($target)" ;;
      uninstall) if [ -f "$target" ]; then rm -f "$target"; echo "되돌렸어요: $name"; else echo "추가한 설정이 없어요: $name"; fi ;;
      status) [ -f "$target" ] && echo "허용됨: $name" || echo "허용 안 됨: $name" ;;
      *) echo "install, uninstall, status 중 하나를 써 주세요" >&2; exit 2 ;;
    esac
  fi
  touched=1
done
[ "$touched" = 1 ] || echo "적용할 브라우저를 찾지 못했어요. 끝에 chrome, chromium, edge, brave 중 하나를 붙여 주세요."
[ "$ACTION" != install ] || echo "브라우저를 완전히 닫았다가 다시 열어 주세요."
