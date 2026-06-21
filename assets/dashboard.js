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

// FLOW-STATE: is this source DELIBERATELY paused (a chosen hold) rather than broken?
// Two honest signals already in the snapshot — no new backend state invented:
//   1) status === FROZEN, which the hub already means as "intentionally not updated"
//      (e.g. facebook, detail: "frozen source (intentionally not updated)"), or
//   2) the source's own prose (detail/note/label) explicitly says it's PAUSED /
//      "intentionally not updated" — e.g. reddit_imagined_titles' note: "the bulk
//      builder, PAUSED 2026-06-19 to conserve quota". Such a source can carry a STALE
//      status (its latest_date drifts while paused) yet is NOT a stall to fix.
// When paused we render an amber PAUSED badge in place of the raw status, and the hub
// pulse counts it as "paused", not an issue — so a deliberate hold never reads as broken.
// Returns { reason } (a short why, when prose gives one) | {} | null.
function pausedInfo(s) {
  const st = PB.normStatus(s.status);
  const hay = [s.detail, s.note, s.label].map(t => String(t || '')).join('  ');
  const H = hay.toLowerCase();
  // explicit pause language, OR the hub's "intentionally not updated" frozen phrasing
  const declared = /\bpaused\b/.test(H) || /intentionally not updated/.test(H);
  if (st !== 'FROZEN' && !declared) return null;
  // lift a short human reason when the prose states one (e.g. "to conserve quota").
  const m = hay.match(/paused[^.]*?\bto\s+([^.,;)]+)/i);
  const reason = m ? `to ${m[1].trim()}` : (st === 'FROZEN' ? 'frozen — intentionally not updated' : null);
  return { reason };
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
  // flow-state: a DELIBERATELY paused/frozen source (chosen hold), so it reads as
  // intentional rather than as a broken stall (see pausedInfo).
  const paused = pausedInfo(s);

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

  // a deliberately-paused source shows an amber PAUSED badge IN PLACE OF the raw status
  // (so a chosen hold never reads as a broken stall); its tooltip carries the reason and
  // the real underlying status for transparency. Otherwise the normal status badge.
  const statusBadge = paused
    ? `<span class="badge b-PAUSED"${st && st !== 'UNKNOWN'
        ? ` title="deliberately paused${paused.reason ? ' ' + PB.esc(paused.reason) : ''} — underlying status: ${PB.esc(st)}"` : ''}>`
      + `<span class="swatch"></span>PAUSED</span>`
    : facetBadge(s.status);

  let html = `<div class="facet${clickable ? ' clickable' : ''}${isOpen ? ' open' : ''}"`
    + ` data-id="${PB.esc(s.id)}"${clickable ? ' role="button" tabindex="0"' : ''}>
    <div class="f-name">${PB.esc(s.facet || s.id)}<small>${PB.esc(s.label || '')}</small></div>
    <div class="f-metric"><b>${PB.fmtInt(headline)}</b>${metricLbl}</div>
    <div class="f-badge">${statusBadge}${newPill}${plannedPill}</div>
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
  if (!board) return;   // guard: ideas.html has no source board — no-op there (no console error)
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

  // board_error banner: shown when pb_snapshot.py fell back to last-good data
  // (DB write-locked; statuses are stale). Amber, calm — not alarming.
  const boardErr = snap.board_error;
  const errBanner = boardErr
    ? `<div class="board-err-banner">⚠️ Data may be stale — snapshot degraded (${PB.esc(boardErr)}); showing last-good.</div>`
    : '';

  board.innerHTML = errBanner + (html
    || `<div class="loading">No sources in snapshot.</div>`);
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


/* ---- "Cover now": today's actionable coverage opportunities ----
   The morning-editor read. Renders snapshot.cover_now.posts — the SPECIFIC fresh, on-brand,
   uncovered, listicle-ready viral posts (from v_opportunities_now / derived 68), ranked by
   upvote velocity. Sits ABOVE the source board so the first thing on screen (esp. on a phone)
   is "what to cover", not "is the plumbing healthy". Served from the SAME snapshot the page
   already fetched (no key, no extra request). Purely additive + self-hiding: if the block is
   absent/empty (older snapshot, or simply no opportunities today) the section stays hidden,
   so the board/leaders/usage below are never affected. Honest by construction — it shows the
   data's own caveat (velocity = avg-since-birth) as a quiet footnote, mirroring 68/Slack. */
function coverNowCard(p) {
  const sub = p.subreddit ? ('r/' + p.subreddit) : '';
  // permalink is a Reddit-relative path; make it absolute. Fall back to the media url.
  let href = '';
  if (p.permalink) href = /^https?:/i.test(p.permalink) ? p.permalink : ('https://www.reddit.com' + p.permalink);
  else if (p.url) href = p.url;
  const score = (p.score != null) ? PB.fmtInt(p.score) : '—';
  const vel   = (p.velocity_per_hr != null) ? PB.fmtInt(Math.round(p.velocity_per_hr)) : null;
  const age   = (p.days_old != null)
    ? (p.days_old < 1 ? Math.round(p.days_old * 24) + 'h old' : p.days_old + 'd old')
    : '';
  const cov   = (p.sub_pct_covered != null) ? p.sub_pct_covered + '% covered' : '';
  // compact, scannable metric row: upvotes · velocity · age · subreddit coverage gap
  const meta = [
    '<span class="cn-up" title="snapshot upvotes">▲ ' + score + '</span>',
    vel ? '<span class="cn-vel" title="upvotes per hour since the post was submitted (average rate, not a live delta)">' + vel + '/hr</span>' : '',
    age ? '<span class="cn-age" title="age of the post">' + PB.esc(age) + '</span>' : '',
    cov ? '<span class="cn-cov" title="how much of this subreddit&#39;s viral backlog BoredPanda has historically covered — context, not a per-post claim">' + sub + ' · ' + PB.esc(cov) + '</span>'
        : (sub ? '<span class="cn-cov">' + sub + '</span>' : ''),
  ].filter(Boolean).join('<span class="cn-dot" aria-hidden="true">·</span>');

  const titleHtml = PB.esc(p.title || '(untitled)');
  const title = href
    ? '<a class="cn-title" href="' + PB.esc(href) + '" target="_blank" rel="noopener noreferrer">' + titleHtml + '</a>'
    : '<span class="cn-title">' + titleHtml + '</span>';

  // Visual decision aid: the reddit post's thumbnail, left of the title. BoredPanda is a
  // visual brand — seeing the image helps an editor decide "cover this". GRACEFUL BY
  // CONSTRUCTION: only render an <img> for a real http(s) URL (the snapshot already filters
  // reddit sentinel values like "self"/"default"/"nsfw"); and reddit hotlinks can 403 on a
  // third-party origin, so onerror REMOVES the thumb element (it collapses to no-image, never
  // a broken-image icon). When absent the card lays out exactly as before (no empty gap —
  // the .cn-thumb element simply isn't emitted). Lazy-loaded; alt empty (decorative). */
  const turl = (p.thumb && /^https?:\/\//i.test(p.thumb)) ? p.thumb : '';
  const thumb = turl
    ? '<img class="cn-thumb" src="' + PB.esc(turl) + '" alt="" loading="lazy" decoding="async" ' +
      'referrerpolicy="no-referrer" ' +
      'onerror="this.remove()">'
    : '';

  return '<div class="cn-card">' +
    '<div class="cn-rank">' + (p.rank != null ? p.rank : '') + '</div>' +
    thumb +
    '<div class="cn-body">' +
      '<div class="cn-titlewrap">' + title + '</div>' +
      '<div class="cn-meta">' + meta + '</div>' +
    '</div>' +
  '</div>';
}

function renderCoverNow(snap) {
  const sect  = document.getElementById('cover-now-section');
  const panel = document.getElementById('cover-now-panel');
  if (!sect || !panel) return;
  const cn = snap.cover_now;
  const posts = (cn && Array.isArray(cn.posts)) ? cn.posts : [];
  if (!posts.length) { sect.hidden = true; return; }  // self-hide (older snapshot / none today)

  const cards = posts.map(coverNowCard).join('');
  // quiet honest footnote: carries the view's own caveat so a velocity number is never
  // over-read as a live delta. Mirrors derived/68 build.sql + the Slack "Cover now" board.
  const caveat = (cn && cn.caveat)
    ? '<div class="cn-foot">' + PB.esc(cn.caveat) + '</div>' : '';
  panel.innerHTML = '<div class="cn-list">' + cards + '</div>' + caveat;
  sect.hidden = false;   // reveal once populated (the section ships hidden in index.html)
}

/* ---- "Movers today": already-published articles that suddenly surged ----
   The other morning-editor read, paired with Cover now. Renders snapshot.movers.articles —
   each an article whose pageviews on the latest COMPLETE GA4 day jumped sharply vs its OWN
   trailing 7-day daily average (computed honestly server-side: the partial current day is
   excluded; only established pages with real history qualify). Chartbeat-style row: title +
   ▲ pageviews + the jump ("↑3.2× vs 7d avg"). Served from the SAME snapshot the page already
   fetched (no key, no extra request). Purely additive + self-hiding: absent/empty block, or a
   STALE snapshot, leaves the section hidden so the rest of the page is never affected. Honest
   by construction — carries the data's own caveat (partial-day handling) as a quiet footnote. */
function moverFmtJump(r) {
  // ratio phrasing the editor reads at a glance. >=10x -> integer (15×), else one decimal (3.2×).
  if (r == null || !isFinite(r)) return '';
  return (r >= 10 ? Math.round(r) : (Math.round(r * 10) / 10)) + '×';
}
// Title fallback for a riser the article spine hasn't caught up to: humanise the slug.
// "/dumb-home-improvement-fails/" -> "Dumb home improvement fails".
function moverSlugTitle(pp) {
  const slug = String(pp || '').replace(/^\/+|\/+$/g, '');
  if (!slug) return '(untitled)';
  const words = slug.replace(/-/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function moverCard(m, rank) {
  // url from the spine, else build the canonical BoredPanda url from the page_path.
  let href = m.url || '';
  if (!href && m.page_path) href = 'https://www.boredpanda.com' + m.page_path;
  const titleHtml = PB.esc(m.title || moverSlugTitle(m.page_path));
  const title = href
    ? '<a class="mv-title" href="' + PB.esc(href) + '" target="_blank" rel="noopener noreferrer">' + titleHtml + '</a>'
    : '<span class="mv-title">' + titleHtml + '</span>';
  const pv = (m.pageviews != null) ? PB.fmtInt(m.pageviews) : '—';
  const jump = moverFmtJump(m.jump_ratio);
  const base = (m.base_avg_pv != null) ? PB.fmtInt(m.base_avg_pv) : null;
  // compact, scannable metric row: pageviews · the jump vs 7d avg · author
  const meta = [
    '<span class="mv-pv" title="pageviews on the latest complete GA4 day">▲ ' + pv + ' views</span>',
    jump ? '<span class="mv-jump" title="' + (base ? 'vs a ' + PB.esc(base) + '/day trailing 7-day average' : 'vs this article’s trailing 7-day daily average') + '">↑' + jump + ' vs 7d avg</span>' : '',
    m.author ? '<span class="mv-by" title="author">' + PB.esc(m.author) + '</span>' : '',
  ].filter(Boolean).join('<span class="mv-dot" aria-hidden="true">·</span>');

  return '<div class="mv-card">' +
    '<div class="mv-rank">' + (rank != null ? rank : '') + '</div>' +
    '<div class="mv-body">' +
      '<div class="mv-titlewrap">' + title + '</div>' +
      '<div class="mv-meta">' + meta + '</div>' +
    '</div>' +
  '</div>';
}

function renderMovers(snap) {
  const sect  = document.getElementById('movers-section');
  const panel = document.getElementById('movers-panel');
  if (!sect || !panel) return;
  const mv = snap.movers;
  const arts = (mv && Array.isArray(mv.articles)) ? mv.articles : [];
  // self-hide on empty/older snapshot. Also hide on a STALE snapshot: a "surging now"
  // claim from a snapshot that's > staleMin old would be a quiet lie about freshness.
  const age = PB.snapshotAge(snap && snap.generated_at);
  if (!arts.length || age.stale) { sect.hidden = true; return; }

  const sub = document.getElementById('movers-sub');
  if (sub && mv.recent_day) {
    // label the COMPLETE day the jump is measured on — never imply "today" (partial GA4 day).
    sub.textContent = '— already-published articles surging vs their own 7-day average · as of ' + mv.recent_day;
  }
  const cards = arts.map(function(m, i) { return moverCard(m, i + 1); }).join('');
  const caveat = (mv && mv.caveat)
    ? '<div class="mv-foot">' + PB.esc(mv.caveat) + '</div>' : '';
  panel.innerHTML = '<div class="mv-list">' + cards + '</div>' + caveat;
  sect.hidden = false;   // reveal once populated (the section ships hidden in index.html)
}

/* ---- Usage panel ---- */

// ── "Lopsided winners" — cross-platform outliers, pushable to a 2nd platform.
// Same card grammar as movers/cover-now, but a TEAL "redistribute" rail and a
// per-card ACTION line (the replicable next move). Reads snapshot.lopsided_winners,
// which the snapshot builder fills from v_cross_platform_outliers — the same view the
// Slack daily digest reads, so the dashboard and the digest never disagree.
function lopsidedSlugTitle(pp) {
  const slug = String(pp || '').replace(/^\/+|\/+$/g, '');
  if (!slug) return '(untitled)';
  const words = slug.replace(/-/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// short, human label for the winning platform shown on the trophy chip.
function lopsidedPlatLabel(p) {
  const k = String(p || '').trim().toLowerCase();
  return ({ ga4: 'GA4 traffic', chartbeat: 'engagement', bp_views: 'on-site',
            reddit: 'Reddit', facebook: 'Facebook', pinterest: 'Pinterest'
          })[k] || (p || '?');
}

function lopsidedCard(w, rank) {
  // url: build the canonical BoredPanda url from the page_path (the view has no url col).
  const href = w.page_path ? ('https://www.boredpanda.com' + w.page_path) : '';
  const titleHtml = PB.esc(w.title || lopsidedSlugTitle(w.page_path));
  const title = href
    ? '<a class="lw-title" href="' + PB.esc(href) + '" target="_blank" rel="noopener noreferrer">' + titleHtml + '</a>'
    : '<span class="lw-title">' + titleHtml + '</span>';

  const win  = lopsidedPlatLabel(w.winning_platform);
  const wpct = (w.winning_percentile != null)
    ? Math.round(w.winning_percentile * 100) + 'th pct' : null;
  const missing = w.missing_platforms ? String(w.missing_platforms) : '';

  // metric row: where it won (+ its percentile) · where it's absent
  const meta = [
    '<span class="lw-win" title="the single platform this article ranks highest on">🏆 ' + PB.esc(win) +
      (wpct ? ' <span class="lw-pct">' + PB.esc(wpct) + '</span>' : '') + '</span>',
    missing ? '<span class="lw-miss" title="platforms where this article is in the bottom ~30% — the push opportunity">absent on ' + PB.esc(missing) + '</span>' : '',
  ].filter(Boolean).join('<span class="lw-dot" aria-hidden="true">·</span>');

  // the replicable next move, supplied by the snapshot (kept in sync with the Slack digest).
  const action = w.action
    ? '<div class="lw-action" title="the replicable next move for this lopsided winner">💡 ' + PB.esc(w.action) + '</div>'
    : '';

  return '<div class="lw-card">' +
    '<div class="lw-rank">' + (rank != null ? rank : '') + '</div>' +
    '<div class="lw-body">' +
      '<div class="lw-titlewrap">' + title + '</div>' +
      '<div class="lw-meta">' + meta + '</div>' +
      action +
    '</div>' +
  '</div>';
}

function renderLopsided(snap) {
  const sect  = document.getElementById('lopsided-section');
  const panel = document.getElementById('lopsided-panel');
  if (!sect || !panel) return;
  const lw = snap.lopsided_winners;
  const wins = (lw && Array.isArray(lw.winners)) ? lw.winners : [];
  // self-hide on empty/older snapshot. Also hide on a STALE snapshot — an "absent on X"
  // claim from a snapshot well past its refresh window would be a quiet lie about freshness.
  const age = PB.snapshotAge(snap && snap.generated_at);
  if (!wins.length || age.stale) { sect.hidden = true; return; }

  const cards  = wins.map(function (w, i) { return lopsidedCard(w, w.rank != null ? w.rank : i + 1); }).join('');
  const caveat = (lw && lw.caveat)
    ? '<div class="lw-foot">' + PB.esc(lw.caveat) + '</div>' : '';
  panel.innerHTML = '<div class="lw-list">' + cards + '</div>' + caveat;
  sect.hidden = false;   // reveal once populated (the section ships hidden in index.html)
}

function renderUsage(snap) {
  const panel = document.getElementById('usage-panel');
  if (!panel) return;
  const u = snap.usage;
  if (!u) { panel.innerHTML = ''; return; }

  const ct = u.channel_today || {};
  const c7 = u.channel_7d   || {};
  const uu  = u.unique_users_today || 0;
  const uu7 = u.unique_users_7d   || 0;
  const series = u.daily_series || [];
  const note = u.note || '';

  // Channel rows: API, MCP query, MCP agentic
  const channels = [
    { key: 'api',         label: 'REST API',    tagClass: 'tag-api', tag: 'direct' },
    { key: 'mcp_query',   label: 'MCP query',   tagClass: 'tag-mcp', tag: 'mcp' },
    { key: 'mcp_agentic', label: 'MCP agentic', tagClass: 'tag-mcp', tag: 'mcp' },
  ];

  const chanHTML = channels.map(ch => {
    const v7 = c7[ch.key] || 0;
    return '<div class="usage-channel">' +
      '<div class="usage-ch-label">' + PB.esc(ch.label) + '</div>' +
      '<div class="usage-ch-today">' + PB.fmtInt(ct[ch.key] || 0) + '</div>' +
      '<div class="usage-ch-7d">7d: ' + PB.fmtInt(v7) + ' request' + (v7 === 1 ? '' : 's') + '</div>' +
      '<span class="usage-ch-tag ' + PB.esc(ch.tagClass) + '">' + PB.esc(ch.tag) + '</span>' +
    '</div>';
  }).join('');

  // Daily-volume sparkline (total per day, last 30d)
  let sparkHTML = '';
  if (series.length) {
    const vals = series.map(function(r) { return r.total || 0; });
    const max  = Math.max(1, Math.max.apply(null, vals));
    const n    = vals.length;
    const W = 640, H = 36;
    const bw = W / Math.max(n, 1);
    const pad = bw * 0.15;
    let bars = '';
    for (let i = 0; i < n; i++) {
      const v   = vals[i];
      const bh  = v > 0 ? Math.max(2, (v / max) * (H - 2)) : 2;
      const col = v > 0 ? 'var(--teal)' : 'var(--border)';
      bars += '<rect x="' + (i*bw+pad).toFixed(1) + '" y="' + (H-bh).toFixed(1) + '" ' +
              'width="' + (bw-2*pad).toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="0.6" fill="' + col + '"/>';
    }
    const firstDate = series[0] ? series[0].date : '';
    const lastDate  = series[series.length - 1] ? series[series.length - 1].date : '';
    // Nascent series caption: usage tracking only began recently, so a 1-3 day window
    // is the whole history, not a broken/placeholder chart. Caption it the same way the
    // board captions a just-started source ("tracking started …") so the single bar
    // reads as "the series builds over time", NOT as faked or missing data. No invented
    // data — we only label the honest start date the series itself carries.
    const nascent = n <= 3;
    const startCap = nascent
      ? '<span class="usage-spark-cap" title="request tracking began ' + PB.esc(firstDate) +
          '; this series builds out one bar per day">tracking started ' + PB.esc(firstDate) +
          ' · series builds over time</span>'
      : '';
    sparkHTML =
      '<div class="usage-spark-wrap">' +
        '<div class="usage-spark-title">Daily volume — last ' + n + ' day' + (n === 1 ? '' : 's') +
          startCap +
        '</div>' +
        '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
             'role="img" aria-label="Daily API+MCP request volume">' + bars + '</svg>' +
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--fg-quiet);margin-top:3px">' +
          '<span>' + PB.esc(firstDate) + '</span><span>' + PB.esc(lastDate) + '</span>' +
        '</div>' +
      '</div>';
  }

  panel.innerHTML =
    '<div class="usage-channels">' + chanHTML + '</div>' +
    sparkHTML +
    '<div class="usage-footer">' +
      '<div class="usage-users">Today: <b>' + PB.fmtInt(uu) + '</b> unique caller' + (uu === 1 ? '' : 's') +
        '  ·  7d: <b>' + PB.fmtInt(uu7) + '</b></div>' +
      '<div class="usage-note">' + PB.esc(note) + '</div>' +
    '</div>';
}

/* ---- editorial leaders: top authors + categories ----
   Renders snapshot.editorial_leaders, which pb_snapshot.py already computes from the
   GA4/article catalog (top N authors & categories over a rolling window, with articles
   / pageviews / avg engagement-time / total timespent). The status board above tells you
   the *plumbing* is healthy; this is the one panel that tells an editor what's actually
   WORKING — the Chartbeat-style "who/what is winning" read, served from the SAME snapshot
   the page already fetched (no key, no extra request, no /v1 call). Purely additive and
   self-hiding: if the block is absent/empty (older snapshot), the section stays hidden. */
function leaderTable(rows, nameKey, nameLabel) {
  if (!rows || !rows.length) return '';
  // Rank by pageviews (the headline editorial metric); bar-meter is relative to the
  // top row so the column reads as a Chartbeat-style horizontal ranking at a glance.
  const sorted = rows.slice().sort((a, b) => (b.pageviews || 0) - (a.pageviews || 0));
  const max = Math.max(1, sorted[0].pageviews || 0);
  const body = sorted.map((r, i) => {
    const pv  = r.pageviews || 0;
    const pct = Math.max(2, (pv / max) * 100);
    const eng = r.avg_engagement_time;
    const engTxt = (eng == null || isNaN(eng)) ? '—' : Math.round(eng) + 's';
    return '<tr>' +
      '<td class="lead-rank">' + (i + 1) + '</td>' +
      '<td class="lead-name" title="' + PB.esc(r[nameKey]) + '">' + PB.esc(r[nameKey]) + '</td>' +
      '<td class="lead-arts">' + PB.fmtInt(r.articles) + '</td>' +
      '<td class="lead-pv">' +
        '<span class="lead-bar" style="width:' + pct.toFixed(1) + '%" aria-hidden="true"></span>' +
        '<span class="lead-pv-n">' + PB.fmtInt(pv) + '</span>' +
      '</td>' +
      '<td class="lead-eng">' + engTxt + '</td>' +
    '</tr>';
  }).join('');
  return '<div class="lead-card">' +
    '<div class="lead-card-title">' + PB.esc(nameLabel) + '</div>' +
    '<table class="lead-table"><thead><tr>' +
      '<th class="lead-rank"></th>' +
      '<th class="lead-name">' + PB.esc(nameLabel === 'Top authors' ? 'Author' : 'Category') + '</th>' +
      '<th class="lead-arts">Articles</th>' +
      '<th class="lead-pv">Pageviews</th>' +
      '<th class="lead-eng" title="average engagement time per article">Avg&nbsp;eng.</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table>' +
  '</div>';
}

function renderLeaders(snap) {
  const sect = document.getElementById('leaders-section');
  const panel = document.getElementById('leaders-panel');
  if (!sect || !panel) return;
  const el = snap.editorial_leaders;
  const authors = (el && el.authors) || [];
  const cats    = (el && el.categories) || [];
  if (!authors.length && !cats.length) { sect.hidden = true; return; }  // self-hide

  // window caption ("last 30 days") pulled straight from the snapshot — no invented label.
  const days = el && el.days;
  const cap = document.getElementById('leaders-window');
  if (cap) cap.textContent = days ? ('— top authors & categories · last ' + days + ' days · by pageviews') : '';

  panel.innerHTML =
    leaderTable(authors, 'author', 'Top authors') +
    leaderTable(cats, 'category', 'Top categories');
  sect.hidden = false;
}

/* ---- "Efficiency MVPs": engaged-sessions PER ARTICLE leaderboard ----
   The cross-source pivot the standings board can't give. Editorial leaders (above) ranks
   authors by TOTAL pageviews — so it's a VOLUME board, dominated by high-output writers.
   This panel instead joins the articles spine (author) × GA4 engaged-sessions × GA4 category
   and ranks by engaged-sessions ÷ articles published — the EFFICIENCY read, surfacing the
   MVPs hidden behind raw volume (a 39-article author at ~16.7K engaged-sessions/article can
   outrank a 373-article author at ~3.8K). Each row carries the author's top category (their
   winning lane). Reads snapshot.efficiency_leaders, computed server-side from the SAME
   pre-aggregated fact the editorial board uses (no key, no extra request). Purely additive +
   self-hiding: absent/empty block (older snapshot / none) leaves the section hidden, so the
   four existing pivots widgets are never affected. Honest by construction — carries the data's
   own caveat (efficiency not volume; min-articles floor) as a quiet footnote, like the others. */
function efficiencyCard(a, rank, max) {
  const epa = (a.eng_per_article != null) ? a.eng_per_article : 0;
  const pct = Math.max(2, (epa / max) * 100);   // bar-meter relative to the top row
  const cat = a.top_category
    ? '<span class="ef-cat" title="this author’s highest-pageview category over the window">' + PB.esc(a.top_category) + '</span>'
    : '';
  const arts = (a.articles != null) ? PB.fmtInt(a.articles) : '—';
  const eng  = (a.engaged_sessions != null) ? PB.fmtInt(a.engaged_sessions) : '—';
  return '<tr>' +
    '<td class="lead-rank">' + (rank != null ? rank : '') + '</td>' +
    '<td class="lead-name" title="' + PB.esc(a.author || '') + '">' + PB.esc(a.author || '—') + cat + '</td>' +
    '<td class="lead-arts">' + arts + '</td>' +
    '<td class="lead-pv">' +
      '<span class="lead-bar" style="width:' + pct.toFixed(1) + '%" aria-hidden="true"></span>' +
      '<span class="lead-pv-n" title="engaged sessions per article published in the window">' + PB.fmtInt(epa) + '</span>' +
    '</td>' +
    '<td class="lead-eng" title="total GA4 engaged sessions over the window">' + eng + '</td>' +
  '</tr>';
}

function renderEfficiency(snap) {
  const sect  = document.getElementById('efficiency-section');
  const panel = document.getElementById('efficiency-panel');
  if (!sect || !panel) return;   // guard: no-op on pages without this section
  const eff = snap.efficiency_leaders;
  const authors = (eff && Array.isArray(eff.authors)) ? eff.authors : [];
  if (!authors.length) { sect.hidden = true; return; }   // self-hide (older snapshot / none)

  // already ranked server-side by eng_per_article desc; bar-meter relative to the top row.
  const max = Math.max(1, authors[0].eng_per_article || 0);
  const rows = authors.map(function (a, i) { return efficiencyCard(a, i + 1, max); }).join('');

  // window caption pulled straight from the snapshot — no invented label.
  const cap = document.getElementById('efficiency-window');
  if (cap) {
    const days = eff && eff.days;
    cap.textContent = days
      ? ('— engaged sessions per article · last ' + days + ' days · impact, not volume')
      : '— engaged sessions per article · impact, not volume';
  }

  const caveat = (eff && eff.caveat)
    ? '<div class="lead-foot">' + PB.esc(eff.caveat) + '</div>' : '';
  panel.innerHTML =
    '<div class="lead-card">' +
      '<div class="lead-card-title">Efficiency MVPs — engaged sessions / article</div>' +
      '<table class="lead-table"><thead><tr>' +
        '<th class="lead-rank"></th>' +
        '<th class="lead-name">Author</th>' +
        '<th class="lead-arts">Articles</th>' +
        '<th class="lead-pv" title="GA4 engaged sessions per article published in the window">Eng. sessions / article</th>' +
        '<th class="lead-eng" title="total engaged sessions over the window">Total&nbsp;eng.</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '</div>' + caveat;
  sect.hidden = false;   // reveal once populated (the section ships hidden in pivots.html)
}

/* ---- "What competitors are winning" — top MSN + AOL stories this week --------------
   The first cross-source pivot to surface the competitor MSN/AOL layer (warehoused in the
   hub but never joined onto the dashboard — every prior cross-source widget was reddit×GA4
   or articles×GA4). Reads snapshot.competitor_winners: the top N competitor stories of the
   last 7d, MSN + AOL UNIONed and ranked by engagement (MSN = reactions+comments; AOL =
   comments only, which the row carries honestly), each with its outlet, a category tag where
   the source URL gives one cheaply (MSN; AOL slugs carry none), the engagement count, and a
   link to the story — so a BP editor sees what rivals are WINNING that BP could own. Reuses
   the .lead-* leaderboard table chrome (sibling of Efficiency MVPs). Purely additive +
   self-hiding: an absent/empty block leaves the section hidden, so the five existing pivots
   widgets are never affected. Honest by construction — carries the data's own caveat (which
   engagement metric per outlet; no fuzzy "we don't cover this" gap match) as a quiet
   footnote, like the others. */
// Competitor headlines arrive as URL-slug decodes (the MSN/AOL warehouse carries NO clean
// headline field anywhere — title/syndicated_title/example_title are all slug-derived), so
// they're all-lowercase with apostrophes dropped ("the trump administration … here s what …").
// This is a DISPLAY fix only (no query change → snapshot stays light): restore the common
// contraction apostrophes a slug strips, then Title Case. Best-effort + honest — we never
// invent words, only re-case + re-punctuate what the slug already says.
function cwRestoreApostrophes(t) {
  // common contractions a URL slug loses (the apostrophe + a following letter become a space):
  // "here s" -> "here's", "you re" -> "you're", "don t" -> "don't", "we d" -> "we'd", etc.
  // \b…\b keeps it from mangling real words; applied case-insensitively pre-title-casing.
  return t
    .replace(/\b(\w+) s\b/gi, "$1's")                       // possessive / "here's", "it's", "that's"
    .replace(/\b(\w+) (re|ve|ll|d|t|m)\b/gi, "$1'$2")       // you're, we've, we'll, we'd, don't, I'm
    // the "n t" split ("doesn t" -> "doesn't") — handled by the (…)(t) rule above as "doesn't".
    .replace(/\bo (clock)\b/gi, "o'$1");                    // o'clock
}
// lightweight Title Case: capitalise each word's first letter, but keep short function words
// (a/an/the/of/and/…) lowercase UNLESS they lead the title. Apostrophes/hyphens preserved.
function cwTitleCase(t) {
  const small = new Set(['a','an','and','as','at','but','by','for','from','in','into','nor',
    'of','on','onto','or','per','the','to','vs','via','with']);
  const words = String(t).split(/(\s+)/);   // keep the whitespace tokens to rejoin verbatim
  let wi = 0;
  return words.map(tok => {
    if (/^\s+$/.test(tok) || tok === '') return tok;
    const isFirst = wi === 0;
    wi++;
    const lower = tok.toLowerCase();
    if (!isFirst && small.has(lower)) return lower;
    // capitalise the first alpha char (skips a leading quote/paren); leave the rest as-is
    // so an existing ALLCAPS acronym from the slug isn't relevant (slugs are all-lower anyway).
    return lower.replace(/[a-z]/, c => c.toUpperCase());
  }).join('');
}
function cwPrettyTitle(t) {
  const raw = String(t || '').trim();
  if (!raw) return '(untitled)';
  // strip the snapshot's truncation ellipsis before processing, re-append after.
  const trunc = /\.\.\.$/.test(raw);
  const core = trunc ? raw.replace(/\s*\.\.\.$/, '') : raw;
  return cwTitleCase(cwRestoreApostrophes(core)) + (trunc ? '…' : '');
}
// Publisher display: drop the no-information "(unknown)" sentinel entirely (match the
// no-fuzzy-guess policy — show nothing rather than a guess). Title-Case ONLY a bare
// all-lowercase name ("parade" -> "Parade", an AOL slug-derived publisher); leave names
// that already carry case ("HuffPost", "USA TODAY", "MarketWatch") untouched — re-casing
// those would corrupt them ("Huffpost" / "Usa Today").
function cwPrettyPublisher(p) {
  const raw = String(p || '').trim();
  if (!raw || raw.toLowerCase() === '(unknown)' || raw.toLowerCase() === 'unknown') return '';
  // already has an uppercase letter → trust the source casing as-is.
  if (/[A-Z]/.test(raw)) return raw;
  return cwTitleCase(raw);
}

function competitorRow(s, rank, max) {
  const eng = (s.engagement != null) ? s.engagement : 0;
  const pct = Math.max(2, (eng / max) * 100);   // bar-meter relative to the top row
  // outlet badge: a tiny MSN/AOL chip so the editor reads the source at a glance.
  const oc = (String(s.outlet || '').toLowerCase() === 'aol') ? 'cw-out-aol' : 'cw-out-msn';
  const outlet = '<span class="cw-outlet ' + oc + '">' + PB.esc(s.outlet || '?') + '</span>';
  // category chip (MSN only / where the URL maps cleanly); AOL & unmapped rows show none.
  const cat = s.category
    ? '<span class="ef-cat" title="this story’s section on the competitor site">' + PB.esc(s.category) + '</span>'
    : '';
  // DISPLAY-FIX the slug-derived headline: restore apostrophes + Title Case (no real
  // headline field exists in the warehouse to join to — see cwPrettyTitle).
  const titleTxt = PB.esc(cwPrettyTitle(s.title));
  // title links out to the competitor story when a resolvable URL is present.
  const title = s.url
    ? '<a class="cw-title" href="' + PB.esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + titleTxt + '</a>'
    : '<span class="cw-title">' + titleTxt + '</span>';
  const pubTxt = cwPrettyPublisher(s.publisher);   // '' for "(unknown)"/AOL → no line shown
  const pub = pubTxt
    ? '<div class="cw-pub" title="originating publisher">' + PB.esc(pubTxt) + '</div>' : '';
  // metric label: MSN carries reactions+comments; AOL is comments-only — name it honestly.
  const engTitle = (String(s.outlet || '').toLowerCase() === 'aol')
    ? 'AOL comments (AOL exposes no reaction count)'
    : 'MSN reactions + comments';
  return '<tr>' +
    '<td class="lead-rank">' + (rank != null ? rank : '') + '</td>' +
    '<td class="lead-name">' + outlet + title + cat + pub + '</td>' +
    '<td class="lead-pv">' +
      '<span class="lead-bar" style="width:' + pct.toFixed(1) + '%" aria-hidden="true"></span>' +
      '<span class="lead-pv-n" title="' + engTitle + '">' + PB.fmtInt(eng) + '</span>' +
    '</td>' +
  '</tr>';
}

function renderCompetitors(snap) {
  const sect  = document.getElementById('competitors-section');
  const panel = document.getElementById('competitors-panel');
  if (!sect || !panel) return;   // guard: no-op on pages without this section
  const cw = snap.competitor_winners;
  const stories = (cw && Array.isArray(cw.stories)) ? cw.stories : [];
  if (!stories.length) { sect.hidden = true; return; }   // self-hide (older snapshot / none)

  // already ranked server-side by engagement desc; bar-meter relative to the top row.
  const max = Math.max(1, stories[0].engagement || 0);
  const rows = stories.map(function (s, i) { return competitorRow(s, i + 1, max); }).join('');

  const cap = document.getElementById('competitors-window');
  if (cap) {
    const days = cw && cw.days;
    cap.textContent = days
      ? ('— top MSN & AOL stories · last ' + days + ' days · by engagement')
      : '— top MSN & AOL stories this week · by engagement';
  }

  const caveat = (cw && cw.caveat)
    ? '<div class="lead-foot">' + PB.esc(cw.caveat) + '</div>' : '';
  panel.innerHTML =
    '<div class="lead-card">' +
      '<div class="lead-card-title">What competitors are winning — MSN &amp; AOL top stories</div>' +
      '<table class="lead-table"><thead><tr>' +
        '<th class="lead-rank"></th>' +
        '<th class="lead-name">Story</th>' +
        '<th class="lead-pv">Engagement</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '</div>' + caveat;
  sect.hidden = false;   // reveal once populated (the section ships hidden in pivots.html)
}

/* ---- "Where to beat them" — competitor OPPORTUNITIES (the actionable sibling) -------
   The prescriptive complement to "What competitors are winning": where that widget reads
   what rivals DID, this reads where an editor should WRITE — topic buckets where competitors
   pile up engagement but BoredPanda's recent coverage is thin. Reads
   snapshot.competitor_opportunities (the proven v_competitor_opportunities view): one row per
   topic_bucket, ranked by opportunity_score (competitor engagement ÷ BP 90-day coverage). Each
   row shows the topic, the competitor engagement signal, the BP coverage level (the gap), and
   the score. Reuses the .lead-* table chrome (sibling of "What competitors are winning") and
   the SAME slug display-fix (cwPrettyTitle / cwPrettyPublisher) the competitor headlines use —
   the example title is a slug decode from the same warehouse. Self-hiding: an absent/empty
   block leaves the <section> hidden, so older snapshots never break the layout. */
// topic_bucket arrives as a snake_case warehouse key ('health_wellness', 'film_tv',
// 'entertainment_other'). Map the handful of buckets to clean editorial labels; fall back to a
// generic underscore→space Title-Case for any new bucket so an added bucket never shows raw.
function coBucketLabel(b) {
  const map = {
    autos: 'Autos', celebrity: 'Celebrity', entertainment_other: 'Entertainment',
    film_tv: 'Film & TV', food: 'Food', health_wellness: 'Health & Wellness',
    lifestyle: 'Lifestyle', travel: 'Travel', music: 'Music', animals: 'Animals',
  };
  const key = String(b || '').toLowerCase();
  if (map[key]) return map[key];
  return key ? cwTitleCase(key.replace(/_/g, ' ')) : '(uncategorised)';
}
// coverage label → a tiny semantic chip class so the GAP (the opportunity) reads at a glance:
// ABSENT/THIN = the opportunity (warm), WELL-COVERED = no gap (cool).
function coCoverageChip(cov) {
  const c = String(cov || '').toUpperCase();
  let cls = 'co-cov-mid';
  if (c.startsWith('ABSENT')) cls = 'co-cov-absent';
  else if (c.startsWith('THIN')) cls = 'co-cov-thin';
  else if (c.startsWith('WELL')) cls = 'co-cov-well';
  return '<span class="co-cov ' + cls + '" title="BoredPanda articles in this topic over the last 90 days">'
    + PB.esc(cov || '—') + '</span>';
}

function opportunityRow(o, max) {
  const score = (o.opportunity_score != null) ? o.opportunity_score : 0;
  const pct = Math.max(2, (score / max) * 100);   // bar-meter relative to the top row
  const bucket = '<span class="co-bucket">' + PB.esc(coBucketLabel(o.topic_bucket)) + '</span>';
  const cov = coCoverageChip(o.bp_coverage);
  // competitor engagement signal: reactions + comments over the warehoused window. Shown as the
  // "what they're getting" line; the example article (slug-decoded, display-fixed) gives a
  // concrete read of what's winning in the bucket.
  const eng = (o.competitor_reactions || 0) + (o.competitor_comments || 0);
  const exTitle = o.example_title ? cwPrettyTitle(o.example_title) : '';
  const exPub = cwPrettyPublisher(o.example_publisher);
  const example = exTitle
    ? '<div class="co-ex" title="the top competitor story in this topic">' +
        '<span class="co-ex-q">e.g.</span> ' + PB.esc(exTitle) +
        (exPub ? ' <span class="co-ex-pub">· ' + PB.esc(exPub) + '</span>' : '') +
      '</div>'
    : '';
  const artLabel = (o.bp_articles_90d != null)
    ? (o.bp_articles_90d + ' BP article' + (o.bp_articles_90d === 1 ? '' : 's') + ' · 90d')
    : '';
  return '<tr>' +
    '<td class="lead-rank">' + (o.rank != null ? o.rank : '') + '</td>' +
    '<td class="lead-name">' + bucket + cov +
      '<div class="co-arts" title="BoredPanda articles published in this topic in the last 90 days">' +
        PB.esc(artLabel) + '</div>' + example +
    '</td>' +
    '<td class="lead-pv co-eng">' +
      '<span class="lead-bar" style="width:' + pct.toFixed(1) + '%" aria-hidden="true"></span>' +
      '<span class="lead-pv-n" title="competitor engagement (reactions + comments) in this topic">' +
        PB.fmtInt(eng) + '</span>' +
    '</td>' +
    '<td class="co-score" title="opportunity score = competitor engagement ÷ BP 90-day coverage — higher means a bigger gap to fill">' +
      PB.fmtInt(Math.round(score)) + '</td>' +
  '</tr>';
}

function renderOpportunities(snap) {
  const sect  = document.getElementById('opportunities-section');
  const panel = document.getElementById('opportunities-panel');
  if (!sect || !panel) return;   // guard: no-op on pages without this section
  const co = snap.competitor_opportunities;
  const rows0 = (co && Array.isArray(co.opportunities)) ? co.opportunities : [];
  if (!rows0.length) { sect.hidden = true; return; }   // self-hide (older snapshot / none)

  // already ranked server-side by opportunity_score desc; bar-meter relative to the top engagement.
  const maxScore = Math.max(1, rows0[0].opportunity_score || 0);
  const rows = rows0.map(function (o) { return opportunityRow(o, maxScore); }).join('');

  const caveat = (co && co.caveat)
    ? '<div class="lead-foot">' + PB.esc(co.caveat) + '</div>' : '';
  panel.innerHTML =
    '<div class="lead-card">' +
      '<div class="lead-card-title">Where to beat them — topics rivals win that BP under-covers</div>' +
      '<table class="lead-table"><thead><tr>' +
        '<th class="lead-rank"></th>' +
        '<th class="lead-name">Topic &amp; coverage gap</th>' +
        '<th class="lead-pv">Competitor engagement</th>' +
        '<th class="co-score">Score</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '</div>' + caveat;
  sect.hidden = false;   // reveal once populated (the section ships hidden in pivots.html)
}

/* ---- Pivots page: 3 labeled, collapsible sections + sticky sub-nav ----------------
   The six pivots widgets are grouped into three labeled sections on pivots.html:
     🔴 Act now          (cover-now + movers)        — always open
     🟢 Our performance  (lopsided + leaders + eff.) — collapsible
     🔵 Competitive intel(competitors)               — collapsible
   This reuses the source-board's collapse GRAMMAR (a header role=button that toggles a
   `.collapsed` class on the section, rotating a caret) rather than inventing a new one —
   here the classes are .pv-group / .pv-ghead / .pv-gbody (mirrors .group / .g-head /
   .g-body) so pivots can't disturb the board's own collapse state set.

   Two extra behaviours layer on top:
     1) GROUP SELF-HIDE — each widget's renderer already self-hides its own <section> when
        its snapshot block is empty. wirePivots() then hides a WHOLE group when every widget
        inside it is hidden, so an empty section header never shows (mirrors the widgets'
        own "nothing to surface today → stay hidden" honesty). The group's collapsed state
        is otherwise left exactly as authored (Act now open; the other two collapsed).
     2) SUB-NAV — the sticky in-page nav's anchors jump to a section; if that section is
        collapsed we expand it first so the jump lands on content, not a closed header. */
function pivotsToggle(sec, collapse) {
  const want = (collapse == null) ? !sec.classList.contains('collapsed') : !!collapse;
  sec.classList.toggle('collapsed', want);
  const head = sec.querySelector('.pv-ghead');
  if (head) head.setAttribute('aria-expanded', want ? 'false' : 'true');
}

let pivotsWired = false;
function wirePivots() {
  const groups = document.querySelectorAll('.pv-group');
  if (!groups.length) return;   // no-op on pages without the pivots sections (index/ideas)

  // (1) self-hide a group whose every widget <section> is hidden/empty; reveal it otherwise.
  groups.forEach(sec => {
    const widgets = sec.querySelectorAll('.pv-gbody > section, .pv-gbody .pv-two-up > section');
    const anyShown = [...widgets].some(w => !w.hidden);
    sec.hidden = !anyShown;
  });

  if (pivotsWired) return;      // listeners bind once; the self-hide above re-runs each render
  pivotsWired = true;

  // (2) header collapse/expand — same grammar as the board's .g-head (click + Enter/Space).
  groups.forEach(sec => {
    const head = sec.querySelector('.pv-ghead');
    if (!head) return;
    const toggle = () => pivotsToggle(sec);
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });

  // (3) sticky sub-nav: jump to a section, expanding it first if collapsed so the jump
  // lands on its content (smooth scroll comes from html{scroll-behavior:smooth}).
  document.querySelectorAll('.pv-subnav a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const id = a.getAttribute('href').slice(1);
      const target = document.getElementById(id);
      if (!target) return;             // let the browser handle a stray anchor
      e.preventDefault();
      if (target.classList.contains('pv-group')) pivotsToggle(target, false);  // expand
      // defer the scroll one frame so the just-expanded body has laid out.
      requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', '#' + id);
      });
    });
  });
}

/* ---- hub "pulse": at-a-glance health summary ----
   Derived from the SAME snapshot the board already loaded (no extra fetch). Buckets
   every source into one calm category, honoring flow-state so a deliberate pause/frozen
   source counts as "paused", NOT as an issue:
     fresh   — status FRESH
     issue   — STALE / STALLED / MISSING / DEPRECATED *that is not deliberately paused*
     paused  — pausedInfo(s) → FROZEN or prose-declared PAUSED (a chosen hold)
     derived — no status (derived/pending vectors etc.)
   Verdict: "All fresh" only when every source is literally FRESH; "All healthy" when
   there are no issues but some sources are a deliberate hold (paused/frozen) or derived
   — so the verdict never contradicts a "N paused" segment; "Attention" (amber) when any
   issue exists. */
function hubPulse(snap) {
  const sources = snap.sources || [];
  let fresh = 0, issue = 0, paused = 0, derived = 0;
  for (const s of sources) {
    if (pausedInfo(s)) { paused++; continue; }       // deliberate hold — never an issue
    const st = s.status;
    if (st == null) { derived++; continue; }
    if (st === 'FRESH') fresh++;
    else if (st === 'FROZEN') paused++;              // belt-and-braces (pausedInfo already caught these)
    else if (PB.PROBLEM.has(st)) issue++;
    else derived++;                                  // UNKNOWN/other → quiet derived bucket
  }
  return { fresh, issue, paused, derived, total: sources.length };
}

function renderPulse(snap) {
  const el = document.getElementById('hub-pulse');
  if (!el) return;
  const p = hubPulse(snap);
  const attn = p.issue > 0;
  // "All fresh" only when every source is literally fresh; otherwise (no issues, but some
  // deliberately paused/frozen or derived) say "All healthy" so the verdict never reads as
  // contradicting a "N paused" / "N derived" segment beside it.
  const allFresh = p.fresh === p.total;
  const verdict = attn
    ? (p.issue === 1 ? '1 needs attention' : `${p.issue} need attention`)
    : (allFresh ? 'All fresh' : 'All healthy');

  // segments in priority order; only render the ones that are non-zero (issue is always
  // shown when present). Each is a small status dot + count + label.
  const seg = (cls, n, label, title) =>
    `<span class="pulse-seg" title="${PB.esc(title)}"><span class="pulse-dot ${cls}"></span>`
    + `<span class="pulse-n">${n}</span> ${PB.esc(label)}</span>`;
  const parts = [];
  if (p.fresh)   parts.push(seg('pd-fresh',   p.fresh,   'fresh',   `${p.fresh} source(s) up to date`));
  if (p.issue)   parts.push(seg('pd-issue',   p.issue,   p.issue === 1 ? 'needs attention' : 'need attention', `${p.issue} source(s) STALE/STALLED/MISSING — to investigate`));
  if (p.paused)  parts.push(seg('pd-paused',  p.paused,  'paused',  `${p.paused} source(s) deliberately paused or frozen (intentional hold)`));
  if (p.derived) parts.push(seg('pd-derived', p.derived, 'derived', `${p.derived} derived/pending source(s) (no freshness status)`));

  el.className = 'hub-pulse' + (attn ? ' attn' : '');
  el.removeAttribute('hidden');
  el.innerHTML = `<span class="pulse-verdict">${PB.esc(verdict)}</span>`
    + `<span class="pulse-sep" aria-hidden="true">·</span>`
    + parts.join('<span class="pulse-sep" aria-hidden="true">·</span>')
    // freshness "updated N ago" stamp: a quiet trailing segment carrying the snapshot's
    // own age (it lives in the chip so the at-a-glance health read and the as-of time sit
    // together). Filled + kept ticking by renderFreshness() below; placeholder until then.
    + `<span class="pulse-sep pulse-sep-fresh" aria-hidden="true">·</span>`
    + `<span class="pulse-fresh" id="pulse-fresh"></span>`;
  renderFreshness(snap);
}

/* ---- snapshot freshness stamp ("updated N ago") ----
   A small "as-of" indicator appended to the hub-pulse chip. It reads the SAME snapshot
   the board already loaded (snap.generated_at) — no extra fetch. Crucially it keeps the
   RELATIVE time current on its own 30s ticker between the page's ~5-min snapshot fetches,
   so an editor always knows how old the data is, and a STALLED refresh (snapshot stops
   regenerating) surfaces as the age creeping up + an amber tint — the core
   Chartbeat-style observability read ("is this live, and how live?"). Self-hiding when
   generated_at is absent (older snapshot shape). */
let _freshGenAt = null;            // generated_at of the current snapshot
function paintFreshness() {
  const el = document.getElementById('pulse-fresh');
  if (!el) return;
  // On ideas.html the stamp lives in a STANDALONE pill (#ideas-fresh) with no health
  // verdict — so when there's no freshness to show, hide the whole pill, not just the
  // inner span (an empty bordered pill would otherwise show). Harmless on index (no such
  // wrapper; the pulse chip always has its verdict content).
  const standalone = document.getElementById('ideas-fresh');
  const hideAll = () => { el.textContent = ''; el.hidden = true; if (standalone) standalone.hidden = true; };
  if (!_freshGenAt) { hideAll(); return; }
  const a = PB.snapshotAge(_freshGenAt);
  if (a.minutes == null) { hideAll(); return; }
  if (standalone) standalone.hidden = false;
  el.hidden = false;
  el.classList.toggle('is-stale', !!a.stale);
  el.title = 'Snapshot generated ' + a.exact
    + (a.stale ? ' — older than usual; the auto-refresh may be behind' : '')
    + '. The page reloads it every few minutes; this time is live.';
  el.innerHTML = '<span class="pf-dot" aria-hidden="true"></span>'
    + '<span class="pf-lbl">updated</span> <span class="pf-ago">' + PB.esc(a.txt) + '</span>';
}
function renderFreshness(snap) {
  _freshGenAt = (snap && snap.generated_at) || null;
  paintFreshness();
  if (!renderFreshness._tick) {
    // keep the relative label honest between snapshot fetches (lightweight: text only).
    renderFreshness._tick = setInterval(paintFreshness, 30 * 1000);
  }
}

function renderAll(snap) {
  SNAP = snap;
  // hide whichever "Loading snapshot…" placeholder this page carries (index: #dash-loading;
  // ideas: #ideas-loading). Both are guarded so the shared renderer no-ops on the page lacking
  // the other's element.
  ['dash-loading', 'ideas-loading'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  applyDefaultCollapse(snap);
  renderPulse(snap);      // full health summary — only renders where #hub-pulse exists (index)
  // freshness "updated N ago" stamp: renderPulse also calls this, but on a page WITHOUT
  // #hub-pulse (ideas.html) renderPulse early-returns, so call it directly here too. It targets
  // #pulse-fresh by id (idempotent; the 30s ticker is guarded against double-arming).
  renderFreshness(snap);
  renderCoverNow(snap);   // morning-editor "what to cover now"
  renderMovers(snap);     // morning-editor "what already surged" — paired with cover-now
  renderLopsided(snap);   // replicable wins — articles big on one platform, pushable to another
  renderBoard(snap);      // source board — index only (guarded)
  renderLeaders(snap);    // editorial leaders — index only (guarded)
  renderEfficiency(snap); // efficiency MVPs — engaged-sessions/article (pivots only, guarded)
  renderCompetitors(snap);// competitor winners — top MSN/AOL stories (pivots only, guarded)
  renderOpportunities(snap);// "where to beat them" — competitor opportunity gaps (pivots only, guarded)
  renderUsage(snap);      // usage panel — index only (guarded)
  wirePivots();           // pivots 3-section collapse + sub-nav + group self-hide (pivots only, guarded)
}

async function boot() {
  let snap;
  try { snap = await PB.loadSnapshot(); }
  catch (e) {
    // surface the error in whichever "Loading…" placeholder this page carries (index or ideas).
    const loading = document.getElementById('dash-loading') || document.getElementById('ideas-loading');
    if (loading) loading.innerHTML =
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
