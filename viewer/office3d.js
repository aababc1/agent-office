/* office3d.js — the project floor as one 3D space: 서버실 (sinfo partitions → racks) · 데이터 처리 라인 (plan stages → machines,
   cohorts → crates that change shape per step) · 연구실 (sessions → agents). Data-driven: index.html calls Office3D.mount(el, opts)
   once per container and Office3D.sync(data) on every refresh. three.js r128 is loaded on first use; without WebGL mount() rejects and
   the caller falls back to the 2D floors. Every word on screen is an HTML label projected from 3D (crisp on phones). */
(() => {
'use strict';
const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
const HEX = { ok: '#3fd1b0', bad: '#ef6b6b', acc: '#f0a04b', warn: '#f2c14e', info: '#5fb7e8', purple: '#b48cf2', grey: '#3a4660', muted: '#8fa0bf', ink: '#e8edf7' };
const COL = { ok: 0x3fd1b0, bad: 0xef6b6b, acc: 0xf0a04b, warn: 0xf2c14e, info: 0x5fb7e8, purple: 0xb48cf2, grey: 0x3a4660 };
const FORM_BY_ICON = { dock: 'parcel', unpack: 'open', sieve: 'clean', funnel: 'clean', build: 'contig', bins: 'bins', inspect: 'mag', machine: 'parcel' };
const VERB_BY_ICON = { dock: '포장 도착', unpack: '포장 뜯기', sieve: '체질·세척', funnel: '같은 샘플 합치기', build: '리드 → 컨티그', bins: '유전체별 분류', inspect: '다듬기·검수', machine: '공정' };
const BADGE = { '작업': HEX.ok, '탐색': HEX.info, '터미널': HEX.acc, '생각': HEX.warn, '회의': HEX.purple, '협업': HEX.purple, '보고': HEX.acc, '확인 필요': HEX.bad, '휴식': HEX.muted, '종료': HEX.grey };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmtN = n => Number(n || 0).toLocaleString('en-US');
let threeLoading = null;
function loadThree() { if (window.THREE) return Promise.resolve(); if (threeLoading) return threeLoading;
  threeLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = THREE_URL; s.async = true; s.onload = () => res(); s.onerror = () => { threeLoading = null; rej(new Error('three.js load failed')); }; document.head.appendChild(s); }); return threeLoading; }
function webgl() { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')); } catch (e) { return false; } }

const S = { el: null, opts: {}, renderer: null, scene: null, camera: null, labels: [], labelsEl: null, built: false, agents: new Map(), movers: [], machines: [], clickable: [], dyn: null, cam: { zoom: 1, yaw: Math.PI / 4 + .12, pitch: .74 }, target: null, raf: 0, last: 0, tod: 'night', data: null };
const CSS = `
.o3d{--ls:1;position:relative;background:#0d1420;border-radius:10px;overflow:hidden;height:min(72vh,680px);min-height:380px;font-family:var(--body,"IBM Plex Sans KR","Apple SD Gothic Neo",system-ui,sans-serif);color:#e8edf7}
.o3d canvas{display:block;width:100%;height:100%;touch-action:none}
.o3d .lbls{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.o3d .lbl{position:absolute;left:0;top:0;transform:translate(-50%,-100%);white-space:nowrap;pointer-events:none;will-change:transform;font-size:calc(11px*var(--ls));line-height:1.25}
.o3d .lbl.zone{font:600 calc(14px*var(--ls))/1.2 var(--display,Sora,sans-serif);text-shadow:0 1px 2px #000}.o3d .lbl.zone small{display:block;font:500 calc(10.5px*var(--ls))/1.3 inherit;color:#8fa0bf}
.o3d .lbl.part{background:rgba(13,20,32,.88);border:1px solid #2b3a5c;border-radius:8px;padding:3px 7px;text-align:center}.o3d .lbl.part b{font-weight:600;display:block}.o3d .lbl.part .n{display:block;font-variant-numeric:tabular-nums}
.o3d .lbl.mach{background:rgba(13,20,32,.9);border:1px solid #2b3a5c;border-radius:9px;padding:4px 8px;text-align:center}.o3d .lbl.mach b{font-weight:600;display:block;font-size:calc(12px*var(--ls))}.o3d .lbl.mach .num{font:600 calc(14px*var(--ls)) var(--display,Sora,sans-serif);font-variant-numeric:tabular-nums}.o3d .lbl.mach .num small{font-size:calc(10px*var(--ls));color:#8fa0bf;font-weight:400}
.o3d .lbl.mach .pill{display:inline-block;margin-top:2px;padding:1px 7px;border-radius:999px;font-size:calc(10px*var(--ls));border:1px solid}
.o3d .lbl.crate{font-size:calc(9.5px*var(--ls));color:#ffd9a6;background:rgba(42,35,22,.9);border:1px solid #5a4a2a;border-radius:5px;padding:1px 5px}
.o3d .lbl.step{font-size:calc(10px*var(--ls));color:#cfd8ea;background:rgba(13,20,32,.75);border-radius:999px;padding:1px 7px}
.o3d .lbl.agent{background:rgba(13,20,32,.9);border:1px solid #2b3a5c;border-radius:10px;padding:3px 8px 3px 6px;font-weight:600;text-align:left}.o3d .lbl.agent i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}.o3d .lbl.agent small{font-weight:400;color:#8fa0bf;margin-left:4px}
.o3d .lbl.c{padding:2px 6px!important;line-height:1.3}.o3d.compact .lbl.zone small{display:none}.o3d .lbl.mach.c b{display:inline;font-size:inherit}.o3d .lbl.mach.c .num{font-size:inherit}.o3d .lbl.mach.c .num small{font-size:inherit}.o3d .lbl.mach.c i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:0}.o3d .lbl.part.c b{display:inline}.o3d .lbl.part.c .n{display:inline}
.o3d .lbl.product{background:rgba(13,20,32,.9);border:1px solid #f0a04b;border-radius:9px;padding:4px 8px;text-align:center}.o3d .lbl.product b{display:block;color:#f0a04b;font-weight:600}
.o3d .hud{position:absolute;left:10px;right:10px;top:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;pointer-events:none}
.o3d .kpi{display:flex;gap:6px;flex-wrap:wrap}.o3d .kpi div{background:rgba(21,30,48,.9);border:1px solid #2b3a5c;border-radius:8px;padding:4px 8px;font-size:10.5px;color:#8fa0bf;line-height:1.2}.o3d .kpi b{display:block;font:600 14px var(--display,Sora,sans-serif);color:#e8edf7;font-variant-numeric:tabular-nums}
.o3d .kpi .ok{color:#3fd1b0}.o3d .kpi .bad{color:#ef6b6b}.o3d .kpi .acc{color:#f0a04b}
.o3d .foot{position:absolute;left:10px;right:10px;bottom:8px;display:flex;justify-content:space-between;align-items:flex-end;gap:8px;flex-wrap:wrap;pointer-events:none}
.o3d .legend{display:flex;gap:8px;flex-wrap:wrap;font-size:10.5px;color:#8fa0bf;background:rgba(13,20,32,.8);border:1px solid #2b3a5c;border-radius:8px;padding:4px 8px}.o3d .legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.o3d .tod{display:flex;gap:3px;background:rgba(21,30,48,.9);border:1px solid #2b3a5c;border-radius:8px;padding:3px;pointer-events:auto}.o3d .tod button{background:transparent;color:#8fa0bf;border:0;border-radius:6px;padding:4px 8px;font:500 11px inherit;cursor:pointer}.o3d .tod button[aria-pressed="true"]{background:#f0a04b;color:#1a1206}
.o3d .detail{position:absolute;right:10px;bottom:44px;width:270px;max-width:calc(100% - 20px);background:rgba(21,30,48,.96);border:1px solid #2b3a5c;border-radius:10px;padding:10px 12px;display:none;pointer-events:auto;font-size:12px;color:#8fa0bf;line-height:1.45}
.o3d .detail.on{display:block}.o3d .detail h3{margin:0 0 4px;font:600 13px var(--display,Sora,sans-serif);color:#e8edf7}.o3d .detail .x{position:absolute;right:6px;top:6px;background:transparent;border:0;color:#8fa0bf;font-size:14px;cursor:pointer}
.o3d .detail ul{margin:4px 0 0;padding-left:16px}.o3d .detail b{color:#e8edf7}
@media (max-width:760px){.o3d{height:76vh;min-height:460px}.o3d .lbl.mach{padding:3px 6px}.o3d .lbl.crate{display:none}.o3d .lbl.step{display:none}.o3d .kpi{gap:4px}.o3d .kpi div{padding:3px 6px;font-size:9.5px}.o3d .kpi b{font-size:12px}.o3d .legend{font-size:9px;gap:6px;padding:3px 6px}.o3d .legend .hint{display:none}.o3d .tod button{padding:3px 6px;font-size:10px}.o3d .detail{bottom:40px;font-size:11px}.o3d .kpi div{padding:3px 6px}.o3d .kpi b{font-size:12px}.o3d .legend{font-size:9.5px}}`;

function ensureCss() { if (document.getElementById('o3d-css')) return; const st = document.createElement('style'); st.id = 'o3d-css'; st.textContent = CSS; document.head.appendChild(st); }
const M = (c, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: .82, metalness: .05 }, o));
function box(parent, w, h, d, c, x, y, z, o) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(c, o)); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; }
function label(cls, html, x, y, z, anchor) { const el = document.createElement('div'); el.className = 'lbl ' + cls; el.innerHTML = html; S.labelsEl.appendChild(el); const L = { el, pos: new THREE.Vector3(x, y, z), anchor: anchor || 'translate(-50%,-100%)' }; S.labels.push(L); return L; }
function clearDyn() { if (S.dyn) { S.scene.remove(S.dyn); S.dyn.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.dispose) o.material.dispose(); }); }
  S.dyn = new THREE.Group(); S.scene.add(S.dyn); S.clickable = []; S.machines = []; S.movers = [];
  for (const l of S.labels) if (!l.keep) l.el.remove(); S.labels = S.labels.filter(l => l.keep); }

