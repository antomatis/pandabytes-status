/* pandabytes status — dashboard page renderer (grouped: sources rendered as
   GROUPS of facets). Iterates snapshot.groups in order; each group is a
   collapsible card; under it the facets (sources whose .group == group.id). */
'use strict';

let SNAP = null;             // current snapshot-shaped data being rendered
const expandedFacets = new Set();   // facet ids whose 30-day column chart is open
const collapsedGroups = new Set();  // group ids the user has collapsed
let edDim = 'authors';       // editorial leaderboard active dimension: 'authors' | 'categories'
let statusFilter = 'all';    // board status-filter chip: 'all' | 'attn' | 'FRESH' | 'FROZEN' | <STATUS>

/* ---- board status filter ("what needs attention") ----
   A small chip row above the source board that filters the visible sources by their
   freshness status. Chips are built DYNAMICALLY from the statuses actually present in
   the snapshot (with live counts) — no hardcoded source list:
     · All            → every source (respects the user's collapse state)
     · Needs attention → the union of PROBLEM statuses (STALE/STALLED/MISSING/DEPRECATED)
     · Fresh / Frozen  → that single status
   Pure front-end, reads s.status off the same snapshot the board already uses. */

// does a source match the active filter chip? null status (derived) only shows under "all".
function facetMatchesFilter(s) {
  if (statusFilter === 'all') return true;
  if (s.status == null) return false;
  const st = PB.normStatus(s.status);
  if (statusFilter === 'attn') return PB.PROBLEM.has(st);
  return st === statusFilter;
}

// chips to show, in triage order, built from the statuses present (count > 0 only).
// returns [{key, label, count, attn}] — 'all' always first.
function buildFilterChips(byGroup) {
  const counts = {};            // status -> n
  let total = 0, attn = 0;
  for (const facets of byGroup.values()) {
    for (const s of facets) {
      total++;
      if (s.status == null) continue;
      const st = PB.normStatus(s.status);
      counts[st] = (counts[st] || 0) + 1;
      if (PB.PROBLEM.has(st)) attn++;
    }
  }
  const chips = [{ key: 'all', label: 'All', count: total, attn: false }];
  if (attn > 0) chips.push({ key: 'attn', label: 'Needs attention', count: attn, attn: true });
  // FRESH then FROZEN then any other concrete status present, each only if non-zero.
  for (const st of ['FRESH', 'FROZEN']) {
    if (counts[st]) chips.push({ key: st, label: st[0] + st.slice(1).toLowerCase(), count: counts[st], attn: false });
  }
  return chips;
}

function renderStatusFilter(byGroup) {
  const host = document.getElementById('status-filter');
  if (!host) return;
  const chips = buildFilterChips(byGroup);
  // only one meaningful chip (just "All") -> nothing to filter, keep it hidden.
  if (chips.length < 2) { host.hidden = true; host.innerHTML = ''; return; }
  // if the active filter no longer exists in this snapshot, fall back to "all".
  if (!chips.some(c => c.key === statusFilter)) statusFilter = 'all';
  host.hidden = false;
  host.innerHTML = chips.map(c => {
    const active = c.key === statusFilter;
    return `<button type="button" role="tab" class="fchip${active ? ' active' : ''}${c.attn ? ' fchip-attn' : ''}"`
      + ` data-filter="${PB.esc(c.key)}" aria-selected="${active}" aria-pressed="${active}">`
      + `${PB.esc(c.label)}<span class="fchip-n">${PB.fmtInt(c.count)}</span></button>`;
  }).join('');
  host.querySelectorAll('.fchip[data-filter]').forEach(b => {
    b.onclick = () => {
      const f = b.getAttribute('data-filter');
      if (f === statusFilter) return;
      statusFilter = f;
      renderBoard(SNAP);
    };
  });
}

/* ---- editorial leaderboard (Chartbeat-style top authors / categories, 30d) ----
   Reads snap.editorial_leaders ({authors:[...], categories:[...], days, generated_at}),
   built read-only into the snapshot by pb_snapshot.py. A ranked list per dimension:
   rank · name · pageviews · avg engagement. Keyless (same snapshot.json as the board). */

// seconds -> compact "1m 42s" / "42s" for the avg-engagement column.
function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return '—';
  sec = Math.round(Number(sec));
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + 'm' + (s ? ' ' + s + 's' : '');
}

