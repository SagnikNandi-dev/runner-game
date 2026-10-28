const cv = document.getElementById("game"), ctx = cv.getContext("2d");
const W = cv.width, H = cv.height;
const overlay = document.getElementById("overlay"), msg = document.getElementById("msg");
const scoreEl = document.getElementById("score"), coinsEl = document.getElementById("coins");

// Pseudo-3D camera: z = distance ahead of the player (0 = near, FAR = horizon)
const HORIZON = 230, FAR = 100, LANE_W = 1.0, CAM_H = 3.0, PZ = 3;   // PZ = how far up the track the player stands
const project = (x, y, z) => {
  const s = 0.79 / (1 + z * 0.08);                // perspective scale (1 world unit ~ 190*s px)
  return { x: W / 2 + x * s * 190, y: HORIZON + (CAM_H - y) * s * 190, s };
};

let player, objs, speed, dist, coins, spawnZ, running, best = +localStorage.getItem("bestScore") || 0, totalCoins = +localStorage.getItem("totalCoins") || 0;
let pw = { magnet: 0, double: 0, shield: 0 }, paused = false, started = false, muted = false, raf = 0;
const startBtn = document.getElementById("start"), restartBtn = document.getElementById("restart");
const coinBox = document.getElementById("coinbox"), stats = document.getElementById("stats"), abBar = document.getElementById("abbar"), abTxt = document.getElementById("abtxt"), abLabel = document.getElementById("ablabel"), abWrap = document.getElementById("abwrap"), abBtn = document.getElementById("ab"), chars = document.getElementById("chars"), titleEl = overlay.querySelector("h1"), pwEl = document.getElementById("pw");

// ---------- audio (synthesized, no files needed) ----------
let AC, master, musicTimer, step = 0;
function audio() {
  if (!AC) { AC = new (window.AudioContext || window.webkitAudioContext)(); master = AC.createGain(); master.gain.value = 0.5; master.connect(AC.destination); }
  if (AC.state === "suspended") AC.resume();
}
function tone(f, d, type = "square", vol = 0.15, slide = 0, when = 0) {
  if (!AC || muted) return;
  const t0 = AC.currentTime + when, o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t0 + d);
  g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + d);
  o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + d);
}
const sfx = {
  coin() { tone(880, 0.08, "square", 0.1); tone(1320, 0.12, "square", 0.1, 0, 0.07); },
  jump() { tone(300, 0.18, "sine", 0.2, 400); },
  slide() { tone(500, 0.15, "sawtooth", 0.08, -350); },
  lane() { tone(220, 0.05, "triangle", 0.1); },
  power() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, "triangle", 0.18, 0, i * 0.07)); },
  shield() { tone(200, 0.25, "sawtooth", 0.2, 300); },
  thud() { tone(90, 0.15, "square", 0.2, -40); },
  ability() { tone(400, 0.3, "triangle", 0.2, 500); tone(800, 0.2, "sine", 0.12, 0, 0.1); },
  hit() { tone(120, 0.5, "sawtooth", 0.3, -90); tone(60, 0.5, "square", 0.25); }
};
const NOTES = [220, 262, 330, 262, 196, 247, 294, 247, 175, 220, 262, 220, 196, 247, 294, 392];
function music(on) {
  clearInterval(musicTimer);
  if (!on) return;
  musicTimer = setInterval(() => {
    if (paused || !running) return;
    const n = NOTES[step++ % NOTES.length];
    tone(n, 0.16, "triangle", 0.09);
    if (step % 4 === 1) tone(n / 2, 0.35, "sine", 0.14);
  }, 190);
}

function reset() {
  player = { lane: 0, x: 0, y: 0, vy: 0, slide: 0, alive: true };
  objs = []; speed = 22; dist = 0; coins = 0; spawnZ = 40; running = true; paused = false;
  pw = { magnet: 0, double: 0, shield: 0 };
  ab = { t: 0, grace: 0, cd: 0, lift: 0, kind: null };
}

