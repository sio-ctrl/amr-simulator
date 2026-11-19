// Canvas editing: drag & drop palette, move nodes, draw paths/links, resize map, pan/zoom, selection.
let drag = null;   // {kind:'node'|'edge'|'link'|'resize'|'pan', ...}
let mouseM = null; // cursor position in meters (status bar)
let tool = 'select';

function hitNode(p) {
  let best = null, bd = 13 / view.sc;
  for (const n of S.nodes) { const d = dist(n, p); if (d < bd) { bd = d; best = n; } }
  return best;
}
function hitSeg(list, p) {
  const tol = 6 / view.sc;
  return list.find(e => {
    const a = node(e.a), b = node(e.b), dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const k = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    return Math.hypot(p.x - a.x - k * dx, p.y - a.y - k * dy) < tol;
  });
}
const hitEdge = p => hitSeg(S.edges, p);
// the active tool's line kind wins, then paths, C/V, links
function hitLine(p) {
  const order = { link: ['link', 'edge', 'cv'], cv: ['cv', 'edge', 'link'] }[tool] || ['edge', 'cv', 'link'];
  const lists = { edge: S.edges, cv: S.cvs, link: S.links };
  for (const kind of order) { const h = hitSeg(lists[kind], p); if (h) return { kind, a: h.a, b: h.b }; }
  return null;
}
function hitHandle(ev) {
  const r = cv.getBoundingClientRect(), [X1, Y1] = toPx(S.mapW, S.mapH);
  return !sim && Math.abs(ev.clientX - r.left - X1) < 10 && Math.abs(ev.clientY - r.top - Y1) < 10;
}
function snap(p) {
  const g = +document.getElementById('snap').value || 0, c = v => g ? Math.round(v / g) * g : Math.round(v * 100) / 100;
  return { x: Math.max(0, Math.min(S.mapW, c(p.x))), y: Math.max(0, Math.min(S.mapH, c(p.y))) };
}
function select(s) { sel = s; renderProps(); }
function deleteSelected() {
  if (!sel) return;
  if (sel.kind === 'node') deleteNode(sel.id);
  else if (sel.kind === 'edge') setEdge(sel.a, sel.b, 'none');
  else if (sel.kind === 'cv') S.cvs = S.cvs.filter(c => c !== findCv(sel.a, sel.b));
  else S.links = S.links.filter(l => l !== findLink(sel.a, sel.b));
  sel = null; edited();
}
function setTool(t) {
  tool = t;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
}
function tryLink(a, b) {
  const na = node(a), nb = node(b);
  if (findLink(a, b)) return true;
  if (isLinePair(na, nb)) { alert('라인 공급 → 라인 회수는 스테이션 연결이 아니라 C/V 연결로 이어야 합니다.\n"C/V 연결 (C)" 도구로 라인 공급에서 라인 회수 쪽으로 드래그하세요.'); return false; }
  if (!isStation(na.type) || !isStation(nb.type) || !linkOK(na, nb)) {
    alert(`연결 불가: ${na.name} ↔ ${nb.name}\n공급 가능(제품 공급·라인 회수·겸용) ↔ 수신 가능(제품 회수·라인 공급·겸용) 이어야 하고, 한쪽은 라인 스테이션이어야 합니다.`);
    return false;
  }
  S.links.push({ a, b });
  return true;
}
function tryCv(a, b) {
  if (!isSlot(node(a).type) || !isSlot(node(b).type)) {
    alert('C/V 연결은 C/V 또는 스테이션끼리만 가능합니다.');
    return false;
  }
  if (node(a).type === 'lineOut' && node(b).type === 'lineIn') [a, b] = [b, a]; // line always flows 공급 → 회수
  setCv(a, b); // replaces a's old downstream and b's old upstream
  return { a, b };
}

// --- mouse ---
cv.addEventListener('mousedown', ev => {
  if (ev.button !== 0) return;
  const p = toM(ev), n = hitNode(p);
  if (hitHandle(ev)) { drag = { kind: 'resize' }; view.frozen = true; return; }
  if (n) {
    select({ kind: 'node', id: n.id });
    drag = tool === 'link' || tool === 'cv' ? { kind: tool, from: n.id, cur: p }
      : (tool === 'edge' || ev.shiftKey) ? { kind: 'edge', from: n.id, cur: p }
      : { kind: 'node', n, moved: false };
    return;
  }
  const line = hitLine(p);
  if (line) { select(line); return; }
  select(null);
  drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, px: view.panX, py: view.panY };
});

