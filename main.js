import * as THREE from "three";
import { OrbitControls } from "./lib/OrbitControls.js";
import { EASY, HARD, EXTRA } from "./cities.js?v=2";

const $ = (s) => document.querySelector(s);
const canvas = $("#scene");
const loadingEl = $("#loading");
const labelEl = $("#label");

const isMobile = window.matchMedia("(pointer: coarse)").matches;
const DEG = Math.PI / 180;
const EARTH_KM = 6371;
const ROUNDS = 10;

// ---------- renderer / scene ----------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.75 : 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.minDistance = 3; // replaced by updateZoomLimit() once sizes are known
controls.maxDistance = 7;
controls.zoomSpeed = 0.8;
controls.autoRotateSpeed = 0.4;

// ---------- textures ----------
// Small textures load first so the globe appears quickly; a sharper day map
// replaces it in the background (8K on capable desktops, 4K elsewhere).

const loader = new THREE.TextureLoader();
const maxAniso = renderer.capabilities.getMaxAnisotropy();
const prep = (t, srgb) => {
  t.anisotropy = Math.min(16, maxAniso);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
};
const load = (url, srgb) => prep(loader.load(url), srgb);

const dayMap = load("textures/earth_atmos_2048.jpg", true);
const nightMap = load("textures/earth_night_4k.jpg", true);
const oceanMap = load("textures/earth_ocean_4k.jpg", false);
const cloudMap = load("textures/earth_clouds_1024.png", false);

const canDo8k =
  !isMobile &&
  renderer.capabilities.maxTextureSize >= 8192 &&
  (navigator.deviceMemory === undefined || navigator.deviceMemory >= 4);

// Big maps are decoded off the main thread where possible (createImageBitmap),
// so an 8K JPEG doesn't freeze the page. Safari's ImageBitmap support has had
// orientation bugs, so it uses the regular loader.
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const bitmapLoader =
  typeof createImageBitmap === "function" && !isSafari
    ? new THREE.ImageBitmapLoader().setOptions({ imageOrientation: "flipY" })
    : null;

const swapIn = (t, uniform) => {
  prep(t, true);
  renderer.initTexture(t); // upload now so the swap itself doesn't hitch
  const old = earthMaterial.uniforms[uniform].value;
  earthMaterial.uniforms[uniform].value = t;
  old.dispose();
  updateZoomLimit();
};
const upgrade = (url, uniform) => {
  if (bitmapLoader) {
    bitmapLoader.load(url, (bitmap) => {
      const t = new THREE.Texture(bitmap);
      t.flipY = false; // already flipped during decode
      t.needsUpdate = true;
      swapIn(t, uniform);
    });
  } else {
    loader.load(url, (t) => swapIn(t, uniform));
  }
};

// Start the sharp maps only after the first view is up, so they don't compete
// with the small textures for bandwidth.
let upgradesStarted = false;
const startUpgrades = () => {
  if (upgradesStarted) return;
  upgradesStarted = true;
  upgrade(canDo8k ? "textures/earth_day_8k.jpg" : "textures/earth_day_4k.jpg", "dayMap");
  if (canDo8k) upgrade("textures/earth_night_8k.jpg", "nightMap");
};
const finishLoading = () => {
  if (loadingEl.isConnected) loadingEl.remove();
  startUpgrades();
};
// Never leave "Loading…" up forever if a texture fails on a bad connection.
setTimeout(finishLoading, 15000);

// Never let the camera get so close that one texel covers more than ~1.5
// screen pixels — that's where it starts to look blurry or blocky. Uses the
// lower-resolution of the day and night maps currently on the globe, so the
// limit relaxes only once the sharper maps have actually loaded.
const MAX_STRETCH = 1.5;
const texWidth = (t) => (t.image && t.image.width) || 2048;
const updateZoomLimit = () => {
  const u = earthMaterial.uniforms;
  const texW = Math.min(texWidth(u.dayMap.value), texWidth(u.nightMap.value));
  const texel = (2 * Math.PI) / texW; // world units per texel along the surface
  const viewH = window.innerHeight;
  const span = 2 * Math.tan((camera.fov * DEG) / 2); // world units per unit distance
  controls.minDistance = Math.max(1.15, 1 + (texel * viewH) / (MAX_STRETCH * span));
};

// ---------- earth ----------

const sunDir = new THREE.Vector3(1, 0, 0); // light used for shading
const realSunDir = new THREE.Vector3(1, 0, 0); // where the sun really is now

