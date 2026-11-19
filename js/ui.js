// Side panel: settings, station links, results, save/load.
const $ = id => document.getElementById(id);
const fmtT = s => { s = Math.round(s); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const f1 = v => v.toFixed(1);

// any layout/param change invalidates the running simulation
function edited() {
  sim = null; running = false;
  $('xferInfo').textContent = S.params.rollerSpeed > 0 ? `${f1(xferT())} s` : '-';
  renderLinks(); renderProps(); showResults();
}

function applyState() {
  syncInputs(); setBg(S.bg); sel = null;
  view.zoom = 1; view.panX = view.panY = 0;
  edited();
}

function syncInputs() {
  $('mapW').value = S.mapW; $('mapH').value = S.mapH;
  document.querySelectorAll('[data-k]').forEach(el => el.value = S.params[el.dataset.k]);
}

// --- params / map ---
document.querySelectorAll('[data-k]').forEach(el => el.oninput = () => {
  const v = parseFloat(el.value); if (!(v >= 0)) return;
  S.params[el.dataset.k] = ['amrCount', 'lookAhead'].includes(el.dataset.k) ? Math.round(v) : v;
  if (el.dataset.k !== 'simSpeed') edited();
});
$('mapW').onchange = () => { const v = +$('mapW').value; if (v >= 5) { S.mapW = v; edited(); } };
$('mapH').onchange = () => { const v = +$('mapH').value; if (v >= 5) { S.mapH = v; edited(); } };
function readBgFile(f) { const r = new FileReader(); r.onload = () => setBg(r.result); r.readAsDataURL(f); }
$('bgFile').onchange = e => { if (e.target.files[0]) readBgFile(e.target.files[0]); e.target.value = ''; };
$('bgClear').onclick = () => setBg(null);
$('btnFit').onclick = () => { view.zoom = 1; view.panX = view.panY = 0; };
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));

// --- station links list ---
function renderLinks() {
  const home = S.nodes.find(n => n.type === 'charger');
  const linked = S.links.map((l, i) => {
    const d = linkDir(node(l.a), node(l.b)), [p, r] = d || [l.a, l.b], th = home ? theoryCT(home.id, p, r) : null;
    return `<tr><td>${i + 1}</td><td>${nameOf(p)} ${d ? '→' : '⇄'} ${nameOf(r)}</td><td>${th == null ? '경로없음' : f1(th) + 's'}</td><td><button data-del="${i}">✕</button></td></tr>`;
  });
  const auto = S.nodes.filter(n => TYPES[n.type].line && onPath(n.id) && !linkedTo(n.id).some(y => !isBuf(y))).map(n => {
    const ps = partnersOf(n.id);
    const home = S.nodes.find(c => c.type === 'charger');
    const broken = home && ps.find(y => { const d = linkDir(n, node(y)); return d && theoryCT(home.id, d[0], d[1]) == null; });
    return `<tr><td>자동</td><td>${n.name} ↔ ${ps.length ? ps.map(nameOf).join(', ') : '<span style="color:#ff6b6b">상대 없음</span>'}</td>
      <td>${broken ? '<span style="color:#ff6b6b">경로없음</span>' : ''}</td><td></td></tr>`;
  });
  $('links').tBodies[0].innerHTML = linked.concat(auto).join('') || '<tr><td colspan="4" class="hint">라인 스테이션을 배치하세요.</td></tr>';
}
$('links').onclick = e => { if (e.target.dataset.del != null) { S.links.splice(+e.target.dataset.del, 1); sel = null; edited(); } };

// --- status / results ---
const pendingCount = () => sim ? Object.values(sim.st).filter(s => s.reqT != null && s.res == null).length : 0;
function updateStatus() {
  const pos = mouseM ? `  |  커서 (${f1(mouseM.x)}, ${f1(mouseM.y)}) m` : '';
  if (!sim) {
    const st = S.nodes.filter(n => isStation(n.type)).length, ch = S.nodes.filter(n => n.type === 'charger').length;
    $('status').textContent = `편집 중  |  노드 ${S.nodes.length}  경로 ${S.edges.length}  충전소 ${ch}  스테이션 ${st}  C/V 연결 ${S.cvs.length}  스테이션 연결 ${S.links.length}  |  도구: ${{ select: '선택·이동', edge: '경로 그리기', link: '스테이션 연결', cv: 'C/V 연결' }[tool]}  |  줌 ${(view.zoom * 100).toFixed(0)}%${pos}`;
    return;
  }
  const dl = sim.amrs.filter(a => a.inDL).map(a => `AMR${a.id}(${nameOf(a.at)})`);
  $('status').textContent = `${running ? '▶ 실행 중' : '⏸ 정지'}  |  시뮬 시간 ${fmtT(sim.t)} / ${fmtT(sim.end)}${onBreak(sim.t) ? ' (휴식 중)' : ''}  |  완료 작업 ${sim.cycles.length}  |  대기 요청 ${pendingCount()}` +
    (dl.length ? `  |  ⚠ 교착: ${dl.join(' → ')} 서로 대기 중` : '') + pos;
}

