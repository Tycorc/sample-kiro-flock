/* kiro-flock dashboard */

// ---------- Auth layer -------------------------------------------------------
let authConfig = null;
let idToken = null;

async function initAuth() {
  // Load auth config written by install.sh
  try {
    const res = await fetch("auth-config.json");
    if (res.ok) authConfig = await res.json();
  } catch { /* auth-config.json missing — auth disabled */ }

  if (!authConfig) return; // No Cognito configured, run without auth

  // Show logout button when auth is configured
  document.getElementById("btn-logout").style.display = "block";

  // Check for id_token in URL hash (Cognito implicit flow callback)
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  if (params.has("id_token")) {
    idToken = params.get("id_token");
    sessionStorage.setItem("flock_id_token", idToken);
    // Clean the URL
    history.replaceState(null, "", window.location.pathname);
    return;
  }

  // Check sessionStorage for existing token
  idToken = sessionStorage.getItem("flock_id_token");
  if (idToken) {
    // Validate token hasn't expired
    try {
      const payload = JSON.parse(atob(idToken.split(".")[1]));
      if (payload.exp * 1000 > Date.now()) return; // Still valid
    } catch { /* invalid token, re-auth */ }
    sessionStorage.removeItem("flock_id_token");
    idToken = null;
  }

  // No valid token — redirect to Cognito hosted UI
  const redirectUri = authConfig.apiUrl;
  const loginUrl = `https://${authConfig.cognitoDomain}/login?client_id=${authConfig.clientId}&response_type=token&scope=openid&redirect_uri=${encodeURIComponent(redirectUri)}`;
  window.location.href = loginUrl;
}

// Wrap fetch to attach Authorization header
const _origFetch = window.fetch;
window.fetch = function(url, opts = {}) {
  if (idToken && typeof url === "string" && url.startsWith("cluster")) {
    opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${idToken}` };
  }
  return _origFetch.call(this, url, opts);
};

function logout() {
  sessionStorage.removeItem("flock_id_token");
  if (authConfig) {
    const logoutUrl = `https://${authConfig.cognitoDomain}/logout?client_id=${authConfig.clientId}&logout_uri=${encodeURIComponent(authConfig.apiUrl)}`;
    window.location.href = logoutUrl;
  } else {
    window.location.reload();
  }
}

// Run auth before anything else
initAuth().then(() => {
  // Auth complete, start the dashboard
  initDashboard();
});