const earthMaterial = new THREE.ShaderMaterial({
  uniforms: {
    dayMap: { value: dayMap },
    nightMap: { value: nightMap },
    oceanMap: { value: oceanMap },
    cloudMap: { value: cloudMap },
    sunDir: { value: sunDir },
    cloudOffset: { value: 0 },
    cloudStrength: { value: 1 },
    ambient: { value: 0.3 },
    specStrength: { value: 0.35 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vViewNormal;
    varying vec3 vWorldPos;
    void main() {
      vUv = uv;
      vNormal = normalize(mat3(modelMatrix) * normal);
      vViewNormal = normalize(normalMatrix * normal);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D dayMap;
    uniform sampler2D nightMap;
    uniform sampler2D oceanMap;
    uniform sampler2D cloudMap;
    uniform vec3 sunDir;
    uniform float cloudOffset;
    uniform float cloudStrength;
    uniform float ambient;
    uniform float specStrength;
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vViewNormal;
    varying vec3 vWorldPos;

    void main() {
      vec3 N = normalize(vNormal);
      vec3 V = normalize(cameraPosition - vWorldPos);
      float ndl = dot(N, sunDir);
      float lit = max(ndl, 0.0);
      float dayMix = smoothstep(-0.12, 0.22, ndl);

      float ocean = texture2D(oceanMap, vUv).r;
      vec3 day = texture2D(dayMap, vUv).rgb;
      day = mix(day, day * vec3(0.85, 0.97, 1.15), ocean);
      day = mix(vec3(dot(day, vec3(0.299, 0.587, 0.114))), day, 1.1);

      vec4 c = texture2D(cloudMap, vUv - vec2(cloudOffset, 0.0));
      float cloudShadow = c.r * c.a * cloudStrength;
      day *= (lit * (1.2 - ambient) + ambient) * (1.0 - 0.4 * cloudShadow);

      vec3 night = texture2D(nightMap, vUv).rgb * vec3(1.0, 0.82, 0.55);
      night *= (1.0 - dayMix) * 1.8 * (1.0 - 0.6 * cloudShadow);

      vec3 H = normalize(sunDir + V);
      float spec = pow(max(dot(N, H), 0.0), 90.0) * ocean * lit * specStrength;

      vec3 color = mix(night + day * 0.25, day, dayMix) + spec * vec3(1.0, 0.96, 0.88);

      float rim = 1.0 - dot(normalize(vViewNormal), vec3(0.0, 0.0, 1.0));
      color += vec3(0.3, 0.6, 1.0) * pow(rim, 2.0) * 0.75;

      gl_FragColor = vec4(color, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
});

const segments = isMobile ? 96 : 160;
const earth = new THREE.Mesh(new THREE.SphereGeometry(1, segments, segments / 2), earthMaterial);
scene.add(earth);

const cloudMaterial = new THREE.ShaderMaterial({
  uniforms: {
    cloudMap: { value: cloudMap },
    sunDir: { value: sunDir },
    ambient: { value: 0.3 },
    opacity: { value: 0.9 },
  },
  transparent: true,
  depthWrite: false,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    varying vec3 vNormal;
    void main() {
      vUv = uv;
      vNormal = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D cloudMap;
    uniform vec3 sunDir;
    uniform float ambient;
    uniform float opacity;
    varying vec2 vUv;
    varying vec3 vNormal;
    void main() {
      vec4 c = texture2D(cloudMap, vUv);
      float ndl = dot(normalize(vNormal), sunDir);
      float light = smoothstep(-0.15, 0.4, ndl) * (1.0 - ambient) + ambient;
      gl_FragColor = vec4(vec3(light), c.r * c.a * opacity);
      #include <colorspace_fragment>
    }
  `,
});
const clouds = new THREE.Mesh(
  new THREE.SphereGeometry(1.006, segments, segments / 2),
  cloudMaterial,
);
scene.add(clouds);

const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(1, 64, 32),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vertexNormal;
      void main() {
        vertexNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vertexNormal;
      void main() {
        float intensity = pow(0.6 - dot(vertexNormal, vec3(0.0, 0.0, 1.0)), 2.0);
        gl_FragColor = vec4(0.3, 0.6, 1.0, 1.0) * intensity * 0.8;
      }
    `,
  }),
);
atmosphere.scale.setScalar(1.17);
scene.add(atmosphere);

{
  const count = isMobile ? 3000 : 6000;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.randomDirection().multiplyScalar(60 + Math.random() * 40);
    pos.set([v.x, v.y, v.z], i * 3);
    const b = 0.4 + Math.random() * 0.6;
    const warm = Math.random();
    col.set([b, b * (0.9 + warm * 0.1), b * (1.05 - warm * 0.2)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  scene.add(
    new THREE.Points(
      g,
      new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true }),
    ),
  );
}

// ---------- geo helpers ----------
// The textures are centred on Greenwich: lon 0 is +X, lon 90°E is -Z, north is +Y.

const lonLatToVec = (lonDeg, latDeg, target = new THREE.Vector3()) => {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  return target.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
};
const vecToLonLat = (v) => ({ lat: Math.asin(v.y) / DEG, lon: Math.atan2(-v.z, v.x) / DEG });
const angleBetween = (a, b) => Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
const kmBetween = (a, b) => angleBetween(a, b) * EARTH_KM;

const subsolar = (date) => {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - start) / 86400000;
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365.24) * (dayOfYear + 10));
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  return { lon: -(hours - 12) * 15, lat: decl };
};

const slerpDir = (a, b, t, out) => {
  const w = angleBetween(a, b);
  if (w < 1e-5) return out.copy(a);
  const s = Math.sin(w);
  return out
    .copy(a)
    .multiplyScalar(Math.sin((1 - t) * w) / s)
    .addScaledVector(b, Math.sin(t * w) / s);
};

const fmtKm = (km) =>
  km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString("en-US")} km`;
const fmtCoord = (v, pos, neg) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? pos : neg}`;

const timeFormatters = new Map();
const localTime = (tz, date) => {
  if (!timeFormatters.has(tz)) {
    let offset;
    try {
      offset = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
    } catch (e) {
      offset = null;
    }
    timeFormatters.set(tz, {
      time: new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }),
      day: new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }),
      offset,
    });
  }
  const f = timeFormatters.get(tz);
  const off = f.offset
    ? (f.offset.formatToParts(date).find((p) => p.type === "timeZoneName") || {}).value
    : "";
  return { time: f.time.format(date), day: f.day.format(date), offset: off || "" };
};