// ---------- static room (built once)
function buildRoom() {
  const scene = S.scene; const RW = 36, RD = 24; const g = new THREE.Group(); scene.add(g);
  const floor = box(g, RW, .5, RD, 0x1a2338, 0, -.25, 0); floor.castShadow = false;
  const tile = new THREE.PlaneGeometry(1.96, 1.96);
  for (let i = 0; i < RW / 2; i++) for (let j = 0; j < RD / 2; j++) { const m = new THREE.Mesh(tile, M((i + j) % 2 ? 0x1e2a42 : 0x1b2539, { roughness: .95 })); m.rotation.x = -Math.PI / 2; m.position.set(-RW / 2 + 1 + i * 2, .005, -RD / 2 + 1 + j * 2); m.receiveShadow = true; g.add(m); }
  const wb = box(g, RW, 7, .3, 0x1c2740, 0, 3.5, -RD / 2 - .15), wl = box(g, .3, 7, RD, 0x182238, -RW / 2 - .15, 3.5, 0); wb.castShadow = wl.castShadow = false;
  for (const x of [-12, -3, 6]) { const w = box(g, 5.5, 2.6, .12, 0x8fc3ff, x, 4.1, -RD / 2 + .05, { emissive: 0x6aa6ff, emissiveIntensity: .5, roughness: .3 }); w.castShadow = false; w.name = 'window'; }
  for (const z of [-7, 1, 8]) { const w = box(g, .12, 2.6, 4.5, 0x8fc3ff, -RW / 2 + .05, 4.1, z, { emissive: 0x6aa6ff, emissiveIntensity: .5, roughness: .3 }); w.castShadow = false; w.name = 'window'; }
  const plate = (x, z, w, d, c, edge) => { const p = box(g, w, .12, d, c, x, .06, z); p.castShadow = false; const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, .12, d)), new THREE.LineBasicMaterial({ color: edge, transparent: true, opacity: .6 })); e.position.copy(p.position); g.add(e); };
  plate(0, -10.2, 35, 3.2, 0x141c2e, 0x3a4f7a); plate(0, -2.2, 35, 5.2, 0x18213a, 0x4b5a7f); plate(0, 7.4, 35, 8.6, 0x1c2235, 0x5a4a2a);
  const gw = box(g, 35, 3.2, .06, 0x7fb7e8, 0, 1.6, -8.5, { transparent: true, opacity: .1, roughness: .1 }); gw.castShadow = false;
  // belt (texture animated in the loop)
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const cx = c.getContext('2d'); cx.fillStyle = '#2a3448'; cx.fillRect(0, 0, 64, 64); cx.fillStyle = '#1b2334'; cx.fillRect(0, 0, 10, 64); cx.fillStyle = '#3b4a66'; cx.fillRect(28, 0, 4, 64);
  S.beltTex = new THREE.CanvasTexture(c); S.beltTex.wrapS = S.beltTex.wrapT = THREE.RepeatWrapping; S.beltTex.repeat.set(32, 1);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(34, .5, 1.6), new THREE.MeshStandardMaterial({ map: S.beltTex, roughness: .9 })); belt.position.set(0, .25, -0.4); belt.receiveShadow = belt.castShadow = true; g.add(belt);
  for (let x = -16; x < 17; x += 3) box(g, .3, .4, .3, 0x1b2334, x, .2, .5);
  // lab furniture: meeting table, sofa, plants, whiteboard frame (texture set per sync), PI glass office
  const t = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, .08, 24), M(0xa57049)); t.position.set(6.5, .74, 8.8); t.castShadow = true; g.add(t); const leg = new THREE.Mesh(new THREE.CylinderGeometry(.1, .22, .72, 12), M(0x3a2a1f)); leg.position.set(6.5, .36, 8.8); g.add(leg);
  for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + .4; const s = box(g, .44, .08, .44, 0x2a3348, 6.5 + Math.cos(a) * 1.6, .45, 8.8 + Math.sin(a) * 1.6); s.rotation.y = -a; }
  box(g, 2.6, .5, 1.0, 0x2f6f8f, 1.5, .35, 10.6); box(g, 2.6, .6, .3, 0x2f6f8f, 1.5, .8, 11.0);
  for (const [px, pz] of [[16.8, 11.2], [-16.6, 11.2], [17, 3.8], [-16.6, 3.8]]) { box(g, .5, .45, .5, 0x5a3d2b, px, .22, pz); const lv = new THREE.Mesh(new THREE.SphereGeometry(.42, 10, 8), M(0x3fae6a)); lv.position.set(px, .85, pz); lv.scale.y = 1.3; lv.castShadow = true; g.add(lv); }
  S.boardCanvas = document.createElement('canvas'); S.boardCanvas.width = 512; S.boardCanvas.height = 300; S.boardTex = new THREE.CanvasTexture(S.boardCanvas);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.1), new THREE.MeshBasicMaterial({ map: S.boardTex })); board.position.set(-1.2, 1.9, 7.5); board.rotation.y = Math.PI / 2; g.add(board); box(g, .08, 2.3, 3.8, 0x2f3a52, -1.3, 1.9, 7.5); box(g, .1, .8, .1, 0x2f3a52, -1.3, .4, 5.9); box(g, .1, .8, .1, 0x2f3a52, -1.3, .4, 9.1);
  const gl = { transparent: true, opacity: .2, roughness: .1, emissive: 0x1a3a5a, emissiveIntensity: .25 };
  const w1 = box(g, .08, 3.2, 5.4, 0x7fb7e8, 11.6, 1.6, 8.6, gl), w2 = box(g, 5.6, 3.2, .08, 0x7fb7e8, 14.4, 1.6, 5.9, gl); w1.castShadow = w2.castShadow = false;
  box(g, .1, 3.2, .1, 0x3a4660, 11.6, 1.6, 5.9); box(g, .1, 3.2, .1, 0x3a4660, 11.6, 1.6, 11.3); box(g, .1, 3.2, .1, 0x3a4660, 17.2, 1.6, 5.9);
  const pd = desk(g, 14.4, 9.0); pd.rotation.y = Math.PI;
  DESK_SPOTS.forEach(([x, z]) => desk(g, x, z));
  // zone signs: one position for the isometric (wide) view, one for the portrait view where the room's long axis runs down the screen
  S.zones = []; const zl = (h, iso, port) => { const l = label('zone', h, 0, 0, 0); l.keep = true; S.zones.push({ l, iso, port }); };
  zl('서버실<small>랙 = 파티션 · 칸 = 노드</small>', [13.5, 0.2, -7.2, 'translate(-50%,-100%)'], [-17.6, 3.4, -10.3, 'translate(-50%,-100%)']);
  zl('데이터 처리 라인<small>게이지 = 진행률 · 상자 = 다음 코호트</small>', [-17.6, 0.2, 1.6, 'translate(0,-100%)'], [-17.6, 3.0, -0.4, 'translate(-50%,-100%)']);
  zl('연구실<small>책상 = 세션 · 뱃지 = 상태</small>', [-17.6, 0.2, 11.9, 'translate(0,-100%)'], [-17.6, 3.2, 10.0, 'translate(-50%,-100%)']);
  placeZones();
  const pl = label('agent', `<i style="background:${HEX.acc}"></i>PI<small>사무실</small>`, 14.4, 2.2, 7.8); pl.keep = true;
}
function placeZones() { for (const z of (S.zones || [])) { const p = S.portrait ? z.port : z.iso; z.l.pos.set(p[0], p[1], p[2]); z.l.anchor = p[3]; } }
function desk(parent, x, z) { const g = new THREE.Group(); const top = new THREE.Mesh(new THREE.BoxGeometry(1.9, .08, 1.0), M(0xa57049, { roughness: .7 })); top.position.y = .76; g.add(top);
  for (const [lx, lz] of [[-.85, -.4], [.85, -.4], [-.85, .4], [.85, .4]]) { const l = new THREE.Mesh(new THREE.BoxGeometry(.06, .76, .06), M(0x2a3448)); l.position.set(lx, .38, lz); g.add(l); }
  const mon = new THREE.Mesh(new THREE.BoxGeometry(.9, .56, .05), M(0x202838)); mon.position.set(0, 1.12, -.3); g.add(mon); const scr = new THREE.Mesh(new THREE.PlaneGeometry(.82, .48), new THREE.MeshBasicMaterial({ color: 0x3a6fb0 })); scr.position.set(0, 1.12, -.27); scr.name = 'screen'; g.add(scr);
  const st = new THREE.Mesh(new THREE.BoxGeometry(.08, .3, .08), M(0x202838)); st.position.set(0, .9, -.3); g.add(st);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(.5, .08, .5), M(0x2a3348)); seat.position.set(0, .45, 1.0); const back = new THREE.Mesh(new THREE.BoxGeometry(.5, .5, .08), M(0x2a3348)); back.position.set(0, .75, 1.25); const post = new THREE.Mesh(new THREE.CylinderGeometry(.04, .04, .45, 8), M(0x1b2232)); post.position.set(0, .22, 1.0); g.add(seat, back, post);
  g.position.set(x, 0, z); g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); parent.add(g); return g; }

