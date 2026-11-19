// Canvas drawing + view transform (zoom/pan).
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const view = { zoom: 1, panX: 0, panY: 0, sc: 1, ox: 0, oy: 0, frozen: false };
const toPx = (x, y) => [view.ox + x * view.sc, view.oy + y * view.sc];
function toM(ev) {
  const r = cv.getBoundingClientRect();
  return { x: (ev.clientX - r.left - view.ox) / view.sc, y: (ev.clientY - r.top - view.oy) / view.sc };
}
const amrColor = id => AMR_COLOR[(id - 1) % AMR_COLOR.length];

function updateView() {
  if (view.frozen) return; // keep map still while its handle is dragged
  const w = cv.clientWidth, h = cv.clientHeight, pad = 30;
  view.sc = Math.min((w - 2 * pad) / S.mapW, (h - 2 * pad) / S.mapH) * view.zoom;
  view.ox = (w - S.mapW * view.sc) / 2 + view.panX;
  view.oy = (h - S.mapH * view.sc) / 2 + view.panY;
}

function amrPos(a) {
  if (a.edge) {
    const f = node(a.edge.from), t = node(a.edge.to), k = a.edge.len ? a.edge.prog / a.edge.len : 1;
    return { x: f.x + (t.x - f.x) * k, y: f.y + (t.y - f.y) * k };
  }
  return node(a.at);
}

function arrow(x1, y1, x2, y2, at = 0.5) {
  const ang = Math.atan2(y2 - y1, x2 - x1), mx = x1 + (x2 - x1) * at, my = y1 + (y2 - y1) * at, s = 7;
  ctx.beginPath();
  ctx.moveTo(mx + s * Math.cos(ang), my + s * Math.sin(ang));
  ctx.lineTo(mx + s * Math.cos(ang + 2.5), my + s * Math.sin(ang + 2.5));
  ctx.lineTo(mx + s * Math.cos(ang - 2.5), my + s * Math.sin(ang - 2.5));
  ctx.fill();
}

const isSel = (kind, e) => sel && sel.kind === kind && ((e.a === sel.a && e.b === sel.b) || (e.a === sel.b && e.b === sel.a));