const daylightAt = (dir) => {
  const d = dir.dot(realSunDir);
  if (d > 0.05) return "☀ Daytime";
  if (d > -0.1) return d > 0 ? "🌅 Sunrise / sunset" : "🌆 Twilight";
  return "☾ Night";
};

const ALL_CITIES = [...EASY, ...HARD, ...EXTRA].map(([name, country, lat, lon, continent, tz]) => ({
  name,
  country,
  continent,
  tz,
  dir: lonLatToVec(lon, lat),
}));

// ---------- markers & arc ----------

const markers = new THREE.Group();
scene.add(markers);

const ringGeo = new THREE.RingGeometry(0.75, 1, 40);
const dotGeo = new THREE.CircleGeometry(0.45, 24);

const makeMarker = (color) => {
  const g = new THREE.Group();
  const mat = (opacity) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, mat(1));
  const dot = new THREE.Mesh(dotGeo, mat(1));
  const pulse = new THREE.Mesh(ringGeo, mat(0.8));
  g.add(ring, dot, pulse);
  g.userData = { ring, pulse, born: performance.now() };
  g.visible = false;
  markers.add(g);
  return g;
};

const guessMarker = makeMarker(0xffffff);
const answerMarker = makeMarker(0xffcf5a);
const MARKERS = [guessMarker, answerMarker];

const placeMarker = (m, dir) => {
  m.position.copy(dir).multiplyScalar(1.009);
  m.lookAt(dir.x * 2, dir.y * 2, dir.z * 2);
  m.userData.born = performance.now();
  m.visible = true;
};

let arc = null;
let arcProgress = 0;
const ARC_SEGMENTS = 120;
const arcMaterial = new THREE.MeshBasicMaterial({ color: 0xffcf5a, transparent: true, opacity: 0.95 });

const clearArc = () => {
  if (!arc) return;
  scene.remove(arc);
  arc.geometry.dispose();
  arc = null;
};

