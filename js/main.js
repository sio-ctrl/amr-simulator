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
if (location.hash === '#test') selfTest();
requestAnimationFrame(frame);
