const cpuHistory = [];
const ramHistory = [];
const peerHistory = {};
const MAX_POINTS = 18;

function fmtBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

function fmtRelative(unixSeconds) {
  if (!unixSeconds) return "never";
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtGB(bytes) {
  return (bytes / 1024 ** 3).toFixed(1) + " GB";
}

function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    d += ` Q ${x0} ${y0} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

function renderTrend() {
  const w = 200, h = 30;
  const n = Math.max(cpuHistory.length, ramHistory.length, 2);
  const step = w / (Math.max(n, 2) - 1);

  function toPoints(series) {
    const padded = Array(n - series.length).fill(series[0] ?? 0).concat(series);
    return padded.map((v, i) => [i * step, h - (v / 100) * (h - 3) - 1.5]);
  }

  const cpuPts = toPoints(cpuHistory.length ? cpuHistory : [0]);
  const ramPts = toPoints(ramHistory.length ? ramHistory : [0]);

  const svg = document.getElementById("trendChart");
  svg.innerHTML = `
    <path class="line" d="${smoothPath(ramPts)}" stroke="var(--ram)" opacity="0.85"></path>
    <path class="line" d="${smoothPath(cpuPts)}" stroke="var(--cpu)"></path>
  `;
}

function sparkline(points, w = 60, h = 18) {
  if (points.length < 2) return `<svg class="spark idle" width="${w}" height="${h}"></svg>`;
  const max = Math.max(...points, 1);
  const step = w / (points.length - 1);
  const pts = points.map((v, i) => [i * step, h - (v / max) * (h - 2) - 1]);
  const linePath = smoothPath(pts);
  const areaPath = `${linePath} L ${w} ${h} L 0 ${h} Z`;
  const isIdle = max <= 1;
  return `<svg class="spark ${isIdle ? "idle" : ""}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <path class="area" d="${areaPath}"></path>
    <path class="line" d="${linePath}"></path>
  </svg>`;
}

function updatePeerHistory(peer) {
  const key = peer.allowed_ips;
  const prev = peerHistory[key];
  const total = peer.rx_bytes + peer.tx_bytes;
  let delta = 0;
  if (prev && prev.lastTotal !== undefined) delta = Math.max(0, total - prev.lastTotal);
  if (!peerHistory[key]) peerHistory[key] = { points: [], lastTotal: total };
  peerHistory[key].points.push(delta);
  if (peerHistory[key].points.length > MAX_POINTS) peerHistory[key].points.shift();
  peerHistory[key].lastTotal = total;
  return peerHistory[key].points;
}

function peerRow(p) {
  const points = updatePeerHistory(p);
  return `<div class="peer">
    <div class="peer-id">
      <div class="signal ${p.connected ? "live" : ""}"><div class="signal-core"></div></div>
      <div class="peer-text">
        <div class="peer-name">${p.name}</div>
        <div class="peer-meta">${p.allowed_ips.replace("/32", "")} · ${fmtRelative(p.latest_handshake)}</div>
      </div>
    </div>
    <div class="peer-chart">
      ${sparkline(points)}
      <div class="peer-bytes"><span>↓${fmtBytes(p.rx_bytes)}</span><span>↑${fmtBytes(p.tx_bytes)}</span></div>
    </div>
  </div>`;
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiUrl", "apiToken"], (result) => resolve(result));
  });
}

function saveConfig(apiUrl, apiToken) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ apiUrl, apiToken }, resolve);
  });
}

function showSettings(prefill) {
  document.getElementById("app").style.display = "none";
  document.getElementById("settings").style.display = "block";
  if (prefill?.apiUrl) document.getElementById("apiUrl").value = prefill.apiUrl;
  if (prefill?.apiToken) document.getElementById("apiToken").value = prefill.apiToken;
}

function showApp() {
  document.getElementById("settings").style.display = "none";
  document.getElementById("app").style.display = "block";
}

async function refresh() {
  const { apiUrl, apiToken } = await getConfig();
  if (!apiUrl || !apiToken) return showSettings();

  try {
    const res = await fetch(apiUrl.replace(/\/$/, "") + "/api/status", {
      headers: { Authorization: "Bearer " + apiToken }
    });
    if (res.status === 401) {
      document.getElementById("errorBox").innerHTML =
        `<div class="error-line">Invalid token. Update it in settings.</div>`;
      showApp();
      return;
    }
    const data = await res.json();

    document.getElementById("errorBox").innerHTML = data.wg_error
      ? `<div class="error-line">wg show error: ${data.wg_error}</div>` : "";

    const s = data.system;

    cpuHistory.push(s.cpu_percent);
    ramHistory.push(s.memory_percent);
    if (cpuHistory.length > MAX_POINTS) cpuHistory.shift();
    if (ramHistory.length > MAX_POINTS) ramHistory.shift();

    document.getElementById("cpuValue").textContent = s.cpu_percent.toFixed(0) + "%";
    document.getElementById("ramValue").textContent = s.memory_percent.toFixed(0) + "%";
    document.getElementById("uptimeValue").textContent = fmtUptime(s.uptime_seconds);
    renderTrend();

    const circumference = 150.8;
    const offset = circumference - (s.disk_percent / 100) * circumference;
    document.getElementById("diskRing").style.strokeDashoffset = offset;
    document.getElementById("diskValue").textContent = s.disk_percent.toFixed(0) + "%";

    const anyLive = data.peers.some(p => p.connected);
    document.getElementById("headerDot").classList.toggle("live", anyLive);

    if (data.egress) {
      const q = data.egress;
      document.getElementById("quotaCard").style.display = "block";
      document.getElementById("quotaValue").textContent = `${fmtGB(q.used_bytes)} / 10 TB`;
      const fill = document.getElementById("quotaFill");
      fill.style.width = q.percent + "%";
      fill.classList.toggle("warn", q.percent >= 80);
      document.getElementById("quotaSub").textContent =
        `${q.percent}% used this month (${q.month})`;
    } else {
      document.getElementById("quotaCard").style.display = "none";
    }

    document.getElementById("peers").innerHTML =
      data.peers.length ? data.peers.map(peerRow).join("") :
      `<div class="empty-state">No devices found</div>`;

    document.getElementById("updated").textContent =
      "Last Updated: " + new Date(data.generated_at * 1000).toLocaleTimeString("en-GB", { hour12: false });

    showApp();
  } catch (e) {
    document.getElementById("errorBox").innerHTML =
      `<div class="error-line">Could not reach server: ${e.message}</div>`;
    showApp();
  }
}

document.getElementById("refreshBtn").addEventListener("click", refresh);

document.getElementById("gearBtn").addEventListener("click", async () => {
  const cfg = await getConfig();
  showSettings(cfg);
});

function showSettingsError(message) {
  document.getElementById("errorBox").innerHTML = `<div class="error-line">${message}</div>`;
  showApp();
}

document.getElementById("saveBtn").addEventListener("click", async () => {
  const apiUrl = document.getElementById("apiUrl").value.trim();
  const apiToken = document.getElementById("apiToken").value.trim();
  if (!apiUrl || !apiToken) return;

  let originPattern;
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:") return showSettingsError("Dashboard URL must use https://");
    originPattern = url.origin + "/*";
  } catch {
    return showSettingsError("Invalid dashboard URL.");
  }

  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) return showSettingsError("Permission to reach the dashboard was denied.");

  await saveConfig(apiUrl, apiToken);
  refresh();
});

refresh();