const drawArc = (a, b) => {
  clearArc();
  const w = angleBetween(a, b);
  const lift = Math.min(0.35, w * 0.22);
  const pts = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= 64; i++) {
    const t = i / 64;
    slerpDir(a, b, t, p);
    pts.push(p.clone().multiplyScalar(1.009 + lift * Math.sin(Math.PI * t)));
  }
  const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), ARC_SEGMENTS, 0.0045, 6);
  geo.setDrawRange(0, 0);
  arc = new THREE.Mesh(geo, arcMaterial);
  arcProgress = 0;
  scene.add(arc);
};

// ---------- camera moves ----------

let fly = null;
const flyTo = (dir, dist, duration = 1.2) => {
  dist = THREE.MathUtils.clamp(dist, controls.minDistance, controls.maxDistance);
  fly = {
    from: camera.position.clone().normalize(),
    to: dir.clone().normalize(),
    d0: camera.position.length(),
    d1: dist,
    t: 0,
    duration,
  };
};
const tmpDir = new THREE.Vector3();
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

let homeDist = 3.6;

// ---------- sound ----------

let actx = null;
let muted = false;
try {
  muted = localStorage.getItem("earthMuted") === "1";
} catch (e) {}
const muteBtn = $("#muteBtn");
const syncMute = () => (muteBtn.textContent = muted ? "🔇" : "🔊");
syncMute();
muteBtn.addEventListener("click", () => {
  muted = !muted;
  syncMute();
  try {
    localStorage.setItem("earthMuted", muted ? "1" : "0");
  } catch (e) {}
});

const tone = (freq, delay = 0, dur = 0.12, type = "sine", vol = 0.12, slideTo) => {
  if (muted) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    const t0 = actx.currentTime + delay;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  } catch (e) {}
};
const sfx = {
  tap: () => tone(720, 0, 0.06, "triangle", 0.08),
  tick: () => tone(1100, 0, 0.04, "square", 0.025),
  good: (perfect) => {
    [523, 659, 784].forEach((f, i) => tone(f, i * 0.08, 0.18, "triangle", 0.1));
    if (perfect) tone(1047, 0.26, 0.35, "triangle", 0.1);
  },
  meh: () => tone(440, 0, 0.18, "triangle", 0.08),
  bad: () => tone(300, 0, 0.3, "sawtooth", 0.05, 140),
  end: () => [784, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.22, "triangle", 0.1)),
};
const buzz = (p) => navigator.vibrate && navigator.vibrate(p);

// ---------- game state ----------

// Points per guess and max speed bonus for each difficulty.
const MODE = {
  easy: { points: 1000, speed: 250, time: 20 },
  hard: { points: 1500, speed: 375, time: 15 },
};
// Best possible game (perfect, instant, full streak) — used to grade the result.
const maxScore = (m) => {
  let total = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const mult = i >= 1 ? 1 + 0.1 * Math.min(i, 5) : 1;
    total += (MODE[m].points + MODE[m].speed) * mult;
  }
  return total;
};

let state = "menu"; // menu | playing | reveal | over | explore
let mode = "easy";
let rounds = [];
let roundIndex = 0;
let score = 0;
let streak = 0;
let timeLeft = 0;
let roundTime = 20;
let lastTick = 0;
let guessDir = null;
let history = [];
let labelTarget = null;
let paused = false; // quit dialog open

const readBest = (m) => {
  try {
    return parseInt(localStorage.getItem(`earthBest-v2-${m}`)) || 0;
  } catch (e) {
    return 0;
  }
};
const writeBest = (m, v) => {
  try {
    localStorage.setItem(`earthBest-v2-${m}`, String(v));
  } catch (e) {}
};
const showBests = () => {
  for (const m of ["easy", "hard"]) {
    const b = readBest(m);
    $(`#best-${m}`).textContent = b ? `Best: ${b.toLocaleString("en-US")}` : "Best: –";
  }
};
showBests();

const show = (sel, on) => ($(sel).hidden = !on);

const setLighting = (real) => {
  const amb = real ? 0.07 : 0.3;
  earthMaterial.uniforms.ambient.value = amb;
  cloudMaterial.uniforms.ambient.value = amb;
  useRealSun = real;
};
let useRealSun = false;

const resetScene = () => {
  guessMarker.visible = false;
  answerMarker.visible = false;
  clearArc();
  labelTarget = null;
  labelEl.hidden = true;
};

const goMenu = () => {
  state = "menu";
  resetScene();
  setLighting(false);
  controls.autoRotate = true;
  paused = false;
  ["#hud", "#prompt", "#actions", "#over", "#exploreBar", "#exploreInfo", "#quitBtn", "#quitDialog"].forEach(
    (s) => show(s, false),
  );
  show("#menu", true);
  showBests();
  flyTo(camera.position, homeDist, 1);
};