function initDashboard() {

const API = "cluster";
const POLL_MS = 5000;
const grid = document.getElementById("grid");
const badge = document.getElementById("cluster-badge");
const toast = document.getElementById("toast");

// Run timer
let runStartTime = null;
const runTimerEl = document.getElementById("run-timer");

function updateRunTimer() {
  if (!runStartTime) { runTimerEl.style.display = "none"; return; }
  runTimerEl.style.display = "";
  const elapsed = Math.floor((Date.now() - runStartTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const s = String(elapsed % 60).padStart(2, "0");
  runTimerEl.textContent = `${h}:${m}:${s}`;
}
setInterval(updateRunTimer, 1000);

// Load saved direction on page load
let savedDirection = "";
async function loadDirection() {
  try {
    const res = await fetch(`${API}/direction`);
    if (res.ok) {
      const { direction } = await res.json();
      savedDirection = direction || "";
      const ta = document.getElementById("in-direction");
      ta.value = savedDirection;
      syncDirectionBtn();
    }
  } catch { /* non-fatal */ }
}

function syncDirectionBtn() {
  const ta = document.getElementById("in-direction");
  const btn = document.querySelector(".btn-save");
  const changed = ta.value.trim() !== savedDirection.trim();
  btn.disabled = !changed;
  btn.style.opacity = changed ? "1" : "0.4";
  btn.style.cursor = changed ? "pointer" : "default";
}

loadDirection();

// Load current config values
async function loadConfig() {
  try {
    const res = await fetch(`${API}/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.loopIntervalSeconds != null) document.getElementById("in-interval").value = cfg.loopIntervalSeconds;
    if (cfg.concurrency != null) document.getElementById("in-concurrency").value = cfg.concurrency;
    if (cfg.neighbourRadius != null) document.getElementById("in-neighbours").value = cfg.neighbourRadius;
  } catch { /* non-fatal */ }
}
loadConfig();

// Load instance types — curated list, smallest to largest
let instanceSpecs = {};
let vcpuQuota = 0;
let concurrencyCap = 600;

async function loadInstanceTypes() {
  const sel = document.getElementById("in-instance");
  try {
    const res = await fetch(`${API}/instance-types`);
    if (!res.ok) return;
    const data = await res.json();
    const { instanceTypes } = data;
    vcpuQuota = data.vcpuQuota || 0;
    concurrencyCap = data.concurrencyCap || 600;

    // Apply cap to the concurrency input
    const concInput = document.getElementById("in-concurrency");
    concInput.max = concurrencyCap;
    if ((parseInt(concInput.value) || 0) > concurrencyCap) {
      concInput.value = concurrencyCap;
    }

    // Update the cap label in the hint
    const capLabel = document.getElementById("concurrency-cap-label");
    if (capLabel) capLabel.textContent = concurrencyCap;
    if (!instanceTypes || !instanceTypes.length) return;
    instanceSpecs = {};
    instanceTypes.forEach(t => {
      instanceSpecs[t.type] = { vcpus: t.vcpus, memoryGb: t.memoryGb };
    });
    sel.innerHTML = instanceTypes.map(t => {
      const maxAgents = vcpuQuota > 0 ? Math.floor(vcpuQuota / t.vcpus) : null;
      const maxStr = maxAgents !== null ? ` / quota: ${maxAgents} agents` : "";
      const label = `${t.type}  (${t.vcpus} vCPU, ${t.memoryGb} GB${maxStr})`;
      return `<option value="${t.type}"${t.type === "t4g.medium" ? " selected" : ""}>${label}</option>`;
    }).join("");
    checkCapacity();
  } catch { /* non-fatal */ }
}

function updateInstanceSpec() {
  checkCapacity();
}

function checkCapacity() {
  const concurrency = parseInt(document.getElementById("in-concurrency").value) || 0;
  const val = document.getElementById("in-instance").value;
  const spec = instanceSpecs[val];
  const vcpusNeeded = spec ? concurrency * spec.vcpus : 0;
  const maxInstances = spec && vcpuQuota > 0 ? Math.floor(vcpuQuota / spec.vcpus) : null;
  const btn = document.getElementById("btn-start");
  const warn = document.getElementById("capacity-warn");

  if (concurrency > concurrencyCap) {
    btn.disabled = true;
    if (warn) {
      warn.textContent = `${concurrency} agents exceeds the configured cap of ${concurrencyCap}.`;
      warn.style.display = "block";
    }
  } else if (vcpuQuota > 0 && vcpusNeeded > vcpuQuota) {
    btn.disabled = true;
    if (warn) {
      warn.textContent = `${concurrency} agents needs ${vcpusNeeded} vCPUs, your limit allows ${maxInstances} agents of this type. Request an increase in Service Quotas.`;
      warn.style.display = "block";
    }
  } else {
    btn.disabled = false;
    if (warn) warn.style.display = "none";
  }

  const agentsLabel = document.getElementById("agents-usage");
  if (agentsLabel && maxInstances !== null) {
    agentsLabel.textContent = `${concurrency} / ${maxInstances}`;
  } else if (agentsLabel) {
    agentsLabel.textContent = "";
  }
}

function stepVal(id, delta) {
  const el = document.getElementById(id);
  const min = parseInt(el.min) || 0;
  const max = parseInt(el.max) || 999;
  const next = Math.max(min, Math.min(max, (parseInt(el.value) || 0) + delta));
  el.value = next;
  checkCapacity();
}

loadInstanceTypes();

// Track changes to direction textarea
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("in-direction").addEventListener("input", syncDirectionBtn);
});

// ---------- Helpers ----------------------------------------------------------
const esc = s => s ? String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") : "";
const pct = v => v != null ? `${Math.round(v)}%` : "—";
const fmtBytes = v => {
  if (v == null) return "—";
  if (v < 1024) return v + "B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + "K";
  return (v / (1024 * 1024)).toFixed(1) + "M";
};
const trunc = (s, n) => s && s.length > n ? s.slice(0, n) + "\u2026" : (s || "—");
const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString() : "—";

function showError(msg) {
  toast.textContent = msg;
  toast.classList.add("visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("visible"), 8000);
}

function statusPillClass(s) {
  if (s === "running") return "status-running";
  if (s === "terminated") return "status-terminated";
  if (s === "shutting-down") return "status-shutting-down";
  return "status-starting";
}

// ---------- Minimal markdown renderer ----------------------------------------
function renderMarkdown(text) {
  // Escape HTML first, then apply markdown patterns
  let html = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Code blocks (``` ... ```)
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${code.trim()}</code></pre>`);

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Headings
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // HR
  html = html.replace(/^---+$/gm, "<hr>");

  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

  // Unordered list items
  html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);

  // Ordered list items
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

  // Paragraphs — wrap lines not already in a block tag
  html = html.split("\n").map(line => {
    if (!line.trim()) return "";
    if (/^<(h[1-3]|ul|ol|li|pre|blockquote|hr)/.test(line)) return line;
    return `<p>${line}</p>`;
  }).join("\n");

  return html;
}

// ---------- Habitat panel ----------------------------------------------------
let habitatFiles = [];
let habitatActive = null;
const habitatFilesEl = document.getElementById("habitat-files");
const habitatViewerEl = document.getElementById("habitat-viewer");
const habitatBackEl = document.getElementById("habitat-back");

async function loadHabitat() {
  try {
    const res = await fetch(`${API}/habitat`);
    if (!res.ok) return;
    const { files, archivedRuns } = await res.json();
    habitatFiles = files || [];
    renderHabitatList(archivedRuns || 0);
  } catch { /* non-fatal */ }
}

function renderHabitatList(archivedRuns) {
  let html = "";
  if (archivedRuns > 0) {
    html += `<div class="habitat-archive-note">Previous run archived. ${archivedRuns} run${archivedRuns > 1 ? "s" : ""} in history.</div>`;
  }
  const dlAllBtn = document.getElementById("habitat-dl-all");
  if (habitatFiles.length === 0) {
    html += '<div class="habitat-empty">No environment files yet.</div>';
    habitatFilesEl.innerHTML = html;
    if (dlAllBtn) dlAllBtn.style.display = "none";
    return;
  }
  if (dlAllBtn) dlAllBtn.style.display = "block";
  html += habitatFiles.map(f => {
    const name = f.key.replace("output/", "");
    const size = f.size < 1024 ? f.size + "B" : (f.size / 1024).toFixed(1) + "K";
    const active = habitatActive === f.key ? " active" : "";
    return `<div class="habitat-file${active}" data-key="${esc(f.key)}" data-name="${esc(name)}">
      <div class="habitat-file-info">
        <span class="habitat-file-name">${esc(name)}</span>
        <span class="habitat-file-meta">${size} · ${fmtTime(f.lastModified)}</span>
      </div>
      <button class="habitat-dl habitat-dl-inline" data-dl-key="${esc(f.key)}" data-dl-name="${esc(name)}">&#8595;</button>
    </div>`;
  }).join("");
  habitatFilesEl.innerHTML = html;

  // Attach event listeners via delegation instead of inline onclick
  habitatFilesEl.querySelectorAll(".habitat-file-info").forEach(el => {
    el.addEventListener("click", () => {
      const key = el.parentElement.dataset.key;
      if (key) openHabitatFile(key);
    });
  });
  habitatFilesEl.querySelectorAll(".habitat-dl-inline").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadFile(el.dataset.dlKey, el.dataset.dlName);
    });
  });
}

