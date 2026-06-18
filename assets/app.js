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

PB.statusColor = (s) => ({
  FRESH: '#3fb950', STALE: '#d29922', STALLED: '#db8e3c', FROZEN: '#6cb6ff',
  MISSING: '#f85149', DEPRECATED: '#8b949e', UNKNOWN: '#6e7b8a',
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
      // visible gap marker: a faint baseline tick
      bars += `<rect x="${(i*bw+pad).toFixed(2)}" y="${h-1.5}" width="${(bw-2*pad).toFixed(2)}" height="1.5" fill="#3a2326"/>`;
    } else {
      bars += `<rect x="${(i*bw+pad).toFixed(2)}" y="${(h-bh).toFixed(2)}" width="${(bw-2*pad).toFixed(2)}" height="${bh.toFixed(2)}" rx="0.6" fill="${color}"/>`;
    }
  }
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}">${bars}</svg>`;
};

// full column chart with axis labels + hover, for the expanded panel.
PB.columnChart = (cov, color, unitLabel) => {
  const W = 880, H = 160, padL = 8, padR = 8, padT = 10, padB = 22;
  if (!cov || !cov.length) return '<div class="chart-note">No coverage data for this source.</div>';
  const vals = cov.map(p => (p.key_metric == null ? null : Number(p.key_metric)));
  const max = Math.max(1, ...vals.map(v => v == null ? 0 : v));
  const n = cov.length;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const bw = plotW / n, pad = Math.min(bw * 0.16, 6);
  let bars = '', labels = '';
  for (let i = 0; i < n; i++) {
    const v = vals[i], x = padL + i * bw, missing = (v == null);
    const date = cov[i].date || '';
    const rc = cov[i].row_count == null ? '—' : PB.fmtInt(cov[i].row_count);
    const title = missing
      ? `${date}: no data (gap)`
      : `${date}: ${PB.fmtFull(v)} ${unitLabel} · ${rc} rows`;
    if (missing || v === 0) {
      bars += `<rect x="${(x+pad).toFixed(1)}" y="${(padT+plotH-2)}" width="${(bw-2*pad).toFixed(1)}" height="2" fill="#5a2c30"><title>${PB.esc(title)}</title></rect>`;
    } else {
      const bh = Math.max(2, (v / max) * plotH);
      bars += `<rect x="${(x+pad).toFixed(1)}" y="${(padT+plotH-bh).toFixed(1)}" width="${(bw-2*pad).toFixed(1)}" height="${bh.toFixed(1)}" rx="1" fill="${color}"><title>${PB.esc(title)}</title></rect>`;
    }
    // x labels: first, mid, last
    if (i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
      const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
      const lx = i === 0 ? padL : (i === n - 1 ? W - padR : padL + i * bw + bw / 2);
      labels += `<text x="${lx.toFixed(0)}" y="${H-6}" font-size="10" fill="#6e7b8a" text-anchor="${anchor}">${PB.esc(date.slice(5))}</text>`;
    }
  }
  // y max label
  labels += `<text x="${padL}" y="${padT+8}" font-size="10" fill="#6e7b8a">peak ${PB.fmtInt(max)}</text>`;
  return `<svg class="bigchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}${labels}</svg>`;
};

/* ---------- docs helpers ---------- */
PB.copyToClipboard = (btn) => {
  const pre = btn.closest('pre'); const code = pre ? pre.querySelector('code') : null;
  const txt = code ? code.innerText : '';
  navigator.clipboard && navigator.clipboard.writeText(txt).then(() => {
    const old = btn.textContent; btn.textContent = 'copied'; setTimeout(() => btn.textContent = old, 1200);
  });
};
