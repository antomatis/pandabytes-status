/* pandabytes status — dashboard page renderer (grouped: sources rendered as
   GROUPS of facets). Iterates snapshot.groups in order; each group is a
   collapsible card; under it the facets (sources whose .group == group.id). */
'use strict';

let SNAP = null;             // current snapshot-shaped data being rendered
const expandedFacets = new Set();   // facet ids whose 30-day column chart is open
const collapsedGroups = new Set();  // group ids the user has collapsed

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

// status badge only when a real status is present; null status -> quiet dash.
function facetBadge(status) {
  if (status == null) return '<span class="badge b-none">—</span>';
  const st = PB.normStatus(status);
  return `<span class="badge b-${st}"><span class="swatch sw-${st}"></span>${st}</span>`;
}

function hasCoverage(s) {
  return Array.isArray(s.coverage_30d) && s.coverage_30d.length > 0;
}

// A facet whose DAILY series only just began: it has a live_from boundary and the
// whole (short) coverage window sits on/after that boundary — i.e. tracking literally
// started at live_from, so the mostly-empty 30-day chart is correct, NOT a gap.
// Returns { started: 'yyyy-mm-dd' } when so, else null. Generic (no hardcoded ids):
// reddit Comments today, anything that flips to live tracking tomorrow.
function newSeriesInfo(s) {
  const cov = s.coverage_30d;
  const lf = s.live_from;
  if (!lf || !Array.isArray(cov) || !cov.length || cov.length > 5) return null;
  const allOnOrAfter = cov.every(p => p.date && String(p.date) >= String(lf));
  return allOnOrAfter ? { started: cov[0].date } : null;
}

// Split a facet whose headline is a big *historical archive* from its brand-new *live
// daily* series. True only when the daily series just began (fresh) AND the headline
// dwarfs everything the live series has logged so far — i.e. the big number is the
// pre-live backfill/archive, not the live total (e.g. reddit Comments: 23B archive vs
// a 2-day live chart). Generic, data-driven (no hardcoded ids/dates): when so we caption
// the headline as "archive" and the chart as "live daily" so the two never read as
// contradictory. Returns { archiveBefore: 'yyyy-mm-dd', liveFrom: 'yyyy-mm-dd' } or null.
function archiveVsLive(s, fresh, headline) {
  if (!fresh || headline == null) return null;
  const liveSum = (s.coverage_30d || []).reduce((a, p) => a + (Number(p.key_metric) || 0), 0);
  // headline must be >=100x the whole live window for it to be "mostly archive".
  if (!(headline >= liveSum * 100)) return null;
  return { archiveBefore: fresh.started, liveFrom: s.live_from || fresh.started };
}

