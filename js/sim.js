// Simulation core: slot (station + C/V) flow → ACS requests → dispatch → AMR plans,
// node look-ahead reservation for traffic, charger PIO + simple battery.
let simSeq = 0;
const provReady = s => !!TYPES[s.type].prov && s.has && s.done && s.down == null;
const recvReady = s => !!TYPES[s.type].recv && !s.has && !(TYPES[s.type].buf && s.up != null); // buffer: Unload only at its C/V start
// buffers only pass pallets one way: 제품 공급 -> 공급 버퍼 -> 라인, 라인 -> 회수 버퍼 -> 제품 회수
function pairOK(p, r) {
  const P = TYPES[p.type], R = TYPES[r.type];
  if (P.buf) return P.buf === 'in' ? !!R.line : r.type === 'sink';
  if (R.buf) return R.buf === 'in' ? p.type === 'src' : !!P.line;
  return true;
}
// 공급 버퍼 refill signal, one pallet at a time: check from the end backwards — end detected? then the slot before it?
// ... — at the first slot without a detected pallet the buffer calls, but only when nothing is still moving on it
// (every slot from there up to the start is empty) and no AMR is already bringing one (start not reserved)
function bufCall(sm, head) {
  const ch = []; for (let x = head; x && !ch.includes(x); x = x.down != null ? sm.st[x.down] : null) ch.push(x);
  let i = ch.length - 1;
  while (i >= 0 && ch[i].has && ch[i].done) i--;
  return i >= 0 && head.res == null && ch.slice(0, i + 1).every(x => !x.has);
}
// what a slot asks the ACS for: lines both ways, 공급 버퍼 a refill (at its start), 회수 버퍼 a pickup at its end
const wants = (sm, s) => TYPES[s.type].buf === 'in' ? recvReady(s) && bufCall(sm, s) : TYPES[s.type].buf === 'out' ? provReady(s) : provReady(s) || recvReady(s);
const requests = s => s.port && (TYPES[s.type].line || TYPES[s.type].buf);

function spath(sm, a, b) { // layout is frozen during a run → cache paths
  if (!sm) return shortest(a, b);
  const k = a + '>' + b;
  if (!(k in sm.pc)) sm.pc[k] = shortest(a, b);
  return sm.pc[k];
}

const W = (cat, t, label, done) => ({ type: 'wait', cat, t, label, done });
const M = (r, label) => ({ type: 'move', path: r.path.slice(), len: r.len, label });
// one job: (charger exit if docked) → provider (Load) → receiver (Unload). It ends at the receiver after UnDocking:
// the AMR takes its next job from there, or heads home (homePlan) and can still be given a job on the way.
function buildPlan(sm, from, prov, recv, docked = true) {
  const P = S.params, r1 = spath(sm, from, prov), r2 = spath(sm, prov, recv);
  if (!r1 || !r2) return null;
  return [
    ...(docked ? [W('pio', P.chargePio, 'PIO 충전 해제'), W('undock', P.undockT, '충전소 UnDocking')] : []),
    { ...M(r1, `이동 → ${nameOf(prov)}`), gate: node(prov).type === 'src' ? prov : null }, // 제품 공급: queue behind until it's our pallet
    W('dock', P.dockT, `Docking ${nameOf(prov)}`), W('pio', P.pioLoad, 'PIO Load'), W('xfer', xferT(), '컨베이어 Loading', ['pick', prov]), W('undock', P.undockT, 'UnDocking'),
    { ...M(r2, `이동 → ${nameOf(recv)}`), gate: node(recv).type === 'sink' ? recv : null }, // 제품 회수: queue behind until its start is free
    W('dock', P.dockT, `Docking ${nameOf(recv)}`), W('pio', P.pioUnload, 'PIO Unload'), W('xfer', xferT(), '컨베이어 Unloading', ['drop', recv]), W('undock', P.undockT, 'UnDocking'),
  ];
}
function homePlan(sm, from, home) {
  const P = S.params, r = spath(sm, from, home);
  return [M(r, `복귀 → ${nameOf(home)}`), W('dock', P.dockT, '충전소 Docking'), W('pio', P.chargePio, 'PIO 충전 시작')];
}

