
const CLASS_COLORS = {
  Benign: "#34d399",
  DDoS:   "#f87171",
  DoS:    "#fb923c",
  Mirai:  "#f472b6",
  Other:  "#fbbf24",
  Recon:  "#a78bfa",
};

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

async function checkHealth() {
  const dot = document.getElementById("modelStatusDot");
  const text = document.getElementById("modelStatusText");
  const meta = document.getElementById("modelMeta");
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (res.ok) {
      dot.classList.add("ok");
      text.textContent = "Model online";
      meta.textContent = data.num_features_expected
        ? `${data.num_features_expected} features · ${data.classes.length} classes`
        : `${data.classes.length} classes`;
    } else {
      throw new Error("bad response");
    }
  } catch (e) {
    dot.classList.add("err");
    text.textContent = "Model unavailable";
  }
}
checkHealth();

function wireDropzone(zoneId, inputId, nameId, onFile) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  const nameEl = document.getElementById(nameId);

  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    if (input.files[0]) {
      nameEl.textContent = input.files[0].name;
      onFile(input.files[0]);
    }
  });

  ["dragover", "dragenter"].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove("dragover"); })
  );
  zone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) {
      input.files = e.dataTransfer.files;
      nameEl.textContent = file.name;
      onFile(file);
    }
  });
}

function showError(elId, message) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.classList.remove("hidden");
}

function hideError(elId) {
  document.getElementById(elId).classList.add("hidden");
}

function buildReasonSentence(prediction, topFeatures) {
  if (!topFeatures || topFeatures.length === 0) {
    return `Classified as ${prediction} — no feature attribution available for this row.`;
  }

  const supporting = topFeatures.filter((f) => f.direction === "increased");
  const opposing = topFeatures.filter((f) => f.direction === "decreased");

  if (supporting.length > 0) {
    const names = supporting.slice(0, 2).map((f) => `${f.feature}`).join(" and ");
    let sentence = `Flagged as <strong>${prediction}</strong> mainly because of ${names} — these values pushed the model's score toward ${prediction} the most.`;
    if (opposing.length > 0) {
      sentence += ` (${opposing[0].feature} pointed away from this verdict but was outweighed by the rest.)`;
    }
    return sentence;
  }

  return `Flagged as <strong>${prediction}</strong>. The single strongest factor, ${topFeatures[0].feature}, actually argued against this verdict — the combined, smaller effect of the remaining features still tipped the classification toward ${prediction}.`;
}

function renderExplanationBars(containerId, topFeatures) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  if (!topFeatures || topFeatures.length === 0) {
    container.innerHTML = '<div class="explain-empty">No feature attribution available.</div>';
    return;
  }

  const maxAbs = Math.max(...topFeatures.map((f) => Math.abs(f.contribution)), 1e-9);

  topFeatures.forEach((f) => {
    const isPos = f.direction === "increased";
    const pct = (Math.abs(f.contribution) / maxAbs) * 50;
    const row = document.createElement("div");
    row.className = "explain-row";
    row.innerHTML = `
      <div class="explain-feature">
        <span class="explain-name">${f.feature}</span>
        <span class="explain-value">value: ${f.value}</span>
      </div>
      <div class="explain-bar-track">
        <div class="explain-bar-center"></div>
        <div class="explain-bar-fill ${isPos ? "pos" : "neg"}" style="width:${pct}%"></div>
      </div>
      <div class="explain-contribution ${isPos ? "pos" : "neg"}">${f.contribution > 0 ? "+" : ""}${f.contribution.toFixed(3)}</div>
    `;
    container.appendChild(row);
  });

  const legend = document.createElement("div");
  legend.className = "explain-legend";
  legend.innerHTML = `
    <span><span class="swatch pos"></span> supports this verdict</span>
    <span><span class="swatch neg"></span> argues against it</span>
  `;
  container.appendChild(legend);
}


let batchFile = null;

