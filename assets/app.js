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
PB.columnChart = (cov, color, metricName, unitLabel) => {
  if (!cov || !cov.length) return '<div class="chart-note">No coverage data for this source.</div>';
  // viewBox uses a 1:1 user-unit space; CSS sizes it responsively (no distortion).
  const W = 880, H = 188;
  const padL = 52, padR = 14, padT = 30, padB = 30;        // gutters: title + y-scale + x-dates
  const vals = cov.map(p => (p.key_metric == null ? null : Number(p.key_metric)));
  const present = vals.filter(v => v != null && v > 0);
  const max = Math.max(1, ...vals.map(v => v == null ? 0 : v));
  const n = cov.length;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const baseY = padT + plotH;
  const bw = plotW / n, pad = Math.min(bw * 0.18, 5);
  const innerW = Math.max(1, bw - 2 * pad);
  const yOf = (v) => baseY - (v / max) * plotH;

  // index of min / max / last present bars → always-on value labels
  let iMax = -1, iMin = -1, iLast = -1, vMax = -Infinity, vMin = Infinity;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v == null || v <= 0) continue;
    iLast = i;
    if (v > vMax) { vMax = v; iMax = i; }
    if (v < vMin) { vMin = v; iMin = i; }
  }
  const labelSet = new Set([iMax, iMin, iLast].filter(i => i >= 0));

  // weekly-ish x ticks: ~6 evenly spaced, always include first & last
  const step = Math.max(1, Math.round(n / 6));
  const tickSet = new Set([0, n - 1]);
  for (let i = 0; i < n; i += step) tickSet.add(i);

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
    const v = vals[i], x = padL + i * bw + pad, missing = (v == null);
    const cx = (x + innerW / 2);
    const date = cov[i].date || '';
    const rc = cov[i].row_count;
    // data-* drive the JS tooltip (no native <title> — too slow/unstyled)
    const data = `data-d="${PB.esc(PB.fmtDayLong(date))}" data-v="${missing ? '' : PB.esc(PB.fmtFull(v))}"`
      + ` data-vu="${PB.esc(unit)}" data-r="${rc == null ? '' : PB.esc(PB.fmtFull(rc))}" data-gap="${(missing || v === 0) ? '1' : '0'}"`;
    if (missing || v === 0) {
      // zero/gap day: thin red baseline tick (still hoverable for {date,gap})
      bars += `<rect class="cc-bar cc-gap" x="${x.toFixed(1)}" y="${(baseY-2.5).toFixed(1)}" width="${innerW.toFixed(1)}" height="2.5" rx="0.6" ${data}/>`;
    } else {
      const by = yOf(v), bh = Math.max(2, baseY - by);
      bars += `<rect class="cc-bar" x="${x.toFixed(1)}" y="${by.toFixed(1)}" width="${innerW.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${color}" ${data}/>`;
      // always-on compact value above the min / max / last bars
      if (labelSet.has(i)) {
        const ty = Math.max(padT - 1, by - 4);
        vlab += `<text x="${cx.toFixed(1)}" y="${ty.toFixed(1)}" class="cc-vl" text-anchor="middle">${PB.esc(PB.fmtInt(v))}</text>`;
      }
    }
    if (tickSet.has(i)) {
      const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
      const lx = i === 0 ? padL : (i === n - 1 ? W - padR : cx);
      xlab += `<text x="${lx.toFixed(1)}" y="${(H-9).toFixed(1)}" class="cc-xt" text-anchor="${anchor}">${PB.esc(PB.fmtDay(date))}</text>`;
    }
  }

  // chart title (WHAT is plotted) + sample-size note
  const days = `${present.length}/${n} days`;
  const title = `<text x="${padL}" y="16" class="cc-title">${PB.esc(metric)} / day</text>`
    + `<text x="${(W-padR).toFixed(1)}" y="16" class="cc-sub" text-anchor="end">peak ${PB.esc(PB.fmtInt(max))} ${PB.esc(unit)} · ${days}</text>`;

  return `<svg class="bigchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"`
    + ` aria-label="${PB.esc(metric)} per day, peak ${PB.esc(PB.fmtInt(max))}">`
    + `${grid}${bars}${vlab}${xlab}${title}</svg>`;
};

// Attach one floating tooltip to a chart holder. Reads data-* off .cc-bar rects.
// Idempotent per holder. Called after the detail panel is inserted into the DOM.
PB.wireChartTooltips = (holder) => {
  if (!holder || holder._ccWired) return;
  holder._ccWired = true;
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