document.querySelectorAll(".mode").forEach((btn) =>
  btn.addEventListener("click", () => {
    mode = btn.dataset.mode;
    document.querySelectorAll(".mode").forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-checked", b === btn ? "true" : "false");
    });
    sfx.tap();
  }),
);

const pickRounds = () => {
  const pool = (mode === "easy" ? EASY : HARD).slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, ROUNDS).map(([name, country, lat, lon, continent, tz]) => ({
    name,
    country,
    continent,
    tz,
    dir: lonLatToVec(lon, lat),
  }));
};

const startGame = () => {
  rounds = pickRounds();
  roundIndex = 0;
  score = 0;
  streak = 0;
  history = [];
  roundTime = MODE[mode].time;
  setLighting(false);
  show("#menu", false);
  show("#over", false);
  show("#hud", true);
  show("#prompt", true);
  show("#actions", true);
  show("#quitBtn", true);
  paused = false;
  startRound();
};

const updateHud = () => {
  $("#round").textContent = `${Math.min(roundIndex + 1, ROUNDS)}/${ROUNDS}`;
  $("#score").textContent = score.toLocaleString("en-US");
  $("#streak").textContent = streak >= 2 ? `🔥 ${streak}` : "–";
  $("#streakBox").classList.toggle("hot", streak >= 2);
};

const actionBtn = $("#actionBtn");
const timerBar = $("#timerBar");
const tapHint = $("#tapHint");

const startRound = () => {
  state = "playing";
  resetScene();
  guessDir = null;
  controls.autoRotate = false;
  const r = rounds[roundIndex];
  $("#city").textContent = r.name;
  $("#where").textContent = mode === "easy" ? `${r.country} · ${r.continent}` : r.country;
  timeLeft = roundTime;
  lastTick = Math.ceil(timeLeft);
  timerBar.classList.remove("low");
  tapHint.textContent = "Spin the globe and tap to drop your pin";
  show("#tapHint", true);
  show("#result", false);
  actionBtn.textContent = "📍 Drop a pin first";
  actionBtn.disabled = true;
  updateHud();
  // Zoom back out so the whole globe is visible for the next guess.
  if (camera.position.length() < homeDist - 0.2) flyTo(camera.position, homeDist, 0.9);
};

const placeGuess = (dir) => {
  guessDir = dir.clone();
  placeMarker(guessMarker, guessDir);
  actionBtn.textContent = "Confirm ✓";
  actionBtn.disabled = false;
  tapHint.textContent = "Tap somewhere else to move your pin";
  sfx.tap();
};

const rate = (km) => {
  if (km < 100) return "Bullseye! 🎯";
  if (km < 400) return "Excellent!";
  if (km < 1000) return "Great!";
  if (km < 2500) return "Good";
  if (km < 5000) return "Not bad";
  return "Way off";
};

const reveal = (timedOut) => {
  state = "reveal";
  const r = rounds[roundIndex];
  placeMarker(answerMarker, r.dir);
  labelTarget = r.dir;
  labelEl.textContent = r.name;

  let km = null;
  let gain = 0;
  let detail = "";
  if (!timedOut && guessDir) {
    km = kmBetween(guessDir, r.dir);
    // Hard cities are worth more: 1.5x the points for the same accuracy.
    const base = Math.round(MODE[mode].points * Math.exp(-km / 1200));
    const timeBonus = km < 2000 ? Math.round((MODE[mode].speed * timeLeft) / roundTime) : 0;
    streak = km < 750 ? streak + 1 : 0;
    const mult = streak >= 2 ? 1 + 0.1 * Math.min(streak - 1, 5) : 1;
    gain = Math.round((base + timeBonus) * mult);
    detail = `${fmtKm(km)} away` + (timeBonus ? ` · +${timeBonus} speed` : "") +
      (mult > 1 ? ` · ×${mult.toFixed(1)} streak` : "");
    drawArc(guessDir, r.dir);
    // Frame both points: aim between them and back off by how far apart they are.
    const mid = slerpDir(guessDir, r.dir, 0.5, new THREE.Vector3());
    const w = angleBetween(guessDir, r.dir);
    flyTo(mid, THREE.MathUtils.clamp(1.9 + w * 1.6, 1.9, homeDist), 1.3);
    if (km < 400) sfx.good(km < 100);
    else if (km < 2500) sfx.meh();
    else sfx.bad();
    buzz(km < 400 ? [30, 50, 30] : 25);
  } else {
    streak = 0;
    detail = "No guess";
    flyTo(r.dir, 2.4, 1.2);
    sfx.bad();
  }
  score += gain;

  const t = localTime(r.tz, new Date());
  $("#rating").textContent = timedOut ? "Time's up!" : rate(km);
  $("#resultLine").textContent = detail;
  $("#gain").textContent = `+${gain}`;
  $("#cityInfo").textContent =
    `🕒 ${t.time} ${t.day} in ${r.name}${t.offset ? ` (${t.offset})` : ""} · ${daylightAt(r.dir)}`;
  show("#tapHint", false);
  show("#result", true);
  actionBtn.textContent = roundIndex + 1 < ROUNDS ? "Next" : "See results";
  actionBtn.disabled = false;
  history.push({ name: r.name, km, gain });
  updateHud();
};