function theoryCT(from, prov, recv, sm, docked = true) {
  const k = `ct${from}>${prov}>${recv}>${docked}`; // dispatch asks this every tick for every AMR × pair; layout is frozen during a run
  if (sm && k in sm.pc) return sm.pc[k];
  const plan = buildPlan(sm, from, prov, recv, docked), ct = plan && plan.reduce((s, g) => s + (g.type === 'wait' ? g.t : pathT(g.path)), 0);
  if (sm) sm.pc[k] = ct;
  return ct;
}
// can take a job now: charging at home (needs PIO + UnDocking first), or driving home after a job (not yet docking there)
const freeAmr = a => a.bat > S.params.minBat && !a.charging && (!a.plan || (!a.job && a.plan[a.si] && a.plan[a.si].type === 'move'));
const zeroCyc = () => ({ travel: 0, block: 0, pwait: 0, dock: 0, pio: 0, xfer: 0, undock: 0 });

// ---- slots: pallet arrives → waits T → done → next C/V / AMR Load / leaves ----
function arrive(s) { s.has = true; s.done = false; s.timer = s.T; }
function leave(s) { s.has = false; s.done = false; s.timer = null; s.out++; }

// Supply C/V is pull-based: its head feeds a pallet only while empty 라인 공급 stations
// that this 제품 공급 can serve outnumber the pallets already on the way.
// ponytail: a line served by several 제품 공급 is counted by each, so they may feed one extra pallet
const demand = (sm, srcId) => Object.values(sm.st).filter(L => L.port && (TYPES[L.type].line ? recvReady(L) : TYPES[L.type].buf === 'in' && wants(sm, L)) && L.res == null && sm.partners[L.id].includes(srcId)).length;
const pipeline = (sm, srcId) => sm.chains[srcId].filter(id => sm.st[id].has || sm.st[id].feed != null).length;

// 제품 공급 can take several AMRs at once: one per pallet on its C/V (end detected + queued behind).
// They load in dispatch order (sm.queue); the others wait `lookAhead` nodes before the station.
const palletsOn = (sm, srcId) => (sm.chains[srcId] || [srcId]).filter(id => sm.st[id].has).length;
const queueOf = (sm, srcId) => sm.queue[srcId] || (sm.queue[srcId] = []);
const srcAvail = (sm, y) => provReady(y) && palletsOn(sm, y.id) > queueOf(sm, y.id).length;
// whoever reaches the 제품 대기 point first takes the ready pallet (arrival order, so the front AMR never blocks its turn)
// 제품 회수 likewise takes several AMRs at once: one per empty slot on its C/V (start + downstream);
// they Unload in arrival order, each when the start is free again; the others wait `lookAhead` nodes before it
const slotsFree = (sm, id) => { let n = 0; for (let x = sm.st[id], seen = 0; x && seen++ < 1000; x = x.down != null ? sm.st[x.down] : null) if (!x.has) n++; return n; };
const sinkAvail = (sm, y) => slotsFree(sm, y.id) > queueOf(sm, y.id).length;
const pickGateOpen = (sm, a, id) => (node(id).type === 'src' ? provReady(sm.st[id]) : recvReady(sm.st[id])) && !sm.amrs.some(o => o !== a && o.committed === id);

function stationEvent(sm, [kind, id], now, a) { // AMR `a` finished Loading (pick) or Unloading (drop)
  const s = sm.st[id];
  if (s.reqT != null && TYPES[s.type].line) {
    const w = now - s.reqT; s.n++; s.sum += w; s.max = Math.max(s.max, w); s.reqT = null;
  }
  s.res = null;
  if ((kind === 'pick' && s.type === 'src') || (kind === 'drop' && s.type === 'sink')) {
    const q = queueOf(sm, id); q.splice(q.indexOf(a.id), 1); a.committed = null;
  }
  if (kind === 'drop') arrive(s); else leave(s);
}