// ---------- dynamic parts (rebuilt on every sync)
function cabinet(x, z, p, zig) {
  const g = new THREE.Group(); const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.6, .9), M(0x1a2236, { roughness: .6, metalness: .2 })); body.position.y = 1.3; body.castShadow = body.receiveShadow = true; g.add(body);
  const states = [].concat(Array(p.ours).fill('acc'), Array(p.others).fill('bad'), Array(p.idle).fill('ok'), Array(p.drained).fill('grey'));
  const n = Math.min(p.total, 8); for (let i = 0; i < n; i++) { const st = states[i] || 'grey'; const b = new THREE.Mesh(new THREE.BoxGeometry(.86, .2, .04), M(COL[st], { emissive: COL[st], emissiveIntensity: st === 'grey' ? .05 : .55, roughness: .4 })); b.position.set(0, .35 + i * .29, .47); if (st === 'acc') b.userData.pulse = true; g.add(b); }
  const cap = new THREE.Mesh(new THREE.BoxGeometry(1.14, .06, .94), M(0x2a3650)); cap.position.y = 2.63; g.add(cap);
  g.position.set(x, 0, z); S.dyn.add(g); g.userData = { kind: 'part', p }; body.userData.ref = g; S.clickable.push(body);
  const avail = p.idle > 0; const col = avail ? HEX.ok : HEX.bad;
  if (S.compact) { label('part c', `<b>${esc(p.name.replace(/^cpu\d+-only-/, '').replace(/-only$/, ''))}</b> <span style="color:${col};font-weight:600">${avail ? p.idle : (p.drained >= p.total ? '점검' : '0')}</span><span style="color:${HEX.muted}">/${p.total}</span>${p.ours ? ` <span style="color:${HEX.acc}">▶${p.ours}</span>` : ''}${p.pending ? ` <span style="color:${HEX.warn}">⏳${p.pending}</span>` : ''}`, x, 2.9, z); return; }
  label('part', `<b>${esc(p.name)}</b><span class="n"><span style="color:${col};font-weight:600">${avail ? p.idle + ' 가능' : (p.drained >= p.total ? '점검' : '사용 중')}</span><span style="color:${HEX.muted}"> / ${p.total}</span>${p.ours ? ` <span style="color:${HEX.acc}">▶${p.ours}</span>` : ''}${p.pending ? ` <span style="color:${HEX.warn}">⏳${p.pending}</span>` : ''}</span>`, x, 2.9 + (zig ? .9 : 0), z);
}
function machine(x, st, zig) {
  const col = { done: 'ok', run: 'acc', wait: 'warn', part: 'acc', bad: 'bad', idle: 'warn', off: 'grey' }[st.state] || 'grey'; const ratio = st.total ? Math.min(1, st.done / st.total) : 0;
  const g = new THREE.Group(); const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.3, 2.2), M(0x2c3750, { roughness: .55, metalness: .15 })); body.position.y = 1.15; body.castShadow = body.receiveShadow = true; g.add(body);
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.7, .1, 2.3), M(0x3d4a68)); top.position.y = 2.33; g.add(top);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.1, .06), M(0x0f1726)); panel.position.set(0, 1.05, 1.12); g.add(panel);
  const track = new THREE.Mesh(new THREE.BoxGeometry(1.7, .28, .04), M(0x232d44)); track.position.set(0, .8, 1.16); g.add(track);
  const fw = Math.max(.05, 1.7 * ratio); const fill = new THREE.Mesh(new THREE.BoxGeometry(fw, .28, .05), M(COL[col], { emissive: COL[col], emissiveIntensity: .5 })); fill.position.set(-.85 + fw / 2, .8, 1.17); g.add(fill);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(.14, 12, 10), M(COL[col], { emissive: COL[col], emissiveIntensity: st.state === 'off' ? .1 : 1 })); lamp.position.set(1.0, 2.45, .8); lamp.userData.pulse = st.running > 0; g.add(lamp);
  if (st.running > 0) { const ch = new THREE.Mesh(new THREE.CylinderGeometry(.18, .22, .7, 10), M(0x1f2940)); ch.position.set(-.8, 2.7, -.5); g.add(ch); g.userData.smoke = []; for (let k = 0; k < 4; k++) { const p = new THREE.Mesh(new THREE.SphereGeometry(.18, 8, 6), new THREE.MeshBasicMaterial({ color: 0x9fb0cc, transparent: true, opacity: .35 })); p.position.set(-.8, 3.1 + k * .5, -.5); p.userData.t = k / 4; g.add(p); g.userData.smoke.push(p); } }
  g.position.set(x, 0, -3.6); S.dyn.add(g); g.userData.stage = st; body.userData.ref = g; S.clickable.push(body); S.machines.push(g);
  const pill = { done: ['완료', HEX.ok], run: [`진행 중${st.nodeJobs ? ' · 잡 ' + st.nodeJobs : ''}`, HEX.acc], part: ['일부 완료', HEX.acc], wait: ['앞 단계 대기', HEX.warn], idle: ['대기', HEX.warn], bad: ['실패', HEX.bad], off: ['미계획', HEX.grey] }[st.state] || ['—', HEX.grey];
  label('step', esc(st.verb), x, .55, .7);
  if (S.compact) { label('mach c', `<i style="background:${pill[1]}"></i><b>${esc(st.name)}</b> <span class="num">${st.total != null ? fmtN(st.done) + '<small>/' + fmtN(st.total) + '</small>' : (st.done ? fmtN(st.done) : '—')}</span>${st.failed ? ` <span style="color:${HEX.bad}">✗${st.failed}</span>` : ''}${st.running > 0 ? ` <span style="color:${HEX.acc}">▶</span>` : ''}`, x, 2.7 + (zig ? .9 : 0), -3.6); return; }
  label('mach', `<b>${esc(st.name)} <span style="font-weight:400;color:${HEX.muted}">${esc(st.ko)}</span></b><span class="num">${st.total != null ? fmtN(st.done) : (st.done ? fmtN(st.done) : '—')} <small>${st.total != null ? '/ ' + fmtN(st.total) : ''}</small></span><br><span class="pill" style="color:${pill[1]};border-color:${pill[1]}">${pill[0]}</span>${st.failed ? ` <span style="color:${HEX.bad};font-size:10px">실패 ${st.failed}</span>` : ''}`, x, 2.7 + (zig ? 1.1 : 0), -3.6);
}
function item(form) {
  const g = new THREE.Group(); const add = (geo, col, x, y, z, o = {}) => { const m = new THREE.Mesh(geo, M(col, o)); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  if (form === 'parcel') { add(new THREE.BoxGeometry(.62, .5, .5), 0x8a6a3a, 0, .25, 0); add(new THREE.BoxGeometry(.64, .52, .1), 0xd9b98a, 0, .25, 0); add(new THREE.BoxGeometry(.1, .52, .52), 0xd9b98a, 0, .25, 0); }
  else if (form === 'open') { add(new THREE.BoxGeometry(.62, .42, .5), 0x8a6a3a, 0, .21, 0); const f1 = add(new THREE.BoxGeometry(.3, .04, .5), 0xa98355, -.3, .44, 0); f1.rotation.z = 1.1; const f2 = add(new THREE.BoxGeometry(.3, .04, .5), 0xa98355, .3, .44, 0); f2.rotation.z = -1.1; for (let k = 0; k < 4; k++) add(new THREE.BoxGeometry(.06, .5, .3), 0x5fb7e8, -.18 + k * .12, .55, 0, { emissive: 0x5fb7e8, emissiveIntensity: .35 }); }
  else if (form === 'clean') { for (let k = 0; k < 5; k++) add(new THREE.BoxGeometry(.08, .55, .34), 0x3fd1b0, -.24 + k * .12, .28, 0, { emissive: 0x3fd1b0, emissiveIntensity: .45, roughness: .3 }); add(new THREE.BoxGeometry(.7, .06, .44), 0x2a3448, 0, .03, 0); }
  else if (form === 'contig') { for (let k = 0; k < 3; k++) add(new THREE.BoxGeometry(.7 - k * .12, .16, .26), 0x7f93b8, (k % 2 ? .06 : -.04), .08 + k * .18, 0, { roughness: .5 }); }
  else if (form === 'bins') { add(new THREE.BoxGeometry(.78, .06, .5), 0x2a3448, 0, .03, 0); [0xf0a04b, 0xb48cf2, 0x5fb7e8].forEach((c, k) => add(new THREE.CylinderGeometry(.1, .09, .34, 12), c, -.25 + k * .25, .23, 0, { emissive: c, emissiveIntensity: .3 })); }
  else { add(new THREE.CylinderGeometry(.22, .26, .12, 16), 0x3a4660, 0, .06, 0); add(new THREE.IcosahedronGeometry(.22, 1), 0xf0a04b, 0, .4, 0, { emissive: 0xf0a04b, emissiveIntensity: .6, roughness: .2, metalness: .3 }); }
  S.dyn.add(g); return g;
}
function agentMesh(color) { const g = new THREE.Group(); const col = new THREE.Color(color);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(.2, .22, .62, 12), M(col.getHex(), { roughness: .6 })); body.position.y = .62; const head = new THREE.Mesh(new THREE.SphereGeometry(.2, 12, 10), M(0xf1d2b6)); head.position.y = 1.18; const hair = new THREE.Mesh(new THREE.SphereGeometry(.21, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), M(0x2b2118)); hair.position.y = 1.2;
  const lL = new THREE.Mesh(new THREE.BoxGeometry(.14, .34, .16), M(0x2a3348)); lL.position.set(-.1, .17, 0); const lR = lL.clone(); lR.position.x = .1; g.add(body, head, hair, lL, lR); g.traverse(o => { if (o.isMesh) o.castShadow = true; }); return { g, body, lL, lR }; }