async function openHabitatFile(key) {
  habitatActive = key;
  renderHabitatList(0);
  habitatViewerEl.innerHTML = '<pre>Loading…</pre>';
  habitatFilesEl.style.display = "none";
  habitatViewerEl.classList.add("visible");
  habitatBackEl.classList.add("visible");
  document.getElementById("habitat-dl-btn").style.display = "block";
  document.getElementById("habitat-refresh-btn").style.display = "block";
  document.getElementById("habitat-dl-all").style.display = "none";
  try {
    const res = await fetch(`${API}/habitat/file?key=${encodeURIComponent(key)}`);
    if (!res.ok) { habitatViewerEl.innerHTML = `<pre>Error ${res.status}</pre>`; return; }
    const { content } = await res.json();
    const name = key.replace("output/", "");
    const isMarkdown = name.endsWith(".md") || name.endsWith(".markdown");
    if (isMarkdown) {
      habitatViewerEl.innerHTML = renderMarkdown(content);
    } else {
      habitatViewerEl.innerHTML = `<pre>${esc(content)}</pre>`;
    }
  } catch (err) {
    habitatViewerEl.innerHTML = `<pre>Failed: ${esc(err.message)}</pre>`;
  }
}

function habitatBack() {
  habitatActive = null;
  habitatFilesEl.style.display = "";
  habitatViewerEl.classList.remove("visible");
  habitatViewerEl.innerHTML = "";
  habitatBackEl.classList.remove("visible");
  document.getElementById("habitat-dl-btn").style.display = "none";
  document.getElementById("habitat-refresh-btn").style.display = "none";
  document.getElementById("habitat-dl-all").style.display = habitatFiles.length > 0 ? "block" : "none";
  renderHabitatList(0);
}