function scanRequests(sm, now) { // a line slot requests while AMR service is possible
  for (const s of Object.values(sm.st)) if (requests(s)) {
    const ready = wants(sm, s);
    if (ready && s.reqT == null) s.reqT = now;
    else if (!ready && s.res == null) s.reqT = null;
  }
}

// 생산 prodH → 휴식 breakH, repeating from t = 0
function onBreak(t) {
  const P = S.params, c = (P.prodH + P.breakH) * 3600;
  return P.breakH > 0 && P.prodH > 0 && t % c >= P.prodH * 3600;
}
function stepStations(sm, dt) {
  const all = Object.values(sm.st), rest = onBreak(sm.t);
  for (const s of all) {
    if (rest && s.prod) continue; // 휴식: lines don't consume/process; C/V and AMRs keep going
    if (s.timer != null && (s.timer -= dt) <= 1e-9) { s.timer = null; s.done = true; }
    if (s.feed != null && (s.feed -= dt) <= 1e-9) { s.feed = null; s.has = true; s.done = true; s.fed++; } // pallet detected at the head
  }
  for (const s of all) {
    if (!s.has || !s.done) continue;
    if (s.down != null) { // accumulate: move only into an empty, unreserved slot
      const d = sm.st[s.down];
      if (!d.has && d.res == null) { leave(s); arrive(d); }
    } else if (!TYPES[s.type].prov) leave(s); // end of line: consumed / removed
  }
  // heads of C/V lines start feeding: supply lines on demand, others (production) whenever empty
  for (const s of all)
    if (s.up == null && GEN[s.type] && !s.has && s.feed == null && (s.pull == null || demand(sm, s.pull) > pipeline(sm, s.pull))) s.feed = s.T;
  scanRequests(sm, sm.t + dt);
}

// ---- ACS dispatch: oldest request first, nearest idle AMR, linked partner that is ready ----
// why a partner can't serve right now (shown in the station table)
function partnerState(sm, y) {
  if (y.type === 'src' && queueOf(sm, y.id).length) return `배차 ${queueOf(sm, y.id).length}대 / C/V 제품 ${palletsOn(sm, y.id)}개`;
  if (y.type === 'sink') return `배차 ${queueOf(sm, y.id).length}대 / C/V 빈 칸 ${slotsFree(sm, y.id)}개`;
  if (y.res != null) return '다른 작업에 배차됨';
  if (y.has) return y.done ? (y.down != null ? 'C/V 이동 대기' : '준비됨') : `이동/감지 중 ${Math.ceil(y.timer)}s`;
  if (y.feed != null) return `C/V 투입 중 ${Math.ceil(y.feed)}s`;
  if (sm.chains[y.id] && pipeline(sm, y.id)) return 'C/V 이송 중';
  return '제품 없음';
}
// built only when the station table is drawn (building it every tick for every request was most of the run time)
function whyOf(sm, x) {
  const why = sm.partners[x.id].map(y => `${nameOf(y)} ${partnerState(sm, sm.st[y])}`).join(', ');
  return sm.amrs.some(freeAmr) ? why : `배차 가능한 AMR 없음 (작업 중/잔량 ≤ ${S.params.minBat}%) · ${why}`;
}