// ---------- input ----------
addEventListener("keydown", e => {
  const k = e.key.toLowerCase();
  if (k === "m") return toggleMute();
  if (k === "r" && started) return startGame();
  if ((k === "p" || k === "escape") && running) return togglePause();
  if (!running && !chars.hidden && (k === "arrowleft" || k === "arrowright")) { pick(ORDER[Math.max(0, Math.min(ORDER.length - 1, ORDER.indexOf(chosen) + (k === "arrowleft" ? -1 : 1)))]); return; }
  if (k === "f" || k === "e") return useAbility();
  if (!running || paused) return;
  if (k === "arrowleft" || k === "a") { if (player.lane > -1) sfx.lane(); player.lane = Math.max(-1, player.lane - 1); }
  if (k === "arrowright" || k === "d") { if (player.lane < 1) sfx.lane(); player.lane = Math.min(1, player.lane + 1); }
  if ((k === "arrowup" || k === " " || k === "w") && player.y === 0 && !flying()) { player.vy = 9; sfx.jump(); }
  if ((k === "arrowdown" || k === "s") && !flying()) { if (player.slide <= 0) sfx.slide(); player.slide = 0.7; if (player.y > 0) player.vy = -14; }
  if (k.startsWith("arrow") || k === " ") e.preventDefault();
});
let tx, ty;                                        // touch / swipe support
cv.addEventListener("touchstart", e => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; });
cv.addEventListener("touchend", e => {
  const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
  const k = Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? "ArrowRight" : "ArrowLeft") : (dy > 0 ? "ArrowDown" : "ArrowUp");
  dispatchEvent(new KeyboardEvent("keydown", { key: k }));
});
function startGame() {
  audio(); cancelAnimationFrame(raf); reset(); started = true;
  overlay.classList.add("hidden"); restartBtn.hidden = true; chars.hidden = true; stats.hidden = true; titleEl.classList.remove("over");
  last = performance.now(); music(true); raf = requestAnimationFrame(loop);
}
function togglePause() {
  if (!running) return;
  paused = !paused;
  if (paused) {
    titleEl.textContent = "Paused"; msg.textContent = "Take a breath."; startBtn.textContent = "Resume"; chars.hidden = true; stats.hidden = true; titleEl.classList.remove("over");
    restartBtn.hidden = false; overlay.classList.remove("hidden");
  } else { overlay.classList.add("hidden"); last = performance.now(); }
}
function toggleMute() { muted = !muted; document.getElementById("mute").textContent = muted ? "✕" : "♪"; }
startBtn.onclick = () => paused ? togglePause() : startGame();
restartBtn.onclick = startGame;
document.getElementById("pause").onclick = e => { togglePause(); e.target.blur(); };
document.getElementById("mute").onclick = e => { toggleMute(); e.target.blur(); };
document.addEventListener("visibilitychange", () => { if (document.hidden && running && !paused) togglePause(); });

// ---------- spawning ----------
function spawn() {
  const r = Math.random(), lane = [-1, 0, 1][Math.floor(Math.random() * 3)];
  if (Math.random() < 0.09) {                                             // power-up
    objs.push({ t: "pu", kind: ["magnet", "double", "shield"][Math.floor(Math.random() * 3)], lane, z: spawnZ });
    spawnZ += 11; return;
  }
  if (r < 0.35) for (let i = 0; i < 5; i++) objs.push({ t: "coin", lane, z: spawnZ + i * 2.2 });
  else if (r < 0.6) objs.push({ t: "rock", lane, z: spawnZ });          // jump over
  else if (r < 0.8) objs.push({ t: "beam", lane, z: spawnZ });          // slide under
  else if (r < 0.92) objs.push({ t: "wall", lane, z: spawnZ });         // switch lane
  else for (const l of [-1, 0, 1]) if (l !== lane) objs.push({ t: "rock", lane: l, z: spawnZ });
  spawnZ += 11 + Math.random() * 6;
}

