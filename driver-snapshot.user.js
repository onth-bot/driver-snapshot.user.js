// ==UserScript==
// @name         Driver Snapshot - Split Behind vs On Track (Red/Green) + Copy Photos
// @namespace    https://github.com/onth/scripts
// @version      5.5.1
// @description  Create two shareable snapshot images: BEHIND/NEEDS ATTENTION (<threshold) and ON TRACK (>=threshold), with Download + Copy Photo
// @match        https://logistics.amazon.com/operations/execution/itineraries*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/<OWNER>/<REPO>/<BRANCH>/userscripts/driver-snapshot.user.js
// @updateURL    https://raw.githubusercontent.com/<OWNER>/<REPO>/<BRANCH>/userscripts/driver-snapshot.user.js
// @homepageURL  https://github.com/<OWNER>/<REPO>
// ==/UserScript==
(function () {
  "use strict";

  /**
   * ==========================
   * CONFIG (edit only here)
   * ==========================
   * Change SNAPSHOT.THRESHOLD_ON_TRACK one time and it updates:
   * - grouping (behind vs on track)
   * - labels (top legend + card badge + footer + button text)
   */
  const SNAPSHOT = Object.freeze({
    THRESHOLD_ON_TRACK: 75 // >= is ON TRACK, < is BEHIND / NEEDS ATTENTION
  });

  const SELECTORS = {
    rows: '[data-testid="allow-text-selection-div"]',
    scrollPanel: ".fp-page-template"
  };

  // Higher-contrast split: BEHIND = red, ON TRACK = green
  const THEME = {
    page: "#0a0a0a",
    hero: "#111214",
    card: "#18191d",
    border: "#2a2c31",

    text: "#f0efe8",
    body: "#c8c8c8",
    muted: "#8b8d95",

    // Group colors (used for the big badge + headers accents)
    behind: "#ff4d4d",
    behindTint: "rgba(255,77,77,0.12)",
    behindBorder: "rgba(255,77,77,0.30)",

    onTrack: "#39d98a",
    onTrackTint: "rgba(57,217,138,0.12)",
    onTrackBorder: "rgba(57,217,138,0.30)",

    // Row/performance colors (progress bar color by completion %)
    danger: "#ff6b6b",
    warning: "#f5b880",
    success: "#39d98a",
    info: "#8fd3ff"
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function safeInt(x, fallback = 0) {
    const n = parseInt(String(x ?? "").replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function normalizeName(name) {
    return String(name || "Unknown").replace(/\s+/g, " ").trim();
  }

  function parseRow(text) {
    const t = String(text || "");
    const lines = t.split("\n").map((s) => s.trim()).filter(Boolean);
    const name = normalizeName(lines[0] || "Unknown");

    let stopsDone = 0;
    let totalStops = 0;
    const stopsMatch = t.match(/(\d+)\s*\/\s*(\d+)\s*stops/i);
    if (stopsMatch) {
      stopsDone = safeInt(stopsMatch[1], 0);
      totalStops = safeInt(stopsMatch[2], 0);
    }

    const routeCompletion =
      totalStops > 0 ? clamp(Math.round((stopsDone / totalStops) * 100), 0, 100) : 0;

    const sphMatch = t.match(/\bAvg:\s*(\d+)\b/i);
    const sph = sphMatch ? safeInt(sphMatch[1], null) : null;

    const paceMatch = t.match(/\bPace:\s*(\d+)\b/i);
    const pace = paceMatch ? safeInt(paceMatch[1], null) : null;

    const rtsMatch = t.match(/\bProjected RTS:\s*([0-2]?\d:\d{2}\s*[ap]m)\b/i);
    const projectedRTS = rtsMatch ? rtsMatch[1].replace(/\s+/g, "").toLowerCase() : null;

    return { name, totalStops, stopsDone, routeCompletion, sph, pace, projectedRTS };
  }

  function extractData() {
    const rowElements = document.querySelectorAll(SELECTORS.rows);
    const drivers = [];
    rowElements.forEach((row) => {
      const d = parseRow(row.innerText || "");
      if (!d.name || d.name.toLowerCase() === "unknown") return;
      drivers.push(d);
    });
    return drivers;
  }

  function calculateStats(data) {
    const total = data.length || 1;
    const avgCompletion = Math.round(
      data.reduce((sum, d) => sum + (d.routeCompletion || 0), 0) / total
    );

    const totalStops = data.reduce((sum, d) => sum + (d.totalStops || 0), 0);
    const completedStops = data.reduce((sum, d) => sum + (d.stopsDone || 0), 0);
    const remainingStops = Math.max(0, totalStops - completedStops);

    // Stops/hour avg for the group (average of drivers that actually have an SPH value)
    const sphValues = data
      .map((d) => (typeof d.sph === "number" ? d.sph : null))
      .filter((v) => v != null);

    const avgSPH =
      sphValues.length > 0
        ? Math.round(sphValues.reduce((sum, v) => sum + v, 0) / sphValues.length)
        : null;

    return { total: data.length, avgCompletion, totalStops, completedStops, remainingStops, avgSPH };
  }

  // Sorting rules:
  // - BEHIND: furthest behind first (lowest completion % at top)
  // - ON TRACK: furthest from being done first (lowest completion % at top)
  // Tie-breaker: driver name A→Z
  function sortBehind(arr) {
    return arr.sort((a, b) => {
      const da = a.routeCompletion ?? 0;
      const db = b.routeCompletion ?? 0;
      if (da !== db) return da - db;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }

  function sortOnTrack(arr) {
    return arr.sort((a, b) => {
      const da = a.routeCompletion ?? 0;
      const db = b.routeCompletion ?? 0;
      if (da !== db) return da - db;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }

  // Row color (independent of which card you’re on)
  function getPerformanceColor(completion) {
    const threshold = SNAPSHOT.THRESHOLD_ON_TRACK;
    if (completion >= 90) return THEME.success;
    if (completion >= threshold) return THEME.onTrack;
    if (completion >= 50) return THEME.warning;
    return THEME.danger;
  }

  function ensureHtml2CanvasLoaded() {
    return new Promise((resolve, reject) => {
      if (window.html2canvas) return resolve();
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load html2canvas"));
      document.head.appendChild(s);
    });
  }

  function toast(msg, kind = "info") {
    let el = document.getElementById("snapshot-toast");
    if (el) el.remove();

    el = document.createElement("div");
    el.id = "snapshot-toast";

    const bg =
      kind === "success"
        ? "rgba(57,217,138,0.14)"
        : kind === "danger"
          ? "rgba(255,77,77,0.14)"
          : kind === "warning"
            ? "rgba(245,184,128,0.14)"
            : "rgba(143,211,255,0.10)";

    const border =
      kind === "success"
        ? "rgba(57,217,138,0.30)"
        : kind === "danger"
          ? "rgba(255,77,77,0.30)"
          : kind === "warning"
            ? "rgba(245,184,128,0.30)"
            : "rgba(143,211,255,0.26)";

    Object.assign(el.style, {
      position: "fixed",
      bottom: "18px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "1000001",
      background: bg,
      border: `1px solid ${border}`,
      color: THEME.text,
      padding: "10px 12px",
      borderRadius: "12px",
      fontWeight: "900",
      fontSize: "12px",
      backdropFilter: "blur(8px)",
      maxWidth: "80vw",
      textAlign: "center"
    });

    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function filenameFor(kind) {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "_",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0")
    ].join("");
    return `driver-snapshot_${kind}_${stamp}.png`;
  }

  async function captureBlobFromElement(el) {
    if (!el) return null;
    await ensureHtml2CanvasLoaded();
    await sleep(120);

    const canvas = await window.html2canvas(el, {
      backgroundColor: THEME.page,
      scale: 2,
      useCORS: true,
      logging: false
    });

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob || null;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadCard(kind) {
    const el = document.getElementById(
      kind === "behind" ? "snapshot-card-behind" : "snapshot-card-ontrack"
    );
    const blob = await captureBlobFromElement(el);
    if (!blob) return;
    downloadBlob(blob, filenameFor(kind));
  }

  async function copyCard(kind) {
    const el = document.getElementById(
      kind === "behind" ? "snapshot-card-behind" : "snapshot-card-ontrack"
    );
    const blob = await captureBlobFromElement(el);
    if (!blob) return;

    try {
      if (!navigator.clipboard || !window.ClipboardItem) {
        toast("Copy not supported here. Use Download PNG.", "warning");
        return;
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast(`${kind === "behind" ? "BEHIND" : "ON TRACK"} snapshot copied. Paste it into chat.`, "success");
    } catch {
      toast("Could not copy. Use Download PNG (browser/permission restriction).", "warning");
    }
  }

  async function downloadBoth() {
    await downloadCard("behind");
    await sleep(250);
    await downloadCard("ontrack");
  }

  function cardLabel(kind) {
    const t = SNAPSHOT.THRESHOLD_ON_TRACK;
    if (kind === "behind") return `BEHIND / NEEDS ATTENTION (<${t}%)`;
    return `ON TRACK (≥${t}%)`;
  }

  function cardSubtitle(kind) {
    return kind === "behind"
      ? "Sorted by: Lowest completion first (furthest behind at top)"
      : "Sorted by: Lowest completion first (furthest from done at top)";
  }

  function renderCard(kind, data, now) {
    const stats = calculateStats(data);
    const dateStr = now.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit"
    });
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    const rows = data
      .map((d, i) => {
        const color = getPerformanceColor(d.routeCompletion);
        const rts = d.projectedRTS ? d.projectedRTS : "—";
        const rtsClass = d.projectedRTS ? "" : "na";
        const sph = d.sph == null ? "—" : String(d.sph);
        const pace = d.pace == null ? "—" : String(d.pace);

        const remaining = Math.max(0, (d.totalStops || 0) - (d.stopsDone || 0));

        return `
        <div class="trow">
          <div class="num">${i + 1}</div>
          <div class="name">${d.name}</div>
          <div class="center">${d.totalStops || 0}</div>
          <div class="center">${remaining}</div>
          <div class="progress">
            <div class="bar">
              <div class="fill" style="width:${d.routeCompletion}%;background:${color}"></div>
            </div>
            <div class="pct" style="color:${color}">${d.routeCompletion}%</div>
          </div>
          <div class="center">${sph}</div>
          <div class="center">${pace}</div>
          <div class="center"><span class="pill ${rtsClass}">${rts}</span></div>
        </div>
      `;
      })
      .join("");

    const id = kind === "behind" ? "snapshot-card-behind" : "snapshot-card-ontrack";

    const tone =
      kind === "behind"
        ? { tint: THEME.behindTint, border: THEME.behindBorder, color: THEME.behind }
        : { tint: THEME.onTrackTint, border: THEME.onTrackBorder, color: THEME.onTrack };

    const badgeTone = `background: ${tone.tint}; border: 1px solid ${tone.border}; color: ${tone.color};`;

    const avgSPHText = stats.avgSPH == null ? "—" : String(stats.avgSPH);

    return `
      <div class="card-wrap">
        <div id="${id}" class="snapshot-card">
          <div class="card-header">
            <div class="title-row">
              <div class="title">
                <h1>Driver Performance Snapshot</h1>
                <div class="subtitle">${cardSubtitle(kind)}</div>
              </div>
              <div class="meta">
                <div>${dateStr} • ${timeStr}</div>
                <div>${stats.total} drivers • Avg ${stats.avgCompletion}%</div>
              </div>
            </div>

            <div class="section-badge" style="${badgeTone}">
              ${cardLabel(kind)}
            </div>

            <!-- Definition text removed per request -->

            <div class="stats">
              <div class="stat">
                <div class="label">Drivers</div>
                <div class="value">${stats.total}</div>
                <div class="hint">In this group</div>
              </div>
              <div class="stat">
                <div class="label">Average completion</div>
                <div class="value" style="color:${tone.color}">${stats.avgCompletion}%</div>
                <div class="hint">Group average</div>
              </div>
              <div class="stat">
                <div class="label">Stops remaining</div>
                <div class="value">${(stats.remainingStops || 0).toLocaleString()}</div>
                <div class="hint">of ${(stats.totalStops || 0).toLocaleString()}</div>
              </div>
              <div class="stat">
                <div class="label">Stops / hour (avg)</div>
                <div class="value" style="color:${tone.color}">${avgSPHText}</div>
                <div class="hint">Group average</div>
              </div>
            </div>
          </div>

          <div class="table">
            <div class="thead ${kind === "behind" ? "thead-behind" : "thead-ontrack"}">
              <div style="text-align:center">#</div>
              <div>Driver</div>
              <div style="text-align:center">Total</div>
              <div style="text-align:center">Remaining</div>
              <div>Progress</div>
              <div style="text-align:center">SPH</div>
              <div style="text-align:center">Pace</div>
              <div style="text-align:center">RTS</div>
            </div>

            <div class="tbody">
              ${
                rows ||
                `<div class="trow"><div class="name" style="grid-column: 1 / -1;">No drivers in this group.</div></div>`
              }
            </div>
          </div>

          <div class="footer">
            ${cardLabel(kind)} • Share as image
          </div>
        </div>
      </div>
    `;
  }

  function renderSplit(behind, ontrack) {
    const existing = document.getElementById("snapshot-overlay");
    if (existing) existing.remove();

    const now = new Date();
    const t = SNAPSHOT.THRESHOLD_ON_TRACK;

    const overlay = document.createElement("div");
    overlay.id = "snapshot-overlay";

    overlay.innerHTML = `
      <style>
        :root{
          --page:${THEME.page};
          --hero:${THEME.hero};
          --card:${THEME.card};
          --border:${THEME.border};

          --text:${THEME.text};
          --body:${THEME.body};
          --muted:${THEME.muted};

          --behind:${THEME.behind};
          --behindTint:${THEME.behindTint};
          --behindBorder:${THEME.behindBorder};

          --onTrack:${THEME.onTrack};
          --onTrackTint:${THEME.onTrackTint};
          --onTrackBorder:${THEME.onTrackBorder};
        }
        * { box-sizing: border-box; }

        #snapshot-overlay{
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.60);
          z-index: 1000000;
          overflow: auto;
          padding: 18px;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Noto Sans", "Helvetica Neue", sans-serif;
        }

        .topbar{
          max-width: 1160px;
          margin: 0 auto 12px auto;
          display:flex;
          gap:10px;
          align-items:center;
          justify-content: space-between;
          flex-wrap: wrap;
        }

        .topbar .left{
          color: var(--text);
          font-weight: 950;
          font-size: 13px;
        }
        .topbar .left .legend{
          display:flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 6px;
          color: var(--muted);
          font-weight: 900;
          font-size: 12px;
        }
        .tag{
          display:inline-flex;
          align-items:center;
          gap: 8px;
          border-radius: 999px;
          padding: 6px 10px;
          border: 1px solid var(--border);
          background: rgba(255,255,255,0.02);
          white-space: nowrap;
        }
        .dot{
          width: 10px;
          height: 10px;
          border-radius: 999px;
        }
        .dot.behind{ background: var(--behind); box-shadow: 0 0 0 4px rgba(255,77,77,0.15); }
        .dot.ontrack{ background: var(--onTrack); box-shadow: 0 0 0 4px rgba(57,217,138,0.15); }

        .top-actions{
          display:flex;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
          align-items: center;
        }

        .btn{
          border-radius: 12px;
          padding: 10px 14px;
          font-weight: 950;
          font-size: 13px;
          cursor:pointer;
          color: var(--page);
          background: var(--onTrack);
          border: 1px solid rgba(0,0,0,0.20);
        }
        .btn.secondary{
          background: transparent;
          border: 1px solid var(--border);
          color: var(--text);
        }
        .btn.behind{
          background: var(--behind);
          color: var(--page);
        }
        .btn.ontrack{
          background: var(--onTrack);
          color: var(--page);
        }

        .grid{
          max-width: 1160px;
          margin: 0 auto;
          display:grid;
          grid-template-columns: 1fr;
          gap: 14px;
        }

        .card-wrap{
          display:flex;
          flex-direction: column;
          gap: 10px;
        }

        .snapshot-card{
          width: 1120px;
          margin: 0 auto;
          background: linear-gradient(180deg, var(--hero), var(--page));
          border: 1px solid var(--border);
          border-radius: 18px;
          overflow: hidden;
          box-shadow: 0 26px 70px rgba(0,0,0,0.45);
        }

        .card-header{
          padding: 18px 18px 14px 18px;
          border-bottom: 1px solid var(--border);
          background: linear-gradient(180deg, var(--hero), rgba(17,18,20,0.2));
        }

        .title-row{
          display:flex;
          justify-content: space-between;
          align-items:flex-start;
          gap: 14px;
        }

        .title h1{
          margin:0;
          font-size: 20px;
          letter-spacing: -0.2px;
          color: var(--text);
        }
        .subtitle{
          margin-top: 6px;
          color: var(--muted);
          font-size: 12px;
          font-weight: 900;
        }
        .meta{
          color: var(--muted);
          font-size: 12px;
          font-weight: 900;
          text-align:right;
          white-space: nowrap;
        }

        .section-badge{
          margin-top: 12px;
          display:inline-block;
          padding: 8px 10px;
          border-radius: 14px;
          font-weight: 1000;
          font-size: 12px;
          letter-spacing: 0.6px;
          text-transform: uppercase;
        }

        .badge-help{
          margin-top: 6px;
          color: var(--muted);
          font-size: 12px;
          font-weight: 900;
        }

        .stats{
          display:grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
          margin-top: 12px;
        }
        .stat{
          background: rgba(255,255,255,0.02);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 12px 12px;
        }
        .stat .label{
          color: var(--muted);
          font-size: 11px;
          font-weight: 950;
          text-transform: uppercase;
          letter-spacing: 0.6px;
        }
        .stat .value{
          color: var(--text);
          font-size: 22px;
          font-weight: 1000;
          margin-top: 6px;
        }
        .stat .hint{
          color: var(--muted);
          font-size: 11px;
          font-weight: 900;
          margin-top: 3px;
        }

        .table{ padding: 12px 14px 16px 14px; }

        .thead, .trow{
          display:grid;
          grid-template-columns: 46px 1.3fr 90px 90px 1.6fr 80px 80px 110px;
          gap: 10px;
          align-items:center;
        }

        .thead{
          padding: 10px 10px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 1000;
          text-transform: uppercase;
          letter-spacing: 0.6px;
          border: 1px solid rgba(255,255,255,0.06);
          background: rgba(255,255,255,0.02);
          color: var(--text);
        }
        .thead-behind{
          border-color: var(--behindBorder);
          background: var(--behindTint);
          color: var(--behind);
        }
        .thead-ontrack{
          border-color: var(--onTrackBorder);
          background: var(--onTrackTint);
          color: var(--onTrack);
        }

        .tbody{
          margin-top: 10px;
          border: 1px solid var(--border);
          border-radius: 12px;
          overflow:hidden;
          background: rgba(255,255,255,0.01);
        }

        .trow{
          padding: 10px 10px;
          border-bottom: 1px solid rgba(42,44,49,0.8);
        }
        .trow:nth-child(even){ background: rgba(255,255,255,0.015); }
        .trow:last-child{ border-bottom: none; }

        .num{
          color: var(--muted);
          font-weight: 1000;
          font-size: 12px;
          text-align:center;
        }
        .name{
          color: var(--text);
          font-weight: 1000;
          font-size: 13px;
          overflow:hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .center{
          text-align:center;
          color: var(--body);
          font-weight: 950;
          font-size: 13px;
        }

        .progress{
          display:flex;
          align-items:center;
          gap: 10px;
        }
        .bar{
          flex: 1;
          height: 9px;
          background: rgba(120,121,127,0.25);
          border-radius: 999px;
          overflow:hidden;
          border: 1px solid rgba(42,44,49,1);
        }
        .fill{
          height: 100%;
          border-radius: 999px;
        }
        .pct{
          width: 50px;
          text-align:right;
          font-weight: 1000;
          font-size: 12px;
        }

        .pill{
          display:inline-block;
          padding: 5px 8px;
          border-radius: 12px;
          font-weight: 1000;
          font-size: 12px;
          text-align:center;
          min-width: 92px;
          background: rgba(255,255,255,0.03);
          color: var(--text);
          border: 1px solid rgba(255,255,255,0.08);
        }
        .pill.na{
          background: rgba(120,121,127,0.12);
          color: #c8c8c8;
          border-color: rgba(120,121,127,0.25);
        }

        .footer{
          padding: 10px 14px 14px 14px;
          color: rgba(120,121,127,0.95);
          font-size: 11px;
          font-weight: 900;
          text-align:center;
        }

        @media (max-width: 1160px){
          .snapshot-card{ width: 1000px; }
        }
      </style>

      <div class="topbar">
        <div class="left">
          Split snapshots (completion right now):
          <div class="legend">
            <span class="tag"><span class="dot behind"></span><b style="color:var(--behind)">BEHIND / NEEDS ATTENTION</b> = &lt;${t}%</span>
            <span class="tag"><span class="dot ontrack"></span><b style="color:var(--onTrack)">ON TRACK</b> = ≥${t}%</span>
          </div>
        </div>

        <div class="top-actions">
          <button class="btn behind" id="copy-behind">Copy BEHIND Photo</button>
          <button class="btn ontrack" id="copy-ontrack">Copy ON TRACK Photo</button>
          <button class="btn secondary" id="close-overlay">Close</button>
          <button class="btn" id="download-both">Download Both</button>
        </div>
      </div>

      <div class="grid">
        ${renderCard("behind", behind, now)}
        ${renderCard("ontrack", ontrack, now)}
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector("#close-overlay").onclick = () => overlay.remove();
    overlay.querySelector("#download-both").onclick = downloadBoth;

    overlay.querySelector("#copy-behind").onclick = () => copyCard("behind");
    overlay.querySelector("#copy-ontrack").onclick = () => copyCard("ontrack");
  }

  async function runScraper() {
    const panel = document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
    if (!panel) return;

    panel.scrollTop = 0;
    await sleep(900);

    const allData = new Map();
    let stagnantCount = 0;
    let lastSize = 0;

    for (let i = 0; i < 60; i++) {
      const batch = extractData();
      batch.forEach((d) => allData.set(d.name, d));

      if (allData.size === lastSize) stagnantCount++;
      else stagnantCount = 0;

      if (stagnantCount > 4) break;

      lastSize = allData.size;
      panel.scrollTop += 900;
      await sleep(450);
    }

    const data = Array.from(allData.values());
    if (!data.length) {
      toast("No rows detected yet. Try scrolling a bit then Generate again.", "warning");
      renderSplit([], []);
      return;
    }

    const t = SNAPSHOT.THRESHOLD_ON_TRACK;

    const behind = sortBehind(data.filter((d) => (d.routeCompletion || 0) < t));
    const ontrack = sortOnTrack(data.filter((d) => (d.routeCompletion || 0) >= t));

    renderSplit(behind, ontrack);
  }

  function addTriggerButton() {
    if (document.getElementById("pull-data-btn")) return;

    const btn = document.createElement("button");
    btn.id = "pull-data-btn";
    btn.textContent = "Generate Split Snapshot";
    Object.assign(btn.style, {
      position: "fixed",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "999999",
      padding: "12px 18px",
      background: THEME.onTrack,
      color: THEME.page,
      border: `1px solid ${THEME.onTrackBorder}`,
      borderRadius: "14px",
      cursor: "pointer",
      fontWeight: "1000",
      fontSize: "13px",
      boxShadow: "0 14px 30px rgba(57,217,138,0.18)"
    });

    btn.onmouseenter = () => (btn.style.filter = "brightness(0.95)");
    btn.onmouseleave = () => (btn.style.filter = "none");
    btn.onclick = runScraper;

    document.body.appendChild(btn);
  }

  addTriggerButton();
})();