const DESK_SPOTS = [[-15.5, 4.6], [-12, 4.6], [-8.5, 4.6], [-5, 4.6], [-15.5, 8.4], [-12, 8.4], [-8.5, 8.4], [-5, 8.4], [1.8, 4.6], [5.3, 4.6], [8.8, 4.6], [1.8, 8.4]];
const CORR_Z = 6.6, PI_SPOT = () => new THREE.Vector3(13.8, 0, 8.0), WB_SPOT = () => new THREE.Vector3(0.1, 0, 7.5), MEET = i => { const a = i / 4 * Math.PI * 2 + .4; return new THREE.Vector3(6.5 + Math.cos(a) * 1.6, 0, 8.8 + Math.sin(a) * 1.6); };
function route(from, to) { const p = []; if (Math.abs(from.z - CORR_Z) > .2) p.push(new THREE.Vector3(from.x, 0, CORR_Z)); if (Math.abs(from.x - to.x) > .2) p.push(new THREE.Vector3(to.x, 0, CORR_Z)); p.push(to.clone()); return p; }
function setStatus(A, s) { A.cur = s; A.lab.el.innerHTML = `<i style="background:${BADGE[s] || HEX.muted}"></i>${esc(A.name)}${S.compact ? '' : `<small>${esc(s)}</small>`}`; }
function syncAgents(list) {
  const seen = new Set();
  list.slice(0, DESK_SPOTS.length).forEach((a, i) => { seen.add(a.id); let A = S.agents.get(a.id); const [x, z] = DESK_SPOTS[i];
    if (!A) { const m = agentMesh(a.color); const home = new THREE.Vector3(x, 0, z + 1.0); m.g.position.copy(home); m.g.rotation.y = Math.PI; S.scene.add(m.g);
      const lab = label('agent', '', home.x, 1.75, home.z); lab.keep = true;
      A = { id: a.id, g: m.g, body: m.body, lL: m.lL, lR: m.lR, lab, home, pos: home.clone(), path: [], state: 'desk', t: 0, nextAt: 6 + Math.random() * 10 }; S.agents.set(a.id, A); m.g.userData = { kind: 'agent', a: A }; m.body.userData.ref = m.g; }
    A.name = a.name; A.role = a.role; A.task = a.task; A.status = a.status; A.active = a.active; A.home.set(x, 0, z + 1.0); if (A.state === 'desk') setStatus(A, a.status); S.clickable.push(A.body); });
  for (const [id, A] of S.agents) if (!seen.has(id)) { S.scene.remove(A.g); A.lab.el.remove(); S.labels = S.labels.filter(l => l !== A.lab); S.agents.delete(id); }
}
function pick(A) { if (!A.active) return; const r = Math.random(); const others = [...S.agents.values()].filter(o => o !== A); let to, next;
  if (r < .4 && others.length) { const o = others[Math.floor(Math.random() * others.length)]; to = o.home.clone().add(new THREE.Vector3(.9, 0, 0)); next = '협업'; }
  else if (r < .6) { to = PI_SPOT(); next = '보고'; } else if (r < .8) { to = WB_SPOT(); next = '생각'; } else { to = MEET(Math.floor(Math.random() * 4)); next = '회의'; }
  A.path = route(A.pos, to); A.state = 'walk'; A.next = next; setStatus(A, next); }