function drawStation(n, x, y) {
  const T = TYPES[n.type];
  ctx.fillStyle = T.color; ctx.fillRect(x - 11, y - 11, 22, 22);
  ctx.fillStyle = '#111'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(T.glyph, x, y + 3);
  ctx.fillStyle = '#ccc'; ctx.font = '11px sans-serif'; ctx.fillText(`${n.group ? `[${n.group}] ` : ''}${n.name} · ${n.t}s`, x, y + 25);
  ctx.textAlign = 'left';
  const s = sim && sim.st[n.id];
  if (!s) return;
  const tm = s.timer != null ? s.timer : s.feed;
  if (tm != null && s.T > 0) { // timer progress ring (dashed = feeding a new pallet)
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; if (s.feed != null) ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(x, y, 17, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * (1 - tm / s.T)); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (s.has) { // pallet: white = moving/dwelling or ready, orange = done but next C/V is full
    ctx.fillStyle = s.done && s.down != null ? '#ffa726' : '#fff';
    ctx.fillRect(x + 6, y - 17, 10, 10); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(x + 6, y - 17, 10, 10);
  }
  if (s.res != null) { ctx.strokeStyle = '#2ee6e6'; ctx.lineWidth = 2; ctx.strokeRect(x - 13, y - 13, 26, 26); }
  else if (s.reqT != null) { // open request
    ctx.fillStyle = '#ff3b3b'; ctx.beginPath(); ctx.arc(x - 14, y - 14, 7, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.fillText('!', x - 16, y - 10);
  }
  ctx.lineWidth = 1;
}

function draw() {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  updateView();
  const [X0, Y0] = toPx(0, 0), [X1, Y1] = toPx(S.mapW, S.mapH);

  // map + grid
  ctx.fillStyle = '#191a1f'; ctx.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
  if (bgImg) { ctx.globalAlpha = 0.5; ctx.drawImage(bgImg, X0, Y0, X1 - X0, Y1 - Y0); ctx.globalAlpha = 1; }
  const minor = view.sc >= 6;
  for (let x = 0; x <= S.mapW; x++) {
    if (x % 5 && !minor) continue;
    ctx.strokeStyle = x % 5 ? '#24262c' : '#363944'; const [px] = toPx(x, 0);
    ctx.beginPath(); ctx.moveTo(px, Y0); ctx.lineTo(px, Y1); ctx.stroke();
  }
  for (let y = 0; y <= S.mapH; y++) {
    if (y % 5 && !minor) continue;
    ctx.strokeStyle = y % 5 ? '#24262c' : '#363944'; const [, py] = toPx(0, y);
    ctx.beginPath(); ctx.moveTo(X0, py); ctx.lineTo(X1, py); ctx.stroke();
  }
  ctx.strokeStyle = '#667'; ctx.strokeRect(X0, Y0, X1 - X0, Y1 - Y0);
  ctx.fillStyle = '#667'; ctx.font = '10px sans-serif';
  for (let x = 0; x <= S.mapW; x += 5) ctx.fillText(x + 'm', toPx(x, 0)[0] - 6, Y0 - 6);
  for (let y = 5; y <= S.mapH; y += 5) ctx.fillText(y + 'm', X0 - 26, toPx(0, y)[1] + 3);
  if (!sim) { // resize handle
    ctx.fillStyle = '#8fc1ff'; ctx.fillRect(X1 - 6, Y1 - 6, 12, 12);
    ctx.fillText(`${S.mapW} × ${S.mapH} m`, X1 - 60, Y1 + 18);
  }

  // 대기 포지션 check zones (under the paths): yellow in edit, red = occupied / green = clear during the run
  const zones = S.nodes.filter(n => n.type === 'wait').map(n => ({ n, ...waitZone(n.id) }));
  for (const z of zones) {
    let col = 'rgba(255,213,79,0.30)';
    if (sim) { // red = an AMR is in the zone (others arriving at W must wait), green = clear
      const me = sim.locks[z.n.id];
      col = [...z.hop.keys()].some(id => sim.locks[id] && sim.locks[id] !== me) ? 'rgba(255,80,80,0.40)' : 'rgba(80,220,120,0.30)';
    }
    ctx.strokeStyle = col; ctx.lineWidth = 14; ctx.lineCap = 'round';
    for (const e of z.edges) {
      const [x1, y1] = toPx(node(e.a).x, node(e.a).y), [x2, y2] = toPx(node(e.b).x, node(e.b).y);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.lineCap = 'butt'; ctx.lineWidth = 1;
  }

  // path edges
  for (const e of S.edges) {
    const a = node(e.a), b = node(e.b), bi = hasEdge(e.b, e.a);
    if (bi && e.a > e.b) continue;
    const [x1, y1] = toPx(a.x, a.y), [x2, y2] = toPx(b.x, b.y);
    ctx.lineWidth = isSel('edge', e) ? 6 : 3;
    ctx.strokeStyle = isSel('edge', e) ? '#2ee6e6' : bi ? '#5a6273' : '#4d7aa8';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    if (e.v > 0) { // own speed (usually a faster stretch): green dashes on top + speed label
      ctx.strokeStyle = '#3ecf6e'; ctx.setLineDash([6, 5]); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#7ee2a0'; ctx.font = '10px sans-serif'; ctx.fillText(`${e.v} m/s`, (x1 + x2) / 2 + 4, (y1 + y2) / 2 - 4);
    }
    if (!bi) { ctx.fillStyle = '#8fc1ff'; arrow(x1, y1, x2, y2); }
  }

  // C/V connections (pallet flow)
  for (const c of S.cvs) {
    const a = node(c.a), b = node(c.b), [x1, y1] = toPx(a.x, a.y), [x2, y2] = toPx(b.x, b.y);
    ctx.lineWidth = isSel('cv', c) ? 10 : 7; ctx.strokeStyle = isSel('cv', c) ? '#2ee6e6' : '#6d4c41';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.fillStyle = '#ffcc80'; arrow(x1, y1, x2, y2);
  }
  ctx.lineWidth = 1;

  // station links (logistics, not driving paths)
  ctx.setLineDash([5, 5]);
  for (const l of S.links) {
    const a = node(l.a), b = node(l.b), d = linkDir(a, b), [p, r] = d ? [node(d[0]), node(d[1])] : [a, b];
    const [x1, y1] = toPx(p.x, p.y), [x2, y2] = toPx(r.x, r.y);
    ctx.lineWidth = isSel('link', l) ? 4 : 1.5; ctx.strokeStyle = isSel('link', l) ? '#2ee6e6' : '#c9a0ff';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    if (d) { ctx.fillStyle = '#c9a0ff'; arrow(x1, y1, x2, y2, 0.6); }
  }
  ctx.setLineDash([]); ctx.lineWidth = 1;

  // rubber band while drawing a path / link
  if (drag && (drag.kind === 'edge' || drag.kind === 'link' || drag.kind === 'cv')) {
    const a = node(drag.from), [x1, y1] = toPx(a.x, a.y), [x2, y2] = toPx(drag.cur.x, drag.cur.y);
    ctx.setLineDash([6, 4]); ctx.strokeStyle = { link: '#c9a0ff', cv: '#ffcc80', edge: '#ff0' }[drag.kind]; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = 1;
  }

  // node reservations (look-ahead) in each AMR's color
  if (sim) for (const k in sim.locks) {
    const n = node(+k); if (!n) continue;
    const [x, y] = toPx(n.x, n.y);
    ctx.strokeStyle = amrColor(sim.locks[k]); ctx.lineWidth = 3;
    // stations/chargers are drawn on top and are bigger than a path dot → ring outside them, or a docked AMR's hold is hidden
    ctx.beginPath(); ctx.arc(x, y, n.type === 'path' ? 9 : 14, 0, 7); ctx.stroke(); ctx.lineWidth = 1;
  }

  // nodes
  ctx.font = '11px sans-serif';
  for (const n of S.nodes) {
    const [x, y] = toPx(n.x, n.y);
    if (n.type === 'path') {
      ctx.fillStyle = TYPES.path.color; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
      ctx.fillStyle = '#ccc'; ctx.fillText(n.name, x + 9, y - 8);
    } else if (n.type === 'wait') { // diamond
      ctx.fillStyle = TYPES.wait.color;
      ctx.beginPath(); ctx.moveTo(x, y - 10); ctx.lineTo(x + 10, y); ctx.lineTo(x, y + 10); ctx.lineTo(x - 10, y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#111'; ctx.font = 'bold 9px sans-serif'; ctx.fillText('W', x - 4, y + 3);
      ctx.fillStyle = '#ffd54f'; ctx.font = '11px sans-serif'; ctx.fillText(`${n.name} (앞 ${n.ahead})`, x + 12, y - 8);
    } else if (n.type === 'charger') {
      ctx.fillStyle = TYPES.charger.color; ctx.fillRect(x - 10, y - 10, 20, 20);
      ctx.fillStyle = '#111'; ctx.fillText('⚡', x - 6, y + 4);
      ctx.fillStyle = '#ccc'; ctx.fillText(n.name, x + 13, y + 4);
    } else drawStation(n, x, y);
    if (!sim && (n.type === 'path' || n.type === 'charger' || onPath(n.id)) && isDeadEnd(n.id)) { // can't drive both in and out
      ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(x, y, 15, 0, 7); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
      ctx.fillStyle = '#ff6b6b'; ctx.font = 'bold 10px sans-serif'; ctx.fillText(hasIn(n.id) ? '나가는 경로 없음' : '들어오는 경로 없음', x - 36, y + 38);
      ctx.font = '11px sans-serif';
    }
    if (sel && sel.kind === 'node' && sel.id === n.id) { ctx.strokeStyle = '#2ee6e6'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 18, 0, 7); ctx.stroke(); ctx.lineWidth = 1; }
  }

  // hop numbers of the selected 대기 포지션's zone
  const selZone = sel && sel.kind === 'node' && zones.find(z => z.n.id === sel.id);
  if (selZone) for (const [id, d] of selZone.hop) {
    const [x, y] = toPx(node(id).x, node(id).y);
    ctx.fillStyle = '#ffd54f'; ctx.beginPath(); ctx.arc(x - 14, y + 14, 8, 0, 7); ctx.fill();
    ctx.fillStyle = '#111'; ctx.font = 'bold 10px sans-serif'; ctx.fillText(d, x - 17, y + 18);
  }

  // AMRs: body = phase color, border = AMR color
  if (sim) for (const a of sim.amrs) {
    const p = amrPos(a), [x, y] = toPx(p.x, p.y), r = Math.max(10, 0.45 * view.sc);
    ctx.fillStyle = CAT_COLOR[a.cat]; ctx.strokeStyle = amrColor(a.id); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(x - r, y - r * 0.75, 2 * r, 1.5 * r, 4); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = '#000'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(a.id, x - 3, y + 4);
    if (a.inDL) { ctx.fillStyle = '#ff3b3b'; ctx.font = 'bold 12px sans-serif'; ctx.fillText('⚠ 교착', x - 18, y - r - 4); }
  }

  // legend
  ctx.font = '11px sans-serif'; let lx = 10;
  for (const [k, c] of Object.entries(CAT_COLOR)) {
    ctx.fillStyle = c; ctx.fillRect(lx, h - 16, 10, 10);
    const t = CAT[k] || '충전 대기'; ctx.fillStyle = '#bbb'; ctx.fillText(t, lx + 14, h - 7);
    lx += ctx.measureText(t).width + 30;
  }
  ctx.fillStyle = '#bbb';
  ctx.fillText('□ 제품  ■(주황) 다음 C/V 대기  ◯ 타이머  🔴 요청  ▢ 배차됨  ◯(AMR색) 선점  ━ C/V  ┅ 스테이션 연결', lx + 10, h - 7);
}