function dispatch(sm) {
  const idle = sm.amrs.filter(freeAmr); // 잔량 ≤ minBat → 임무 받지 않음
  // first come, first served (a 회수 버퍼 end pallet queues with the line requests in detection order);
  // only refilling a 공급 버퍼 waits until every line request is served
  const fill = s => TYPES[s.type].buf === 'in';
  const pend = Object.values(sm.st).filter(s => s.reqT != null && s.res == null)
    .sort((x, y) => fill(x) - fill(y) || x.reqT - y.reqT);
  for (const x of pend) {
    if (!idle.length) return;
    if (x.res != null) continue; // reserved as partner earlier in this loop
    let best = null;
    for (const yId of sm.partners[x.id]) {
      const y = sm.st[yId];
      const yProv = y.type === 'src' ? srcAvail(sm, y) : provReady(y) && y.res == null;
      const yRecv = y.type === 'sink' ? sinkAvail(sm, y) : recvReady(y) && y.res == null;
      const pair = [recvReady(x) && yProv && [y, x], provReady(x) && yRecv && [x, y]].find(p => p && pairOK(...p));
      if (!pair) continue;
      // a line's own buffer wins over the 제품 공급/회수 (회수 버퍼 full -> falls through to 제품 회수)
      const pri = TYPES[y.type].buf ? 0 : 1;
      for (const a of idle) {
        const c = theoryCT(a.edge ? a.edge.to : a.at, pair[0].id, pair[1].id, sm, !a.plan); // from where the AMR is now
        if (c != null && (!best || pri < best.pri || (pri === best.pri && c < best.c))) best = { a, pr: pair[0], rc: pair[1], c, pri };
      }
    }
    if (!best) continue;
    const { a, pr, rc } = best;
    ++sm.jobSeq;
    if (rc.type === 'sink') queueOf(sm, rc.id).push(a.id); else rc.res = sm.jobSeq;
    if (pr.type === 'src') queueOf(sm, pr.id).push(a.id); else pr.res = sm.jobSeq;
    // driving home: finish the edge in progress, then go from its end node; drop the look-ahead toward the charger
    const docked = !a.plan, from = a.edge ? a.edge.to : a.at;
    if (!docked) for (const k in sm.locks) if (sm.locks[k] === a.id && +k !== a.at && +k !== from) delete sm.locks[k];
    a.plan = buildPlan(sm, from, pr.id, rc.id, docked); a.si = 0; a.wt = 0; a.blocked = 0; a.job = true;
    a.pi = a.edge ? -1 : 0; // arriving at `from` makes it path index 0
    a.cyc = { amr: a.id, job: `${nameOf(pr.id)}→${nameOf(rc.id)}`, pr: pr.id, rc: rc.id, from, docked, start: sm.t, ...zeroCyc(),
      lead: a.edge ? (a.edge.len - a.edge.prog) / a.edge.v : 0 }; // time left on the edge before `from`
    idle.splice(idle.indexOf(a), 1);
  }
}

// ---- traffic: reserve up to N nodes ahead; final approach to the destination is all-or-nothing ----
// Last path index of the bidirectional section entered with the next step (a station spur, a two-way aisle).
// Such a section is taken WHOLE before entering, so two AMRs never meet head-on inside it. Stops at a 대기 포지션.
function biRunEnd(path, i) {
  const bi = k => hasEdge(path[k + 1], path[k]);
  let j = i + 1;
  if (!bi(i) && !(j < path.length - 1 && bi(j))) return j; // ordinary one-way step
  while (j < path.length - 1 && bi(j) && node(path[j]).type !== 'wait') j++;
  return j;
}
// returns the blocking node id, or null when the next node is ours
// `limit` = last path index that may be reserved (the 제품 대기 point while it's not our turn)
function reserveAhead(sm, a, path, limit = Infinity) {
  const L = Math.max(1, Math.round(S.params.lookAhead)), rest = path.length - 1 - a.pi;
  const free = n => !sm.locks[n] || sm.locks[n] === a.id;
  const run = path.slice(a.pi + 1, Math.min(biRunEnd(path, a.pi), limit) + 1);
  if (run.length > 1) { // bidirectional section: all or nothing
    const b = run.find(n => !free(n)); if (b !== undefined) return b;
    run.forEach(n => sm.locks[n] = a.id);
  }
  let want = path.slice(a.pi + 1, Math.min(a.pi + 1 + Math.min(L, rest), limit + 1));
  let cut = want.length < Math.min(L, rest);
  // look-ahead stops AT a 대기 포지션: nothing beyond it is reserved until the AMR stands on it and passes its gate
  const wi = want.findIndex(n => node(n).type === 'wait');
  if (wi >= 0 && wi < want.length - 1) cut = true;
  if (wi >= 0) want = want.slice(0, wi + 1);
  if (rest <= L && !cut) { const b = want.find(n => !free(n)); if (b !== undefined) return b; }
  for (const n of want) { if (!free(n)) break; sm.locks[n] = a.id; }
  return sm.locks[want[0]] === a.id ? null : want[0];
}
// 대기 포지션: the AMR stands here while ANY other AMR is in the zone ahead (the yellow band: every node within
// `ahead` hops, not looking back where it came from). When clear, it reserves its route through the zone at once.
function waitGate(sm, a, path, limit = Infinity) {
  const w = node(a.at);
  if (w.type !== 'wait') return null;
  const zone = waitZone(w.id, a.prev).hop;
  const b = [...zone.keys()].find(n => sm.locks[n] && sm.locks[n] !== a.id);
  if (b !== undefined) return b;
  for (let i = a.pi + 1; i < path.length && i <= limit && zone.has(path[i]); i++) sm.locks[path[i]] = a.id;
  return null;
}
function releaseAhead(sm, a) { for (const k in sm.locks) if (sm.locks[k] === a.id && +k !== a.at) delete sm.locks[k]; }