function stepAgent(A, dt) { A.t += dt;
  if (A.state === 'walk') { const wp = A.path[0]; if (!wp) { A.state = A.next; A.t = 0; A.stay = 4 + Math.random() * 6; A.g.rotation.y = Math.PI; return; }
    const d = wp.clone().sub(A.pos), len = d.length(); if (len < .05) { A.path.shift(); return; } d.normalize(); A.pos.addScaledVector(d, Math.min(len, 2.0 * dt)); A.g.position.copy(A.pos); A.g.rotation.y = Math.atan2(d.x, d.z); const sw = Math.sin(A.t * 10) * .4; A.lL.rotation.x = sw; A.lR.rotation.x = -sw; A.lab.pos.set(A.pos.x, 1.75, A.pos.z); return; }
  A.lL.rotation.x = A.lR.rotation.x = 0;
  if (A.state === 'home') { A.state = 'desk'; A.t = 0; A.nextAt = 10 + Math.random() * 20; setStatus(A, A.status); A.lab.pos.set(A.home.x, 1.75, A.home.z); return; }
  if (A.state !== 'desk') { if (A.t > A.stay) { A.state = 'walk'; A.next = 'home'; A.path = route(A.pos, A.home); } return; }
  if (A.t > A.nextAt) pick(A); }