/* ---- per-facet row ---- */
function facetRow(s) {
  const st = PB.normStatus(s.status);
  const color = s.status == null ? '#1aa6a0' : PB.statusColor(st);  /* derived sources → Chartbeat teal */
  const counts = s.counts || {};
  const headline = counts.headline_total != null ? counts.headline_total
    : (s.key_metric_value != null ? s.key_metric_value : null);
  const sync = PB.syncedAgo(s.latest_date, SNAP.generated_at);
  const covErr = (counts && counts._error) || s.coverage_error;
  const isOpen = expandedFacets.has(s.id);
  const cov = hasCoverage(s);
  const clickable = cov && !covErr;
  const fresh = newSeriesInfo(s);   // daily series just began? (not a gap)
  // when the big headline is a historical archive and the chart is a brand-new live
  // feed, caption both so the 23B-total + near-empty-chart pair never looks contradictory.
  const split = archiveVsLive(s, fresh, headline);

  let sparkCell;
  if (covErr) {
    sparkCell = '<span class="src-err">no coverage</span>';
  } else if (cov) {
    sparkCell = PB.sparkline(s.coverage_30d, color, 120, 30);
  } else {
    sparkCell = '<span class="no-series">no daily series</span>';
  }
  // sub-caption under the sparkline: tells the viewer the (short) chart is the LIVE
  // daily feed — paired with the "archive" headline caption it splits the two cleanly.
  const sparkCap = split
    ? `<div class="spark-cap">live daily · from ${PB.esc(PB.fmtDay(split.liveFrom))}</div>`
    : '';

  // "new" pill next to the status badge when daily tracking just started — so the
  // short/empty-looking sparkline reads as "just began", not broken/stalled.
  const newPill = fresh
    ? `<span class="badge b-new" title="daily tracking began ${PB.esc(fresh.started)} — the short series is expected, not a gap">tracking just started</span>`
    : '';

  // metric sub-label: normally just the metric name. When the headline is an archive
  // total (split), prefix it "archive ·" and add a quiet caption noting the cutoff —
  // so the big number is unmistakably the historical archive, not the live chart total.
  const metricLbl = split
    ? `<span class="mlbl"><span class="arch">archive</span> · ${PB.esc(s.key_metric_name || '')}</span>`
      + `<span class="arch-cap" title="historical archive total — the chart below is the separate live daily feed">total through pre-live archive</span>`
    : `<span class="mlbl">${PB.esc(s.key_metric_name || '')}</span>`;

  let html = `<div class="facet${clickable ? ' clickable' : ''}${isOpen ? ' open' : ''}"`
    + ` data-id="${PB.esc(s.id)}"${clickable ? ' role="button" tabindex="0"' : ''}>
    <div class="f-name">${PB.esc(s.facet || s.id)}<small>${PB.esc(s.label || '')}</small></div>
    <div class="f-metric"><b>${PB.fmtInt(headline)}</b>${metricLbl}</div>
    <div class="f-badge">${facetBadge(s.status)}${newPill}</div>
    <div class="f-spark">${sparkCell}${sparkCap}<div class="synced">${PB.esc(sync.txt)}</div></div>
  </div>`;

  if (clickable && isOpen) {
    const metricName = s.key_metric_name || 'rows';
    // when the series just began, tell columnChart so it labels the live bars
    // "tracking started …" instead of the (Posts-only) "recovering" firehose copy.
    const chart = `<div class="bigchart-holder"><div class="bigchart-scroll">${PB.columnChart(s.coverage_30d, color, metricName, unitLabel(s), s.live_from, fresh ? fresh.started : null)}</div></div>`;
    // Source-provided explanation (e.g. reddit archive→firehose boundary), surfaced
    // right under the chart title so a known step-down doesn't read as broken.
    const noteHtml = s.note
      ? `<div class="chart-source-note">${PB.esc(s.note)}</div>` : '';
    // footer caption: for a just-started series the generic "empty bars = gaps to
    // investigate" line is wrong (the empty days predate tracking), so swap the copy.
    const footerNote = fresh
      ? `Daily ${PB.esc(metricName)} since tracking began ${PB.esc(fresh.started)}. Earlier days are blank because the series didn't exist yet — not a gap.`
      : `30-day daily ${PB.esc(metricName)}. Empty bars = days with no data (gaps to investigate).`;
    html += `<div class="detail" data-detail="${PB.esc(s.id)}">
      <div class="chart-wrap">
        <div class="chart-meta">
          <span><b>${PB.esc(s.label || s.facet || s.id)}</b></span>
          <span>metric: <b>${PB.esc(s.key_metric_name || '—')}</b> (${PB.esc(unitLabel(s))})</span>
          <span>latest: <b>${PB.esc(s.latest_date || '—')}</b></span>
          <span>status: <b>${PB.esc(s.status || '—')}</b></span>
        </div>
        ${noteHtml}
        ${chart}
        <div class="chart-note">${footerNote}</div>
      </div></div>`;
  }
  return html;
}

/* ---- group roll-up: N fresh / N frozen / N issues ---- */
function groupRollup(facets) {
  let fresh = 0, frozen = 0, issues = 0, derived = 0;
  for (const s of facets) {
    const st = s.status;
    if (st == null) { derived++; continue; }
    if (st === 'FRESH') fresh++;
    else if (st === 'FROZEN') frozen++;
    else if (PB.PROBLEM.has(st)) issues++;
  }
  return { fresh, frozen, issues, derived, total: facets.length };
}