// ---------- update ----------
function update(dt) {
  speed = Math.min(60, speed + dt * 0.6);
  for (const k in pw) pw[k] = Math.max(0, pw[k] - dt);
  if (ab.t > 0) { ab.t -= dt; if (ab.t <= 0) { ab.t = 0; ab.grace = 1.2; ab.cd = ABCD; } }   // special ability timers
  else { ab.grace = Math.max(0, ab.grace - dt); ab.cd = Math.max(0, ab.cd - dt); }
  ab.lift += ((flying() ? 2.4 : 0) - ab.lift) * Math.min(1, dt * 5);
  dist += speed * dt;
  player.x += (player.lane * LANE_W - player.x) * Math.min(1, dt * 14);
  player.vy -= 28 * dt; player.y += player.vy * dt;
  if (player.y <= 0) { player.y = 0; player.vy = 0; }
  player.slide = Math.max(0, player.slide - dt);

  for (const o of objs) o.z -= speed * dt;
  if (pw.magnet > 0) for (const o of objs) if (o.t === "coin" && o.z < 20) o.lane += (player.x / LANE_W - o.lane) * Math.min(1, dt * 8);
  spawnZ -= speed * dt;
  while (spawnZ < FAR) spawn();

  for (const o of objs) {
    if (o.dead || o.z > PZ + 1.2 || o.z < PZ - 1.2 || Math.abs(o.lane * LANE_W - player.x) > 0.5) continue;
    if (o.t === "coin") { o.dead = true; coins += pw.double > 0 ? 2 : 1; sfx.coin(); popCoin(); }
    else if (o.t === "pu") { o.dead = true; pw[o.kind] = { magnet: 8, double: 8, shield: 15 }[o.kind]; sfx.power(); }
    else if (o.t === "rock" && player.y < 0.5) hit(o, "You tripped on a rock!");
    else if (o.t === "beam" && player.slide <= 0) hit(o, "Ouch! Should have slid under that.");
    else if (o.t === "wall") hit(o, "You hit a wall!");
  }
  objs = objs.filter(o => !o.dead && o.z > -3);
  scoreEl.innerHTML = "Score " + score() + "<small>" + Math.floor(dist) + " m</small>"; coinsEl.textContent = coins;
  pwEl.innerHTML = [["magnet", "Magnet"], ["double", "Double coins"], ["shield", "Shield"]]
    .filter(([k]) => pw[k] > 0).map(([k, n]) => n + " " + Math.ceil(pw[k]) + "s").join("<br>");
  abBtn.textContent = "✦ " + (ab.t > 0 ? Math.ceil(ab.t) + "s" : ab.cd > 0 ? Math.ceil(ab.cd) + "s" : CHARS[chosen].label);
  abBtn.classList.toggle("cool", ab.t > 0 || ab.cd > 0);
  const cs = CHARS[chosen];                                              // circular ability gauge
  let pct = 100, mode = "ready", big = "READY", small = "press F";
  if (ab.t > 0) { pct = ab.t / cs.dur * 100; mode = "on"; big = ab.t.toFixed(1) + "s"; small = "active"; }
  else if (ab.cd > 0) { pct = (1 - ab.cd / ABCD) * 100; mode = "cool"; big = ab.cd.toFixed(1) + "s"; small = "recharge"; }
  abBar.style.setProperty("--p", pct); abBar.className = mode;
  abTxt.innerHTML = "<b>" + big + "</b><small>" + small + "</small>"; abLabel.textContent = cs.label + " (" + cs.dur + "s)";
}