function drawBoard(ms) { const g = S.boardCanvas.getContext('2d'); g.fillStyle = '#f4f1ea'; g.fillRect(0, 0, 512, 300); g.fillStyle = '#1c2740'; g.font = '600 24px Sora, "IBM Plex Sans KR", sans-serif'; g.fillText('마일스톤', 24, 44);
  (ms || []).slice(0, 4).forEach((m, i) => { const y = 84 + i * 48; g.font = '500 19px "IBM Plex Sans KR", sans-serif'; g.fillStyle = '#1c2740'; g.fillText(`${m.complete ? '✓ ' : ''}${m.name} ${m.date || ''}`.slice(0, 22), 24, y + 8); g.fillStyle = '#d9d4ca'; g.fillRect(300, y - 10, 140, 20); g.fillStyle = m.status === 'late' ? '#ef6b6b' : '#f0a04b'; g.fillRect(300, y - 10, 140 * Math.min(1, m.ratio || 0), 20); g.fillStyle = '#6b7590'; g.font = '500 17px "IBM Plex Sans KR", sans-serif'; g.fillText(m.dday == null ? '' : (m.dday >= 0 ? `D-${m.dday}` : `D+${-m.dday}`), 450, y + 8); });
  if (!(ms || []).length) { g.font = '500 18px "IBM Plex Sans KR", sans-serif'; g.fillStyle = '#6b7590'; g.fillText('plan.yaml milestones 미설정', 24, 100); }
  S.boardTex.needsUpdate = true; }

// ---------- camera / interaction / loop
function placeCamera() { const c = S.cam; S.camera.position.set(S.target.x + Math.cos(c.yaw) * 40 * Math.cos(c.pitch), S.target.y + 40 * Math.sin(c.pitch) * 1.5, S.target.z + Math.sin(c.yaw) * 40 * Math.cos(c.pitch)); S.camera.lookAt(S.target); }
const ROOM = [[-18.5, 0, -12.5], [18.5, 0, -12.5], [-18.5, 0, 12.5], [18.5, 0, 12.5], [-18.5, 4.2, -12.5], [18.5, 4.2, -12.5], [-18.5, 4.2, 12.5], [18.5, 4.2, 12.5]];
function fitScale(a, vk) { // half-height of the orthographic frustum that shows the whole room at the current yaw/pitch (vk: vertical squeeze for overlays)
  S.camera.updateMatrixWorld(); const inv = new THREE.Matrix4().copy(S.camera.matrixWorld).invert(); let ex = 0, ey = 0;
  for (const [x, y, z] of ROOM) { const v = new THREE.Vector3(x, y, z).applyMatrix4(inv); ex = Math.max(ex, Math.abs(v.x)); ey = Math.max(ey, Math.abs(v.y)); }
  return Math.max(ex / a, ey * (vk || 1)) * 1.03; }
const YAW_ISO = Math.PI / 4 + .12, YAW_PORT = .28;
function resize() { const w = S.el.clientWidth, h = S.el.clientHeight; if (!w || !h) return; const a = w / h;
  const port = a < 1.35; if (port !== S.portrait) { S.portrait = port; S.cam.yaw = port ? YAW_PORT : YAW_ISO; placeZones(); }   // narrow box: long axis of the room runs down the screen
  // keep the room between the HUD (top) and the legend (bottom): fit into the free band, then shift the view centre into it
  const hud = S.el.querySelector('.hud'), foot = S.el.querySelector('.foot'); const top = hud ? hud.offsetHeight + 10 : 0, bot = foot ? foot.offsetHeight + 10 : 0; const avail = Math.max(140, h - top - bot);
  placeCamera(); const s = fitScale(a, h / avail) / S.cam.zoom; const ppu = h / (2 * s); const d = (top - bot) / 2 / ppu;
  S.camera.left = -s * a; S.camera.right = s * a; S.camera.top = s + d; S.camera.bottom = -s + d; S.camera.updateProjectionMatrix(); S.renderer.setSize(w, h, false);
  S.el.style.setProperty('--ls', Math.max(.7, Math.min(1, ppu / 22)).toFixed(3));
  const compact = ppu < 21; if (compact !== S.compact) { S.compact = compact; S.el.classList.toggle('compact', compact); if (S.data) sync(S.data); } }
