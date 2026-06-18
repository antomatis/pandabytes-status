/* pandabytes status — shared client logic.
   Keyless static JS. The dashboard reads the LIVE same-origin snapshot at
   /snapshot.json (served by nginx from /DATA/api/snapshot.json, refreshed every
   ~10 min). No API key, no localStorage. The /v1 REST API stays key-gated for
   agents/MCP — see docs.html. No secrets in this repo. */
'use strict';

const PB = {
  API_BASE: '/v1',                    // REST API base (key-gated; used by docs examples only)
  SNAPSHOT_URL: '/snapshot.json',     // live same-origin snapshot served by nginx

  STATUS_ORDER: { MISSING: 0, STALLED: 1, STALE: 2, DEPRECATED: 3, FROZEN: 4, FRESH: 5, UNKNOWN: 6 },
  STATUS_LIST: ['FRESH', 'STALE', 'STALLED', 'FROZEN', 'MISSING', 'DEPRECATED'],
  PROBLEM: new Set(['MISSING', 'STALLED', 'STALE', 'DEPRECATED']),
};

/* ---------- formatting ---------- */
PB.fmtInt = (n) => {
  if (n == null || isNaN(n)) return '—';
  n = Number(n);
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 2).replace(/\.0+$/, '') + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 2).replace(/\.0+$/, '') + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0+$/, '') + 'K';
  // small decimals (e.g. revenue eur)
  if (!Number.isInteger(n) && Math.abs(n) < 1000) return n.toFixed(Math.abs(n) < 1 ? 4 : 2).replace(/\.?0+$/, '');
  return Math.round(n).toLocaleString('en-US');
};
PB.fmtFull = (n) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US');

PB.parseTs = (s) => {
  if (!s) return null;
  // snapshot generated_at like "2026-06-18 19:33:17.926625+03"
  let t = String(s).trim().replace(' ', 'T');
  // normalize a bare +03 offset to +03:00
  t = t.replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
};

// synced X ago, computed from latest_date vs the snapshot's generated_at
PB.syncedAgo = (latestDate, generatedAt) => {
  if (!latestDate) return { txt: 'no data', hours: null };
  const ld = PB.parseTs(latestDate.length <= 10 ? latestDate + 'T00:00:00Z' : latestDate);
  const gen = PB.parseTs(generatedAt) || new Date();
  if (!ld) return { txt: '—', hours: null };
  const ms = gen.getTime() - ld.getTime();
  const h = ms / 3.6e6;
  let txt;
  if (h < 1.5) txt = 'synced <1h ago';
  else if (h < 48) txt = 'synced ' + Math.round(h) + 'h ago';
  else txt = 'synced ' + Math.round(h / 24) + 'd ago';
  return { txt, hours: h };
};

PB.normStatus = (s) => (s && PB.STATUS_LIST.includes(s)) ? s : 'UNKNOWN';

// Light-theme status palette (Slack tokens) — also drives sparkline/column-chart
// bar fills, so values are saturated enough to read on white.
PB.statusColor = (s) => ({
  FRESH: '#2eb67d', STALE: '#ecb22e', STALLED: '#e0973a', FROZEN: '#5b7795',
  MISSING: '#e01e5a', DEPRECATED: '#98a2b3', UNKNOWN: '#b0b8c4',
}[PB.normStatus(s)]);

