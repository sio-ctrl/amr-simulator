// Shared state + layout/graph helpers. Classic scripts share these globals (ES modules are blocked on file://).
const P_DEF = {
  amrCount: 3, speed: 0.3, dockT: 15, pioLoad: 5, pioUnload: 5, undockT: 10,
  rollerSpeed: 0.3, palletL: 1100, palletW: 100, palletH: 150, xferMargin: 0,
  lookAhead: 3, blockTimeout: 20, chargePio: 5, batRunH: 6, batChargeH: 2, minBat: 30, chargeTo: 50, payload: 1000, productKg: 500,
  simHours: 1, simSpeed: 30, prodH: 5, breakH: 1,
};
// conveyor roller transfer: the pallet travels its own length (+ margin) at roller speed
const xferT = () => (S.params.palletL + S.params.xferMargin) / 1000 / S.params.rollerSpeed;
const CAT = { travel: '주행', block: '대기(교통)', pwait: '제품 대기', dock: 'Docking', pio: 'PIO', xfer: '이재(Load/Unload)', undock: 'UnDocking' };
const CAT_COLOR = { travel: '#4da3ff', block: '#ff5a5a', pwait: '#ff9800', dock: '#f0a030', pio: '#b57bff', xfer: '#3ecf6e', undock: '#f0d030', idle: '#888' };
const AMR_COLOR = ['#ff6b6b', '#4dd0e1', '#ffd54f', '#ba68c8', '#81c784', '#ff8a65', '#f06292', '#90a4ae'];

// Slot behaviour (stations + C/V). Every slot holds one pallet:
//   pallet arrives → waits t seconds → 'done' → moves to the downstream C/V if connected,
//   else waits for AMR Load (prov types), else leaves (consumed / removed).
//  prov: AMR can Load here   recv: AMR can Unload here   line: raises requests to ACS
//  names are from the AMR's point of view: 라인 공급 = AMR gives to the line, 라인 회수 = AMR takes from the line
const TYPES = {
  path:    { label: '일반 노드', prefix: 'N', color: '#9aa' },
  charger: { label: '충전소', prefix: 'C', color: '#3ecf6e', glyph: '⚡' },
  // 협소 구간 앞 대기 포지션: AMR waits here until the next `ahead` nodes on its route are free
  wait:    { label: '대기 포지션', prefix: 'W', color: '#ffd54f', glyph: 'W' },
  lineIn:  { label: '라인 공급', act: 'AMR → 라인 공급 C/V (Unload)', prefix: 'LI', color: '#e0912f', glyph: 'IN', slot: true, recv: true, line: true, tLabel: 'C/V 이송 시간 (s)', tDef: 10 },
  lineOut: { label: '라인 회수', act: '제품 소진 후 라인 → AMR (Load)', prefix: 'LO', color: '#e0662f', glyph: 'OUT', slot: true, prov: true, line: true, tLabel: '제품 소진 시간 (s)', tDef: 120 },
  lineIO:  { label: '라인 공급/회수', act: 'AMR → 라인 (Unload), 가공 후 라인 → AMR (Load)', prefix: 'LX', color: '#d65aa8', glyph: 'I/O', slot: true, prov: true, recv: true, line: true, tLabel: '가공 시간 (s)', tDef: 120 },
  src:     { label: '제품 공급', act: '스테이션 → AMR (Load)', prefix: 'PS', color: '#3fb8c9', glyph: 'PS', slot: true, prov: true, tLabel: '제품 감지 시간 (s)', tDef: 5 },
  sink:    { label: '제품 회수', act: 'AMR → 스테이션 (Unload)', prefix: 'PR', color: '#6f8fe0', glyph: 'PR', slot: true, recv: true, tLabel: '제품 회수 시간 (s)', tDef: 5 },
  // buffer C/V lines: AMR Unloads at the C/V start, Loads at the C/V end; assigned to lines by station link
  bufIn:   { label: '공급 버퍼', act: '제품 공급 → 버퍼 시작 (Unload), 버퍼 끝 → 라인 공급 (Load)', prefix: 'BI', color: '#4db6ac', glyph: 'BI', slot: true, prov: true, recv: true, buf: 'in', tLabel: 'C/V 이송 시간 (s)', tDef: 5 },
  bufOut:  { label: '회수 버퍼', act: '라인 회수 → 버퍼 시작 (Unload), 버퍼 끝 → 제품 회수 (Load)', prefix: 'BO', color: '#9575cd', glyph: 'BO', slot: true, prov: true, recv: true, buf: 'out', tLabel: 'C/V 이송 시간 (s)', tDef: 5 },
  cv:      { label: 'C/V', prefix: 'CV', color: '#a1887f', glyph: 'C/V', slot: true, tLabel: 'C/V 이송 시간 (s)', tDef: 5 },
};
// with no upstream C/V these feed a pallet after t seconds: the head of a supply C/V line only while
// a 라인 공급 it serves is empty (pull), other heads (production) whenever they are empty
const GEN = { src: true, lineOut: true, cv: true };
// a station block off the AMR path is just C/V; only the 라인 회수 port consumes
function tLabelOf(n) {
  if (isStation(n.type) && !onPath(n.id)) return 'C/V 이송 시간 (s)';
  if (n.type === 'lineIn' && cvDown(n.id) == null) return '제품 소진 시간 (s)'; // standalone 라인 공급 consumes itself
  return TYPES[n.type].tLabel;
}
// last slot reached by following C/V downstream from id
function cvEnd(id) { const seen = [id]; let d; while ((d = cvDown(id)) != null && !seen.includes(d)) { seen.push(d); id = d; } return id; }
const isStation = t => !!(TYPES[t] && (TYPES[t].prov || TYPES[t].recv));
const isSlot = t => !!(TYPES[t] && TYPES[t].slot);
const STORE_KEY = 'amrsim.default';