const V = { v: null };
function updateLabels() { const r = S.renderer.domElement.getBoundingClientRect(); if (!V.v) V.v = new THREE.Vector3(); for (const l of S.labels) { V.v.copy(l.pos).project(S.camera); const x = (V.v.x + 1) / 2 * r.width, y = (1 - V.v.y) / 2 * r.height; l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) ${l.anchor}`; } }
const TOD = { day: { hemi: [0xdfefff, 0x6a5240, 1.0], sun: [0xfff4e0, 1.1], warm: .15, cold: .1, win: [0xbfe0ff, .9], bg: 0x1a2436 }, evening: { hemi: [0xffd9b0, 0x4a3324, .7], sun: [0xffb070, .7], warm: .7, cold: .2, win: [0xffb36a, .8], bg: 0x141b2a }, night: { hemi: [0xcfe1ff, 0x2a2118, .55], sun: [0x8fa6ff, .4], warm: .7, cold: .5, win: [0x6aa6ff, .55], bg: 0x0d1420 } };
function setTod(k) { const t = TOD[k] || TOD.night; S.tod = k; const L = S.lights; L.hemi.color.set(t.hemi[0]); L.hemi.groundColor.set(t.hemi[1]); L.hemi.intensity = t.hemi[2]; L.sun.color.set(t.sun[0]); L.sun.intensity = t.sun[1]; L.warm.intensity = t.warm; L.cold.intensity = t.cold; S.scene.traverse(o => { if (o.name === 'window') { o.material.emissive.set(t.win[0]); o.material.emissiveIntensity = t.win[1]; } }); S.renderer.setClearColor(t.bg); S.el.querySelectorAll('.tod button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tod === k))); try { localStorage.setItem('office.tod', k); } catch (e) { /* no storage */ } }
function bindUi() { S.el.querySelectorAll('.tod button').forEach(b => b.addEventListener('click', () => setTod(b.dataset.tod))); S.el.querySelector('.detail .x').addEventListener('click', () => S.el.querySelector('.detail').classList.remove('on')); }
function bind() { if (S.bound) return; S.bound = true; const el = S.renderer.domElement; let drag = null, pinch = null;
  el.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, yaw: S.cam.yaw, pitch: S.cam.pitch, moved: false }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => { if (!drag) return; if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true; S.cam.yaw = drag.yaw + (e.clientX - drag.x) * .005; S.cam.pitch = Math.max(.3, Math.min(1.2, drag.pitch + (e.clientY - drag.y) * .004)); resize(); });
  el.addEventListener('pointerup', e => { if (drag && !drag.moved) clickAt(e); drag = null; });
  el.addEventListener('wheel', e => { e.preventDefault(); S.cam.zoom = Math.max(.6, Math.min(2.4, S.cam.zoom * (1 - e.deltaY * .0012))); resize(); }, { passive: false });
  el.addEventListener('touchstart', e => { if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }, { passive: true });
  el.addEventListener('touchmove', e => { if (e.touches.length === 2 && pinch) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); S.cam.zoom = Math.max(.6, Math.min(2.4, S.cam.zoom * d / pinch)); pinch = d; resize(); } }, { passive: true });
}
function clickAt(e) { const el = S.renderer.domElement; const r = el.getBoundingClientRect(); const ndc = new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, S.camera); const hits = ray.intersectObjects(S.clickable, false); const d = S.el.querySelector('.detail'); if (!hits.length) { d.classList.remove('on'); return; } showDetail(hits[0].object.userData.ref); }
function showDetail(g) { const d = S.el.querySelector('.detail'); let t = '', b = ''; const data = S.data || {};
  if (g.userData.kind === 'part') { const p = g.userData.p; t = `${p.name} · ${p.gpu ? 'GPU' : 'CPU'} 파티션`; b = `노드 ${p.total} · 사용 가능 <b>${p.idle}</b> · 타인 ${p.others} · 우리 잡 ${p.ours} · 점검 ${p.drained}<br>wall ${esc(p.limit || '?')} · ${p.mine ? '우리 계정 제출 가능' : '우리 계정 권한 없음'}${p.pending ? `<br>⏳ 우리 대기열 ${p.pending}` : ''}${(p.jobs || []).map(j => `<br>▶ ${esc(j.name)} ${esc(j.state)} ${esc(j.time || '')}`).join('')}`; }
  else if (g.userData.stage) { const s = g.userData.stage; t = `${s.name} · ${s.ko}`; b = (S.opts.detailHtml && S.opts.detailHtml(s.name)) || `${s.total != null ? fmtN(s.done) + ' / ' + fmtN(s.total) : '단위 미정'}${s.failed ? ` · 실패 ${s.failed}` : ''}`; if (s.cohorts && s.cohorts.length) b += `<br>다음에 들어갈 코호트: ${s.cohorts.slice(0, 6).map(esc).join(', ')}${s.cohorts.length > 6 ? ' …' : ''}`; }
  else if (g.userData.kind === 'agent') { const A = g.userData.a; t = `${A.name}${A.role ? ' · ' + A.role : ''}`; b = `상태: ${esc(A.cur)}${A.task ? `<br>${esc(A.task)}` : ''}`; if (S.opts.onAgent) b += `<br><a href="#" data-sess="${esc(A.id)}" style="color:#f0a04b">이 세션 열기 →</a>`; }
  d.querySelector('h3').textContent = t; d.querySelector('p').innerHTML = b; d.classList.add('on');
  const a = d.querySelector('a[data-sess]'); if (a) a.onclick = ev => { ev.preventDefault(); S.opts.onAgent(a.dataset.sess); }; }
function frame(now) { if (!S.renderer || !S.el.isConnected) { S.raf = 0; return; } const dt = Math.min(.05, (now - S.last) / 1000); S.last = now;
  if (!S.reduce) { for (const A of S.agents.values()) stepAgent(A, dt); if (S.beltTex && S.beltOn) S.beltTex.offset.x -= dt * .35;
    for (const m of S.movers) { m.x += 1.0 * dt; if (m.x > 16.5) m.x = -16.5; moverShape(m); }
    S.scene.traverse(o => { if (o.userData && o.userData.pulse) o.material.emissiveIntensity = .5 + .5 * Math.sin(now / 300 + o.id); if (o.userData && o.userData.spin) o.rotation.y += dt * .6; if (o.name === 'screen') o.material.color.setHSL(.58, .55, .33 + .08 * Math.sin(now / 900 + o.id)); });
    for (const m of S.machines) if (m.userData.smoke) for (const p of m.userData.smoke) { p.userData.t = (p.userData.t + dt * .25) % 1; p.position.y = 3.1 + p.userData.t * 2.2; p.position.x = -.8 + Math.sin(p.userData.t * 6) * .15; p.material.opacity = .4 * (1 - p.userData.t); p.scale.setScalar(.6 + p.userData.t * 1.6); } }
  S.renderer.render(S.scene, S.camera); updateLabels(); S.raf = requestAnimationFrame(frame); }
function moverShape(m) { const f = formAt(m.x); if (f !== m.form) { if (m.g) S.dyn.remove(m.g); m.form = f; m.g = item(f); } m.g.position.set(m.x, .5, -0.35); }
function formAt(x) { let f = 'parcel'; (S.stepX || []).forEach((sx, i) => { if (x > sx) f = S.forms[i]; }); return f; }

// ---------- public API
async function mount(container, opts) {
  if (!webgl()) throw new Error('no webgl'); await loadThree(); ensureCss();
  S.opts = opts || {}; S.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!S.renderer) { S.renderer = new THREE.WebGLRenderer({ antialias: true }); S.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); S.renderer.shadowMap.enabled = true; S.renderer.shadowMap.type = THREE.PCFSoftShadowMap; S.renderer.outputEncoding = THREE.sRGBEncoding;
    S.scene = new THREE.Scene(); S.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 200); S.target = new THREE.Vector3(0, 1.0, 0);
    S.lights = { hemi: new THREE.HemisphereLight(0xcfe1ff, 0x2a2118, .55), sun: new THREE.DirectionalLight(0xffffff, .75), warm: new THREE.PointLight(0xffc98a, .7, 40), cold: new THREE.PointLight(0x7fb7ff, .5, 30) };
    S.lights.sun.position.set(14, 24, 10); S.lights.sun.castShadow = true; S.lights.sun.shadow.mapSize.set(2048, 2048); Object.assign(S.lights.sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 80 }); S.lights.sun.shadow.bias = -0.0005; S.lights.warm.position.set(8, 7, 8); S.lights.cold.position.set(-10, 6, -5);
    S.scene.add(S.lights.hemi, S.lights.sun, S.lights.warm, S.lights.cold); S.labelsEl = document.createElement('div'); S.labelsEl.className = 'lbls'; buildRoom(); }
  // (re)attach to the container: index.html rebuilds the card's HTML on every refresh
  if (S.el !== container) { S.el = container; container.classList.add('o3d'); container.innerHTML = '';
    container.appendChild(S.renderer.domElement); container.appendChild(S.labelsEl);
    container.insertAdjacentHTML('beforeend', `<div class="hud"><div class="kpi"></div></div><div class="foot"><div class="legend"><span><i style="background:${HEX.ok}"></i>사용 가능</span><span><i style="background:${HEX.bad}"></i>타인 사용 중</span><span><i style="background:${HEX.acc}"></i>우리 잡</span><span><i style="background:#3a4660"></i>점검</span><span><i style="background:#ffd9a6"></i>상자 = 코호트</span><span class="hint">드래그 회전 · 휠/핀치 확대 · 클릭 = 상세</span></div><div class="tod" role="group" aria-label="시간대"><button type="button" data-tod="day">낮</button><button type="button" data-tod="evening">저녁</button><button type="button" data-tod="night">밤</button></div></div><div class="detail"><button type="button" class="x" aria-label="닫기">✕</button><h3></h3><p></p></div>`);
    bind(); bindUi(); const hr = new Date().getHours(); let tod = hr >= 7 && hr < 17 ? 'day' : hr < 20 ? 'evening' : 'night'; try { tod = localStorage.getItem('office.tod') || tod; } catch (e) { /* no storage */ } setTod(tod);
    if (S.ro) S.ro.disconnect(); S.ro = new ResizeObserver(() => resize()); S.ro.observe(container); resize(); }
  if (!S.raf) { S.last = performance.now(); S.raf = requestAnimationFrame(frame); }
}
function sync(data) {
  if (!S.renderer) return; S.data = data; clearDyn();
  // 서버실: one cabinet per partition (CPU ones first, then GPU), zigzag labels
  const parts = (data.parts || []).slice(0, 10); const step = parts.length > 1 ? Math.min(3.35, 32 / (parts.length - 1)) : 0; const x0 = -(parts.length - 1) * step / 2;
  parts.forEach((p, i) => cabinet(x0 + i * step, -10.3, p, i % 2 === 1));
  if (!parts.length) { const l = label('part', `<b>서버 정보 없음</b><span class="n" style="color:${HEX.muted}">프로브가 sinfo를 보내면 랙이 섭니다</span>`, 0, 2.9, -10.3); }
  // 처리 라인: machines along the belt, crates = cohorts whose next step is that machine, three travelling samples
  const stages = data.stages || []; const n = stages.length; const sx = n > 1 ? Math.min(5, 30 / (n - 1)) : 0; const mx0 = -(n - 1) * sx / 2;
  S.stepX = stages.map((s, i) => mx0 + i * sx); S.forms = stages.map(s => FORM_BY_ICON[s.icon] || 'parcel');
  stages.forEach((s, i) => { machine(S.stepX[i], s, i % 2 === 1); const inForm = i ? S.forms[i - 1] : 'parcel';
    (s.cohorts || []).slice(0, 6).forEach((nm, k) => { const col = k % 3, row = Math.floor(k / 3); const g = item(inForm); g.position.set(S.stepX[i] - .8 + col * .8, .5 + (row ? .55 : 0), -0.4 + (row ? -.3 : .35)); if (k === 0) label('crate', esc(nm), g.position.x, g.position.y + .7, g.position.z); }); });
  S.beltOn = stages.some(s => s.running > 0);
  if (n) { S.movers = [{ x: -16 }, { x: -5 }, { x: 6 }].map(m => Object.assign(m, { form: null, g: null })); S.movers.forEach(moverShape);
    const st = box(S.dyn, 3.2, .5, 1.8, 0x2a3448, 18.0, .25, -3.4); st.castShadow = false; box(S.dyn, 1.0, 1.4, 1.0, 0x1f2940, 18.0, 1.25, -3.4);
    const model = new THREE.Mesh(new THREE.IcosahedronGeometry(.55, 1), M(0xf0a04b, { emissive: 0xf0a04b, emissiveIntensity: .25, roughness: .3, metalness: .4, wireframe: true })); model.position.set(18.0, 2.6, -3.4); model.userData.spin = true; S.dyn.add(model);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(.3, 1), M(0x3a4660, { emissive: 0xf0a04b, emissiveIntensity: .15 })); core.position.copy(model.position); S.dyn.add(core);
    const done = data.doneCohorts || []; if (S.compact) label('product c', `<b style="display:inline">완제품</b> ${done.length}`, 18.0, 1.3, -3.4); else label('product', `<b>완제품 → 최종 모델</b>${data.productText || `전 단계 완료 코호트 ${done.length}`}`, 18.0, 3.6, -3.4); }
  // 연구실: sessions as agents; whiteboard = milestones
  syncAgents(data.agents || []); drawBoard(data.milestones || []);
  // HUD
  const k = S.el.querySelector('.kpi'); if (k) k.innerHTML = (data.kpi || []).map(([t, v, s, c]) => `<div>${esc(t)}<b class="${c || ''}">${esc(v)}</b>${esc(s)}</div>`).join('');
}
function destroy() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; if (S.ro) S.ro.disconnect(); if (S.renderer) { S.renderer.dispose(); } S.renderer = null; S.scene = null; S.agents.clear(); S.labels = []; S.el = null; }
window.Office3D = { mount, sync, destroy, supported: webgl };
})();
