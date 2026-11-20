# AMR Cycle Time Simulator

컨베이어 롤러 타입 AMR의 물류 Cycle Time을 브라우저에서 시뮬레이션하는 도구입니다.
ACS 맵·노드·스테이션·C/V를 드래그 앤 드롭으로 배치하고, AMR 대수·속도·Docking/PIO 시간·배터리 조건에 따른 CT와 처리량을 계산합니다.

빌드나 설치가 필요 없는 순수 HTML/JS 정적 웹 앱입니다.

## 실행

- **로컬**: `index.html`을 브라우저로 열면 됩니다.
- **GitHub Pages**: 저장소 Settings → Pages → Branch `main` / `/ (root)` 선택 후 `https://<계정>.github.io/<저장소>/` 로 접속.

### 세팅 공유 링크

주소 뒤에 `?layout=<파일 경로>`를 붙이면 그 세팅으로 바로 열립니다 (GitHub Pages 등 웹 주소에서만 동작).

- 현재 세팅: https://sio-ctrl.github.io/amr-simulator/?layout=settings/amr_layout.json
- 다른 세팅을 공유하려면 `settings/` 폴더에 JSON을 넣고 push한 뒤 파일 이름만 바꿔서 링크를 보내면 됩니다.

## 주요 기능

| 구분 | 내용 |
|------|------|
| ACS Map | 맵 크기 설정, 배경 도면 이미지, 확대/축소·이동, Grid Snap |
| 노드 | 주행 노드, 충전소, 대기 포지션, 라인 공급/회수/겸용, 제품 공급/회수, 공급/회수 버퍼, C/V |
| 경로 | 단방향/양방향 주행 경로, C/V 연결(Pallet 흐름), 스테이션 연결(물류 흐름, 선택) |
| AMR 사양 | Payload, 제품 중량, 롤러 속도, Pallet 치수, 이재 여유 거리 → Loading/Unloading 시간 자동 계산 |
| AMR 파라미터 | 수량, 주행 속도, Docking/UnDocking, PIO Load/Unload 통신 시간 |
| 교통 제어 | 선점 노드 수(look-ahead), 우회 탐색 대기 시간, 대기 포지션, 교착 표시 |
| 충전 | PIO 자동 충전, 가동/충전 시간, 임무 불가 잔량, 목표 충전량 |
| 시뮬레이션 | 생산/휴식 반복, 재생 배속, 즉시 계산, 결과 CSV 내보내기 |

## 사용 방법

1. **ACS Map** 크기를 정하고 필요하면 배경 도면을 올립니다 (캔버스에 끌어다 놓아도 됨).
2. 왼쪽 팔레트 아이콘을 캔버스로 드래그해 노드·스테이션을 배치합니다.
3. `경로 그리기 (E)` 또는 **Shift+드래그**로 AMR 주행 경로를, `C/V 연결 (C)`로 컨베이어 흐름을 연결합니다.
4. AMR 사양·파라미터·충전 조건을 입력합니다.
5. `▶ 시작`으로 애니메이션 재생, `⚡ 즉시 계산`으로 결과만 바로 확인합니다.
6. `결과 CSV`로 사이클 로그를 내보냅니다.

### 단축키

| 키 | 동작 |
|----|------|
| `E` | 경로 그리기 |
| `C` | C/V 연결 |
| `L` | 스테이션 연결 |
| `Shift` + 드래그 | 경로 그리기 |
| `Delete` / 우클릭 | 선택 항목 삭제 |
| 마우스 휠 | 확대/축소 |
| 상태바 드래그 | 아래 결과 창 크기 조절 (Map 영역 확대) |
| 상태바 더블클릭 | 결과 창 접기/펼치기 |

## 설정 관리

- **레이아웃 JSON 저장 / 열기**: 레이아웃과 파라미터 전체를 JSON 파일로 저장·불러오기 (JSON 파일을 캔버스에 드롭해도 열림).
- **기본 설정으로 저장**: 현재 설정을 브라우저(localStorage)에 저장 → 다음 실행 시 자동 로드.
- **기본설정 파일 내보내기**: `default-config.js` 파일로 내보냄. [js/config/default-config.js](js/config/default-config.js)를 이 파일로 교체해 커밋하면 팀 공용 기본값이 됩니다.
- 우선순위: 브라우저에 저장한 기본 설정 > `js/config/default-config.js`
- 저장 버튼(JSON·기본설정 파일·CSV)은 Chrome/Edge에서 저장 위치를 고르는 창이 뜨고, 마지막에 고른 폴더를 기억합니다. 다른 브라우저는 다운로드 폴더에 저장됩니다.
- 저장한 설정은 [settings/](settings/) 폴더에 모아 두는 것을 권장합니다.

## 프로젝트 구조

```
index.html                 UI 레이아웃
css/style.css              스타일
js/config/default-config.js 공장 기본 레이아웃·파라미터
js/model.js                데이터 모델, 노드 타입, 경로 탐색, 저장/불러오기
js/sim.js                  시뮬레이션 코어 (스테이션/C/V 흐름, ACS 배차, 교통 제어, 충전)
js/render.js               캔버스 렌더링
js/editor.js               캔버스 편집 (드래그 앤 드롭, 경로/연결, 줌/이동)
js/ui.js                   사이드바 입력, 결과·CSV
js/selftest.js             자체 테스트
js/main.js                 부팅 및 애니메이션 루프
```

스크립트 로드 순서가 중요합니다: config → model → sim → render → editor → ui → selftest → main

## 자체 테스트

`index.html#test`로 열면 기본 레이아웃으로 자체 테스트가 실행되고, 결과가 브라우저 탭 제목에 표시됩니다.
