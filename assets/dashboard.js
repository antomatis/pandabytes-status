/* pandabytes status — dashboard page renderer (grouped: sources rendered as
   GROUPS of facets). Iterates snapshot.groups in order; each group is a
   collapsible card; under it the facets (sources whose .group == group.id). */
'use strict';

let SNAP = null;             // current snapshot-shaped data being rendered
const expandedFacets = new Set();   // facet ids whose 30-day column chart is open
const collapsedGroups = new Set();  // group ids the user has collapsed

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

// A facet the catalog has deliberately declared PLANNED / nascent (an early-stage build
// that is INTENTIONALLY tiny, not a real source that's broken or stuck). The hub already
// encodes this in the source's own prose — the label carries "IN PROGRESS" and/or the
// note/footer say the catalog status is PLANNED / NASCENT — so we read it from there
// rather than hardcoding ids. We keep the underlying status (e.g. FRESH) untouched so the
// freshness policy + green board are unchanged; this is only a SECONDARY honest affordance
// (like "tracking just started") so a 0.14%-built source reads as intentional, not alarming.
// Also lifts the source's own "~X% of <target>" phrasing, when present, so the small
// headline is contextualised inline. Returns { progress: '~0.14% of 12.4M' } | {} | null.
function plannedInfo(s) {
  const hay = [s.label, s.note, s.coverage_footer].map(t => String(t || '')).join('  ');
  const H = hay.toLowerCase();
  const declared = /\bin progress\b/.test(H)
    || /status\s*(?:is|=)\s*planned/.test(H)
    || /\bnascent\b/.test(H)
    || /\bplanned\b/.test(H);
  if (!declared) return null;
  // honest progress phrasing the source already states, e.g. "~0.14% of the 12.4M-image target".
  const m = hay.match(/~?\s*([0-9.]+\s*%)\s+of\s+(?:the\s+)?([0-9.]+\s*[KMB]?)\b/i);
  const progress = m ? `~${m[1].replace(/\s+/g, '')} of ${m[2].replace(/\s+/g, '')}` : null;
  return { progress };
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
  // catalog-declared PLANNED/nascent source: its small headline is intentional (an
  // early-stage build), not a stalled/broken source — flag it as such, honestly.
  const planned = plannedInfo(s);

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

  // "planned" pill beside the status badge: a calm, intentional marker for a catalog-
  // declared nascent build, so its small headline reads as early-stage-by-design rather
  // than broken. Lives in the always-visible badge column (so it survives the mobile
  // label truncation that hides the "IN PROGRESS" prose). Status badge itself is unchanged.
  const plannedPill = planned
    ? `<span class="badge b-planned" title="catalog status: PLANNED — this build is deliberately ramping${planned.progress ? ` (${PB.esc(planned.progress)} so far)` : ''}; the small count is expected, not a stall">planned</span>`
    : '';

  // metric sub-label: normally just the metric name. When the headline is an archive
  // total (split), prefix it "archive ·" and add a quiet caption noting the cutoff —
  // so the big number is unmistakably the historical archive, not the live chart total.
  // quiet progress caption for a PLANNED source — the source's own "~0.14% of 12.4M"
  // phrasing under the small headline, so the tiny number is read as "early build", not
  // "stuck". Reuses the .arch-cap quiet-caption style; suppressed when split already owns
  // the caption slot (archive sources are never planned, so they can't collide in practice).
  const plannedCap = (planned && planned.progress && !split)
    ? `<span class="arch-cap" title="catalog status: PLANNED — deliberately ramping">${PB.esc(planned.progress)} built so far</span>`
    : '';
  const metricLbl = split
    ? `<span class="mlbl"><span class="arch">archive</span> · ${PB.esc(s.key_metric_name || '')}</span>`
      + `<span class="arch-cap" title="historical archive total — the chart below is the separate live daily feed">total through pre-live archive</span>`
    : `<span class="mlbl">${PB.esc(s.key_metric_name || '')}</span>${plannedCap}`;

  let html = `<div class="facet${clickable ? ' clickable' : ''}${isOpen ? ' open' : ''}"`
    + ` data-id="${PB.esc(s.id)}"${clickable ? ' role="button" tabindex="0"' : ''}>
    <div class="f-name">${PB.esc(s.facet || s.id)}<small>${PB.esc(s.label || '')}</small></div>
    <div class="f-metric"><b>${PB.fmtInt(headline)}</b>${metricLbl}</div>
    <div class="f-badge">${facetBadge(s.status)}${newPill}${plannedPill}</div>
    <div class="f-spark">${sparkCell}${sparkCap}<div class="synced">${PB.esc(sync.txt)}</div></div>
  </div>`;

  if (clickable && isOpen) {
    const metricName = s.key_metric_name || 'rows';
    // when the series just began, tell columnChart so it labels the live bars
    // "tracking started …" instead of the (Posts-only) "recovering" firehose copy.
    // s.granularity ('monthly') switches the chart to per-month labels/title.
    const chart = `<div class="bigchart-holder"><div class="bigchart-scroll">${PB.columnChart(s.coverage_30d, color, metricName, unitLabel(s), s.live_from, fresh ? fresh.started : null, s.granularity)}</div></div>`;
    // Source-provided explanation (e.g. reddit archive→firehose boundary), surfaced
    // right under the chart title so a known step-down doesn't read as broken.
    const noteHtml = s.note
      ? `<div class="chart-source-note">${PB.esc(s.note)}</div>` : '';
    // footer caption priority:
    //  1) source-provided coverage_footer (explains its own gaps — e.g. reddit_comments
    //     monthly: the short June bar is the known Jun 1-17 gap, NOT a problem),
    //  2) a just-started daily series (empty earlier bars predate tracking),
    //  3) the generic daily "empty bars = gaps to investigate" copy.
    const monthly = s.granularity === 'monthly';
    const footerNote = s.coverage_footer
      ? PB.esc(s.coverage_footer)
      : fresh
        ? `Daily ${PB.esc(metricName)} since tracking began ${PB.esc(fresh.started)}. Earlier days are blank because the series didn't exist yet — not a gap.`
        : monthly
          ? `Monthly ${PB.esc(metricName)}, one bar per month.`
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

  board.innerHTML = html
    || `<div class="loading">No sources in snapshot.</div>`;
  wireBoard();
}

function wireBoard() {
  const board = document.getElementById('board');

  // group header collapse/expand
  board.querySelectorAll('.g-head').forEach(h => {
    const sec = h.closest('.group');
    const id = sec.getAttribute('data-group');
    const toggle = () => {
      // drive off the DOM's actual state (a group can be force-open under a filter
      // while still in collapsedGroups) so one click always flips what's on screen.
      const nowCollapsed = !sec.classList.contains('collapsed');
      sec.classList.toggle('collapsed', nowCollapsed);
      if (nowCollapsed) collapsedGroups.add(id); else collapsedGroups.delete(id);
      h.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
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
