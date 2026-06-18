/* pandabytes status — dashboard page renderer */
'use strict';

let SNAP = null;       // current snapshot-shaped data being rendered
const expanded = new Set();

function statusBadge(s) {
  const st = PB.normStatus(s);
  return `<span class="badge b-${st}"><span class="swatch sw-${st}"></span>${st}</span>`;
}

function renderStats(snap) {
  const el = document.getElementById('statbar');
  const srcs = snap.sources || [];
  const stats = snap.stats || {};
  const total = stats.sources_total || srcs.length;
  const factRows = stats.total_fact_rows != null ? stats.total_fact_rows
    : srcs.reduce((a, s) => a + (Number(s.fact_rows) || 0), 0);
  const counts = {};
  PB.STATUS_LIST.concat('UNKNOWN').forEach(s => counts[s] = 0);
  srcs.forEach(s => counts[PB.normStatus(s.status)]++);
  const problems = (counts.MISSING || 0) + (counts.STALLED || 0) + (counts.STALE || 0);
  const ago = PB.parseTs(snap.generated_at);
  const agoTxt = ago ? timeAgo(ago) : '—';

  el.innerHTML = `
    <div class="stat"><div class="num">${total}</div><div class="lbl">Data sources</div>
      <div class="sub">${counts.FRESH} fresh · ${counts.FROZEN} frozen</div></div>
    <div class="stat"><div class="num">${PB.fmtInt(factRows)}</div><div class="lbl">Total fact rows</div>
      <div class="sub">${PB.fmtFull(factRows)}</div></div>
    <div class="stat ${problems ? 'warnum' : ''}"><div class="num">${problems}</div><div class="lbl">Needs attention</div>
      <div class="sub">${counts.MISSING} missing · ${counts.STALLED} stalled · ${counts.STALE} stale</div></div>
    <div class="stat"><div class="num" style="font-size:18px">${agoTxt}</div><div class="lbl">Snapshot freshness</div>
      <div class="sub">${snap._live ? 'live from API' : 'bundled snapshot'}</div></div>`;

  // pill row
  const pr = document.getElementById('pillrow');
  pr.innerHTML = PB.STATUS_LIST.filter(s => counts[s]).map(s =>
    `<span class="pill"><span class="swatch sw-${s}"></span>${s} ${counts[s]}</span>`).join('') +
    (counts.UNKNOWN ? `<span class="pill"><span class="swatch sw-UNKNOWN"></span>UNKNOWN ${counts.UNKNOWN}</span>` : '');
}