async function downloadFile(key, filename) {
  try {
    const res = await fetch(`${API}/habitat/file?key=${encodeURIComponent(key)}`);
    if (!res.ok) { showError(`download failed: ${res.status}`); return; }
    const { content } = await res.json();
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  } catch (err) { showError(`download failed: ${err.message}`); }
}

function downloadHabitatFile() {
  if (!habitatActive) return;
  downloadFile(habitatActive, habitatActive.replace("output/", ""));
}

function refreshHabitatFile() {
  if (!habitatActive) return;
  openHabitatFile(habitatActive);
}

async function downloadAllFiles() {
  if (!habitatFiles.length) return;
  const entries = [];
  for (const f of habitatFiles) {
    try {
      const res = await fetch(`${API}/habitat/file?key=${encodeURIComponent(f.key)}`);
      if (!res.ok) continue;
      const { content } = await res.json();
      entries.push({ name: f.key.replace("output/", ""), content });
    } catch { /* skip failed files */ }
  }
  if (!entries.length) { showError("No files to download"); return; }

  // CRC-32 lookup table
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const enc = new TextEncoder();
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const { name, content } of entries) {
    const nameBytes = enc.encode(name);
    const dataBytes = enc.encode(content);
    const checksum = crc32(dataBytes);

    // Local file header (30 bytes + filename)
    const header = new Uint8Array(30 + nameBytes.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true);  // local file header signature
    hv.setUint16(4, 20, true);           // version needed (2.0)
    hv.setUint16(6, 0, true);            // general purpose flags
    hv.setUint16(8, 0, true);            // compression: store
    hv.setUint16(10, 0, true);           // mod time
    hv.setUint16(12, 0, true);           // mod date
    hv.setUint32(14, checksum, true);    // crc-32
    hv.setUint32(18, dataBytes.length, true); // compressed size
    hv.setUint32(22, dataBytes.length, true); // uncompressed size
    hv.setUint16(26, nameBytes.length, true); // filename length
    hv.setUint16(28, 0, true);           // extra field length
    header.set(nameBytes, 30);
    parts.push(header, dataBytes);

    // Central directory entry (46 bytes + filename)
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);   // central dir signature
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0, true);             // flags
    cv.setUint16(10, 0, true);            // compression: store
    cv.setUint16(12, 0, true);            // mod time
    cv.setUint16(14, 0, true);            // mod date
    cv.setUint32(16, checksum, true);     // crc-32
    cv.setUint32(20, dataBytes.length, true); // compressed size
    cv.setUint32(24, dataBytes.length, true); // uncompressed size
    cv.setUint16(28, nameBytes.length, true); // filename length
    cv.setUint16(30, 0, true);            // extra field length
    cv.setUint16(32, 0, true);            // comment length
    cv.setUint16(34, 0, true);            // disk number start
    cv.setUint16(36, 0, true);            // internal file attributes
    cv.setUint32(38, 0, true);            // external file attributes
    cv.setUint32(42, offset, true);       // local header offset
    cd.set(nameBytes, 46);
    centralDir.push(cd);

    offset += header.length + dataBytes.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const cd of centralDir) { parts.push(cd); cdSize += cd.length; }

  // End of central directory (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);              // disk number
  ev.setUint16(6, 0, true);              // disk with central dir
  ev.setUint16(8, entries.length, true);  // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, cdSize, true);         // central dir size
  ev.setUint32(16, cdStart, true);        // central dir offset
  ev.setUint16(20, 0, true);             // comment length
  parts.push(eocd);

  const blob = new Blob(parts, { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "environment.zip";
  a.click();
  URL.revokeObjectURL(url);
}

// Poll habitat every 10s
loadHabitat();
setInterval(loadHabitat, 10000);

// ---------- Resize handle ----------------------------------------------------
const resizeHandle = document.getElementById("resize-handle");
const habitatPanel = document.getElementById("habitat");
let resizing = false;

resizeHandle.addEventListener("mousedown", e => {
  resizing = true;
  resizeHandle.classList.add("dragging");
  e.preventDefault();
});

document.addEventListener("mousemove", e => {
  if (!resizing) return;
  const mainRect = document.querySelector(".main").getBoundingClientRect();
  const newWidth = mainRect.right - e.clientX;
  if (newWidth >= 160 && newWidth <= mainRect.width * 0.7) {
    habitatPanel.style.width = newWidth + "px";
  }
});

document.addEventListener("mouseup", () => {
  resizing = false;
  resizeHandle.classList.remove("dragging");
});

// ---------- Agent panels -----------------------------------------------------
function renderPanel(a) {
  const m = a.metrics || {};
  const prev = a.prevEntry;
  const cur = a.lastEntry;

  let html = `<div class="panel-head">
    <span class="agent-name">${esc(a.agentId)}</span>
    <span class="status-pill ${statusPillClass(a.status)}">${esc(a.status)}</span>
  </div>
  <div class="panel-meta">
    <span class="mono">${trunc(a.instanceId, 19)} · ${esc(a.instanceState || "—")}</span>
    <span>updated ${fmtTime(a.lastUpdatedTs)}${a.elapsedSeconds != null ? ` (${a.elapsedSeconds}s ago)` : ""}</span>
    <span>neighbours: ${a.neighbours && a.neighbours.length ? esc(a.neighbours.join(", ")) : "none"}</span>
  </div>
  <div class="metrics-bar">
    <div class="metric"><span class="metric-val">${pct(m.cpu)}</span><span class="metric-label">cpu</span></div>
    <div class="metric"><span class="metric-val">\u2191${fmtBytes(m.netOut)} \u2193${fmtBytes(m.netIn)}</span><span class="metric-label">net</span></div>
    <div class="metric"><span class="metric-val">${m.status != null ? (m.status === 0 ? '[ok]' : '[x]') : '—'}</span><span class="metric-label">health</span></div>
  </div>`;

  if (prev) {
    html += `<div class="iter-section">
      <div class="iter-tag">prev · iter ${prev.iteration}</div>
      <div class="iter-row"><span class="k">did</span><span class="v-action">${esc(prev.action)}</span></div>
    </div>`;
  }
  if (cur) {
    html += `<div class="iter-section">
      <div class="iter-tag">current · iter ${cur.iteration}</div>
      <div class="iter-row"><span class="k">did</span><span class="v-action">${esc(cur.action)}</span></div>
      <div class="iter-row"><span class="k">res</span><span class="v-result">${esc(cur.result)}</span></div>
      <div class="iter-row"><span class="k">next</span><span class="v-next">${esc(cur.next_intent)}</span></div>
    </div>`;
  } else {
    html += `<div class="waiting">waiting for first iteration\u2026</div>`;
  }
  return html;
}

// Track client-side "starting" state for the window between the 202 response
// and the first poll that finds instances. During this window the server
// reports "stopped" because no instances exist yet.
let pendingStart = false;

function render(data) {
  let cs = data.clusterState || "stopped";
  // Override: if we just sent a start request and the server hasn't caught up yet,
  // show "starting" instead of "stopped" until instances appear.
  if (pendingStart && cs === "stopped") {
    cs = "starting";
  } else if (cs !== "stopped") {
    pendingStart = false;
  }
  badge.textContent = cs;
  badge.className = `badge badge-${cs}`;

  // Run timer: use server-provided cluster start time
  if (data.clusterStartTime && (cs === "running" || cs === "starting" || cs === "stopping")) {
    runStartTime = new Date(data.clusterStartTime).getTime();
    updateRunTimer();
  } else if (cs === "stopped") {
    runStartTime = null;
    updateRunTimer();
  }

  // Enable/disable buttons: Start only when stopped, Stop only when running/starting
  const btnStart = document.getElementById("btn-start");
  const btnStop = document.getElementById("btn-stop");
  const canStart = cs === "stopped";
  const canStop = cs === "running" || cs === "starting";
  btnStart.disabled = !canStart;
  btnStart.style.opacity = canStart ? "1" : "0.3";
  btnStop.disabled = !canStop;
  btnStop.style.opacity = canStop ? "1" : "0.3";

  const agents = data.agents || [];
  if (agents.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="icon">\u25CB</div><p>No agents running. Hit Start to spin up the flock.</p></div>`;
    return;
  }
  if (grid.children.length !== agents.length) {
    grid.innerHTML = agents.map(() => '<div class="panel"></div>').join("");
  }
  agents.forEach((a, i) => { grid.children[i].innerHTML = renderPanel(a); });
}

// Suppress fetch errors caused by page unload (browser refresh / navigation).
let unloading = false;
window.addEventListener("beforeunload", () => { unloading = true; });

// ---------- Polling ----------------------------------------------------------
async function poll() {
  try {
    const res = await fetch(`${API}/status`);
    if (!res.ok) { showError(`status ${res.status}: ${await res.text()}`); return; }
    render(await res.json());
  } catch (err) {
    if (!unloading) showError(`poll failed: ${err.message}`);
  }
}

// ---------- Direction --------------------------------------------------------
async function saveDirection() {
  const ta = document.getElementById("in-direction");
  const direction = ta.value.trim();
  try {
    const res = await fetch(`${API}/direction`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction }),
    });
    if (!res.ok) { showError(`save direction failed: ${res.status} ${await res.text()}`); return; }
    ta.classList.remove("error");
    savedDirection = direction;
    syncDirectionBtn();
  } catch (err) { showError(`save direction failed: ${err.message}`); }
}

// ---------- Cluster controls -------------------------------------------------
async function startCluster() {
  const ta = document.getElementById("in-direction");
  if (!ta.value.trim()) {
    ta.classList.add("error");
    showError("Direction is required — describe what the agents should work on before starting.");
    ta.focus();
    return;
  }
  ta.classList.remove("error");
  await saveDirection();
  const btn = document.getElementById("btn-start");
  btn.disabled = true;
  btn.textContent = "Starting\u2026";
  try {
    const cfg = {
      concurrency: parseInt(document.getElementById("in-concurrency").value) || 8,
      neighbourRadius: parseInt(document.getElementById("in-neighbours").value) || 1,
      instanceType: document.getElementById("in-instance").value || "t4g.medium",
      loopIntervalSeconds: parseInt(document.getElementById("in-interval").value) || 30,
      model: null,
    };
    const cfgRes = await fetch(`${API}/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });
    if (!cfgRes.ok) { showError(`config update failed: ${cfgRes.status} ${await cfgRes.text()}`); return; }
    const startRes = await fetch(`${API}/start`, { method: "POST" });
    if (!startRes.ok && startRes.status !== 202) { showError(`start failed: ${startRes.status} ${await startRes.text()}`); return; }
    pendingStart = true;
    await poll();
  } catch (err) { showError(`start failed: ${err.message}`); }
  finally { btn.disabled = false; btn.textContent = "Start"; }
}

async function stopCluster() {
  const btn = document.getElementById("btn-stop");
  btn.disabled = true;
  btn.textContent = "Stopping\u2026";
  try {
    const res = await fetch(`${API}/stop`, { method: "POST" });
    if (!res.ok) { showError(`stop failed: ${res.status} ${await res.text()}`); return; }
    await poll();
  } catch (err) { showError(`stop failed: ${err.message}`); }
  finally { btn.disabled = false; btn.textContent = "Stop"; }
}

poll();
setInterval(poll, POLL_MS);

// Expose functions called from HTML onclick attributes
window.startCluster = startCluster;
window.stopCluster = stopCluster;
window.saveDirection = saveDirection;
window.syncDirectionBtn = syncDirectionBtn;
window.stepVal = stepVal;
window.updateInstanceSpec = updateInstanceSpec;
window.checkCapacity = checkCapacity;
window.downloadHabitatFile = downloadHabitatFile;
window.refreshHabitatFile = refreshHabitatFile;
window.downloadAllFiles = downloadAllFiles;
window.habitatBack = habitatBack;
window.openHabitatFile = openHabitatFile;
window.downloadFile = downloadFile;

} // end initDashboard