let S = null;          // layout + params (what gets saved)
let sim = null;        // running simulation state
let running = false;
let bgImg = null;      // decoded S.bg
let sel = null;        // {kind:'node', id} | {kind:'edge'|'link'|'cv', a, b}

const clone = o => JSON.parse(JSON.stringify(o));

// logistics link rules: one side provides, the other receives, and at least one is a line station
// 라인 공급 → 라인 회수 is always a C/V connection, never AMR transport
const isLinePair = (na, nb) => [na.type, nb.type].sort().join() === 'lineIn,lineOut';
function linkOK(na, nb) {
  const A = TYPES[na.type], B = TYPES[nb.type];
  if (A.buf || B.buf) { // buffer <-> the line it serves: 공급 버퍼 -> line that receives, line that gives -> 회수 버퍼
    const [b, l] = A.buf ? [A, B] : [B, A];
    return na.id !== nb.id && !!l.line && (b.buf === 'in' ? !!l.recv : !!l.prov);
  }
  return na.id !== nb.id && !isLinePair(na, nb) && !!(A.line || B.line) && !!((A.prov && B.recv) || (B.prov && A.recv));
}
// [providerId, receiverId] when the direction is fixed, null when both ways are possible (lineIO ↔ lineIO)
function linkDir(na, nb) {
  const A = TYPES[na.type], B = TYPES[nb.type], ab = A.prov && B.recv, ba = B.prov && A.recv;
  if (A.buf) return A.buf === 'in' ? [na.id, nb.id] : [nb.id, na.id];
  if (B.buf) return B.buf === 'in' ? [nb.id, na.id] : [na.id, nb.id];
  return ab && !ba ? [na.id, nb.id] : ba && !ab ? [nb.id, na.id] : null;
}

