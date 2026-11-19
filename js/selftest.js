// Open index.html#test → result in the tab title. Uses the factory default layout.
function selfTest() {
  const saved = S;
  S = normalize(clone(window.DEFAULT_CONFIG));
  const r = {};
  // 1 AMR: no traffic → every job equals its theoretical CT
  S.params.amrCount = 1; S.params.simHours = 2;
  const s1 = newSim(); runTo(s1, s1.end);
  r.exact = s1.cycles.length > 0 && s1.cycles.every(c => c.block === 0 && c.pwait === 0 && Math.abs(c.ct - c.lead - theoryCT(c.from, c.pr, c.rc, null, c.docked)) < 0.3)
    && s1.cycles.some(c => !c.docked); // chained: some jobs start where the last one ended, not at the charger
  // 3 AMRs: never share a node (current node and edge target must be reserved by itself)
  S.params.amrCount = Math.min(3, S.nodes.filter(n => n.type === 'charger').length);
  const s3 = newSim(); let overlap = false;
  while (s3.t < s3.end - 1e-9) {
    stepSim(s3, 0.1);
    for (const a of s3.amrs) if (s3.locks[a.at] !== a.id || (a.edge && s3.locks[a.edge.to] !== a.id)) overlap = true;
  }
  r.noOverlap = !overlap;
  r.more = s3.cycles.length > s1.cycles.length;
  // every line station type got its requests served
  r.requests = ['lineIn', 'lineOut', 'lineIO'].every(t => Object.values(s3.st).filter(s => s.type === t).every(s => s.n > 0));
  // C/V flow: supply line feeds PS end, LI → C/V → LO, return line discharges at its end
  const byType = t => Object.values(s3.st).filter(s => s.type === t);
  const head = Object.values(s3.st).find(s => s.type === 'cv' && s.up == null && s.down != null);
  const tail = Object.values(s3.st).find(s => s.type === 'cv' && s.down == null && s.up != null);
  const lo = byType('lineOut').find(s => s.up != null);
  r.cvFlow = !!head && head.out > 0 && byType('src').every(s => s.out > 0) && !!lo && lo.n > 0 && !!tail && tail.out > 0;
  // backpressure: LO waiting for AMR + C/V full → LI keeps its pallet and does not request supply
  const sb0 = newSim(), li0 = Object.values(sb0.st).find(s => s.type === 'lineIn' && s.down != null);
  for (let s = li0; s; s = s.down != null ? sb0.st[s.down] : null) { s.has = true; s.done = true; s.timer = null; }
  stepStations(sb0, 0.1);
  r.backpressure = li0.has && li0.reqT == null;
  // pull supply: no empty 라인 공급 → supply C/V feeds nothing; one empty → exactly one pallet reaches PS end
  const sp = newSim(), ps = S.nodes.find(x => x.type === 'src' && cvUp(x.id) != null).id, hd = sp.st[sp.chains[ps].at(-1)];
  const recvs = Object.values(sp.st).filter(s => TYPES[s.type].line && TYPES[s.type].recv);
  recvs.forEach(s => s.res = -1);
  hd.feed = null; // newSim already started feeding for the empty 라인 공급 at t=0
  const run =sec => { for (let i = 0; i < sec * 10; i++) { stepStations(sp, 0.1); sp.t += 0.1; } };
  run(600);
  const idleOk = hd.fed === 0 && pipeline(sp, ps) === 0;
  recvs.find(s => sp.partners[s.id].includes(ps)).res = null;
  run(600);
  r.pullSupply = idleOk && hd.fed === 1 && pipeline(sp, ps) === 1 && sp.st[ps].has && sp.st[ps].done;
  // C/V lines built from station blocks: supply line = 제품 공급 blocks, return line = 제품 회수 blocks.
  // Only the block on the AMR path is the Load/Unload port; the return line carries the pallet away and it disappears.
  const keepNodes = clone(S.nodes), alB = window.alert; let msgB = ''; window.alert = m => { msgB = m; };
  for (const n of S.nodes) if (n.type === 'cv') {
    if (node(cvEnd(n.id)).type === 'src') n.type = 'src';
    else if (node(cvEnd(n.id)).type === 'lineOut') n.type = 'lineIn';   // 라인 공급 → 라인 공급(C/V 블록) → 라인 회수
    else { let u = n.id; while (cvUp(u) != null && node(u).type !== 'sink') u = cvUp(u); if (node(u).type === 'sink') n.type = 'sink'; }
  }
  const sc = newSim(); if (sc) runTo(sc, sc.end);
  const scTail = sc && Object.values(sc.st).find(s => s.type === 'sink' && s.down == null && s.up != null);
  r.stationBlocks = !!sc && !msgB && Object.values(sc.st).filter(s => TYPES[s.type].line && s.port).every(s => s.n > 0) && !!scTail && scTail.out > 0;
  // 라인 공급 → 라인 회수 C/V is optional, a driving path between them is just a path,
  // and an old 라인 공급–라인 회수 station link is dropped on load instead of blocking the run
  S.nodes = clone(keepNodes); msgB = '';
  const liPort = S.nodes.find(n => n.type === 'lineIn' && onPath(n.id)), loPort = S.nodes.find(n => n.type === 'lineOut' && onPath(n.id));
  const keepCvs = S.cvs, keepEdges = S.edges;
  S.cvs = S.cvs.filter(c => c.a !== liPort.id);
  S.edges = S.edges.concat([{ a: liPort.id, b: loPort.id }, { a: loPort.id, b: liPort.id }]);
  const oldLayout = normalize({ ...clone(S), links: [{ a: loPort.id, b: liPort.id }] });
  const sl = newSim(); if (sl) runTo(sl, sl.end);
  r.lineOptional = !!sl && !msgB && sl.st[liPort.id].n > 0 && sl.st[loPort.id].n > 0 && oldLayout.links.length === 0;
  S.edges = keepEdges; S.cvs = keepCvs;
  S.nodes = keepNodes; window.alert = alB;
  // one-way branch into a station: the error names the broken leg and the cause, and the node is a dead end
  const psNode = S.nodes.find(n => n.type === 'src' && onPath(n.id)), keepE = S.edges; msgB = ''; window.alert = m => { msgB = m; };
  S.edges = S.edges.filter(e => e.a !== psNode.id); // keep only the edge INTO PS
  r.routeDiag = !newSim() && msgB.includes(`끊긴 구간: ${psNode.name} →`) && msgB.includes(`${psNode.name}에서 나가는 경로가 없습니다`) && isDeadEnd(psNode.id);
  S.edges = keepE; window.alert = alB;
  r.noFalseDeadEnds = S.nodes.filter(n => n.type === 'path' || n.type === 'charger' || onPath(n.id)).every(n => !isDeadEnd(n.id));
  // reversed C/V into 제품 공급 is caught before the run
  const keepCv = S.cvs, al0 = window.alert; let msg = ''; window.alert = m => { msg = m; };
  S.cvs = keepCv.map(c => c.b === ps ? { a: ps, b: c.a } : c);
  r.cvDirection = !newSim() && msg.includes('방향');
  S.cvs = keepCv; window.alert = al0;
  // conveyor: 1100 mm pallet at 0.3 m/s
  r.xfer = Math.abs(xferT() - (S.params.palletL + S.params.xferMargin) / 1000 / S.params.rollerSpeed) < 1e-9 && s1.cycles.every(c => Math.abs(c.xfer - 2 * xferT()) < 1e-6);
  // links are optional: with none, every line station is auto-matched and served
  const keepLinks = S.links; S.links = [];
  const sa = newSim(); if (sa) runTo(sa, sa.end);
  r.autoMatch = !!sa && Object.values(sa.st).filter(s => TYPES[s.type].line).every(s => s.n > 0);
  // a linked 제품 공급 is dedicated to its link; unlinked lines don't use it
  const src = S.nodes.find(x => x.type === 'src'), io = S.nodes.find(x => x.type === 'lineIO'), li = S.nodes.find(x => x.type === 'lineIn');
  S.links = [{ a: src.id, b: io.id }];
  r.dedicated = partnersOf(io.id).join() === String(src.id) && !partnersOf(li.id).includes(src.id);
  S.links = keepLinks;
  // editing helpers: split keeps connectivity and direction
  const e = S.edges.find(x => !hasEdge(x.b, x.a)), id = splitEdge({ x: 0, y: 0 }, e.a, e.b, 'path');
  r.split = hasEdge(e.a, id) && hasEdge(id, e.b) && !hasEdge(e.a, e.b) && !hasEdge(id, e.a);
  // link rules
  const n = t => ({ id: Math.random(), type: t });
  r.linkRules = linkOK(n('src'), n('lineIn')) && linkOK(n('lineOut'), n('sink')) && linkOK(n('lineIO'), n('lineIO'))
    && !linkOK(n('lineOut'), n('lineIn')) && !linkOK(n('lineIn'), n('lineOut')) // line pair = C/V only
    && !linkOK(n('src'), n('sink')) && !linkOK(n('lineIn'), n('sink')) && !linkOK(n('src'), n('lineOut'));
  // 제품 공급 queue: end detected + 1 queued pallet + 2 supply requests → 2 AMRs dispatched at once;
  // the 2nd waits exactly lookAhead nodes before 제품 공급, holding nothing past that point, then loads the next pallet
  S = normalize(clone(window.DEFAULT_CONFIG)); S.params.amrCount = 2;
  const sq = newSim(), psq = S.nodes.find(n => n.type === 'src' && onPath(n.id)).id, cvq = cvUp(psq);
  for (const id of [psq, cvq]) Object.assign(sq.st[id], { has: true, done: true, timer: null, feed: null });
  scanRequests(sq, 0); dispatch(sq);
  const both = queueOf(sq, psq).length === 2;
  let sawWait = false, posOK = true;
  for (let i = 0; i < 9000 && sq.cycles.length < 2; i++) {
    stepSim(sq, 0.1);
    for (const m of sq.amrs) if (m.cat === 'pwait') {
      sawWait = true;
      const path = m.plan[m.si].path;
      if (path.length - 1 - m.pi !== Math.min(S.params.lookAhead, path.length - 1)) posOK = false;
      if (Object.keys(sq.locks).some(k => sq.locks[k] === m.id && path.indexOf(+k) > m.pi)) posOK = false;
    }
  }
  r.supplyQueue = both && sawWait && posOK && sq.cycles.length >= 2 && sq.deadlocks === 0;
  // 제품 회수 queue: 2 line returns ready, PR1's C/V has room → 2 AMRs dispatched to PR1 at once, both Unload, no deadlock
  S = normalize(clone(window.DEFAULT_CONFIG)); S.params.amrCount = 2;
  const sk = newSim(), prq = S.nodes.find(n => n.type === 'sink' && onPath(n.id)).id;
  for (const s of Object.values(sk.st).filter(s => s.type === 'lineOut' || s.type === 'lineIO').filter(s => s.port))
    Object.assign(s, { has: true, done: true, timer: null });
  scanRequests(sk, 0); dispatch(sk);
  const both2 = queueOf(sk, prq).length === 2 && slotsFree(sk, prq) >= 2;
  const out0 = sk.st[prq].out; let sawQ = false;
  for (let i = 0; i < 20000 && sk.st[prq].out < out0 + 2; i++) { stepSim(sk, 0.1); if (sk.amrs.some(m => m.phase.startsWith('회수 대기'))) sawQ = true; }
  r.sinkQueue = both2 && sk.st[prq].out >= out0 + 2 && sk.deadlocks === 0 && queueOf(sk, prq).length === 0;
  // 대기 포지션: AMR at W holds while any of the next `ahead` nodes on its route has another AMR
  S = normalize(clone(window.DEFAULT_CONFIG));
  const wId = splitEdge({ x: 7.5, y: 10 }, 1, 3, 'wait'); // upper lane N1 → W → N3 → N5 → N7 → N9 → N11
  const sw = newSim(), aw = sw.amrs[0];
  delete sw.locks[aw.home]; aw.at = wId; sw.locks[wId] = aw.id;
  aw.plan = [{ type: 'move', path: [wId, 3, 5, 7, 9, 11], len: 0, label: 'test' }]; aw.si = 0; aw.pi = 0; aw.wt = 0; aw.edge = null;
  aw.cyc = { travel: 0, block: 0 };
  sw.locks[7] = 2;                         // another AMR 3 nodes ahead
  node(wId).ahead = 3; stepAmr(sw, aw, 0.1);
  // displayed zone covers the 3 nodes this AMR checks (plus branches it could take), never beyond 3 hops
  const wz = waitZone(wId).hop;
  r.waitZone = wz.get(3) === 1 && wz.get(5) === 2 && wz.get(7) === 3 && !wz.has(9) && Math.max(...wz.values()) === 3;
  const held = !aw.edge && aw.at === wId && aw.cat === 'block' && sw.locks[3] !== aw.id;
  node(wId).ahead = 2; stepAmr(sw, aw, 0.1); // only 2 checked → N3, N5 free → goes
  r.waitNode = held && (aw.edge != null || aw.at !== wId) && sw.locks[7] === 2;
  // an AMR on a BRANCH inside the zone (docked at PS1, not on this AMR's route) also holds it
  const resetAt = () => { for (const k in sw.locks) if (sw.locks[k] === aw.id) delete sw.locks[k]; aw.at = wId; aw.pi = 0; aw.edge = null; sw.locks[wId] = aw.id; };
  resetAt(); delete sw.locks[7]; sw.locks[18] = 2; node(wId).ahead = 2;
  stepAmr(sw, aw, 0.1);
  r.waitBranch = !aw.edge && aw.at === wId && aw.cat === 'block';
  delete sw.locks[18];
  // approaching AMR reserves only up to the 대기 포지션, nothing beyond it
  resetAt(); delete sw.locks[wId]; aw.at = 1; sw.locks[1] = aw.id;
  aw.plan = [{ type: 'move', path: [1, wId, 3, 5, 7], len: 0, label: 'test' }]; aw.pi = 0;
  reserveAhead(sw, aw, aw.plan[0].path);
  r.waitLookAheadStops = sw.locks[wId] === aw.id && sw.locks[3] !== aw.id;
  // full run: a BASIC lane node turned into 대기 포지션 → never more than one AMR inside its zone
  S = normalize(clone(window.DEFAULT_CONFIG)); S.params.simHours = 2;
  setType(node(1), 'wait'); node(1).ahead = 3;   // N1, in front of the PS1/PR1 branches
  const zw = [...waitZone(1, 2).hop.keys()], sf = newSim(); let maxIn = 0, holds = 0;
  while (sf.t < sf.end - 1e-9) {
    stepSim(sf, 0.1);
    maxIn = Math.max(maxIn, new Set(zw.map(n => sf.locks[n]).filter(Boolean)).size);
    if (sf.amrs.some(m => m.phase.startsWith('대기 포지션'))) holds++;
  }
  r.waitFullRun = sf.cycles.length > 0 && sf.deadlocks === 0 && maxIn <= 1 && holds > 0;
  // regressions: an AMR must never wait inside a two-way spur / on its junction while another is inside
  // (선점 1 used to deadlock at N3; 3-node spurs used to deadlock inside the spur)
  const runNoStall = (amr, L, longSpurs) => {
    S = normalize(clone(window.DEFAULT_CONFIG)); S.params.amrCount = amr; S.params.lookAhead = L; S.params.simHours = 2; S.params.speed = 1; // 50-cycle bar assumes 1 m/s
    if (longSpurs) for (const st of S.nodes.filter(n => isStation(n.type) && onPath(n.id))) {
      const lane = S.edges.find(x => x.a === st.id).b, m1 = splitEdge({ x: st.x, y: st.y + 1.5 }, st.id, lane, 'path');
      splitEdge({ x: st.x, y: st.y + 3.5 }, m1, lane, 'path');
    }
    const s = newSim(); let worst = 0; const stuck = {};
    while (s.t < s.end - 1e-9) {
      stepSim(s, 0.1);
      for (const a of s.amrs) { stuck[a.id] = a.plan && !a.edge && (a.cat === 'block' || a.cat === 'pwait') ? (stuck[a.id] || 0) + 0.1 : 0; worst = Math.max(worst, stuck[a.id]); }
    }
    return s.cycles.length > 50 && s.deadlocks === 0 && worst < 300;
  };
  r.noStallL1 = runNoStall(3, 1, false);
  r.noStallLongSpurs = runNoStall(3, 3, true);
  // AMRs waiting on each other in a circle are flagged and counted once
  // (the old end-to-end case, 대기 포지션 on PS1's only exit, can't deadlock any more: a docked AMR holds that entry node)
  S = normalize(clone(window.DEFAULT_CONFIG));
  const sd = newSim(); sd.amrs[0].waitOn = 2; sd.amrs[1].waitOn = 1; detectDeadlock(sd); detectDeadlock(sd);
  r.deadlockDetected = sd.deadlocks === 1 && sd.amrs[0].inDL && sd.amrs[1].inDL && !sd.amrs[2].inDL;
  // 대기 포지션 placed ON the branch junction (only exit of PS1) is reported before the run
  S = normalize(clone(window.DEFAULT_CONFIG)); setType(node(3), 'wait');
  const cf = window.confirm; let cmsg = ''; window.confirm = m => { cmsg = m; return false; };
  r.waitTrapWarn = !newSim() && cmsg.includes('PS1에서 나오는 길');
  setType(node(3), 'path'); setType(node(1), 'wait'); cmsg = '';
  r.waitNoFalseWarn = !!newSim() && !cmsg;
  window.confirm = cf;
  // battery: ≤ minBat gets no mission; 6h run 100→0, 2h charge 0→100
  const sb = newSim();
  Object.values(sb.st).filter(s => s.type === 'src').forEach(s => { s.has = true; s.done = true; }); // something to dispatch
  sb.amrs.forEach(a => a.bat = S.params.minBat); dispatch(sb);
  const none = sb.amrs.every(a => !a.plan);
  sb.amrs.forEach(a => a.bat = S.params.minBat + 0.5); dispatch(sb);
  r.batThreshold = none && sb.amrs.some(a => a.plan);
  // once at/below minBat: charges up to chargeTo before taking missions again
  const ac = sb.amrs.find(m => !m.plan); S.params.chargeTo = 50;
  ac.bat = S.params.minBat; stepAmr(sb, ac, 0.1);
  const lowLock = ac.charging; ac.bat = 45; stepAmr(sb, ac, 0.1);
  const stillLocked = !freeAmr(ac); ac.bat = 49.99; stepAmr(sb, ac, 60);
  r.chargeTo = lowLock && stillLocked && !ac.charging && freeAmr(ac);
  const a = sb.amrs[0];
  a.plan = [{ type: 'wait', cat: 'xfer', t: 1e9, label: 'test' }]; a.si = 0; a.wt = 0; a.bat = 100; a.cyc = { xfer: 0 };
  stepAmr(sb, a, 3600);
  const after1h = a.bat;
  a.plan = null; a.bat = 0; stepAmr(sb, a, 3600);
  r.batRates = Math.abs(after1h - (100 - 100 / 6)) < 1e-6 && Math.abs(a.bat - 50) < 1e-6;
  // buffers (linked to LI1 / LO1 by any block): 공급 버퍼 serves LI1 and is refilled from PS1 only when no line waits;
  // 회수 버퍼 takes LO1 returns, its end goes to PR1; LO1 → PR1 directly only while the 회수 버퍼 is full
  S = normalize(clone(window.DEFAULT_CONFIG)); S.params.simHours = 4; S.params.speed = 1;
  const bi1 = addNode(25, 17, 'bufIn'), bc = addNode(27.5, 18, 'cv'), bi2 = addNode(30, 17, 'bufIn');
  const bo1 = addNode(35, 17, 'bufOut'), boc = addNode(36.5, 18, 'cv'), bo2 = addNode(38, 17, 'bufOut');
  setCv(bi1, bc); setCv(bc, bi2); setCv(bo1, boc); setCv(boc, bo2);
  setEdge(bi1, 10, 'bi'); setEdge(bi2, 12, 'bi'); setEdge(bo1, 14, 'bi'); setEdge(bo2, 14, 'bi');
  const bLi = S.nodes.find(x => x.name === 'LI1').id, bLo = S.nodes.find(x => x.name === 'LO1').id;
  S.links.push({ a: bLi, b: bi1 }, { a: bLo, b: bo2 });
  const sbf = newSim(), bSeen = new Set(), bJobs = {}; let bBad = 0;
  while (sbf.t < sbf.end - 1e-9) {
    stepSim(sbf, 0.1);
    for (const m of sbf.amrs) if (m.cyc && !bSeen.has(m.cyc)) {
      bSeen.add(m.cyc); const k = `${m.cyc.pr}>${m.cyc.rc}`; bJobs[k] = (bJobs[k] || 0) + 1;
      if (m.cyc.rc === bi1 && Object.values(sbf.st).some(s => TYPES[s.type].line && s.port && recvReady(s) && s.res == null)) bBad++;
      if (m.cyc.pr === bLo && m.cyc.rc !== bo1 && [bo1, boc, bo2].some(id => !sbf.st[id].has)) bBad++;
    }
  }
  const bj = (p, q) => bJobs[`${p}>${q}`] > 0, bPs = S.nodes.find(x => x.name === 'PS1').id, bPr = S.nodes.find(x => x.name === 'PR1').id;
  r.buffers = !bBad && sbf.deadlocks === 0 && bj(bPs, bi1) && bj(bi2, bLi) && bj(bLo, bo1) && bj(bo2, bPr)
    && linkOK(node(bLi), node(bi1)) && !linkOK(node(bLi), node(bo1)) && !linkOK(node(bLo), node(bi1));
  // 공급 버퍼 calls one pallet at a time, checking from its end backwards
  const [h, m, t] = [bi1, bc, bi2].map(id => sbf.st[id]), set = (x, has, done) => Object.assign(x, { has, done, res: null });
  const call = (...st) => { [h, m, t].forEach((x, i) => set(x, ...st[i])); return bufCall(sbf, h); };
  r.bufCall = call([0, 0], [0, 0], [0, 0]) && call([0, 0], [0, 0], [1, 1]) && call([0, 0], [1, 1], [1, 1])
    && !call([0, 0], [1, 0], [1, 1])          // a pallet still moving into place → wait
    && !call([1, 0], [0, 0], [1, 1])          // just unloaded at the start → wait
    && !call([1, 1], [1, 1], [1, 1])          // full
    && (set(h, 0, 0), set(m, 0, 0), set(t, 0, 0), h.res = 9, !bufCall(sbf, h)); // an AMR is already bringing one
  // same matching by 생산 라인 instead of links; a line of another group doesn't get the buffer
  S.links = []; node(bLi).group = node(bLo).group = node(bi1).group = node(bo2).group = 'A';
  const bLx = S.nodes.find(x => x.name === 'LX1'); bLx.group = 'B';
  r.bufferGroups = partnersOf(bLi).includes(bi2) && partnersOf(bLo).includes(bo1) && !partnersOf(bLx.id).some(isBuf)
    && partnersOf(bi1).includes(bPs) && partnersOf(bo2).includes(bPr) && !!newSim()
  // 회수 버퍼 "A" serves lines A1 and A2; 공급 버퍼 "A1" serves A1 only (not A2, not A10)
    && (node(bLi).group = 'A1', node(bLo).group = 'A2', node(bi1).group = 'A1', node(bo2).group = 'A', true)
    && partnersOf(bLi).includes(bi2) && partnersOf(bLo).includes(bo1)
    && (node(bLi).group = 'A2', !partnersOf(bLi).includes(bi2)) && (node(bLi).group = 'A10', !partnersOf(bLi).includes(bi2))
    && groupMatch('A3', 'A') && groupMatch('a', 'A2') && groupMatch('a1', 'A1') && !groupMatch('B1', 'A') && !groupMatch('A1', 'A2') && !!newSim();
  // payload: product heavier than AMR payload → sim refuses to start
  const al = window.alert; window.alert = () => {};
  // 휴식: line consumption pauses (5h production → 1h break), C/V transfer doesn't
  S.params.productKg = S.params.payload - 1; S.params.prodH = 5; S.params.breakH = 1;
  const sbk = newSim(), bkLo = Object.values(sbk.st).find(s => s.type === 'lineOut' && s.port), bkCv = Object.values(sbk.st).find(s => s.type === 'cv');
  bkLo.timer = bkCv.timer = 100; sbk.t = 5.5 * 3600; stepStations(sbk, 1);
  const paused = bkLo.timer === 100 && bkCv.timer === 99;
  sbk.t = 6.5 * 3600; stepStations(sbk, 1);
  r.breakTime = paused && bkLo.timer === 99 && onBreak(5 * 3600) && !onBreak(6 * 3600) && onBreak(11.5 * 3600);
  S.params.productKg = S.params.payload + 1; r.payload = !newSim();
  window.alert = al;
  const ok = Object.values(r).every(Boolean);
  console.assert(ok, r);
  document.title = ok ? `SELFTEST PASS 1amr=${s1.cycles.length} ${S.params.amrCount}amr=${s3.cycles.length} reroute=${s3.reroutes} dl=${s3.deadlocks}`
    : 'SELFTEST FAIL ' + Object.entries(r).filter(([, v]) => !v).map(([k]) => k).join(',');
  S = saved;
}