function stationState(s) {
  const T = TYPES[s.type];
  let t = s.has ? '제품 있음' : '비어 있음';
  if (s.timer != null) t += ` · ${tLabelOf(node(s.id)).replace(/ \(s\)/, '')} ${Math.ceil(s.timer)}s`;
  else if (s.feed != null) t += ` · Pallet 투입 ${Math.ceil(s.feed)}s`;
  else if (s.has && s.done && s.down != null) t += ` · <span style="color:#ffa726">${nameOf(s.down)} 비기를 대기</span>`;
  if (s.res != null) t += ' · 배차됨';
  else if (s.reqT != null) t += ` · <span style="color:#ff6b6b">요청 ${Math.round(sim.t - s.reqT)}s</span> <span class="hint">(${whyOf(sim, s)})</span>`;
  return t;
}

function summaryHtml() {
  const c = sim.cycles, n = c.length, avg = k => n ? c.reduce((s, x) => s + x[k], 0) / n : 0;
  const hrs = sim.t / 3600, ct = c.map(x => x.ct), sts = Object.values(sim.st);
  const reqN = sts.reduce((s, x) => s + x.n, 0), reqAvg = reqN ? sts.reduce((s, x) => s + x.sum, 0) / reqN : 0, reqMax = Math.max(0, ...sts.map(x => x.max));
  const util = sim.t ? sim.amrs.reduce((s, a) => s + a.busy, 0) / sim.amrs.length / sim.t * 100 : 0;
  let h = `<div class="kpi">
    <div>완료 작업<b>${n}</b></div>
    <div>처리량 (작업/h)<b>${hrs ? f1(n / hrs) : '-'}</b></div>
    <div>평균 CT<b>${n ? f1(avg('ct')) + 's' : '-'}</b></div>
    <div>최소 / 최대 CT<b>${n ? f1(Math.min(...ct)) + ' / ' + f1(Math.max(...ct)) + 's' : '-'}</b></div>
    <div>요청 응답 평균 / 최대<b>${reqN ? f1(reqAvg) + ' / ' + f1(reqMax) + 's' : '-'}</b></div>
    <div>AMR 평균 가동률<b>${f1(util)}%</b></div>
    <div>대기 요청<b>${pendingCount()}</b></div>
    <div>우회 / 교착<b>${sim.reroutes} / ${sim.deadlocks}</b></div></div>`;
  h += '<table><tr><th>CT 평균 구성</th>' + Object.values(CAT).map(v => `<th>${v}</th>`).join('') + '</tr><tr><td>초 (비율)</td>' +
    Object.keys(CAT).map(k => `<td>${f1(avg(k))} (${n ? (avg(k) / avg('ct') * 100).toFixed(0) : 0}%)</td>`).join('') + '</tr></table><br>';
  h += '<table><tr><th>AMR</th><th>충전소</th><th>위치</th><th>상태</th><th>배터리</th><th>작업</th><th>가동률</th></tr>' + sim.amrs.map(a =>
    `<tr><td><span style="color:${amrColor(a.id)}">■</span> AMR${a.id}</td><td>${nameOf(a.home)}</td><td>${nameOf(a.edge ? a.edge.to : a.at)}</td><td>${a.inDL ? '<span style="color:#ff6b6b">⚠ 교착 · </span>' : ''}${a.phase}</td>
     <td>${f1(a.bat)}%</td><td>${a.jobs}</td><td>${sim.t ? f1(a.busy / sim.t * 100) : 0}%</td></tr>`).join('') + '</table><br>';
  h += '<table><tr><th>스테이션 / C/V</th><th>종류</th><th>처리 요청</th><th>평균 응답 (s)</th><th>최대 응답 (s)</th><th>통과 Pallet</th><th>현재 상태</th></tr>' + sts.map(s =>
    `<tr><td>${nameOf(s.id)}</td><td>${TYPES[s.type].label}</td><td>${TYPES[s.type].line ? s.n : '-'}</td><td>${s.n ? f1(s.sum / s.n) : '-'}</td><td>${s.n ? f1(s.max) : '-'}</td><td>${s.out}</td><td>${stationState(s)}</td></tr>`).join('') + '</table>';
  return h;
}

const logRow = (x, i) => `<tr><td>${i}</td><td>AMR${x.amr}</td><td>${x.job}</td><td>${fmtT(x.start)}</td><td>${fmtT(x.end)}</td><td>${f1(x.ct)}</td>` +
  Object.keys(CAT).map(k => `<td>${f1(x[k])}</td>`).join('') + '</tr>';
$('logTable').tHead.innerHTML = '<tr><th>#</th><th>AMR</th><th>작업</th><th>시작</th><th>종료</th><th>CT (s)</th>' + Object.values(CAT).map(v => `<th>${v}</th>`).join('') + '</tr>';