PB.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- data loading ---------- */
// Fetch the LIVE same-origin snapshot. It already carries everything the board needs
// (sources[] with coverage_30d, plus stats). No key, no localStorage, no /v1 call.
PB.loadSnapshot = async () => {
  const r = await fetch(PB.SNAPSHOT_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error('snapshot ' + r.status);
  return r.json();
};

/* ---------- inline SVG charts (no external deps) ---------- */
// compact sparkline of coverage_30d[].key_metric; gaps (null/0) render as visible blanks.
PB.sparkline = (cov, color, w, h) => {
  w = w || 120; h = h || 30;
  if (!cov || !cov.length) return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
  const vals = cov.map(p => (p.key_metric == null ? 0 : Number(p.key_metric)));
  const max = Math.max(1, ...vals);
  const n = cov.length, bw = w / n, pad = bw * 0.18;
  let bars = '';
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    const missing = (cov[i].key_metric == null);
    const bh = missing ? 0 : Math.max(v > 0 ? 1.5 : 0, (v / max) * (h - 2));
    if (missing || v === 0) {
      // visible gap marker on light bg: a soft light-red baseline tick (zero/missing day)
      bars += `<rect x="${(i*bw+pad).toFixed(2)}" y="${h-2}" width="${(bw-2*pad).toFixed(2)}" height="2" rx="0.5" fill="#f3b6c5"/>`;
    } else {
      bars += `<rect x="${(i*bw+pad).toFixed(2)}" y="${(h-bh).toFixed(2)}" width="${(bw-2*pad).toFixed(2)}" height="${bh.toFixed(2)}" rx="0.6" fill="${color}"/>`;
    }
  }
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}">${bars}</svg>`;
};

// Short, readable date for an axis tick: "Jun 16" (from an ISO yyyy-mm-dd string).
PB._MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
PB.fmtDay = (iso) => {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso).slice(5);
  return PB._MON[(+m[2]) - 1] + ' ' + (+m[3]);
};
// Compact per-bar date "6/16" (month/day) — fits under every one of 30 rotated ticks.
PB.fmtDayShort = (iso) => {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso).slice(5);
  return (+m[2]) + '/' + (+m[3]);
};
// Long date for the tooltip: "Mon, Jun 16 2026".
PB._DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
PB.fmtDayLong = (iso) => {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  const d = new Date(Date.UTC(+m[1], (+m[2]) - 1, +m[3]));
  const dow = isNaN(d) ? '' : PB._DOW[d.getUTCDay()] + ', ';
  return dow + PB._MON[(+m[2]) - 1] + ' ' + (+m[3]) + ' ' + m[1];
};