/* ---- one group card ---- */
function groupCard(group, facets) {
  const r = groupRollup(facets);
  const collapsed = collapsedGroups.has(group.id);
  const attn = r.issues > 0;

  const parts = [];
  if (r.fresh) parts.push(`<span class="rs rs-fresh">${r.fresh} fresh</span>`);
  if (r.frozen) parts.push(`<span class="rs rs-frozen">${r.frozen} frozen</span>`);
  if (r.issues) parts.push(`<span class="rs rs-issue">${r.issues} ${r.issues === 1 ? 'issue' : 'issues'}</span>`);
  if (r.derived) parts.push(`<span class="rs rs-derived">${r.derived} derived</span>`);
  const rollup = parts.join('');

  const facetCount = `${r.total} ${r.total === 1 ? 'facet' : 'facets'}`;

  let html = `<section class="group${collapsed ? ' collapsed' : ''}${attn ? ' attn' : ''}" id="grp-${PB.esc(group.id)}" data-group="${PB.esc(group.id)}">
    <header class="g-head" role="button" tabindex="0" aria-expanded="${collapsed ? 'false' : 'true'}">
      <span class="g-caret" aria-hidden="true">▾</span>
      <span class="g-label">${PB.esc(group.label || group.id)}</span>
      ${attn ? '<span class="g-attn" title="a facet needs attention">●</span>' : ''}
      <span class="g-count">${facetCount}</span>
      <span class="g-rollup">${rollup}</span>
    </header>
    <div class="g-body">`;
  html += facets.map(facetRow).join('');
  html += `</div></section>`;
  return html;
}

function renderBoard(snap) {
  const board = document.getElementById('board');
  const sources = snap.sources || [];
  const groups = (snap.groups && snap.groups.length)
    ? snap.groups
    // fallback: derive group order from sources if `groups` is absent
    : (() => {
        const seen = new Set(), out = [];
        for (const s of sources) {
          if (s.group && !seen.has(s.group)) {
            seen.add(s.group);
            out.push({ id: s.group, label: s.group_label || s.group });
          }
        }
        return out;
      })();

  // index facets by group, preserving sources[] order within each group
  const byGroup = new Map();
  for (const s of sources) {
    const g = s.group || 'other';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(s);
  }

  const html = groups.map(g => {
    const facets = byGroup.get(g.id) || [];
    if (!facets.length) return '';
    return groupCard(g, facets);
  }).join('');

  board.innerHTML = html || '<div class="loading">No sources in snapshot.</div>';
  renderGroupRail(groups, byGroup);
  wireBoard();
}

/* ---- group-jump rail: sticky pill-strip that jumps to each group + scroll-spies
   the one in view. Re-rendered with the board (groups can come/go between
   snapshots); the IntersectionObserver is (re)attached to the live sections. ---- */
let railObserver = null;
const railVisible = new Set();

function renderGroupRail(groups, byGroup) {
  const rail = document.getElementById('group-rail');
  if (!rail) return;
  const live = groups.filter(g => (byGroup.get(g.id) || []).length);
  // a single group makes the rail pointless — leave it hidden.
  if (live.length < 2) { rail.hidden = true; rail.innerHTML = ''; return; }
  rail.hidden = false;
  rail.innerHTML = live.map(g =>
    `<a href="#grp-${PB.esc(g.id)}" data-group="${PB.esc(g.id)}">${PB.esc(g.label || g.id)}</a>`
  ).join('');

  // click → expand the group if collapsed, then smooth-scroll it into view.
  rail.querySelectorAll('a[data-group]').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      const id = a.getAttribute('data-group');
      const sec = document.querySelector(`.group[data-group="${CSS.escape(id)}"]`);
      if (!sec) return;
      if (collapsedGroups.has(id)) {
        collapsedGroups.delete(id);
        sec.classList.remove('collapsed');
        const h = sec.querySelector('.g-head');
        if (h) h.setAttribute('aria-expanded', 'true');
      }
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      markRailActive(id);
    };
  });

  attachRailSpy();
}