const endGame = () => {
  state = "over";
  resetScene();
  controls.autoRotate = true;
  show("#hud", false);
  show("#prompt", false);
  show("#actions", false);
  show("#quitBtn", false);

  const best = readBest(mode);
  const isBest = score > best;
  if (isBest) writeBest(mode, score);

  const guessed = history.filter((h) => h.km !== null);
  const avg = guessed.length ? guessed.reduce((s, h) => s + h.km, 0) / guessed.length : null;
  const closest = guessed.slice().sort((a, b) => a.km - b.km)[0];

  const pct = score / maxScore(mode);
  $("#finalTitle").textContent =
    pct >= 0.5 ? "Geography master! 🌍" : pct >= 0.3 ? "Great job!" : pct >= 0.15 ? "Nice!" : "Keep exploring!";
  $("#finalScore").textContent = score.toLocaleString("en-US");
  show("#newBest", isBest && score > 0);
  const modeName = mode === "easy" ? "Easy" : "Hard";
  $("#bestLine").textContent = isBest
    ? `${modeName} · ${best ? `previous best ${best.toLocaleString("en-US")}` : "first game"}`
    : `${modeName} · your best ${best.toLocaleString("en-US")}`;
  $("#finalStats").textContent = avg === null
    ? "No guesses this time."
    : `Average ${fmtKm(avg)} off · closest: ${closest.name} (${fmtKm(closest.km)})`;
  $("#breakdown").innerHTML = history
    .map(
      (h) =>
        `<li><span>${h.name}</span><span>${h.km === null ? "—" : fmtKm(h.km)}</span><span>+${h.gain}</span></li>`,
    )
    .join("");
  show("#over", true);
  flyTo(camera.position, homeDist, 1.2);
  sfx.end();
};

actionBtn.addEventListener("click", () => {
  if (state === "playing" && guessDir) reveal(false);
  else if (state === "reveal") {
    roundIndex++;
    if (roundIndex < ROUNDS) startRound();
    else endGame();
  }
});

$("#playBtn").addEventListener("click", startGame);
$("#againBtn").addEventListener("click", startGame);
$("#menuBtn").addEventListener("click", goMenu);

// ---------- quit / pause ----------

const inGame = () => state === "playing" || state === "reveal";
const openQuit = () => {
  if (!inGame() || paused) return;
  paused = true;
  show("#quitDialog", true);
  $("#resumeBtn").focus();
};
const closeQuit = () => {
  if (!paused) return;
  paused = false;
  show("#quitDialog", false);
  timer.getDelta(); // don't count the time spent in the dialog
};
$("#quitBtn").addEventListener("click", openQuit);
$("#resumeBtn").addEventListener("click", closeQuit);
$("#confirmQuitBtn").addEventListener("click", () => {
  sfx.tap();
  goMenu();
});
// Clicking the dimmed area outside the card also resumes.
$("#quitDialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeQuit();
});

// ---------- explore ----------

const exploreMarker = guessMarker;
let exploreDir = null;

const startExplore = () => {
  state = "explore";
  resetScene();
  setLighting(true);
  controls.autoRotate = false;
  show("#menu", false);
  show("#exploreBar", true);
  show("#exploreInfo", true);
  show("#exploreHint", true);
  show("#placeCard", false);
  exploreDir = null;
  // Face the side of the Earth that's in daylight right now.
  flyTo(realSunDir.clone().add(new THREE.Vector3(0, 0.25, 0)), homeDist, 1.4);
};