function timeAgo(d) {
  const h = (Date.now() - d.getTime()) / 3.6e6;
  if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min ago';
  if (h < 36) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function unitLabel(s) {
  return s.key_metric_unit && s.key_metric_unit !== s.key_metric_name
    ? s.key_metric_unit : (s.key_metric_name || 'rows');
}

function sourceRow(s) {
  const st = PB.normStatus(s.status);
  const color = PB.statusColor(st);
  const counts = s.counts || {};
  const headline = counts.headline_total != null ? counts.headline_total
    : (s.key_metric_value != null ? s.key_metric_value : null);
  const sync = PB.syncedAgo(s.latest_date, SNAP.generated_at);
  const covErr = (counts && counts._error) || s.coverage_error;
  const spark = covErr ? '<span class="src-err">no coverage</span>'
    : PB.sparkline(s.coverage_30d, color, 120, 30);
  const isOpen = expanded.has(s.id);

  let html = `<div class="row" data-id="${PB.esc(s.id)}" role="button" tabindex="0">
    <div class="id">${PB.esc(s.id)}<small>${PB.esc(s.label || '')}</small></div>
    <div class="badge-cell">${statusBadge(s.status)}</div>
    <div class="kind">${PB.esc(s.kind || '')}${s.days_behind != null && s.days_behind > 0 ? ' · ' + s.days_behind + 'd behind' : ''}</div>
    <div class="metric"><b>${PB.fmtInt(headline)}</b><span class="mlbl">${PB.esc(s.key_metric_name || '')}</span></div>
    <div class="metric">${PB.fmtInt(s.fact_rows)}<span class="mlbl">fact rows</span></div>
    <div class="spark">${spark}<div class="synced">${PB.esc(sync.txt)}</div></div>
  </div>`;

  if (isOpen) {
    const ph = covErr ? `<div class="chart-note src-err">coverage error: ${PB.esc(covErr)}</div>`
      : `<div class="bigchart-holder">${PB.columnChart(s.coverage_30d, color, unitLabel(s))}</div>`;
    html += `<div class="detail" data-detail="${PB.esc(s.id)}">
      <div class="chart-wrap">
        <div class="chart-meta">
          <span><b>${PB.esc(s.label || s.id)}</b></span>
          <span>metric: <b>${PB.esc(s.key_metric_name || '—')}</b> (${PB.esc(unitLabel(s))})</span>
          <span>latest: <b>${PB.esc(s.latest_date || '—')}</b></span>
          <span>status: <b>${PB.esc(s.status || 'UNKNOWN')}</b></span>
        </div>
        ${ph}
        <div class="chart-note">30-day daily ${PB.esc(s.key_metric_name || 'metric')}. Empty bars = days with no data (gaps to investigate).</div>
      </div></div>`;
  }
  return html;
}

function renderTable(snap) {
  const tbl = document.getElementById('srctbl');
  const srcs = (snap.sources || []).slice();
  // problems sorted on top: MISSING < STALLED < STALE < DEPRECATED < FROZEN < FRESH < UNKNOWN
  srcs.sort((a, b) => {
    const oa = PB.STATUS_ORDER[PB.normStatus(a.status)], ob = PB.STATUS_ORDER[PB.normStatus(b.status)];
    if (oa !== ob) return oa - ob;
    return (Number(b.fact_rows) || 0) - (Number(a.fact_rows) || 0);
  });
  tbl.innerHTML =
    `<div class="row head">
      <div>Source</div><div>Status</div><div>Kind</div><div>Headline</div><div>Fact rows</div><div>30-day coverage</div>
    </div>` + srcs.map(sourceRow).join('');

  tbl.querySelectorAll('.row[data-id]').forEach(r => {
    const toggle = () => {
      const id = r.getAttribute('data-id');
      if (expanded.has(id)) expanded.delete(id); else { expanded.add(id); maybeFetchCoverage(id); }
      renderTable(SNAP);
    };
    r.onclick = toggle;
    r.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
}

// in live mode, the board endpoint doesn't carry coverage; fetch it lazily on expand.
async function maybeFetchCoverage(id) {
  if (!SNAP._live) return;
  const s = SNAP.sources.find(x => x.id === id);
  if (!s || !s._needsCoverage) return;
  const cov = await PB.loadCoverage(PB.getKey(), id, 30);
  if (cov) { s.coverage_30d = cov; s._needsCoverage = false; if (expanded.has(id)) renderTable(SNAP); }
}

function renderAll(snap) {
  SNAP = snap;
  document.getElementById('dash-loading').style.display = 'none';
  renderStats(snap);
  renderTable(snap);
  const b = document.getElementById('mode-banner');
  if (snap._live) { b.className = 'banner'; b.style.display = 'block';
    b.innerHTML = '● Live — refreshed from <code>' + PB.esc(location.origin + PB.API_BASE) + '</code> at ' + PB.esc(snap.generated_at) + '.'; }
  else { b.style.display = 'none'; }
}

async function boot() {
  let snap;
  try { snap = await PB.loadSnapshot(); }
  catch (e) {
    document.getElementById('dash-loading').innerHTML =
      '<span class="src-err">Could not load bundled snapshot (' + PB.esc(e.message) + ').</span>';
    return;
  }
  renderAll(snap);
  // if a key is present, try live in the background (never blocks)
  const key = PB.getKey();
  if (key) {
    const live = await PB.loadLive(key);
    if (live) { expanded.clear(); renderAll(live); }
  }
}

function onKeyChange(key) {
  if (!key) { boot(); return; }
  PB.loadLive(key).then(live => {
    const m = document.getElementById('pb-key-msg');
    if (live) { expanded.clear(); renderAll(live); if (m) m.innerHTML = '<span class="ok">● live refresh OK</span>'; }
    else if (m) m.innerHTML = '<span class="warn">● key set, but live API unreachable (CORS/invalid key/offline) — showing snapshot. <a href="docs.html#getkey">Need a key?</a></span>';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  PB.mountKeyBar(document.getElementById('keybar'), onKeyChange);
  boot();
});