wireDropzone("batchDropzone", "batchFileInput", "batchFileName", (file) => {
  batchFile = file;
  document.getElementById("batchAnalyzeBtn").disabled = false;
  hideError("batchError");
});

document.getElementById("batchAnalyzeBtn").addEventListener("click", async () => {
  if (!batchFile) return;
  const btn = document.getElementById("batchAnalyzeBtn");
  btn.disabled = true;
  btn.textContent = "Analyzing...";
  hideError("batchError");
  document.getElementById("batchResults").classList.add("hidden");

  const formData = new FormData();
  formData.append("file", batchFile);

  try {
    const res = await fetch("/api/batch_predict", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Analysis failed.");
    renderBatchResults(data);
  } catch (e) {
    showError("batchError", e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Analyze Traffic";
  }
});

let batchPreviewRows = [];

function renderBatchResults(data) {
  document.getElementById("statTotal").textContent = data.total_rows.toLocaleString();
  document.getElementById("statBenign").textContent = data.benign_count.toLocaleString();
  document.getElementById("statAttacks").textContent = data.attack_count.toLocaleString();
  document.getElementById("statRatio").textContent = `${(data.attack_ratio * 100).toFixed(1)}%`;

  renderChart("chartContainer", data.summary, data.total_rows);

  batchPreviewRows = data.preview;
  const tbody = document.getElementById("previewTbody");
  tbody.innerHTML = "";
  data.preview.forEach((row, idx) => {
    const tr = document.createElement("tr");
    const isBenign = row.prediction === "Benign";
    tr.className = "row-clickable";
    tr.dataset.idx = idx;
    tr.innerHTML = `
      <td>${row.row}</td>
      <td><span class="pred-badge ${isBenign ? "benign" : "attack"}">${row.prediction}</span></td>
      <td>${(row.confidence * 100).toFixed(1)}%</td>
    `;
    tr.addEventListener("click", () => selectBatchRow(idx));
    tbody.appendChild(tr);
  });

  const note = document.getElementById("previewNote");
  note.textContent = data.preview_truncated
    ? `Showing first ${data.preview.length.toLocaleString()} of ${data.total_rows.toLocaleString()} rows. Click a row to see why it was flagged.`
    : `Showing all ${data.total_rows.toLocaleString()} rows. Click a row to see why it was flagged.`;

  document.getElementById("batchResults").classList.remove("hidden");

  if (data.preview.length > 0) selectBatchRow(0);
}

function selectBatchRow(idx) {
  const row = batchPreviewRows[idx];
  if (!row) return;

  document.querySelectorAll("#previewTbody tr").forEach((tr) => tr.classList.remove("row-selected"));
  const tr = document.querySelector(`#previewTbody tr[data-idx="${idx}"]`);
  if (tr) tr.classList.add("row-selected");

  document.getElementById("batchExplainTarget").textContent = `(row ${row.row})`;
  document.getElementById("batchExplainSentence").innerHTML = buildReasonSentence(row.prediction, row.top_features);
  renderExplanationBars("batchExplainBars", row.top_features);
}

function renderChart(containerId, summary, total) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  Object.entries(summary).forEach(([label, count]) => {
    const pct = total ? (count / total) * 100 : 0;
    const row = document.createElement("div");
    row.className = "chart-row";
    row.innerHTML = `
      <div class="chart-row-label">${label}</div>
      <div class="chart-bar-track">
        <div class="chart-bar-fill" style="width:${pct}%; background:${CLASS_COLORS[label] || "#888"}"></div>
      </div>
      <div class="chart-row-value">${count.toLocaleString()}</div>
    `;
    container.appendChild(row);
  });
}

let liveFile = null;
let liveSessionId = null;
let liveTimer = null;
let liveStats = { total: 0, benign: 0, attacks: 0 };

wireDropzone("liveDropzone", "liveFileInput", "liveFileName", async (file) => {
  liveFile = file;
  hideError("liveError");
  document.getElementById("liveStartBtn").disabled = true;
  document.getElementById("liveFileName").textContent = `Uploading ${file.name}...`;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/stream/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    liveSessionId = data.session_id;
    document.getElementById("liveFileName").textContent =
      `${file.name} (${data.total_rows.toLocaleString()} rows ready to stream)`;
    document.getElementById("liveStartBtn").disabled = false;
  } catch (e) {
    showError("liveError", e.message);
    document.getElementById("liveFileName").textContent = "No file selected";
  }
});