function newSim() {
  const P = S.params, chargers = S.nodes.filter(n => n.type === 'charger');
  if (!chargers.length) return alert('충전소가 없습니다. 충전소를 캔버스에 끌어다 놓으세요.');
  if (P.amrCount > chargers.length) return alert(`AMR ${P.amrCount}대 > 충전소 ${chargers.length}개. 충전소를 추가하거나 AMR 수량을 줄이세요.`);
  if (P.productKg > P.payload) return alert(`제품 중량 ${P.productKg} kg > AMR Payload ${P.payload} kg. 이송할 수 없습니다.`);
  if (!(P.batRunH > 0) || !(P.batChargeH > 0)) return alert('가동 시간과 충전 시간은 0보다 커야 합니다.');
  if (!(P.rollerSpeed > 0)) return alert('롤러 속도는 0보다 커야 합니다.');
  const lines = S.nodes.filter(n => TYPES[n.type].line && onPath(n.id));
  if (!lines.length) return alert('AMR 경로에 연결된 라인 스테이션이 없습니다. 라인 공급/회수 스테이션을 AMR 노드와 경로로 연결하세요.');
  // C/V direction at AMR ports: AMR loads at the END of a supply line and unloads at the START of a return line.
  // Stations off the AMR path are plain C/V blocks and may sit anywhere in a line.
  for (const c of S.cvs) {
    const a = node(c.a), b = node(c.b), fix = `\n\nC/V 연결(${a.name} → ${b.name})을 클릭해 "방향 반전"하세요.`;
    if (a.type === 'src' && onPath(a.id)) return alert(`C/V 방향 확인: AMR이 Load하는 제품 공급 ${a.name}은 C/V 맨 끝이어야 합니다. 지금은 Pallet이 ${b.name}(으)로 흘러갑니다.${fix}`);
    if (b.type === 'sink' && onPath(b.id)) return alert(`C/V 방향 확인: AMR이 Unload하는 제품 회수 ${b.name}은 C/V 시작이어야 합니다.${fix}`);
    if (b.type === 'lineIn' && onPath(b.id)) return alert(`C/V 방향 확인: 라인 공급 ${b.name}은 AMR이 Unload하는 곳이라 상류 C/V를 둘 수 없습니다.${fix}`);
    if (a.type === 'lineOut' && onPath(a.id)) return alert(`C/V 방향 확인: 라인 회수 ${a.name}은 AMR이 Load하는 곳이라 하류 C/V를 둘 수 없습니다.${fix}`);
  }
  // 대기 포지션 on the only way OUT of a station/charger in its zone: the AMR waiting there blocks the one leaving → deadlock
  const homeIds = chargers.slice(0, P.amrCount).map(c => c.id), trapped = [];
  for (const w of S.nodes.filter(n => n.type === 'wait'))
    for (const z of waitZone(w.id).hop.keys()) {
      const zn = node(z);
      if ((zn.type === 'charger' || (isStation(zn.type) && onPath(z))) && !homeIds.some(h => h !== z && shortest(z, h, new Set([w.id]))))
        trapped.push(`· ${w.name}: ${zn.name}에서 나오는 길이 ${w.name}을(를) 지나야만 합니다`);
    }
  if (trapped.length && !confirm(`대기 포지션 위치 확인 (교착 위험)\n\n${trapped.join('\n')}\n\n대기 중인 AMR이 그 노드를 차지하면 안에서 나오는 AMR이 지나갈 수 없습니다.\n대기 포지션을 분기점 앞, 들어가는 길에만 있는 노드로 옮기는 것을 권장합니다.\n\n그래도 실행할까요?`)) return;
  // 라인 공급 → 라인 회수 by C/V is optional: connected → consumed at 라인 회수, not connected → 라인 공급 consumes itself.
  // AMR paths between them are ordinary paths; product never moves between them by AMR link.
  const homes = chargers.slice(0, P.amrCount).map(c => c.id), partners = {}, pre = { pc: {} }; // route cache shared by the checks below and the run
  for (const x of lines) {
    partners[x.id] = partnersOf(x.id);
    if (!partners[x.id].length) return alert(`${x.name}: 상대 스테이션이 없습니다. ${x.type === 'lineIn' ? '제품 공급' : x.type === 'lineOut' ? '제품 회수' : '제품 공급/회수'} 스테이션을 배치하거나 연결하세요.`);
    for (const y of partners[x.id]) {
      const d = linkDir(x, node(y)), pairs = d ? [d] : [[x.id, y], [y, x.id]];
      for (const h of homes) for (const [p, r] of pairs)
        if (theoryCT(h, p, r, pre) == null || !spath(pre, r, h)) return alert(routeError(h, p, r));
    }
  }
  // buffer C/V lines assigned to lines: both ends on the AMR path, fed/emptied by the lines' 제품 공급/회수
  for (const b of new Set(lines.flatMap(x => partners[x.id].filter(isBuf)))) {
    const T = TYPES[node(b).type], [inP, outP] = T.buf === 'in' ? [cvHead(b), b] : [b, cvEnd(b)];
    for (const p of [inP, outP]) if (!onPath(p) || TYPES[node(p).type].buf !== T.buf)
      return alert(`${T.label} ${nameOf(p)}: 버퍼 C/V의 시작(AMR Unload)과 끝(AMR Load)은 둘 다 ${T.label} 블록이고 AMR 경로에 연결되어 있어야 합니다.`);
    const ext = T.buf === 'in' ? inP : outP; // the end served by 제품 공급 / 제품 회수
    partners[ext] = partnersOf(ext);
    if (!partners[ext].length) return alert(`${nameOf(ext)}: ${T.buf === 'in' ? '버퍼를 채울 제품 공급' : '버퍼를 비울 제품 회수'}이 없습니다. 연결된 라인의 ${T.buf === 'in' ? '제품 공급' : '제품 회수'}을 확인하세요.`);
    for (const y of partners[ext]) for (const h of homes) {
      const [p, r] = T.buf === 'in' ? [y, ext] : [ext, y];
      if (theoryCT(h, p, r, pre) == null || !spath(pre, r, h)) return alert(routeError(h, p, r));
    }
  }
  // passive stations get the reverse list so a line↔line link works from either side
  for (const n of S.nodes) if (isSlot(n.type) && !partners[n.id]) partners[n.id] = [];
  for (const x of lines) for (const y of partners[x.id]) if (!partners[y].includes(x.id)) partners[y].push(x.id);
  const st = {};
  for (const n of S.nodes) if (isSlot(n.type))
    st[n.id] = { id: n.id, type: n.type, T: n.t, port: onPath(n.id), prod: /소진|가공/.test(tLabelOf(n)), has: false, done: false, timer: null, feed: null, fed: 0, pull: null,
      res: null, reqT: null, n: 0, sum: 0, max: 0, out: 0, up: null, down: null };
  for (const c of S.cvs) { st[c.a].down = c.b; st[c.b].up = c.a; }
  for (const n of S.nodes) if (st[n.id] && n.init) { st[n.id].has = true; st[n.id].done = true; } // 시작 시 제품 있음
  // supply chains: walk up from each 제품 공급 (C/V end) to its head; that head feeds on demand
  const chains = {};
  for (const n of S.nodes) if (n.type === 'src' && st[n.id].down == null) {
    const ids = [n.id]; let h = st[n.id];
    while (h.up != null && !ids.includes(h.up)) { ids.push(h.up); h = st[h.up]; }
    if (h.up == null) { h.pull = n.id; chains[n.id] = ids; } // a closed C/V loop has no head → nothing to feed
  }
  const amrs = homes.map((h, i) => ({ id: i + 1, home: h, at: h, plan: null, si: 0, wt: 0, pi: 0, edge: null, blocked: 0, dl: false, cyc: null, cat: 'idle', phase: '충전 중', bat: 100, busy: 0, jobs: 0 }));
  const locks = {}; amrs.forEach(a => locks[a.home] = a.id);
  const sm = { id: ++simSeq, t: 0, end: P.simHours * 3600, amrs, locks, st, partners, chains, queue: {}, pc: pre.pc, jobSeq: 0, cycles: [], reroutes: 0, deadlocks: 0, logged: 0 };
  scanRequests(sm, 0);
  stepStations(sm, 0); // heads start feeding at t=0
  return sm;
}