function hit(o, reason) {
  if (ab.t > 0 || ab.grace > 0) return;   // ability = invulnerable
  if (pw.shield > 0) { pw.shield = 0; o.dead = true; sfx.shield(); } else die(reason);
}
const score = () => Math.floor(dist) + coins * 10;      // score = distance + 10 per coin
function popCoin() { coinBox.classList.remove("pop"); void coinBox.offsetWidth; coinBox.classList.add("pop"); }
function die(reason) {
  if (!running) return;
  running = false; sfx.hit(); music(false);
  const sc = score(), d = Math.floor(dist), newBest = sc > best;
  if (newBest) { best = sc; localStorage.setItem("bestScore", best); }
  totalCoins += coins; localStorage.setItem("totalCoins", totalCoins);
  titleEl.textContent = "GAME OVER"; titleEl.classList.add("over");
  msg.textContent = reason;
  stats.innerHTML = '<div class="box main"><small>Score</small><b>' + sc + '</b></div>'
    + '<div class="box"><small>Coins collected</small><b><i class="coin"></i>' + coins + '</b></div>'
    + '<div class="box"><small>Distance</small><b>' + d + ' m</b></div>'
    + '<p>' + (newBest ? "NEW BEST SCORE!" : "Best score: " + best) + " &nbsp;|&nbsp; Total coins saved: " + totalCoins + '</p>';
  stats.hidden = false;
  startBtn.textContent = "Run again"; restartBtn.hidden = true;
  overlay.classList.remove("hidden"); chars.hidden = false;
}