function normalize(o) {
  if (!o || !Array.isArray(o.nodes) || !Array.isArray(o.edges)) throw new Error('nodes/edges 없음');
  o.params = { ...P_DEF, ...o.params };
  o.mapW = +o.mapW || 40; o.mapH = +o.mapH || 20; o.bg = o.bg || null;
  for (const n of o.nodes) {
    if (!TYPES[n.type]) n.type = 'lineIO';             // pre-v3 'station'
    if (isSlot(n.type) && !(n.t >= 0)) n.t = TYPES[n.type].tDef;
    if (isSlot(n.type) && n.init === undefined) n.init = !!TYPES[n.type].init;
    if (n.type === 'wait' && !(n.ahead >= 1)) n.ahead = 3;
  }
  const byId = Object.fromEntries(o.nodes.map(n => [n.id, n]));
  o.links = (o.links || []).filter(l => byId[l.a] && byId[l.b] && linkOK(byId[l.a], byId[l.b]));
  o.cvs = (o.cvs || []).filter(c => byId[c.a] && byId[c.b] && isSlot(byId[c.a].type) && isSlot(byId[c.b].type) && c.a !== c.b);
  delete o.missions;
  o.nextId = Math.max(o.nextId || 1, ...o.nodes.map(n => n.id + 1));
  return o;
}

function loadDefault() {
  try { const t = localStorage.getItem(STORE_KEY); if (t) return normalize(JSON.parse(t)); } catch (e) { console.warn('저장된 기본 설정 무시:', e); }
  return normalize(clone(window.DEFAULT_CONFIG));
}

const node = id => S.nodes.find(n => n.id === id); // ponytail: linear lookup, use a Map if layouts reach thousands of nodes
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const nameOf = id => (node(id) || {}).name || '?';
const hasEdge = (a, b) => S.edges.some(e => e.a === a && e.b === b);
const findLink = (a, b) => S.links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
const findCv = (a, b) => S.cvs.find(c => (c.a === a && c.b === b) || (c.a === b && c.b === a));
const linkedTo = id => S.links.filter(l => l.a === id || l.b === id).map(l => l.a === id ? l.b : l.a);
// a station is an AMR port (Load/Unload point, requests) only when it sits on the AMR path;
// otherwise it is just a block in a C/V line
const onPath = id => S.edges.some(e => e.a === id || e.b === id);
const cvUp = id => (S.cvs.find(c => c.b === id) || {}).a;
const cvDown = id => (S.cvs.find(c => c.a === id) || {}).b;

// C/V is a single chain per slot: one upstream, one downstream (a new connection replaces the old one)
function setCv(a, b) {
  S.cvs = S.cvs.filter(c => c.a !== a && c.b !== b && !(c.a === b && c.b === a));
  S.cvs.push({ a, b });
}

function cvHead(id) { const seen = [id]; let u; while ((u = cvUp(id)) != null && !seen.includes(u)) { seen.push(u); id = u; } return id; }
const isBuf = id => !!TYPES[node(id).type].buf;
// the buffer port a line uses: Load at the end of a 공급 버퍼, Unload at the start of a 회수 버퍼
const bufPort = id => TYPES[node(id).type].buf === 'in' ? cvEnd(id) : cvHead(id);
// 생산 라인 matching (case-insensitive): "A1" ↔ "A1" only; a group label "A" on either side covers the whole group
// ("A", "A1", "A2", ...). Typical: one 회수 버퍼 "A" for lines A1..A4, a 공급 버퍼 per sub-line A1..A4.
const LINE_GROUPS = ['A', 'B', 'C', 'D'].flatMap(g => [g, g + 1, g + 2, g + 3, g + 4]); // suggestions only, any text works
function groupMatch(lineG, bufG) {
  const l = String(lineG || '').toUpperCase(), b = String(bufG || '').toUpperCase(), grp = g => g.replace(/\d+$/, '');
  return !!l && !!b && (l === b || ((l === grp(l) || b === grp(b)) && grp(l) === grp(b)));
}
// buffer ports a line station uses: linked by station link, or the same 생산 라인 (set on any block of the buffer)
function bufsOf(lineId) {
  const x = node(lineId);
  return [...new Set(S.nodes.filter(b => TYPES[b.type].buf && linkOK(x, b) &&
    (linkedTo(lineId).includes(b.id) || groupMatch(x.group, b.group))).map(b => bufPort(b.id)))];
}