// Full column chart with a title, y-axis scale, dated x-axis + rich JS hover, for
// the expanded panel. `metricName` names WHAT is plotted (e.g. "pageviews");
// `unitLabel` is the unit shown in the tooltip. Bars carry data-* attrs that
// PB.wireChartTooltips() reads to build a floating tooltip ({date, value, rows}).
//
// EVERY bar is labelled: a compact value (rotated vertical) sits on top of the bar
// and a short date (rotated) sits underneath. The SVG carries a generous bottom/top
// margin for the rotated text and a wide per-bar pitch (min ~30u/bar) so all 30+
// labels are legible. On narrow viewports the chart stays at its intrinsic width and
// the holder scrolls horizontally (CSS) instead of squeezing the bars.
PB.columnChart = (cov, color, metricName, unitLabel) => {
  if (!cov || !cov.length) return '<div class="chart-note">No coverage data for this source.</div>';
  const n = cov.length;
  // viewBox uses a 1:1 user-unit space; CSS sizes it responsively (no distortion).
  // Each bar keeps a FIXED comfortable pitch (~30u) for the rotated value/date labels,
  // identical across charts. The plot reserves a minimum window (≥ a ~560u floor) so a
  // short series doesn't look sparse — and the bars are RIGHT-PACKED into that window:
  // the newest day (cov[n-1]) sits flush against the right edge, any unused (older)
  // slots stay empty on the LEFT (standard time-series "newest on the right" layout).
  const padL = 52, padR = 22, padT = 56, padB = 58;        // big top/bottom gutters for rotated labels
  const PITCH = 30;                                        // user-units per bar (label-safe), fixed
  const slots = Math.max(n, Math.round(560 / PITCH));      // window in bar-pitches (floor for short series)
  const offset = slots - n;                                // empty leading slots on the LEFT (right-pack)
  const plotW = slots * PITCH;
  const W = padL + plotW + padR;
  const H = 230;
  const vals = cov.map(p => (p.key_metric == null ? null : Number(p.key_metric)));
  const present = vals.filter(v => v != null && v > 0);
  const max = Math.max(1, ...vals.map(v => v == null ? 0 : v));
  const plotH = H - padT - padB;
  const baseY = padT + plotH;
  const bw = PITCH, pad = Math.min(bw * 0.22, 6);          // fixed bar slot width
  const innerW = Math.max(2, bw - 2 * pad);
  const yOf = (v) => baseY - (v / max) * plotH;

  const metric = metricName || 'value';
  const unit = unitLabel || metric;

  let grid = '', bars = '', xlab = '', vlab = '';

  // horizontal gridlines + y-scale numbers at 0 / 25 / 50 / 75 / 100%
  for (let g = 0; g <= 4; g++) {
    const frac = g / 4;
    const gy = baseY - frac * plotH;
    const isBase = g === 0;
    grid += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${(W-padR).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${isBase ? '#d7dce2' : '#eef0f3'}" stroke-width="1"/>`;
    grid += `<text x="${(padL-7).toFixed(1)}" y="${(gy+3.5).toFixed(1)}" class="cc-yt" text-anchor="end">${frac === 0 ? '0' : PB.fmtInt(max * frac)}</text>`;
  }

  for (let i = 0; i < n; i++) {
    const v = vals[i], x = padL + (offset + i) * bw + pad, missing = (v == null);
    const cx = (x + innerW / 2);
    const date = cov[i].date || '';
    const rc = cov[i].row_count;
    // data-* drive the JS tooltip (no native <title> — too slow/unstyled)
    const data = `data-d="${PB.esc(PB.fmtDayLong(date))}" data-v="${missing ? '' : PB.esc(PB.fmtFull(v))}"`
      + ` data-vu="${PB.esc(unit)}" data-r="${rc == null ? '' : PB.esc(PB.fmtFull(rc))}" data-gap="${(missing || v === 0) ? '1' : '0'}"`;
    // value-on-top: rotated -90° (reads bottom→top), anchored just above the bar top.
    // gap/zero days show a muted "0" so EVERY bar carries a number.
    if (missing || v === 0) {
      // zero/gap day: thin red baseline tick (still hoverable for {date,gap})
      bars += `<rect class="cc-bar cc-gap" x="${x.toFixed(1)}" y="${(baseY-2.5).toFixed(1)}" width="${innerW.toFixed(1)}" height="2.5" rx="0.6" ${data}/>`;
      const ty = baseY - 6;
      vlab += `<text x="${cx.toFixed(1)}" y="${ty.toFixed(1)}" class="cc-vl cc-vl-zero" text-anchor="start" transform="rotate(-90 ${cx.toFixed(1)} ${ty.toFixed(1)})">0</text>`;
    } else {
      const by = yOf(v), bh = Math.max(2, baseY - by);
      bars += `<rect class="cc-bar" x="${x.toFixed(1)}" y="${by.toFixed(1)}" width="${innerW.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${color}" ${data}/>`;
      const ty = by - 4;          // baseline of the (rotated) value label, just above the bar
      vlab += `<text x="${cx.toFixed(1)}" y="${ty.toFixed(1)}" class="cc-vl" text-anchor="start" transform="rotate(-90 ${cx.toFixed(1)} ${ty.toFixed(1)})">${PB.esc(PB.fmtInt(v))}</text>`;
    }
    // date-under-every-bar: rotated -60°, end-anchored so it hangs below-left of cx.
    const dy = baseY + 12;
    xlab += `<text x="${cx.toFixed(1)}" y="${dy.toFixed(1)}" class="cc-xt" text-anchor="end" transform="rotate(-60 ${cx.toFixed(1)} ${dy.toFixed(1)})">${PB.esc(PB.fmtDayShort(date))}</text>`;
  }

  // chart title (WHAT is plotted) + sample-size note
  const days = `${present.length}/${n} days`;
  const title = `<text x="${padL}" y="18" class="cc-title">${PB.esc(metric)} / day</text>`
    + `<text x="${(W-padR).toFixed(1)}" y="18" class="cc-sub" text-anchor="end">peak ${PB.esc(PB.fmtInt(max))} ${PB.esc(unit)} · ${days}</text>`;

  // inner SVG keeps its intrinsic width; the .bigchart-scroll holder (CSS) lets it
  // scroll horizontally on narrow screens rather than cramming 30 labels together.
  return `<svg class="bigchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"`
    + ` preserveAspectRatio="xMinYMid meet" role="img" style="--cc-w:${W}"`
    + ` aria-label="${PB.esc(metric)} per day, peak ${PB.esc(PB.fmtInt(max))}, ${n} days each labelled with date and value">`
    + `${grid}${bars}${vlab}${xlab}${title}</svg>`;
};

// Attach one floating tooltip to a chart holder. Reads data-* off .cc-bar rects.
// Idempotent per holder. Called after the detail panel is inserted into the DOM.
PB.wireChartTooltips = (holder) => {
  if (!holder || holder._ccWired) return;
  holder._ccWired = true;
  // When the chart is wider than its scroll rail (narrow/mobile viewport), start the
  // rail scrolled to its far-RIGHT end so the newest day is visible by default
  // (matches the right-packed, newest-flush-right layout).
  const scroll = holder.querySelector('.bigchart-scroll');
  if (scroll) {
    const toRight = () => { scroll.scrollLeft = scroll.scrollWidth; };
    toRight();
    requestAnimationFrame(toRight);   // re-apply after layout/SVG sizing settles
  }
  let tip = holder.querySelector('.cc-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'cc-tip';
    tip.setAttribute('role', 'tooltip');
    holder.appendChild(tip);
  }
  const show = (bar, ev) => {
    const d = bar.getAttribute('data-d');
    const gap = bar.getAttribute('data-gap') === '1';
    let html = `<div class="cc-tip-d">${PB.esc(d)}</div>`;
    if (gap) {
      html += `<div class="cc-tip-gap">no data (gap)</div>`;
    } else {
      const v = bar.getAttribute('data-v'), vu = bar.getAttribute('data-vu'), r = bar.getAttribute('data-r');
      html += `<div class="cc-tip-v">${PB.esc(v)} <span>${PB.esc(vu)}</span></div>`;
      if (r) html += `<div class="cc-tip-r">${PB.esc(r)} rows</div>`;
    }
    tip.innerHTML = html;
    tip.classList.add('show');
    const hb = holder.getBoundingClientRect(), bb = bar.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = bb.left - hb.left + bb.width / 2 - tw / 2;
    left = Math.max(2, Math.min(left, hb.width - tw - 2));
    let top = bb.top - hb.top - th - 8;
    if (top < 0) top = bb.bottom - hb.top + 8;   // flip below if no room above
    tip.style.left = left.toFixed(0) + 'px';
    tip.style.top = top.toFixed(0) + 'px';
    bar.classList.add('cc-hot');
  };
  const hide = (bar) => { tip.classList.remove('show'); if (bar) bar.classList.remove('cc-hot'); };
  holder.querySelectorAll('.cc-bar').forEach(bar => {
    bar.addEventListener('mouseenter', (e) => show(bar, e));
    bar.addEventListener('mouseleave', () => hide(bar));
    // touch: tap toggles the tooltip
    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      if (bar.classList.contains('cc-hot')) hide(bar);
      else { holder.querySelectorAll('.cc-bar.cc-hot').forEach(b => b.classList.remove('cc-hot')); show(bar, e); }
    });
  });
};

/* ---------- docs helpers ---------- */
PB.copyToClipboard = (btn) => {
  const pre = btn.closest('pre'); const code = pre ? pre.querySelector('code') : null;
  const txt = code ? code.innerText : '';
  navigator.clipboard && navigator.clipboard.writeText(txt).then(() => {
    const old = btn.textContent; btn.textContent = 'copied'; setTimeout(() => btn.textContent = old, 1200);
  });
};