function stepSim(sm, dt) {
  dispatch(sm);
  for (const a of sm.amrs) stepAmr(sm, a, dt);
  detectDeadlock(sm);
  stepStations(sm, dt);
  sm.t += dt;
}

// AMRs waiting on each other in a circle (a.waitOn = AMR that holds what I need) → flag and count once per incident
function detectDeadlock(sm) {
  const byId = Object.fromEntries(sm.amrs.map(a => [a.id, a])), ring = new Set();
  for (const a of sm.amrs) {
    let cur = a, chain = [a.id];
    for (let i = 0; i < sm.amrs.length && cur.waitOn; i++) {
      cur = byId[cur.waitOn]; if (!cur) break;
      if (cur === a) { chain.forEach(id => ring.add(id)); break; }
      chain.push(cur.id);
    }
  }
  for (const a of sm.amrs) a.inDL = ring.has(a.id);
  const key = [...ring].sort().join('→');
  if (key && key !== sm.dlKey) sm.deadlocks++;
  sm.dlKey = key;
}

function stepAmr(sm, a, dt) {
  const P = S.params;
  if (a.bat <= P.minBat) a.charging = true; // low: no missions until charged back up to chargeTo
  if (!a.plan) {
    a.bat = Math.min(100, a.bat + 100 / P.batChargeH * dt / 3600);
    if (a.charging && a.bat >= Math.max(P.chargeTo, P.minBat + 1e-6)) a.charging = false;
    a.cat = 'idle'; a.phase = a.charging ? `충전 중 (${Math.max(P.chargeTo, P.minBat)}%까지, 임무 불가)` : '충전 중';
    return;
  }
  a.busy += dt; a.bat = Math.max(0, a.bat - 100 / P.batRunH * dt / 3600);
  a.waitOn = null; // set again below if this step ends blocked by another AMR
  let rem = dt;
  while (rem > 1e-9) {
    const now = sm.t + (dt - rem), seg = a.plan[a.si];
    if (!seg) {
      if (a.job) { // UnDocked at the receiver: job cycle complete → next job from here (dispatch), else head home
        Object.assign(a.cyc, { end: now, ct: now - a.cyc.start }); sm.cycles.push(a.cyc); a.jobs++;
        a.job = false; a.cyc = zeroCyc(); // the way home is not part of any job's CT
        a.plan = homePlan(sm, a.at, a.home); a.si = 0; a.wt = 0; a.pi = 0;
        continue;
      }
      a.plan = null; a.cat = 'idle'; a.phase = '충전 중'; // docked at the charger again
      return;
    }
    a.phase = seg.label;
    if (seg.type === 'wait') {
      const use = Math.min(rem, seg.t - a.wt);
      a.wt += use; rem -= use; a.cyc[seg.cat] += use; a.cat = seg.cat;
      if (a.wt >= seg.t - 1e-9) { if (seg.done) stationEvent(sm, seg.done, now + use, a); a.si++; a.wt = 0; }
      continue;
    }
    if (!a.edge) {
      if (a.pi >= seg.path.length - 1) { a.si++; a.pi = 0; continue; }
      // 제품 공급 queue: until it's our turn, stop `lookAhead` nodes before the station (or before the two-way
      // section leading to it) and reserve nothing past that point
      let limit = Infinity;
      if (seg.gate != null && a.committed !== seg.gate) {
        // wait point: `lookAhead` nodes before the station, and never on/inside the two-way spur leading to it
        // (its entry junction is the way out for the AMR still at the station)
        const p = seg.path, L = Math.max(1, Math.round(P.lookAhead));
        let k = p.length - 1; while (k > 0 && hasEdge(p[k], p[k - 1])) k--;
        const g = Math.max(0, Math.min(p.length - 1 - L, k - 1));
        if (a.pi >= g || biRunEnd(seg.path, a.pi) > g) {
          if (pickGateOpen(sm, a, seg.gate)) a.committed = seg.gate;
          else {
            const other = sm.amrs.find(o => o !== a && o.committed === seg.gate);
            a.cyc.pwait += rem; a.cat = 'pwait'; a.waitOn = other ? other.id : null;
            a.phase = `${node(seg.gate).type === 'src' ? '제품 대기' : '회수 대기'}: ${nameOf(seg.gate)} 앞 ${seg.path.length - 1 - a.pi}노드 지점`;
            break;
          }
        } else limit = g;
      }
      const gate = waitGate(sm, a, seg.path, limit);
      if (gate != null) { // intended hold: no detour, just wait for the narrow section to clear
        a.cyc.block += rem; a.cat = 'block'; a.waitOn = sm.locks[gate];
        a.phase = `대기 포지션 ${nameOf(a.at)}: 앞 구간 ${nameOf(gate)}에 AMR${sm.locks[gate]}`;
        break;
      }
      const blk = reserveAhead(sm, a, seg.path, limit);
      if (blk != null) {
        a.blocked += rem; a.cyc.block += rem; a.cat = 'block'; a.waitOn = sm.locks[blk];
        a.phase = `대기: ${nameOf(blk)} AMR${sm.locks[blk]} 선점`;
        if (a.blocked >= P.blockTimeout) { // try a detour around the blocking node
          a.blocked = 0;
          const r = shortest(a.at, seg.path[seg.path.length - 1], new Set([blk]));
          if (r && !r.path.includes(blk)) { releaseAhead(sm, a); seg.path = r.path; a.pi = 0; sm.reroutes++; }
        }
        break;
      }
      a.blocked = 0;
      const from = seg.path[a.pi], to = seg.path[a.pi + 1];
      a.edge = { from, to, len: dist(node(from), node(to)), v: edgeV(from, to), prog: 0 };
    }
    a.cat = 'travel';
    const need = (a.edge.len - a.edge.prog) / a.edge.v;
    if (need <= rem) {
      rem -= need; a.cyc.travel += need;
      // arriving to dock at a station: keep the entry node too, until UnDocking is done and the AMR has left
      const dockAt = a.pi + 1 === seg.path.length - 1 && (a.plan[a.si + 1] || {}).cat === 'dock' && node(a.edge.to).type !== 'charger';
      if (a.hold != null && a.hold !== a.edge.to && sm.locks[a.hold] === a.id) delete sm.locks[a.hold];
      a.hold = dockAt ? a.edge.from : null;
      if (!dockAt && sm.locks[a.edge.from] === a.id) delete sm.locks[a.edge.from];
      a.prev = a.edge.from; a.at = a.edge.to; a.edge = null; a.pi++;
    } else {
      a.edge.prog += rem * a.edge.v; a.cyc.travel += rem; rem = 0;
    }
  }
}

function runTo(sm, until) {
  while (sm.t < until - 1e-9) stepSim(sm, Math.min(0.1, until - sm.t));
}