const nearestCity = (dir) => {
  let best = null;
  let bestKm = Infinity;
  for (const c of ALL_CITIES) {
    const km = kmBetween(dir, c.dir);
    if (km < bestKm) {
      bestKm = km;
      best = c;
    }
  }
  return { city: best, km: bestKm };
};

const updatePlaceCard = () => {
  if (!exploreDir) return;
  const now = new Date();
  const { lat, lon } = vecToLonLat(exploreDir);
  const { city, km } = nearestCity(exploreDir);
  let timeText;
  let zoneText;
  if (km < 900) {
    const t = localTime(city.tz, now);
    timeText = t.time;
    zoneText = `${t.day}${t.offset ? ` · ${t.offset}` : ""}`;
  } else {
    // Out at sea or far from any listed city: show solar time from longitude.
    const mins = (((now.getUTCHours() * 60 + now.getUTCMinutes() + lon * 4) % 1440) + 1440) % 1440;
    timeText = `≈${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(Math.floor(mins % 60)).padStart(2, "0")}`;
    zoneText = "solar time";
  }
  $("#placeTime").textContent = timeText;
  $("#placeDaylight").textContent = daylightAt(exploreDir);
  $("#placeName").textContent =
    km < 30 ? `${city.name}, ${city.country}` : `${fmtKm(km)} from ${city.name}, ${city.country}`;
  $("#placeMeta").textContent = `${fmtCoord(lat, "N", "S")}, ${fmtCoord(lon, "E", "W")} · ${zoneText}`;
};

const exploreAt = (dir) => {
  exploreDir = dir.clone();
  placeMarker(exploreMarker, exploreDir);
  const { city, km } = nearestCity(exploreDir);
  labelTarget = km < 900 ? city.dir : null;
  labelEl.textContent = city.name;
  show("#exploreHint", false);
  show("#placeCard", true);
  updatePlaceCard();
  sfx.tap();
};

$("#exploreBtn").addEventListener("click", startExplore);
$("#backBtn").addEventListener("click", goMenu);

// ---------- input ----------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt = null;
canvas.addEventListener("pointerdown", (e) => {
  downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
});
canvas.addEventListener("pointerup", (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  const quick = performance.now() - downAt.t < 400;
  downAt = null;
  if (moved > 8 || !quick) return;
  if (paused || (state !== "playing" && state !== "explore")) return;

  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(earth)[0];
  if (!hit) return;
  const dir = hit.point.clone().normalize();
  if (state === "playing") placeGuess(dir);
  else exploreAt(dir);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (paused) closeQuit();
    else if (inGame()) openQuit();
    else if (state === "explore") goMenu();
    return;
  }
  if (paused) return;
  if (e.key !== "Enter" && e.key !== " ") return;
  // A focused button already handles Enter/Space itself; don't fire twice.
  if (e.target instanceof Element && e.target.closest("button")) return;
  if (state === "menu" || state === "over") startGame();
  else if (!actionBtn.disabled && (state === "playing" || state === "reveal")) actionBtn.click();
  else return;
  e.preventDefault();
});

// ---------- layout ----------

const resize = () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 55 : 45;
  camera.updateProjectionMatrix();
  const vHalf = (camera.fov * DEG) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  homeDist = Math.min(Math.max(3.4, 1.45 / Math.sin(Math.min(vHalf, hHalf))), controls.maxDistance);
  updateZoomLimit();
};
window.addEventListener("resize", resize);
resize();

{
  const tzLon = -new Date().getTimezoneOffset() / 4;
  lonLatToVec(tzLon, 20, camera.position).multiplyScalar(homeDist);
  camera.lookAt(0, 0, 0);
}
controls.autoRotate = true;

// ---------- loop ----------

const timer = new THREE.Clock();
const camDir = new THREE.Vector3();
const camRight = new THREE.Vector3();
const projected = new THREE.Vector3();
let lastSecond = -1;
let lastSunSecond = -1;