cv.addEventListener('mousemove', ev => {
  mouseM = toM(ev);
  if (!drag) cv.style.cursor = hitHandle(ev) ? 'nwse-resize' : hitNode(mouseM) ? (tool === 'select' ? 'move' : 'crosshair') : hitLine(mouseM) ? 'pointer' : 'grab';
});
cv.addEventListener('mouseleave', () => mouseM = null);

window.addEventListener('mousemove', ev => {
  if (!drag) return;
  const p = toM(ev);
  if (drag.kind === 'node') { Object.assign(drag.n, snap(p)); drag.moved = true; if (sim) { sim = null; running = false; } renderProps(); }
  else if (drag.kind === 'edge' || drag.kind === 'link' || drag.kind === 'cv') drag.cur = p;
  else if (drag.kind === 'resize') {
    const g = +document.getElementById('snap').value || 1;
    S.mapW = Math.max(5, Math.round(p.x / g) * g); S.mapH = Math.max(5, Math.round(p.y / g) * g);
    syncInputs();
  }
  else if (drag.kind === 'pan') { view.panX = drag.px + ev.clientX - drag.sx; view.panY = drag.py + ev.clientY - drag.sy; cv.style.cursor = 'grabbing'; }
});

window.addEventListener('mouseup', ev => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.kind === 'node' && d.moved) edited();
  else if (d.kind === 'resize') {
    view.frozen = false;
    S.nodes.forEach(n => { n.x = Math.min(n.x, S.mapW); n.y = Math.min(n.y, S.mapH); }); // keep nodes inside
    edited();
  }
  else if (d.kind === 'edge' || d.kind === 'link' || d.kind === 'cv') {
    const t = hitNode(toM(ev));
    if (!t || t.id === d.from) return;
    if (d.kind === 'edge') {
      if (edgeDir(d.from, t.id) === 'none') setEdge(d.from, t.id, document.getElementById('biDir').checked ? 'bi' : 'ab');
      select({ kind: 'edge', a: d.from, b: t.id });
    } else if (d.kind === 'cv') { const c = tryCv(d.from, t.id); if (c) select({ kind: 'cv', ...c }); }
    else if (tryLink(d.from, t.id)) select({ kind: 'link', a: d.from, b: t.id });
    edited();
  }
});