// one ranked row: rank pill · name · pageviews (big) · avg engagement (quiet).
function edRow(item, rank, dim) {
  const name = dim === 'authors' ? (item.author || '—') : (item.category || '—');
  const pv = item.pageviews;
  const eng = item.avg_engagement_time;
  const arts = item.articles;
  const top3 = rank <= 3 ? ' ed-top' : '';
  return `<li class="ed-row${top3}">
    <span class="ed-rank">${rank}</span>
    <span class="ed-name" title="${PB.esc(name)}">${PB.esc(name)}<small>${PB.fmtInt(arts)} ${arts === 1 ? 'article' : 'articles'}</small></span>
    <span class="ed-pv"><b>${PB.fmtInt(pv)}</b><small>pageviews</small></span>
    <span class="ed-eng"><b>${PB.esc(fmtDuration(eng))}</b><small>avg engage</small></span>
  </li>`;
}

function renderEditorial(snap) {
  const host = document.getElementById('editorial');
  if (!host) return;
  const el = snap.editorial_leaders;
  // no editorial block (older snapshot) -> hide the whole section, leave no empty shell.
  if (!el || (!(el.authors || []).length && !(el.categories || []).length)) {
    host.hidden = true; host.innerHTML = ''; return;
  }
  host.hidden = false;
  const rows = (el[edDim] || []);
  const days = el.days || 30;
  const err = edDim === 'authors' ? el.authors_error : el.categories_error;

  const list = rows.length
    ? `<ol class="ed-list">${rows.map((r, i) => edRow(r, i + 1, edDim)).join('')}</ol>`
    : `<div class="ed-empty">${err ? 'Leaderboard temporarily unavailable (catalog busy).' : 'No editorial data in the last ' + days + ' days.'}</div>`;

  host.innerHTML = `
    <div class="ed-card">
      <header class="ed-head">
        <div class="ed-titles">
          <span class="ed-kicker">Editorial performance</span>
          <h2 class="ed-title">Top ${edDim === 'authors' ? 'authors' : 'categories'} <span>· last ${days} days</span></h2>
        </div>
        <div class="ed-toggle" role="tablist" aria-label="Leaderboard dimension">
          <button type="button" role="tab" class="ed-tab${edDim === 'authors' ? ' active' : ''}" aria-selected="${edDim === 'authors'}" data-dim="authors">Authors</button>
          <button type="button" role="tab" class="ed-tab${edDim === 'categories' ? ' active' : ''}" aria-selected="${edDim === 'categories'}" data-dim="categories">Categories</button>
        </div>
      </header>
      <div class="ed-cols" aria-hidden="true">
        <span class="edc-rank">#</span>
        <span class="edc-name">${edDim === 'authors' ? 'Author' : 'Category'}</span>
        <span class="edc-pv">Pageviews</span>
        <span class="edc-eng">Avg engagement</span>
      </div>
      ${list}
      <div class="ed-foot">Ranked by GA4 pageviews over the trailing ${days} days · avg engagement from Chartbeat · same-origin snapshot, no key needed.</div>
    </div>`;

  // dimension toggle
  host.querySelectorAll('.ed-tab[data-dim]').forEach(b => {
    b.onclick = () => {
      const d = b.getAttribute('data-dim');
      if (d === edDim) return;
      edDim = d;
      renderEditorial(SNAP);
    };
  });
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

/* ---- one group card ----
   `forceOpen` (set while a status filter is active) renders the group expanded
   without touching the user's persisted collapse state — so clearing the filter
   ("All") restores whatever they had collapsed before. */
function groupCard(group, facets, forceOpen) {
  const r = groupRollup(facets);
  const collapsed = !forceOpen && collapsedGroups.has(group.id);
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

  // status-filter chips (built from the full, unfiltered set so counts are stable)
  renderStatusFilter(byGroup);

  // apply the active status filter: keep only matching facets, drop now-empty groups.
  const filtering = statusFilter !== 'all';
  const viewByGroup = new Map();
  for (const [gid, facets] of byGroup) {
    const kept = filtering ? facets.filter(facetMatchesFilter) : facets;
    if (kept.length) viewByGroup.set(gid, kept);
  }

  const html = groups.map(g => {
    const facets = viewByGroup.get(g.id) || [];
    if (!facets.length) return '';
    // when a filter is active the user is triaging — force matching groups open so the
    // hits are visible without an extra click; "All" honours the user's collapse state.
    return groupCard(g, facets, filtering);
  }).join('');

  board.innerHTML = html
    || `<div class="loading">${filtering ? 'No sources match this filter.' : 'No sources in snapshot.'}</div>`;
  // rail follows the filtered view so it never jumps to a group that's now hidden.
  renderGroupRail(groups, viewByGroup);
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
  renderEditorial(snap);
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
