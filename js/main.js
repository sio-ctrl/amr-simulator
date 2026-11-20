// Boot + animation loop. Loaded last.
let lastTs = performance.now(), frameN = 0;
function frame(ts) {
  if (running && sim) {
    runTo(sim, Math.min(sim.end, sim.t + Math.min(0.1, (ts - lastTs) / 1000) * S.params.simSpeed));
    if (sim.t >= sim.end - 1e-9) { running = false; showResults(); }
    else if (++frameN % 30 === 0) showResults();
  }
  lastTs = ts; draw(); updateStatus(); requestAnimationFrame(frame);
}

S = loadDefault();
applyState();
setTool('select');
// share link: index.html?layout=settings/amr_layout.json opens that layout (needs http(s), e.g. GitHub Pages; file:// blocks fetch)
const shared = new URLSearchParams(location.search).get('layout');
if (shared) fetch(shared).then(r => { if (!r.ok) throw new Error(r.status + ' ' + shared); loadJsonFile(r); })
  .catch(e => alert('공유 레이아웃을 불러오지 못했습니다: ' + e.message));
if (location.hash === '#test') selfTest();
requestAnimationFrame(frame);
