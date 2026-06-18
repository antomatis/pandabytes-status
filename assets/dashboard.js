/* pandabytes status — dashboard page renderer */
'use strict';

let SNAP = null;       // current snapshot-shaped data being rendered
const expanded = new Set();

function statusBadge(s) {
  const st = PB.normStatus(s);
  return `<span class="badge b-${st}"><span class="swatch sw-${st}"></span>${st}</span>`;
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
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      renderTable(SNAP);
    };
    r.onclick = toggle;
    r.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
}

// Show "updated <generated_at>" freshness line (replaces the old key banner).
function renderFreshness(snap) {
  const el = document.getElementById('freshness');
  if (!el) return;
  const d = PB.parseTs(snap.generated_at);
  const rel = d ? ' (' + timeAgo(d) + ')' : '';
  el.innerHTML = '<span class="dot-live"></span>Live — updated <b>' +
    PB.esc(snap.generated_at || '—') + '</b>' + rel +
    ' · auto-refreshes every 5&nbsp;min · same-origin, no key needed.';
}

function renderAll(snap) {
  SNAP = snap;
  document.getElementById('dash-loading').style.display = 'none';
  renderFreshness(snap);
  renderTable(snap);
}

async function boot() {
  let snap;
  try { snap = await PB.loadSnapshot(); }
  catch (e) {
    document.getElementById('dash-loading').innerHTML =
      '<span class="src-err">Could not load live snapshot (' + PB.esc(e.message) + ').</span>';
    return;
  }
  renderAll(snap);
}

// periodic live refresh (~5 min); preserves expanded rows, silent on transient errors.
async function refresh() {
  try {
    const snap = await PB.loadSnapshot();
    if (snap) renderAll(snap);
  } catch (e) { /* keep current view on a transient fetch error */ }
}

document.addEventListener('DOMContentLoaded', () => {
  boot();
  setInterval(refresh, 5 * 60 * 1000);
});