// who may serve a line station: its linked stations, or — when it has no (non-buffer) links —
// every compatible 제품 공급 (C/V end) / 제품 회수 (C/V start) port that is not dedicated to someone else by a link;
// plus the buffer ports linked to it. A buffer port is served by the 제품 공급/회수 of the lines it is assigned to.
function partnersOf(id) {
  const x = node(id), all = linkedTo(id);
  if (TYPES[x.type].buf) {
    const want = TYPES[x.type].buf === 'in' ? 'src' : 'sink', port = bufPort(id);
    const lines = S.nodes.filter(l => TYPES[l.type].line && bufsOf(l.id).includes(port));
    return [...new Set(lines.flatMap(l => partnersOf(l.id)).filter(y => node(y).type === want))];
  }
  const linked = all.filter(y => !isBuf(y)), bufs = bufsOf(id);
  const base = linked.length ? linked : S.nodes.filter(y => onPath(y.id) && !linkedTo(y.id).length && linkOK(x, y) &&
    ((y.type === 'src' && cvDown(y.id) == null) || (y.type === 'sink' && cvUp(y.id) == null))).map(y => y.id);
  return [...base, ...bufs];
}

function freeName(prefix) { let i = 1; while (S.nodes.some(n => n.name === prefix + i)) i++; return prefix + i; }

function addNode(x, y, type) {
  const id = S.nextId++, n = { id, x, y, type, name: freeName(TYPES[type].prefix) };
  if (isSlot(type)) { n.t = TYPES[type].tDef; n.init = !!TYPES[type].init; }
  if (type === 'wait') n.ahead = 3;
  S.nodes.push(n);
  return id;
}

function setType(n, type) {
  if (n.type === type) return;
  n.type = type;
  if (/^(N|C|W|LI|LO|LX|PS|PR|BI|BO|CV|ST)\d+$/.test(n.name)) n.name = freeName(TYPES[type].prefix);
  if (isSlot(type)) { n.t = TYPES[type].tDef; n.init = !!TYPES[type].init; } else { delete n.t; delete n.init; }
  if (type === 'wait') n.ahead = 3; else delete n.ahead;
  if (!TYPES[type].line && !TYPES[type].buf) delete n.group;
  S.links = S.links.filter(l => linkOK(node(l.a), node(l.b)));
  S.cvs = S.cvs.filter(c => isSlot(node(c.a).type) && isSlot(node(c.b).type));
}

function deleteNode(id) {
  S.nodes = S.nodes.filter(n => n.id !== id);
  S.edges = S.edges.filter(e => e.a !== id && e.b !== id);
  S.links = S.links.filter(l => l.a !== id && l.b !== id);
  S.cvs = S.cvs.filter(c => c.a !== id && c.b !== id);
}

// direction between two nodes, relative to (a,b): 'bi' | 'ab' | 'ba' | 'none'
function edgeDir(a, b) { const ab = hasEdge(a, b), ba = hasEdge(b, a); return ab && ba ? 'bi' : ab ? 'ab' : ba ? 'ba' : 'none'; }
const samePair = (e, a, b) => (e.a === a && e.b === b) || (e.a === b && e.b === a);
// e.v = 구간 속도 (m/s, e.g. a faster stretch), shared by both directions and kept when the direction changes
function setEdge(a, b, dir, v = (S.edges.find(e => samePair(e, a, b)) || {}).v) {
  S.edges = S.edges.filter(e => !samePair(e, a, b));
  const x = v > 0 ? { v } : {};
  if (dir === 'bi' || dir === 'ab') S.edges.push({ a, b, ...x });
  if (dir === 'bi' || dir === 'ba') S.edges.push({ a: b, b: a, ...x });
}
// AMR speed on a→b: the edge's own speed, else the 기본 주행 속도 (slow/safe by default)
function edgeV(a, b) { const e = S.edges.find(e => e.a === a && e.b === b); return e && e.v > 0 ? e.v : S.params.speed; }
const pathT = path => path.slice(1).reduce((s, n, i) => s + dist(node(path[i]), node(n)) / edgeV(path[i], n), 0);