function markRailActive(id) {
  const rail = document.getElementById('group-rail');
  if (!rail) return;
  rail.querySelectorAll('a[data-group]').forEach(a =>
    a.classList.toggle('active', a.getAttribute('data-group') === id));
  // keep the active pill visible in the horizontal strip
  const active = rail.querySelector('a.active');
  if (active && rail.scrollWidth > rail.clientWidth) {
    active.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

function attachRailSpy() {
  if (!('IntersectionObserver' in window)) return;
  if (railObserver) railObserver.disconnect();
  railVisible.clear();
  const sections = Array.from(document.querySelectorAll('.group[data-group]'));
  if (!sections.length) return;
  railObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = e.target.getAttribute('data-group');
      if (e.isIntersecting) railVisible.add(id); else railVisible.delete(id);
    }
    // topmost intersecting section wins, so exactly one pill is active.
    let activeId = null, best = Infinity;
    for (const id of railVisible) {
      const sec = document.querySelector(`.group[data-group="${CSS.escape(id)}"]`);
      if (!sec) continue;
      const top = sec.getBoundingClientRect().top;
      if (top < best) { best = top; activeId = id; }
    }
    if (activeId) markRailActive(activeId);
  }, { rootMargin: '-120px 0px -65% 0px', threshold: 0 });
  sections.forEach(s => railObserver.observe(s));
}

function wireBoard() {
  const board = document.getElementById('board');

  // group header collapse/expand
  board.querySelectorAll('.g-head').forEach(h => {
    const sec = h.closest('.group');
    const id = sec.getAttribute('data-group');
    const toggle = () => {
      if (collapsedGroups.has(id)) collapsedGroups.delete(id);
      else collapsedGroups.add(id);
      sec.classList.toggle('collapsed');
      h.setAttribute('aria-expanded', collapsedGroups.has(id) ? 'false' : 'true');
    };
    h.onclick = toggle;
    h.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    };
  });

  // wire the floating value tooltip on every open chart
  board.querySelectorAll('.bigchart-holder').forEach(h => PB.wireChartTooltips(h));

  // facet row -> open/close column chart (only the ones flagged clickable)
  board.querySelectorAll('.facet.clickable[data-id]').forEach(r => {
    const toggle = () => {
      const id = r.getAttribute('data-id');
      if (expandedFacets.has(id)) expandedFacets.delete(id);
      else expandedFacets.add(id);
      renderBoard(SNAP);
    };
    r.onclick = toggle;
    r.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    };
  });
}

// Show "Live — updated <generated_at>" freshness line.
function renderFreshness(snap) {
  const el = document.getElementById('freshness');
  if (!el) return;
  const d = PB.parseTs(snap.generated_at);
  const rel = d ? ' (' + timeAgo(d) + ')' : '';
  el.innerHTML = '<span class="dot-live"></span>Live — updated <b>' +
    PB.esc(snap.generated_at || '—') + '</b>' + rel +
    ' · auto-refreshes every 5&nbsp;min · same-origin, no key needed.';
}

// Default collapse policy, applied once on first render: collapse "other" and any
// group whose facets are all frozen/derived (no fresh, no issues).
let defaultsApplied = false;
function applyDefaultCollapse(snap) {
  if (defaultsApplied) return;
  defaultsApplied = true;
  const sources = snap.sources || [];
  const byGroup = new Map();
  for (const s of sources) {
    const g = s.group || 'other';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(s);
  }
  for (const [gid, facets] of byGroup) {
    if (gid === 'other') { collapsedGroups.add(gid); continue; }
    const r = groupRollup(facets);
    if (r.fresh === 0 && r.issues === 0) collapsedGroups.add(gid); // fully frozen/derived
  }
}

function renderAll(snap) {
  SNAP = snap;
  const loading = document.getElementById('dash-loading');
  if (loading) loading.style.display = 'none';
  applyDefaultCollapse(snap);
  renderFreshness(snap);
  renderBoard(snap);
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

// periodic live refresh (~5 min); preserves expanded facets + collapsed groups.
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