function showResults() {
  const sum = $('summary'), tb = $('logTable').tBodies[0];
  if (!sim) {
    sum.innerHTML = '<span class="hint">시뮬레이션을 실행하면 결과가 여기에 표시됩니다.</span>';
    tb.innerHTML = ''; tb.dataset.sim = '';
    return;
  }
  const keep = sum.scrollTop; sum.innerHTML = summaryHtml(); sum.scrollTop = keep;
  // cycle log: append only, so the scroll position never jumps
  if (tb.dataset.sim !== String(sim.id)) { tb.innerHTML = ''; tb.dataset.sim = sim.id; sim.logged = 0; }
  if (sim.logged < sim.cycles.length) {
    tb.insertAdjacentHTML('beforeend', sim.cycles.slice(sim.logged).map((x, i) => logRow(x, sim.logged + i + 1)).join(''));
    sim.logged = sim.cycles.length;
  }
}

// --- simulation buttons ---
$('btnRun').onclick = () => { if (!sim || sim.t >= sim.end) sim = newSim(); if (sim) { running = true; select(null); } };
$('btnPause').onclick = () => { running = false; showResults(); };
$('btnReset').onclick = () => edited();
$('btnInstant').onclick = () => { if (!sim || sim.t >= sim.end) sim = newSim(); if (!sim) return; running = false; runTo(sim, sim.end); showResults(); };

// --- save / load ---
// Chrome/Edge: save dialog (folder + name, last folder remembered via `id`). Others: plain download to the Downloads folder.
async function download(name, text, type) {
  if (window.showSaveFilePicker) {
    try {
      const ext = name.slice(name.lastIndexOf('.'));
      const h = await showSaveFilePicker({ id: 'amr-save', suggestedName: name, types: [{ description: ext, accept: { [type]: [ext] } }] });
      const w = await h.createWritable(); await w.write(text); await w.close();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user cancelled
      console.warn('저장 대화상자 사용 불가, 일반 다운로드로 저장:', e);
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
}
function loadJsonFile(f) {
  f.text().then(t => {
    try { S = normalize(JSON.parse(t)); applyState(); }
    catch (err) { alert('레이아웃 파일 오류: ' + err.message); }
  });
}
$('btnSaveDefault').onclick = () => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); alert('기본 설정으로 저장했습니다. 다음 실행부터 이 설정으로 시작합니다.'); }
  catch (e) { alert('저장 실패 (배경 도면이 너무 크면 용량 초과일 수 있음): ' + e.message); }
};
$('btnLoadDefault').onclick = () => { if (confirm('현재 편집 내용을 버리고 기본 설정을 불러올까요?')) { S = loadDefault(); applyState(); } };
$('btnFactory').onclick = () => {
  if (!confirm('브라우저에 저장된 기본 설정을 지우고 공장 기본값(js/config/default-config.js)으로 되돌릴까요?')) return;
  try { localStorage.removeItem(STORE_KEY); } catch (e) { /* storage blocked: nothing to remove */ }
  S = normalize(clone(window.DEFAULT_CONFIG)); applyState();
};
$('btnExportDefault').onclick = () => download('default-config.js',
  `// js/config/default-config.js 를 이 파일로 교체하면 공장 기본값이 됨\nwindow.DEFAULT_CONFIG = ${JSON.stringify(S, null, 1)};\n`, 'text/javascript');
$('btnSave').onclick = () => download('amr_layout.json', JSON.stringify(S, null, 1), 'application/json');
// status bar = splitter: drag to resize the results panel, double-click to collapse/restore (canvas follows each frame)
{
  const bar = $('status'), res = $('results'), KEY = 'amr.resultsH';
  const setH = h => { res.style.flexBasis = Math.max(0, Math.min(h, innerHeight - 120)) + 'px'; };
  let last = null;
  try { const h = localStorage.getItem(KEY); if (h != null) setH(+h); } catch (e) { /* storage blocked: keep CSS default */ }
  const save = () => { try { localStorage.setItem(KEY, res.offsetHeight); } catch (e) { /* not critical */ } };
  bar.title = '드래그: 결과 창 크기 조절 · 더블클릭: 접기/펼치기';
  bar.onpointerdown = e => {
    bar.setPointerCapture(e.pointerId);
    const y0 = e.clientY, h0 = res.offsetHeight;
    bar.onpointermove = m => setH(h0 - (m.clientY - y0));
    bar.onpointerup = () => { bar.onpointermove = bar.onpointerup = null; save(); };
  };
  bar.ondblclick = () => {
    // > 2: the border keeps a collapsed panel at ~1px
    if (res.offsetHeight > 2) { last = res.offsetHeight; setH(0); } else setH(last || innerHeight * 0.38);
    save();
  };
}
$('btnLoad').onclick = () => $('loadFile').click();
$('loadFile').onchange = e => { if (e.target.files[0]) loadJsonFile(e.target.files[0]); e.target.value = ''; };
$('btnCsv').onclick = () => {
  if (!sim || !sim.cycles.length) return alert('결과가 없습니다.');
  const keys = Object.keys(CAT);
  const rows = [['no', 'amr', 'job', 'start_s', 'end_s', 'ct_s', ...keys]].concat(
    sim.cycles.map((x, i) => [i + 1, 'AMR' + x.amr, x.job, f1(x.start), f1(x.end), f1(x.ct), ...keys.map(k => f1(x[k]))]));
  download('amr_cycles.csv', '﻿' + rows.map(r => r.join(',')).join('\n'), 'text/csv');
};