// insert a new node on segment a-b at the projection of p, keeping direction
function splitEdge(p, a, b, type) {
  const A = node(a), B = node(b), dx = B.x - A.x, dy = B.y - A.y, L = dx * dx + dy * dy;
  const k = L ? Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / L)) : 0;
  const r = v => Math.round(v * 100) / 100;
  const dir = edgeDir(a, b), v = (S.edges.find(e => samePair(e, a, b)) || {}).v, id = addNode(r(A.x + k * dx), r(A.y + k * dy), type);
  setEdge(a, b, 'none'); setEdge(a, id, dir, v); setEdge(id, b, dir, v);
  return id;
}

// Dijkstra on directed edges, O(n²): fine for ACS-sized maps. `avoid` = node ids not to pass through.
function shortest(src, dst, avoid) {
  const D = {}, prev = {}, done = new Set();
  S.nodes.forEach(n => D[n.id] = Infinity); D[src] = 0;
  for (;;) {
    let u = null;
    for (const n of S.nodes) if (!done.has(n.id) && D[n.id] < Infinity && (u === null || D[n.id] < D[u])) u = n.id;
    if (u === null || u === dst) break;
    done.add(u);
    for (const e of S.edges) if (e.a === u && !(avoid && avoid.has(e.b) && e.b !== dst)) {
      const nd = D[u] + dist(node(u), node(e.b));
      if (nd < D[e.b]) { D[e.b] = nd; prev[e.b] = u; }
    }
  }
  if (!(D[dst] < Infinity)) return null;
  const path = [dst]; while (path[0] !== src) path.unshift(prev[path[0]]);
  return { path, len: D[dst] };
}

// nodes a 대기 포지션 checks: everything reachable along path arrows within `ahead` hops (hop count per node).
// `back` = the node the AMR came from; the zone never looks back through it.
function waitZone(id, back) {
  const k = Math.max(1, Math.round(node(id).ahead || 1)), hop = new Map([[id, 0]]), edges = [];
  let frontier = [id];
  for (let d = 1; d <= k && frontier.length; d++) {
    const next = [];
    for (const u of frontier) for (const e of S.edges) if (e.a === u && e.b !== back && !hop.has(e.b)) { hop.set(e.b, d); edges.push(e); next.push(e.b); }
    frontier = next;
  }
  hop.delete(id);
  return { hop, edges };
}

// ---- route diagnosis ----
const hasOut = id => S.edges.some(e => e.a === id);
const hasIn = id => S.edges.some(e => e.b === id);
// AMR can drive in but not out (or out but not in): typical one-way branch into a station/charger
const isDeadEnd = id => hasOut(id) !== hasIn(id) || ((node(id).type === 'charger' || node(id).type === 'wait') && !hasOut(id));
function whyNoPath(a, b) {
  if (!hasOut(a)) return `${nameOf(a)}에서 나가는 경로가 없습니다.`;
  if (!hasIn(b)) return `${nameOf(b)}(으)로 들어가는 경로가 없습니다.`;
  return `${nameOf(a)}에서 ${nameOf(b)}(으)로 가는 방향의 경로가 없습니다. 단방향 화살표 방향을 확인하세요.`;
}
// full message for a job route charger → prov → recv → charger, naming the broken leg
function routeError(h, p, r) {
  const leg = [[h, p], [p, r], [r, h]].find(([a, b]) => !shortest(a, b));
  return `경로 없음: ${nameOf(h)} → ${nameOf(p)} → ${nameOf(r)} → ${nameOf(h)}\n\n` +
    `끊긴 구간: ${nameOf(leg[0])} → ${nameOf(leg[1])}\n원인: ${whyNoPath(leg[0], leg[1])}\n\n` +
    '스테이션·충전소로 들어가는 분기 경로는 양방향이어야 AMR이 들어갔다 나올 수 있습니다.\n' +
    '경로를 클릭하고 "양방향" 버튼을 누르세요. 막힌 노드는 캔버스에 빨간 점선 원으로 표시됩니다.';
}

function setBg(url) {
  S.bg = url || null; bgImg = null;
  if (S.bg) { const img = new Image(); img.onload = () => bgImg = img; img.src = S.bg; }
}