document.getElementById("liveStartBtn").addEventListener("click", startStream);
document.getElementById("liveStopBtn").addEventListener("click", stopStream);

const MIN_INTERVAL_SEC = 0.2;
const DEFAULT_INTERVAL_SEC = 1.5;

function getIntervalMs() {
  const input = document.getElementById("liveInterval");
  let seconds = parseFloat(input.value);
  if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SEC) {
    seconds = DEFAULT_INTERVAL_SEC;
    input.value = seconds;
  }
  return seconds * 1000;
}

function startStream() {
  if (!liveSessionId) return;
  hideError("liveError");
  liveStats = { total: 0, benign: 0, attacks: 0 };
  updateLiveStats();
  document.getElementById("liveLogTbody").innerHTML = "";
  document.getElementById("liveResults").classList.remove("hidden");

  document.getElementById("liveStartBtn").disabled = true;
  document.getElementById("liveStopBtn").disabled = false;
  document.getElementById("liveDropzone").style.pointerEvents = "none";
  document.getElementById("liveDropzone").style.opacity = "0.6";

  const statusEl = document.getElementById("streamStatusValue");
  statusEl.textContent = "Running";
  statusEl.classList.add("running");

  const interval = getIntervalMs();
  pollOnce();
  liveTimer = setInterval(pollOnce, interval);
}

function stopStream() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  document.getElementById("liveStartBtn").disabled = false;
  document.getElementById("liveStopBtn").disabled = true;
  document.getElementById("liveDropzone").style.pointerEvents = "auto";
  document.getElementById("liveDropzone").style.opacity = "1";

  const statusEl = document.getElementById("streamStatusValue");
  statusEl.textContent = "Stopped";
  statusEl.classList.remove("running");
}

async function pollOnce() {
  try {
    const res = await fetch(`/api/stream/next?session_id=${encodeURIComponent(liveSessionId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Stream error.");

    liveStats.total += 1;
    if (data.is_attack) liveStats.attacks += 1; else liveStats.benign += 1;
    updateLiveStats();
    appendLiveLogRow(data);
    updateLiveExplanation(data);
  } catch (e) {
    showError("liveError", e.message);
    stopStream();
  }
}

function updateLiveStats() {
  document.getElementById("liveTotal").textContent = liveStats.total.toLocaleString();
  document.getElementById("liveBenign").textContent = liveStats.benign.toLocaleString();
  document.getElementById("liveAttacks").textContent = liveStats.attacks.toLocaleString();
}

const MAX_LOG_ROWS = 100;

function appendLiveLogRow(data) {
  const tbody = document.getElementById("liveLogTbody");
  const tr = document.createElement("tr");
  tr.className = `flash-row ${data.is_attack ? "attack" : "benign"}`;
  tr.innerHTML = `
    <td>${data.time}</td>
    <td>${data.row_index}</td>
    <td><span class="pred-badge ${data.is_attack ? "attack" : "benign"}">${data.prediction}</span></td>
    <td>${(data.confidence * 100).toFixed(1)}%</td>
  `;
  tbody.insertBefore(tr, tbody.firstChild);

  while (tbody.children.length > MAX_LOG_ROWS) {
    tbody.removeChild(tbody.lastChild);
  }
}

function updateLiveExplanation(data) {
  document.getElementById("liveExplainTarget").textContent = `(row ${data.row_index} · ${data.time})`;
  document.getElementById("liveExplainSentence").innerHTML = buildReasonSentence(data.prediction, data.top_features);
  renderExplanationBars("liveExplainBars", data.top_features);
}
