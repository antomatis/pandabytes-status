/* pandabytes status — shared client logic.
   Pure keyless static JS. The user pastes their API key; it lives only in localStorage.
   The dashboard renders from a bundled static snapshot by default, and live-refreshes
   from the REST API when a key is present. No secrets in this repo. */
'use strict';

const PB = {
  API_BASE: '/v1',
  KEY_HEADER: 'X-API-Key',
  LS_KEY: 'pandabytes_api_key',
  SNAPSHOT_URL: 'data/snapshot.json', // relative -> works under /pandabytes-status/

  STATUS_ORDER: { MISSING: 0, STALLED: 1, STALE: 2, DEPRECATED: 3, FROZEN: 4, FRESH: 5, UNKNOWN: 6 },
  STATUS_LIST: ['FRESH', 'STALE', 'STALLED', 'FROZEN', 'MISSING', 'DEPRECATED'],
  PROBLEM: new Set(['MISSING', 'STALLED', 'STALE', 'DEPRECATED']),
};

/* ---------- API key (localStorage only) ---------- */
PB.getKey = () => { try { return localStorage.getItem(PB.LS_KEY) || ''; } catch (e) { return ''; } };
PB.setKey = (k) => { try { k ? localStorage.setItem(PB.LS_KEY, k) : localStorage.removeItem(PB.LS_KEY); } catch (e) {} };

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
// Always load the bundled snapshot (fast, keyless). If a key exists, try the live API and
// merge richer fields; on any failure we silently keep the snapshot. Never blocks the UI.
PB.loadSnapshot = async () => {
  const r = await fetch(PB.SNAPSHOT_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error('snapshot ' + r.status);
  return r.json();
};

// Try the live REST API. Returns a snapshot-shaped object, or null on any failure.
PB.loadLive = async (key) => {
  if (!key) return null;
  const headers = {}; headers[PB.KEY_HEADER] = key;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const [sj, stj] = await Promise.all([
      fetch(PB.API_BASE + '/sources', { headers, signal: ctrl.signal }).then(r => r.ok ? r.json() : Promise.reject(r.status)),
      fetch(PB.API_BASE + '/stats', { headers, signal: ctrl.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    clearTimeout(to);
    if (!sj || sj.ok === false || !Array.isArray(sj.data)) return null;
    const gen = (sj.meta && sj.meta.generated_at) || new Date().toISOString();
    const sources = sj.data.map(d => ({
      id: d.id, kind: d.kind, label: d.label || d.title || d.id,
      status: d.status, latest_date: d.latest_date, fact_rows: d.fact_rows,
      days_behind: d.days_behind,
      key_metric_name: d.key_metric_name, key_metric_unit: d.key_metric_unit || '',
      synced_hours_ago: d.synced_hours_ago,
      counts: { headline_total: d.key_metric_value },
      coverage_30d: [], _needsCoverage: true,
    }));
    const stats = (stj && stj.data) ? {
      sources_total: stj.data.sources_total, total_fact_rows: stj.data.total_fact_rows,
      ...(stj.data.status_counts || {}),
    } : null;
    return { generated_at: gen, sources, stats, _live: true };
  } catch (e) { clearTimeout(to); return null; }
};

// fetch one source's coverage live (used on expand when in live mode)
PB.loadCoverage = async (key, id, days) => {
  if (!key) return null;
  const headers = {}; headers[PB.KEY_HEADER] = key;
  try {
    const r = await fetch(PB.API_BASE + '/sources/' + encodeURIComponent(id) + '/coverage?days=' + (days || 30), { headers });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.ok === false || !Array.isArray(j.data)) return null;
    // live coverage uses {date, rows, key_metric}; normalize to snapshot {date,row_count,key_metric}
    return j.data.map(p => ({ date: p.date, row_count: p.rows, key_metric: p.key_metric }));
  } catch (e) { return null; }
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

/* ---------- shared header / key bar wiring ---------- */
PB.mountKeyBar = (el, onChange) => {
  const cur = PB.getKey();
  el.innerHTML = `
    <label for="pb-key">API key</label>
    <input id="pb-key" type="password" placeholder="paste your X-API-Key…" autocomplete="off" spellcheck="false" value="${PB.esc(cur)}">
    <button id="pb-key-save">Save</button>
    <button id="pb-key-clear" class="ghost">Clear</button>
    <span id="pb-key-msg" class="hint">${cur ? '<span class="ok">● key saved (localStorage) — live refresh enabled</span>' : 'No key — showing the bundled snapshot. Paste a key to live-refresh from the API. <a href="docs.html#getkey">Get a key →</a>'}</span>
  `;
  const input = el.querySelector('#pb-key'), msg = el.querySelector('#pb-key-msg');
  el.querySelector('#pb-key-save').onclick = () => {
    PB.setKey(input.value.trim());
    msg.innerHTML = input.value.trim() ? '<span class="ok">● key saved — refreshing live…</span>' : 'Key cleared.';
    if (onChange) onChange(input.value.trim());
  };
  el.querySelector('#pb-key-clear').onclick = () => {
    PB.setKey(''); input.value = '';
    msg.innerHTML = 'Key cleared — showing the bundled snapshot.';
    if (onChange) onChange('');
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') el.querySelector('#pb-key-save').click(); });
};

PB.copyToClipboard = (btn) => {
  const pre = btn.closest('pre'); const code = pre ? pre.querySelector('code') : null;
  const txt = code ? code.innerText : '';
  navigator.clipboard && navigator.clipboard.writeText(txt).then(() => {
    const old = btn.textContent; btn.textContent = 'copied'; setTimeout(() => btn.textContent = old, 1200);
  });
};