cv.addEventListener('wheel', ev => {
  ev.preventDefault();
  const before = toM(ev);
  view.zoom = Math.max(0.2, Math.min(20, view.zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
  updateView();
  const [px, py] = toPx(before.x, before.y), r = cv.getBoundingClientRect();
  view.panX += ev.clientX - r.left - px; view.panY += ev.clientY - r.top - py;
}, { passive: false });

cv.addEventListener('contextmenu', ev => { // right-click = delete
  ev.preventDefault();
  const p = toM(ev), n = hitNode(p), line = !n && hitLine(p);
  if (n) select({ kind: 'node', id: n.id }); else if (line) select(line); else return;
  deleteSelected();
});

cv.addEventListener('dblclick', ev => {
  if (hitNode(toM(ev))) { const f = document.getElementById('propName'); f && (f.focus(), f.select()); }
});

document.addEventListener('keydown', ev => {
  if (/INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
  const k = ev.key.toLowerCase();
  if (k === 'delete' || k === 'backspace') deleteSelected();
  else if (k === 'escape') { select(null); setTool('select'); }
  else if (k === 'e') setTool(tool === 'edge' ? 'select' : 'edge');
  else if (k === 'l') setTool(tool === 'link' ? 'select' : 'link');
  else if (k === 'c') setTool(tool === 'cv' ? 'select' : 'cv');
});

// --- drag & drop: palette → canvas, image/JSON files → canvas ---
document.querySelectorAll('.pal').forEach(el => {
  const T = TYPES[el.dataset.type];
  el.style.background = T.color;
  el.title = T.act ? `${T.label}: ${T.act}` : T.label;
  el.addEventListener('dragstart', ev => {
    ev.dataTransfer.setData('text/plain', 'node:' + el.dataset.type);
    ev.dataTransfer.effectAllowed = 'copy';
  });
});
cv.addEventListener('dragover', ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; mouseM = toM(ev); });
cv.addEventListener('drop', ev => {
  ev.preventDefault();
  const f = ev.dataTransfer.files[0];
  if (f) {
    if (f.type.startsWith('image/')) readBgFile(f);
    else if (f.name.toLowerCase().endsWith('.json')) loadJsonFile(f);
    return;
  }
  const t = ev.dataTransfer.getData('text/plain');
  if (!t.startsWith('node:')) return;
  const type = t.slice(5), p = toM(ev);
  if (!TYPES[type] || p.x < 0 || p.y < 0 || p.x > S.mapW || p.y > S.mapH) return;
  const n = hitNode(p), e = !n && type !== 'cv' && hitEdge(p); // C/V is not on the AMR path
  let id;
  if (n) { setType(n, type); id = n.id; }                 // drop on node → change type
  else if (e) id = splitEdge(p, e.a, e.b, type);           // drop on path → insert into path
  else { const q = snap(p); id = addNode(q.x, q.y, type); }
  sel = { kind: 'node', id };
  edited();
});

// --- property panel ---
// what this slot does with a pallet, given its C/V connections
function slotHint(n) {
  const T = TYPES[n.type], up = cvUp(n.id), down = cvDown(n.id), out = [];
  if (isStation(n.type) && !onPath(n.id)) out.push('AMR 경로에 연결 안 됨 → C/V 칸으로만 동작 (AMR Load/Unload·요청 없음)');
  if (up != null) out.push(`상류 C/V ${nameOf(up)}에서 Pallet 유입`);
  else if (GEN[n.type]) out.push(node(cvEnd(n.id)).type === 'src'
    ? `제품 공급 C/V 시작: 라인 공급이 비면 ${n.t}s 후 Pallet 감지 (필요한 만큼만 투입)`
    : `상류 C/V 없음 → 비면 ${n.t}s 후 Pallet 투입`);
  const after = down != null ? `${nameOf(down)}(으)로 C/V 이송`
    : n.type === 'lineOut' ? '제품 소진 → AMR 회수 요청'
    : T.prov ? (T.line ? 'AMR 회수 요청' : 'AMR Load 대기')
    : n.type === 'lineIn' ? '라인에서 제품 소진 → 비면 공급 요청 (C/V로 라인 회수에 연결하면 소진은 라인 회수에서)'
    : 'Pallet 배출 (사라짐)';
  if (up != null || !GEN[n.type]) out.push(`도착 후 ${n.t}s 경과 → ${after}`);
  else out.push(`감지 후 → ${after}`);
  if (T.buf) return [up != null ? `상류 ${nameOf(up)}에서 Pallet 유입` : `버퍼 시작: 비면 AMR Unload (${T.buf === 'in' ? '끝단부터 한 칸씩 제품 감지를 확인해 빈 칸이 있으면 하나씩 공급 요청 (이동 중인 Pallet이 자리 잡은 뒤 다음 요청), 라인 공급 요청이 먼저' : '라인 회수 Pallet 받음, 꽉 차면 라인 회수는 제품 회수로 직행'})`,
    down != null ? `${n.t}s 후 ${nameOf(down)}(으)로 C/V 이송` : `버퍼 끝: ${n.t}s 후 ${T.buf === 'in' ? '연결된 라인 공급에 AMR Load (제품 공급보다 우선)' : '회수 요청 → AMR이 제품 회수로 이송'}`,
    '라인 지정: "생산 라인" 입력 (A1 = 라인 A1 전용, A = 라인 A 전체), 또는 스테이션 연결 도구로 라인과 연결 (버퍼 C/V의 아무 블록이나 가능)'].join('<br>');
  if (T.recv) out.push('비어 있으면 AMR Unload 가능' + (T.line ? ' (공급 요청)' : ''));
  return out.join('<br>');
}
const esc =s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// same type AND same meaning of t (a 라인 회수 port = 소진 시간, a 라인 회수 block off the path = C/V 이송 시간)
const sameKind = n => S.nodes.filter(x => x.type === n.type && tLabelOf(x) === tLabelOf(n));
function renderProps() {
  const box = document.getElementById('props');
  if (sel && sel.kind === 'node' && node(sel.id)) {
    const n = node(sel.id), T = TYPES[n.type];
    box.innerHTML = `
      <label>이름 <input id="propName" value="${esc(n.name)}"></label>
      <label>종류 <select id="propType">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === n.type ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      ${T.act ? `<div class="hint">AMR 동작: ${T.act}</div>` : ''}
      ${n.type === 'wait' ? `<label>앞쪽 확인 노드 수 (개) <input type="number" id="propAhead" min="1" step="1" value="${n.ahead}"></label>
        <div>확인 범위: ${[...waitZone(n.id).hop].map(([id, d]) => `${nameOf(id)}(${d})`).join(', ') || '<span style="color:#ff6b6b">나가는 경로 없음</span>'}</div>
        <div class="hint">AMR이 이 노드에 도착하면, 노란 띠(앞쪽 ${n.ahead}개 노드 범위, 분기 포함) 안에 다른 AMR(위치 또는 선점)이 있는 동안 출발하지 않음. 비면 범위 안 자기 경로를 한 번에 선점하고 진입.<br>다가오는 AMR은 대기 포지션 너머를 미리 선점하지 않음 (뒤에서 대기). 온 방향은 확인하지 않음.<br>시뮬레이션 중 띠 빨강 = 범위 안에 AMR 있음, 초록 = 비어 있음.<br>협소 구간을 빠져나오는 경로는 이 대기 노드를 지나지 않게 그려야 서로 막히지 않음.</div>` : ''}
      ${isSlot(n.type) ? `<label>${tLabelOf(n)} <input type="number" id="propT" min="0" step="1" value="${n.t}"></label>
        <button id="propTAll">모든 ${T.label}에 ${tLabelOf(n).replace(/ \(s\)/, '')} ${n.t}s 적용 (${sameKind(n).length}개)</button>
        <label>시작 시 제품 있음 <input type="checkbox" id="propInit" ${n.init ? 'checked' : ''}></label>
        <div class="hint">${slotHint(n)}</div>` : ''}
      ${T.line || T.buf ? `<label>생산 라인 <input id="propGroup" list="groupList" value="${esc(n.group || '')}" placeholder="예: A, A1"></label>
        <datalist id="groupList">${LINE_GROUPS.map(g => `<option value="${g}">`).join('')}</datalist>
        <div class="hint">${T.buf ? '"A1" → 라인 A1만 사용, "A" → 라인 A, A1, A2… 모두 사용 (버퍼 C/V의 아무 블록에 지정)' : '"A1" → 버퍼 A1·A 사용, "A" → 버퍼 A·A1·A2… 모두 사용'}</div>` : ''}
      ${T.line || T.buf ? `<div class="hint">상대 스테이션: ${linkedTo(n.id).length ? '연결됨 ' : '자동 '}${partnersOf(n.id).map(nameOf).join(', ') || '없음'}</div>` : ''}
      <label>X (m) <input type="number" id="propX" step="0.1" value="${n.x}"></label>
      <label>Y (m) <input type="number" id="propY" step="0.1" value="${n.y}"></label>
      <button id="propDel">삭제 (Del)</button>`;
    box.querySelector('#propName').onchange = e => { if (e.target.value.trim()) { n.name = e.target.value.trim(); edited(); } };
    box.querySelector('#propType').onchange = e => { setType(n, e.target.value); edited(); };
    const pt = box.querySelector('#propT');
    if (pt) pt.onchange = e => { const v = +e.target.value; if (v >= 0) { n.t = v; edited(); } };
    const pta = box.querySelector('#propTAll');
    if (pta) pta.onclick = () => { sameKind(n).forEach(x => x.t = n.t); edited(); };
    const pa = box.querySelector('#propAhead');
    if (pa) pa.onchange = e => { const v = Math.round(+e.target.value); if (v >= 1) { n.ahead = v; edited(); } };
    const pg = box.querySelector('#propGroup');
    if (pg) pg.onchange = e => { const g = e.target.value.trim().toUpperCase(); if (g) n.group = g; else delete n.group; edited(); };
    const pi = box.querySelector('#propInit');
    if (pi) pi.onchange = e => { n.init = e.target.checked; edited(); };
    box.querySelector('#propX').onchange = e => { n.x = Math.max(0, Math.min(S.mapW, +e.target.value)); edited(); };
    box.querySelector('#propY').onchange = e => { n.y = Math.max(0, Math.min(S.mapH, +e.target.value)); edited(); };
    box.querySelector('#propDel').onclick = deleteSelected;
  } else if (sel && sel.kind === 'edge' && edgeDir(sel.a, sel.b) !== 'none') {
    const { a, b } = sel, dir = edgeDir(a, b), len = dist(node(a), node(b));
    const label = { bi: `${nameOf(a)} ⇄ ${nameOf(b)}`, ab: `${nameOf(a)} → ${nameOf(b)}`, ba: `${nameOf(b)} → ${nameOf(a)}` }[dir];
    const ev = (S.edges.find(e => samePair(e, a, b)) || {}).v;
    box.innerHTML = `<div>주행 경로 ${label} &nbsp; <span class="hint">${len.toFixed(2)} m · ${(len / edgeV(...(hasEdge(a, b) ? [a, b] : [b, a]))).toFixed(1)} s</span></div>
      <label>구간 속도 (m/s) <input type="number" id="edgeV" min="0" step="0.1" value="${ev || ''}" placeholder="기본 ${S.params.speed}"></label>
      <div class="hint">속도를 높여도 되는 구간(사람 없는 직선 등)에만 입력. 비우면 기본 주행 속도.</div>
      <button data-dir="bi">양방향</button><button data-dir="ab">${nameOf(a)}→${nameOf(b)}</button><button data-dir="ba">${nameOf(b)}→${nameOf(a)}</button>
      <button data-dir="none">삭제 (Del)</button>`;
    box.querySelector('#edgeV').onchange = e => {
      const v = +e.target.value;
      for (const x of S.edges) if (samePair(x, a, b)) { if (v > 0) x.v = v; else delete x.v; }
      edited();
    };
    box.querySelectorAll('[data-dir]').forEach(btn => btn.onclick = () => {
      setEdge(a, b, btn.dataset.dir);
      if (btn.dataset.dir === 'none') sel = null;
      edited();
    });
  } else if (sel && sel.kind === 'cv' && findCv(sel.a, sel.b)) {
    const c = findCv(sel.a, sel.b);
    box.innerHTML = `<div>C/V 연결 ${nameOf(c.a)} → ${nameOf(c.b)}</div>
      <div class="hint">${nameOf(c.a)}의 시간이 지나면 ${nameOf(c.b)}가 비어 있을 때 Pallet이 이동.</div>
      <button id="cvRev">방향 반전</button><button id="propDel">삭제 (Del)</button>`;
    box.querySelector('#cvRev').onclick = () => { setCv(c.b, c.a); sel = { kind: 'cv', a: c.b, b: c.a }; edited(); };
    box.querySelector('#propDel').onclick = deleteSelected;
  } else if (sel && sel.kind === 'link' && findLink(sel.a, sel.b)) {
    const na = node(sel.a), nb = node(sel.b), d = linkDir(na, nb);
    box.innerHTML = `<div>스테이션 연결 ${d ? `${nameOf(d[0])} → ${nameOf(d[1])}` : `${na.name} ⇄ ${nb.name}`}</div>
      <div class="hint">${d ? `${nameOf(d[0])}에서 Load → ${nameOf(d[1])}에 Unload` : '양쪽 모두 공급/수신 가능 (상태에 따라 방향 결정)'}</div>
      <button id="propDel">삭제 (Del)</button>`;
    box.querySelector('#propDel').onclick = deleteSelected;
  } else {
    box.innerHTML = '<span class="hint">노드, 주행 경로, 스테이션 연결을 클릭하면 속성이 표시됩니다.</span>';
  }
}
