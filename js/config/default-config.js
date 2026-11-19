// 공장 기본값 (Factory default).
// 앱의 "기본설정 파일 내보내기"로 받은 default-config.js 로 이 파일을 교체하면 팀 공용 기본값이 됨.
// 우선순위: 브라우저에 저장한 기본 설정 > 이 파일
//
// 기본 레이아웃의 물류 순환:
//   라인 공급이 비면 → 제품 공급 C/V  CV1(10s 후 감지) → CV2(5s) → PS1(끝단, 5s 후 감지) ──AMR Load──▶
//   라인 공급 LI1 ──C/V──▶ CV3 ──▶ 라인 회수 LO1 (소진 시간 후 회수 요청) ──AMR Load──▶
//   제품 회수 PR1 ──C/V──▶ CV4 ──▶ CV5 (끝단, 배출)
window.DEFAULT_CONFIG = {
  mapW: 40, mapH: 22, bg: null, nextId: 28,
  params: {
    amrCount: 3, speed: 0.3, dockT: 15, pioLoad: 5, pioUnload: 5, undockT: 10,
    rollerSpeed: 0.3,                                // 컨베이어 롤러 속도 (m/s)
    palletL: 1100, palletW: 100, palletH: 150,       // Pallet (mm), 이재 시간 = (L + 여유) ÷ 롤러 속도
    xferMargin: 0,                                   // 이재 여유 거리 (mm), 실측 보정용
    lookAhead: 3, blockTimeout: 20, chargePio: 5,
    batRunH: 6,       // 가동 시간: 100% → 0% (작업 중)
    batChargeH: 2,    // 충전 시간: 0% → 100%
    minBat: 30,       // 이 값 이하이면 임무 받지 않음
    chargeTo: 50,     // minBat 이하로 떨어지면 이 값까지 충전한 뒤 임무 재개
    payload: 1000,    // AMR 최대 Payload (kg), 컨베이어 롤러 타입
    productKg: 500,   // 제품 중량 (kg)
    simHours: 1, simSpeed: 30,
    prodH: 5, breakH: 1, // 생산 5h → 휴식 1h 반복: 휴식 중 라인 소진/가공 멈춤, AMR 임무는 계속
  },
  nodes: [
    { id: 1, x: 5, y: 10, type: 'path', name: 'N1' },   { id: 2, x: 5, y: 14, type: 'path', name: 'N2' },
    { id: 3, x: 10, y: 10, type: 'path', name: 'N3' },  { id: 4, x: 10, y: 14, type: 'path', name: 'N4' },
    { id: 5, x: 15, y: 10, type: 'path', name: 'N5' },  { id: 6, x: 15, y: 14, type: 'path', name: 'N6' },
    { id: 7, x: 20, y: 10, type: 'path', name: 'N7' },  { id: 8, x: 20, y: 14, type: 'path', name: 'N8' },
    { id: 9, x: 25, y: 10, type: 'path', name: 'N9' },  { id: 10, x: 25, y: 14, type: 'path', name: 'N10' },
    { id: 11, x: 30, y: 10, type: 'path', name: 'N11' }, { id: 12, x: 30, y: 14, type: 'path', name: 'N12' },
    { id: 13, x: 35, y: 10, type: 'path', name: 'N13' }, { id: 14, x: 35, y: 14, type: 'path', name: 'N14' },
    { id: 15, x: 10, y: 19, type: 'charger', name: 'C1' },
    { id: 16, x: 15, y: 19, type: 'charger', name: 'C2' },
    { id: 17, x: 20, y: 19, type: 'charger', name: 'C3' },
    { id: 18, x: 10, y: 5, type: 'src', name: 'PS1', t: 5, init: false },   // 제품 공급 C/V 끝단 (도착 후 감지 5s)
    { id: 19, x: 15, y: 5, type: 'sink', name: 'PR1', t: 5, init: false },  // 제품 회수 C/V 시작
    { id: 20, x: 25, y: 5, type: 'lineIn', name: 'LI1', t: 10, init: false },   // 라인 공급 C/V
    { id: 21, x: 30, y: 5, type: 'lineOut', name: 'LO1', t: 120, init: false }, // 라인 회수 C/V (소진 120s)
    { id: 22, x: 35, y: 5, type: 'lineIO', name: 'LX1', t: 180, init: false },  // 라인 공급/회수 겸용
    { id: 23, x: 4, y: 5, type: 'cv', name: 'CV1', t: 10, init: false },   // 제품 공급 C/V 시작: 라인 공급이 비면 10s 후 감지
    { id: 24, x: 7, y: 5, type: 'cv', name: 'CV2', t: 5, init: false },
    { id: 25, x: 27.5, y: 2, type: 'cv', name: 'CV3', t: 10, init: false }, // 라인 C/V
    { id: 26, x: 15, y: 2, type: 'cv', name: 'CV4', t: 5, init: false },
    { id: 27, x: 19, y: 2, type: 'cv', name: 'CV5', t: 20, init: false },  // 회수 C/V 끝단 (배출)
  ],
  // directed path edges a→b. 양방향 = 두 방향 모두 존재
  edges: [
    // upper lane → (one-way)
    { a: 1, b: 3 }, { a: 3, b: 5 }, { a: 5, b: 7 }, { a: 7, b: 9 }, { a: 9, b: 11 }, { a: 11, b: 13 },
    // lower lane ← (one-way)
    { a: 4, b: 2 }, { a: 6, b: 4 }, { a: 8, b: 6 }, { a: 10, b: 8 }, { a: 12, b: 10 }, { a: 14, b: 12 },
    // loop ends
    { a: 13, b: 14 }, { a: 2, b: 1 },
    // charger spurs (bi)
    { a: 15, b: 4 }, { a: 4, b: 15 }, { a: 16, b: 6 }, { a: 6, b: 16 }, { a: 17, b: 8 }, { a: 8, b: 17 },
    // station spurs (bi)
    { a: 18, b: 3 }, { a: 3, b: 18 }, { a: 19, b: 5 }, { a: 5, b: 19 }, { a: 20, b: 9 }, { a: 9, b: 20 },
    { a: 21, b: 11 }, { a: 11, b: 21 }, { a: 22, b: 13 }, { a: 13, b: 22 },
  ],
  // conveyor connections a→b (pallet flow, not AMR paths)
  cvs: [
    { a: 23, b: 24 }, { a: 24, b: 18 },   // 제품 공급 C/V
    { a: 20, b: 25 }, { a: 25, b: 21 },   // 라인 공급 → 라인 회수
    { a: 19, b: 26 }, { a: 26, b: 27 },   // 제품 회수 C/V
  ],
  // station links (optional): none → ACS auto-matches 제품 공급/회수
  links: [],
};