// ---------- draw ----------
function quad(a, b, c, d, col) {
  ctx.fillStyle = col; ctx.beginPath();
  ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
  ctx.fill();
}
function drawBg() {
  const g = ctx.createLinearGradient(0, 0, 0, HORIZON);
  g.addColorStop(0, "#6d3b1e"); g.addColorStop(1, "#e8a35a");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, HORIZON);
  ctx.fillStyle = "#3b2a18"; ctx.fillRect(0, HORIZON, W, H - HORIZON);
  // jungle walls on both sides
  for (let z = FAR; z > 0; z -= 4) {
    const zz = z - (dist % 4);
    for (const side of [-1, 1]) {
      const a = project(side * 2.2, 0, zz), b = project(side * 2.2, 3 + (Math.floor((dist + z) / 4) % 3), zz);
      const w = 40 * a.s;
      ctx.fillStyle = (Math.floor((dist + z) / 4) % 2) ? "#2f5d34" : "#244a2a";
      ctx.fillRect(a.x - w / 2, b.y, w, a.y - b.y);
    }
  }
  // path with moving stripes
  for (let z = FAR; z > -2; z -= 2) {
    const z0 = z - (dist % 2), z1 = z0 + 2;
    const col = (Math.floor((dist + z) / 2) % 2) ? "#b98b4e" : "#a97c42";
    quad(project(-1.6, 0, z0), project(1.6, 0, z0), project(1.6, 0, z1), project(-1.6, 0, z1), col);
  }
  // lane dividers
  ctx.strokeStyle = "rgba(60,35,10,.5)"; ctx.lineWidth = 2;
  for (const x of [-0.5, 0.5]) { const a = project(x, 0, 0), b = project(x, 0, FAR); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
}
function drawObj(o) {
  const x = o.lane * LANE_W, p = project(x, 0, o.z), s = p.s * 1.7;
  if (o.t === "coin") {
    const q = project(x, 0.7, o.z); ctx.fillStyle = "#ffd23a"; ctx.strokeStyle = "#b8860b"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(q.x, q.y, 12 * s, 0, 7); ctx.fill(); ctx.stroke();
  } else if (o.t === "rock") {
    ctx.fillStyle = "#6f6a63"; ctx.beginPath(); ctx.ellipse(p.x, p.y - 14 * s, 38 * s, 26 * s, 0, 0, 7); ctx.fill();
    ctx.fillStyle = "#8c867d"; ctx.beginPath(); ctx.ellipse(p.x - 8 * s, p.y - 22 * s, 18 * s, 10 * s, 0, 0, 7); ctx.fill();
  } else if (o.t === "beam") {
    const top = project(x, 1.5, o.z);
    ctx.fillStyle = "#4a3320"; ctx.fillRect(p.x - 50 * s, top.y - 12 * s, 14 * s, p.y - top.y + 12 * s);
    ctx.fillRect(p.x + 36 * s, top.y - 12 * s, 14 * s, p.y - top.y + 12 * s);
    ctx.fillStyle = "#7a5430"; ctx.fillRect(p.x - 56 * s, top.y - 12 * s, 112 * s, 22 * s);
  } else if (o.t === "wall") {
    const top = project(x, 2.2, o.z);
    ctx.fillStyle = "#847a6b"; ctx.fillRect(p.x - 48 * s, top.y, 96 * s, p.y - top.y);
    ctx.strokeStyle = "#5e564b"; ctx.lineWidth = 2; ctx.strokeRect(p.x - 48 * s, top.y, 96 * s, p.y - top.y);
  } else if (o.t === "pu") {
    const q = project(x, 0.9 + Math.sin(dist * 0.15) * 0.12, o.z);
    ctx.fillStyle = { magnet: "#e74c3c", double: "#9b59b6", shield: "#3498db" }[o.kind];
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(q.x, q.y, 18 * s, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.font = "bold " + 16 * s + "px Georgia";
    ctx.fillText({ magnet: "M", double: "x2", shield: "S" }[o.kind], q.x, q.y + 6 * s);
    ctx.textAlign = "start";
  }
}
// ---------- characters ----------
const CHARS = {
  sagnik: { name: "Sagnik", ability: "helicopter", label: "Helicopter", dur: 4,
    st: { top: "#cfe4ff", sleeve: "#cfe4ff", collar: true, tie: "#8e1b2b", bottom: "pants", legs: "#2a3550", skin: "#f1c27d", hair: "#1d140c", w: 30 } },
  aniruddha: { name: "Aniruddha", ability: "bird", label: "Bird ride", dur: 4,
    st: { top: "#f2c96b", sleeve: "#f2c96b", collar: true, bottom: "shorts", legs: "#3d5a40", skin: "#e0b07a", hair: "#2c1d10", hat: "#6b4423", w: 30 } },
  prasun: { name: "Prasun", ability: "lungi", label: "Lungi glide", dur: 20,
    st: { top: "#f7f7f7", ganji: true, bottom: "lungi", legs: "#2f5fb3", skin: "#c68642", hair: "#1d140c", w: 28 } },
  tuya: { name: "Tuya", ability: "wings", label: "Fairy wings", dur: 6,
    st: { top: "#e85d9b", bottom: "saree", legs: "#e85d9b", skin: "#e8b98a", hair: "#2a150c", long: true, w: 26 } }
};
const ORDER = Object.keys(CHARS);
let chosen = "sagnik", ab = { t: 0, grace: 0, cd: 0, lift: 0, kind: null };
const ABCD = 20;   // recharge time (seconds) after an ability ends
const flying = () => ab.t > 0;
function useAbility() {
  if (!running || paused || ab.t > 0 || ab.cd > 0) return;
  ab.t = CHARS[chosen].dur; ab.kind = CHARS[chosen].ability; sfx.ability();
}
abBtn.onclick = e => { useAbility(); e.target.blur(); };
abWrap.onclick = useAbility;

// c = context, (cx, ty, by) = head-top / feet position, s = scale, st = outfit, sw = leg swing, gad = active gadget
function drawFigure(c, cx, ty, by, s, st, sw, air, gad, tm) {
  const hipY = ty + (by - ty) * 0.62, shY = ty + 20 * s, fl = Math.sin(tm * 30);
  c.lineCap = "round";
  if (gad === "wings") {                                                 // fairy wings behind her
    for (const d of [-1, 1]) for (const k of [0, 1]) {
      c.save(); c.translate(cx + d * 6 * s, shY + 6 * s + k * 10 * s); c.rotate(d * (0.6 + k * 1.6 + fl * 0.25));
      c.fillStyle = "rgba(255,190,230,.55)"; c.strokeStyle = "rgba(255,255,255,.8)"; c.lineWidth = 2;
      c.beginPath(); c.ellipse(0, -(30 - k * 8) * s, (12 - k * 2) * s, (32 - k * 8) * s, 0, 0, 7); c.fill(); c.stroke(); c.restore();
    }
  }
  if (st.long) { c.fillStyle = st.hair; c.beginPath(); c.ellipse(cx - sw * 3 * s, ty + 20 * s, 15 * s, 22 * s, 0, 0, 7); c.fill(); }
  for (const d of [-1, 1]) {                                             // legs
    const hx = cx + d * 6 * s, fx = cx + d * 8 * s + sw * d * 8 * s, fy = by - (air ? 6 * s * d : Math.max(0, sw * d) * 14 * s);
    c.lineWidth = 8 * s; c.strokeStyle = st.bottom === "pants" ? st.legs : st.skin;
    c.beginPath(); c.moveTo(hx, hipY); c.lineTo(fx, fy); c.stroke();
    if (st.bottom === "shorts") { c.strokeStyle = st.legs; c.lineWidth = 10 * s; c.beginPath(); c.moveTo(hx, hipY); c.lineTo(hx + (fx - hx) * 0.5, hipY + (fy - hipY) * 0.5); c.stroke(); }
  }
  if (st.bottom === "lungi" || st.bottom === "saree") {                  // lungi / saree drape
    const long = st.bottom === "saree", y0 = hipY - 8 * s, y1 = long ? by - 3 * s : hipY + (by - hipY) * 0.78;
    const w0 = 15 * s, w1 = (long ? 25 : 21) * s, sway = sw * 4 * s;
    c.fillStyle = st.legs; c.beginPath(); c.moveTo(cx - w0, y0); c.lineTo(cx + w0, y0); c.lineTo(cx + w1 + sway, y1); c.lineTo(cx - w1 + sway, y1); c.fill();
    if (long) { c.strokeStyle = "#f5c542"; c.lineWidth = 3 * s; c.beginPath(); c.moveTo(cx - w1 + sway, y1); c.lineTo(cx + w1 + sway, y1); c.stroke(); }
    else {
      c.strokeStyle = "rgba(255,255,255,.6)"; c.lineWidth = 1.5 * s;
      for (const u of [-0.5, 0, 0.5]) { c.beginPath(); c.moveTo(cx + u * 2 * w0, y0); c.lineTo(cx + u * 2 * w1 + sway, y1); c.stroke(); }
      for (const f of [0.35, 0.7]) { const y = y0 + (y1 - y0) * f, e = w0 + (w1 - w0) * f; c.beginPath(); c.moveTo(cx - e + sway * f, y); c.lineTo(cx + e + sway * f, y); c.stroke(); }
    }
  }
  c.fillStyle = st.top; c.fillRect(cx - st.w / 2 * s, ty + 16 * s, st.w * s, hipY - ty - 12 * s);   // torso
  if (st.ganji) { c.fillStyle = st.skin; c.beginPath(); c.arc(cx, ty + 16 * s, 9 * s, 0, Math.PI); c.fill(); }   // sando ganji neckline
  if (st.collar) { c.fillStyle = "#fff"; c.beginPath(); c.moveTo(cx - 8 * s, ty + 16 * s); c.lineTo(cx + 8 * s, ty + 16 * s); c.lineTo(cx, ty + 27 * s); c.fill(); }
  if (st.tie) { c.fillStyle = st.tie; c.fillRect(cx - 3 * s, ty + 18 * s, 6 * s, 24 * s); }
  if (st.bottom === "saree") { c.strokeStyle = "#c2377a"; c.lineWidth = 10 * s; c.beginPath(); c.moveTo(cx - st.w / 2 * s, shY - 2 * s); c.lineTo(cx + 8 * s, hipY); c.stroke(); }   // pallu
  for (const d of [-1, 1]) {                                             // arms
    c.strokeStyle = st.sleeve || st.skin; c.lineWidth = 6 * s;
    const endY = air ? ty + 4 * s : shY + 18 * s - sw * d * 9 * s;
    c.beginPath(); c.moveTo(cx + d * (st.w / 2) * s, shY); c.lineTo(cx + d * (st.w / 2 + 6) * s, endY); c.stroke();
  }
  c.fillStyle = st.skin; c.beginPath(); c.arc(cx, ty + 8 * s, 12 * s, 0, 7); c.fill();               // head
  c.fillStyle = st.hair;
  if (st.long) { c.beginPath(); c.arc(cx, ty + 8 * s, 13 * s, Math.PI, 0); c.fill(); }
  else c.fillRect(cx - 13 * s, ty - 3 * s, 26 * s, 8 * s);
  if (st.hat) {
    c.fillStyle = st.hat; c.beginPath(); c.ellipse(cx, ty + s, 19 * s, 5 * s, 0, 0, 7); c.fill(); c.fillRect(cx - 11 * s, ty - 12 * s, 22 * s, 13 * s);
    c.fillStyle = "#3a2412"; c.fillRect(cx - 11 * s, ty - 3 * s, 22 * s, 3 * s);
  }
  if (gad === "helicopter") {                                            // rotor pack on the head
    c.fillStyle = "#c0392b"; c.fillRect(cx - 10 * s, ty - 14 * s, 20 * s, 9 * s);
    c.strokeStyle = "#333"; c.lineWidth = 3 * s; c.beginPath(); c.moveTo(cx, ty - 14 * s); c.lineTo(cx, ty - 26 * s); c.stroke();
    const bl = 58 * s * Math.cos(tm * 45);
    c.fillStyle = "rgba(60,60,60,.15)"; c.beginPath(); c.ellipse(cx, ty - 27 * s, 58 * s, 5 * s, 0, 0, 7); c.fill();
    c.strokeStyle = "#222"; c.lineWidth = 4 * s; c.beginPath(); c.moveTo(cx - bl, ty - 27 * s); c.lineTo(cx + bl, ty - 27 * s); c.stroke();
  } else if (gad === "lungi") {                                          // open lungi used as a glider
    const rx = 54 * s * (1 + 0.04 * fl), cy = ty - 30 * s;
    c.strokeStyle = "rgba(255,255,255,.7)"; c.lineWidth = 1.5 * s;
    for (const u of [-1, 0, 1]) { c.beginPath(); c.moveTo(cx + u * rx, cy); c.lineTo(cx + u * 10 * s, shY); c.stroke(); }
    c.fillStyle = "#2f5fb3"; c.beginPath(); c.ellipse(cx, cy, rx, 26 * s, 0, Math.PI, 0); c.fill();
    c.strokeStyle = "rgba(255,255,255,.55)";
    for (const u of [-0.6, -0.2, 0.2, 0.6]) { c.beginPath(); c.moveTo(cx + u * rx, cy - 24 * s * Math.sqrt(1 - u * u)); c.lineTo(cx + u * rx, cy); c.stroke(); }
  } else if (gad === "bird") {                                           // a big bird carries him by the shoulders
    const fy = ty - 34 * s, flap = Math.sin(tm * 14);
    c.strokeStyle = "#e8a838"; c.lineWidth = 3 * s;
    for (const d of [-1, 1]) { c.beginPath(); c.moveTo(cx + d * 7 * s, fy + 8 * s); c.lineTo(cx + d * 10 * s, shY - 2 * s); c.stroke(); }   // talons
    c.fillStyle = "#7a5230"; c.strokeStyle = "#4a2f18"; c.lineWidth = 2;
    for (const d of [-1, 1]) {                                           // flapping wings
      c.beginPath(); c.moveTo(cx + d * 10 * s, fy);
      c.quadraticCurveTo(cx + d * 40 * s, fy - (24 + flap * 18) * s, cx + d * 78 * s, fy - (6 + flap * 22) * s);
      c.quadraticCurveTo(cx + d * 52 * s, fy + 8 * s, cx + d * 10 * s, fy + 12 * s);
      c.fill(); c.stroke();
    }
    c.fillStyle = "#e9dcc3"; c.beginPath(); c.moveTo(cx - 9 * s, fy + 18 * s); c.lineTo(cx + 9 * s, fy + 18 * s); c.lineTo(cx, fy + 34 * s); c.fill();   // tail
    c.fillStyle = "#8b5e34"; c.beginPath(); c.ellipse(cx, fy + 4 * s, 13 * s, 20 * s, 0, 0, 7); c.fill();                                    // body
    c.fillStyle = "#f4ead0"; c.beginPath(); c.arc(cx, fy - 18 * s, 7 * s, 0, 7); c.fill();                                                   // head
    c.fillStyle = "#f5a623"; c.beginPath(); c.moveTo(cx - 3 * s, fy - 23 * s); c.lineTo(cx + 3 * s, fy - 23 * s); c.lineTo(cx, fy - 31 * s); c.fill();   // beak
  }
}
function drawPlayer() {
  const sliding = player.slide > 0, h = sliding ? 0.55 : 1.15, lift = ab.lift, tm = performance.now() / 1000;
  const air = player.y > 0.05 || lift > 0.3;
  const base = project(player.x, player.y + lift, PZ), top = project(player.x, player.y + lift + h, PZ);
  const s = base.s * 1.6, ph = dist * 1.1;
  const sw = air || sliding ? 0.35 : Math.sin(ph);                       // run-cycle swing
  const bob = air || sliding ? 0 : Math.abs(Math.cos(ph)) * 4 * s;
  const hov = lift > 0.3 ? Math.sin(tm * 6) * 5 * s : 0;                 // hover while flying
  const lean = (player.lane * LANE_W - player.x) * 18 * s;               // lean into lane changes
  const cx = base.x + lean, ty = top.y - bob - hov, by = base.y - hov;
  const sh = project(player.x, 0, PZ);
  ctx.fillStyle = "rgba(0,0,0," + (0.3 / (1 + lift)) + ")"; ctx.beginPath(); ctx.ellipse(sh.x, sh.y, 26 * s, 8 * s, 0, 0, 7); ctx.fill();
  const gad = ab.t > 0 && (ab.t > 1 || Math.floor(ab.t * 8) % 2) ? ab.kind : null;   // gadget blinks when about to end
  drawFigure(ctx, cx, ty, by, s, CHARS[chosen].st, sw, air, gad, tm);
  if (pw.shield > 0) {
    ctx.strokeStyle = "rgba(80,170,255," + (0.55 + 0.25 * Math.sin(dist * 0.3)) + ")"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx, (ty + by) / 2, (by - ty) * 0.7, 0, 7); ctx.stroke();
  }
  if (pw.magnet > 0) {
    ctx.strokeStyle = "rgba(231,76,60,.5)"; ctx.lineWidth = 3; ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.arc(cx, (ty + by) / 2, (by - ty) * 0.95, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  }
}
// character select cards on the start screen
const cards = document.querySelectorAll(".char");
function pick(k) { chosen = k; cards.forEach(b => b.classList.toggle("sel", b.dataset.c === k)); if (!running) draw(); }
cards.forEach(b => {
  b.onclick = () => pick(b.dataset.c);
  const c = b.querySelector("canvas").getContext("2d"), s = 0.68, by = 106;
  c.fillStyle = "rgba(0,0,0,.3)"; c.beginPath(); c.ellipse(36, by + 2, 20, 5, 0, 0, 7); c.fill();
  drawFigure(c, 36, by - 136 * s, by, s, CHARS[b.dataset.c].st, 0.5, false, null, 0);
});
function draw() {
  drawBg();
  [...objs].sort((a, b) => b.z - a.z).forEach(o => o.z > PZ && drawObj(o));
  drawPlayer();
  [...objs].forEach(o => o.z <= PZ && o.z > -2 && drawObj(o));
}

// ---------- loop ----------
let last = 0;
function loop(now) {
  const dt = Math.min(0.033, (now - last) / 1000); last = now;
  if (running) { if (!paused) update(dt); draw(); raf = requestAnimationFrame(loop); }
}
reset(); running = false; draw();
if (best) msg.textContent = "Best score: " + best + ". Don't stop running.";