const frame = () => {
  const dt = Math.min(timer.getDelta(), 0.1);
  const now = new Date();
  const nowMs = performance.now();

  // The sun moves 0.004°/s, so once a second is plenty.
  const sec = Math.floor(now.getTime() / 1000);
  if (sec !== lastSunSecond) {
    lastSunSecond = sec;
    const sun = subsolar(now);
    lonLatToVec(sun.lon, sun.lat, realSunDir);
  }

  if (useRealSun) {
    sunDir.copy(realSunDir);
  } else {
    // Lit from just above-left of the viewer so the visible side is bright.
    camDir.copy(camera.position).normalize();
    camRight.crossVectors(camera.up, camDir).normalize();
    sunDir.copy(camDir).addScaledVector(camRight, -0.45).addScaledVector(camera.up, 0.35).normalize();
  }

  // Camera flights.
  if (fly) {
    fly.t = Math.min(1, fly.t + dt / fly.duration);
    const k = ease(fly.t);
    slerpDir(fly.from, fly.to, k, tmpDir);
    camera.position.copy(tmpDir).multiplyScalar(THREE.MathUtils.lerp(fly.d0, fly.d1, k));
    camera.lookAt(0, 0, 0);
    if (fly.t >= 1) fly = null;
  }

  const dist = camera.position.length();
  // Slower rotation when zoomed in so it stays controllable.
  controls.rotateSpeed = THREE.MathUtils.clamp((dist - 1) / 3, 0.08, 0.6);

  // The cloud map is low-res, so fade clouds out as the camera gets close.
  const cloudFade = THREE.MathUtils.smoothstep(dist, controls.minDistance, controls.minDistance + 1.2);
  const cloudBase = state === "playing" || state === "reveal" ? 0.6 : 0.9;
  cloudMaterial.uniforms.opacity.value = cloudBase * (0.1 + 0.9 * cloudFade);
  earthMaterial.uniforms.cloudStrength.value = 0.1 + 0.9 * cloudFade;
  // Up close the glint spreads into a grey haze, so fade it with zoom.
  earthMaterial.uniforms.specStrength.value = (useRealSun ? 0.15 : 0.35) * cloudFade;
  clouds.rotation.y += dt * 0.006;
  earthMaterial.uniforms.cloudOffset.value = clouds.rotation.y / (2 * Math.PI);

  // Markers keep a constant on-screen size and pulse.
  const ms = 0.012 * (dist - 0.85);
  for (const m of MARKERS) {
    if (!m.visible) continue;
    m.scale.setScalar(ms);
    const age = ((nowMs - m.userData.born) / 1400) % 1;
    m.userData.pulse.scale.setScalar(1 + age * 1.8);
    m.userData.pulse.material.opacity = 0.8 * (1 - age);
  }

  // Grow the arc.
  if (arc && arcProgress < 1) {
    arcProgress = Math.min(1, arcProgress + dt / 0.9);
    arc.geometry.setDrawRange(0, Math.floor(ease(arcProgress) * ARC_SEGMENTS) * 6 * 6);
  }

  // Round timer.
  if (state === "playing" && !paused) {
    timeLeft -= dt;
    const frac = Math.max(0, timeLeft / roundTime);
    const bar = timerBar;
    bar.style.transform = `scaleX(${frac})`;
    if (timeLeft <= 5) {
      bar.classList.add("low");
      const s = Math.ceil(timeLeft);
      if (s < lastTick && s > 0) {
        lastTick = s;
        sfx.tick();
      }
    }
    if (timeLeft <= 0) reveal(!guessDir);
  }

  // Floating city label.
  if (labelTarget) {
    camDir.copy(camera.position).normalize();
    const facing = labelTarget.dot(camDir) > 0.15;
    if (facing) {
      projected.copy(labelTarget).multiplyScalar(1.009).project(camera);
      labelEl.style.transform = `translate(${((projected.x + 1) / 2) * window.innerWidth}px, ${((1 - projected.y) / 2) * window.innerHeight}px) translate(-50%, calc(-100% - 14px))`;
    }
    labelEl.hidden = !facing;
  }

  // Once-per-second UI: clocks.
  if (sec !== lastSecond) {
    lastSecond = sec;
    if (state === "explore") {
      $("#utcClock").textContent = `${now.toISOString().slice(11, 16)} UTC · day/night is live`;
      updatePlaceCard();
    }
  }

  if (!fly) controls.update();
  renderer.render(scene, camera);

  if (!upgradesStarted && nightMap.image && oceanMap.image && cloudMap.image && dayMap.image) {
    finishLoading();
  }
};
renderer.setAnimationLoop(frame);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    renderer.setAnimationLoop(null);
  } else {
    timer.getDelta();
    renderer.setAnimationLoop(frame);
  }
});
