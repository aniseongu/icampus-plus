<div align="center">

<img src="icons/icon128.png" width="96" alt="아캠 플러스 아이콘">

# 아캠 플러스

성균관대학교 아이캠퍼스에서 즐겨찾기한 과목의 남은 강의와 과제를 한곳에서 보고, 아이캠퍼스를 어두운 화면으로 쓸 수 있게 해 주는 브라우저 확장 프로그램

![version](https://img.shields.io/badge/version-1.8.0-124532)
![manifest](https://img.shields.io/badge/Manifest-V3-124532)
![browser](https://img.shields.io/badge/Whale%20%7C%20Chrome-Chromium%20150-555555)

</div>

## 소개

[아캠체크(iCampus Check)](https://github.com/moseoridev/iCampusCheck)를 바탕으로 만든 확장입니다. 원본의 팝업과 강의, 과제 표는 그대로 두고, 평소에 아쉬웠던 부분을 하나씩 보태 왔습니다.

> 아이캠퍼스(Canvas)에서 **즐겨찾기(별표)한 과목만** 찾아서 보여 줍니다. 보고 싶은 과목은 아이캠퍼스 왼쪽 메뉴의 과목 > 모든 과목에서 별표를 눌러 즐겨찾기에 넣어 주세요. 네이버 웨일에서 매일 쓰면서 고치고 있습니다.

## 기능

| 구분 | 내용 |
| --- | --- |
| 할 일 목록 | 즐겨찾기 과목의 Canvas 과제와 LearningX 강의콘텐츠를 함께 모아 마감 순으로 보여 줍니다. 기한이 없거나 지난 미완료 과제도 빠뜨리지 않습니다. |
| 조회 실패 안내 | 일부 과목을 가져오지 못하면 어떤 과목의 어떤 자료가 실패했는지 팝업에 표시합니다. |
| 인증 재발급 | 강의콘텐츠 인증이 만료돼 조회가 거절되면, 마이페이지를 한 번 불러 인증을 다시 받고 다시 조회합니다. |
| 재생목록 | 들을 강의를 골라 지금 탭에서 차례로 재생합니다. 2배속과 자동 재생은 재생목록으로 연 강의에만 적용합니다. |
| 인트로 건너뛰기 | 강의 영상의 인트로를 기다리지 않고 바로 넘깁니다. |
| 다크 모드 | Canvas와 LearningX 화면 전체를 어둡게 바꿉니다. 색을 뒤집지 않고 규칙에 따라 면과 글자색을 맞춥니다. |
| 시험 모드 | 시험 중에는 아캠 플러스의 기능을 멈추고 다른 확장과 사이트 알림도 잠시 꺼요. 시험 화면을 누르면 전체화면으로 바꾸고 실수로 탭이나 창을 바꾸는 단축키와 새 탭 링크를 조용히 막아요. |
| 숨은 글씨 표시 | 흰 바탕에 흰 글씨처럼 보이지 않게 넣어 둔 글씨를 빨간 점선 상자로 보여 줍니다. |
| 시간표 버튼 보완 | 위쪽 메뉴의 시간표가 열리지 않을 때 정보광장 주간테이블을 대신 열고 조회합니다. |

## 설치

웹 스토어에는 올리지 않았습니다. 압축 해제한 폴더를 직접 불러와 사용합니다.

```bash
git clone https://github.com/aniseongu/icampus-plus.git
```

또는 이 페이지의 Code 버튼에서 Download ZIP을 눌러 받은 뒤 압축을 풉니다.

1. 웨일은 `whale://extensions`, 크롬은 `chrome://extensions`를 엽니다.
2. 개발자 모드를 켭니다.
3. 압축 해제된 확장 프로그램을 로드를 누르고 `manifest.json`이 있는 폴더를 선택합니다.

웹 스토어판 아캠체크를 쓰고 있다면 하나는 꺼 두세요. 둘 다 켜 두면 팝업이 헷갈립니다.

업데이트는 새 파일로 폴더를 덮어쓴 뒤 확장 관리 화면에서 새로고침을 누르면 됩니다. 폴더 위치를 바꾸면 브라우저가 다른 확장으로 인식해 설정이 초기화됩니다.

## 사용법

1. canvas.skku.edu에 로그인합니다.
2. 왼쪽 메뉴의 과목 > 모든 과목에서 확인하고 싶은 과목에 별표를 눌러 즐겨찾기에 넣습니다. 아캠 플러스는 즐겨찾기한 과목만 찾습니다.
3. 툴바의 아캠 플러스 아이콘을 누르면 즐겨찾기 과목의 남은 강의와 과제가 마감 순으로 나옵니다. 제목을 누르면 해당 페이지가 새 탭에서 열립니다.
4. 재생목록을 쓰려면 강의 표 위의 재생목록 만들기를 누르고, 강의를 체크한 뒤 선택한 강의 재생을 누릅니다.
5. 팝업 아래 화면 설정에서 자동, 밝게, 어둡게 중에 고릅니다. 아이캠퍼스 페이지에도 같이 적용됩니다.

시험 모드는 기본으로 켜져 있습니다. 실제 시험 화면에서 원하는 대로 동작하는지 시험 전에 확인해 주세요.
시험에 필요한 감독용 확장은 화면 설정의 '시험 중에도 켤 확장'에서 골라 두세요. 고른 확장은 다음 시험부터 끄지 않아요.

웨일의 웹 콘텐츠 다크 모드를 켜 두었다면 아이캠퍼스에서는 꺼 주세요. 두 다크 모드가 겹치면 색이 다시 바뀌어 읽기 어려워집니다.

## 권한

| 권한 | 쓰는 이유 |
| --- | --- |
| `canvas.skku.edu` | 팝업을 열 때 로그인된 아이캠퍼스 탭에서 과목, 과제, 강의콘텐츠를 조회하고 다크 모드를 적용합니다. |
| `lcms.skku.edu` | 강의 영상 페이지에서 인트로 건너뛰기와 재생목록 재생을 처리합니다. |
| `kingoinfo.skku.edu` | 시간표 버튼이 연 정보광장 탭에서 주간테이블 조회 버튼만 누릅니다. |
| `activeTab`, `scripting`, `tabs` | 현재 아이캠퍼스 탭에서 조회 스크립트를 실행하고, 재생목록의 다음 강의로 이동합니다. |
| `storage` | 화면 설정과 재생 중인 재생목록 상태를 브라우저 안에 저장합니다. |
| `management` (선택) | 시험 모드에서 다른 확장을 잠시 끄고 다시 켤 때만 사용합니다. |
| `contentSettings` (선택) | 시험 모드에서 사이트 알림을 잠시 막고 시험 뒤 이 확장이 넣은 차단 설정을 지울 때만 사용합니다. |

계정 비밀번호, 토큰, 학번을 파일이나 외부 서버로 보내지 않습니다. 모든 요청은 로그인된 아이캠퍼스 탭 안에서만 일어나고, 팝업을 열지 않은 동안에는 조회를 하지 않습니다.

## 기술 스택

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)
![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)
![Chrome Extension](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)

- 프레임워크와 빌드 과정 없이 순수 JavaScript, HTML, CSS로 작성했습니다. 받은 폴더를 그대로 불러오면 됩니다.
- Chrome 확장 API: `chrome.storage`, `chrome.tabs`, `chrome.scripting`, `chrome.runtime`
- 아이캠퍼스 데이터는 Canvas REST API와 LearningX API를 로그인된 탭 안에서 호출해 가져옵니다.
- 다크 모드 색 변환은 OKLCH 색 공간에서 색상은 유지하고 밝기만 조정해, 글자 대비 4.5:1 이상을 맞춥니다.
- 글꼴: [Pretendard](https://github.com/orioncactus/pretendard) (팝업, CDN)
- 코드 정리: [Prettier](https://prettier.io/)

## 폴더 구조

```text
.
├── manifest.json
├── popup.html            팝업 화면
├── script.js             팝업 동작, 재생목록
├── executescript.js      아이캠퍼스 탭에서 실행하는 조회 코드
├── background.js         재생목록 진행 관리 (서비스 워커)
├── player.js             강의 영상 페이지 (인트로 건너뛰기, 재생목록 재생)
├── timetable.js          아이캠퍼스 시간표 버튼 보완
├── timetable-portal.js   정보광장 주간테이블 자동 조회
├── utils.js
├── dark/                 아이캠퍼스 다크 모드
└── icons/
```

## 알려진 한계

- Canvas에서 즐겨찾기(별표)한 과목만 가져옵니다. 즐겨찾기 조회가 실패해도 다른 과목으로 범위를 넓히지 않고 오류를 보여 줍니다. 즐겨찾기를 하나도 지정하지 않으면 Canvas가 수강 과목 일부를 기본으로 골라 줄 수 있습니다.
- 학교의 비공개 LearningX API를 쓰기 때문에 응답 형식이 바뀌면 일부 강의가 빠질 수 있습니다. 실제 마감 시각은 아이캠퍼스에서 확인해 주세요.
- 재생목록으로 들은 강의가 출석으로 인정되는지는 학교가 처리합니다. 재생 후 출결 상태를 꼭 확인해 주세요.
- 시험에서 확장을 모두 꺼야 한다면 아캠 플러스 자신은 확장 관리 화면에서 직접 꺼야 해요. 확장은 스스로를 끄고 다시 켤 수 없어요.
- 윈도우 알림까지 숨기려면 설정 > 시스템 > 알림에서 '전체 화면 모드로 앱을 사용할 때' 방해 금지를 켜 주세요. Esc를 길게 누르면 전체화면이 풀려요.
- 시험 모드는 확인 창 없이 새 탭 링크를 조용히 막아요. 단축키 차단은 전체화면에서만 돼요. 시험에 필요한 링크가 새 탭으로 열려야 한다면 시험 모드를 끄거나 같은 탭에서 열어 주세요.
- 웨일에서만 확인했습니다. 크롬 등 다른 Chromium 브라우저에서도 동작할 것으로 보지만 따로 시험하지 않았습니다.

## 변경 기록

| 버전 | 내용 |
| --- | --- |
| 1.8 | 시험 모드(아캠 플러스 기능 중지, 다른 확장과 사이트 알림 끄기, 시험 때 전체화면과 키 잠금, 실수로 새 탭 열기 방지), 새 아이콘, 글꼴을 확장 안에 포함 |
| 1.7 | 다크 모드를 규칙 기반으로 다시 작성, 게시판과 수업자료 화면 색 보정, 시간표 자동 조회, 이름을 아캠 플러스로 변경 |
| 1.6 | 아이캠퍼스 다크 모드, 숨은 글씨 표시, 화면 설정 추가 (이때 이름은 아캠 매니저) |
| 1.5 | 웨일용 수정 시작. 과제 수집 보완, 조회 실패 안내, 재생목록, 인트로 건너뛰기, 인증 재발급 |

원본 아캠체크의 이전 기록은 [원본 저장소](https://github.com/moseoridev/iCampusCheck#버전-히스토리)에서 볼 수 있습니다.

## 출처와 참고

이 확장은 아래 프로젝트들 덕분에 만들 수 있었습니다.

| 프로젝트 | 만든 사람 | 참고한 부분 |
| --- | --- | --- |
| [아캠체크 (iCampus Check)](https://github.com/moseoridev/iCampusCheck) | [ductility](https://github.com/ductility/iCampusCheck), [moseoridev](https://github.com/moseoridev) | 이 확장의 바탕입니다. 팝업 배치, 강의와 과제 표, 과제 수집 구조를 이어받았습니다. |
| [아캠 프리미엄 (iCampus Premium)](https://github.com/kangrnin/icampus-premium) | [kangrnin](https://github.com/kangrnin), [threedalpeng](https://github.com/threedalpeng) | 강의 영상의 인트로 건너뛰기 방식. 코드는 새로 작성했습니다. |
| [아캠 매니저 (iCampus Manager)](https://github.com/again7536/icampus-manager) | [again7536](https://github.com/again7536) | 재생목록에서 강의를 고르고 다음 강의로 넘어가는 방식 |
| [Material UI List](https://mui.com/material-ui/react-list/) | MUI | 재생목록의 체크 상태와 선택 개수 표시 |

### 아이콘

삼성학술정보관 정면 사진 [Samsung Library-Front.jpg](https://commons.wikimedia.org/wiki/File:Samsung_Library-Front.jpg)(Srobidx, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/))에서 지붕 윤곽을 따서 만들었습니다. 색은 성균관대 상징색인 진녹색(Pantone 3435C, `#124532`)입니다. 아이콘 파일(`icons/`)은 원본 사진의 라이선스에 따라 CC BY-SA 4.0으로 배포합니다.

## 문의

버그나 제안은 [Issues](https://github.com/aniseongu/icampus-plus/issues)에 남겨 주세요. 어떤 화면에서 무엇이 이상했는지 적어 주시면 고치기 쉽습니다.

## 라이선스

원본 아캠체크 저장소에 라이선스가 명시되어 있지 않아, 이 저장소에도 별도 라이선스를 붙이지 않았습니다. 원본 코드의 권리는 원작자에게 있습니다. 아이콘은 위에 적은 대로 CC BY-SA 4.0입니다.
