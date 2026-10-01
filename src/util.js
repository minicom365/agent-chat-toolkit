import path from 'node:path';

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Human readable duration. `ms` may be negative or NaN (renders as "0s"). */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MIN);
  const s = Math.floor((ms % MIN) / SEC);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h) parts.push(`${s}s`);
  return parts.slice(0, 3).join(' ');
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

export function fmtInt(n) {
  if (!Number.isFinite(n)) return '-';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function fmtPct(part, whole, digits = 1) {
  if (!whole) return '0%';
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

export function fmtTs(ms, tz = null) {
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  const iso = d.toISOString().replace('T', ' ').slice(0, 19);
  return iso;
}

export function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${dayKey(ms)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function makeStyler(enabled) {
  const wrap = (code) => (s) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : String(s));
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    italic: wrap('3'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    magenta: wrap('35'),
    cyan: wrap('36'),
    gray: wrap('90'),
  };
}

/** Minimal width-aware table renderer. */
export function table(headers, rows, aligns = []) {
  const cols = headers.length;
  const widths = headers.map((h, i) =>
    Math.max(strLen(h), ...rows.map((r) => strLen(r[i] ?? '')))
  );
  const pad = (s, i) => {
    const w = widths[i] - strLen(s);
    if (w <= 0) return s;
    const a = aligns[i] ?? 'left';
    if (a === 'right') return ' '.repeat(w) + s;
    if (a === 'center') {
      const l = Math.floor(w / 2);
      return ' '.repeat(l) + s + ' '.repeat(w - l);
    }
    return s + ' '.repeat(w);
  };
  const line = (cells) => cells.map((c, i) => pad(c ?? '', i)).join('  ').trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

/** Visible-width aware (ignores ANSI escapes and counts CJK as 2). */
function strLen(s) {
  const str = String(s ?? '');
  const plain = str.replace(/\u001b\[[0-9;]*m/g, '');
  let n = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1100 && (
      cp <= 0x115f ||
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    )) n += 2;
    else n += 1;
  }
  return n;
}

export function truncate(s, max) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (strLen(str) <= max) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = strLen(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** Parse `--since 2026-09-28`, `--since 2h`, `--since 90m`, or an ISO string. */
export function parseTimeArg(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const rel = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(s);
  if (rel) {
    const mult = { s: SEC, m: MIN, h: HOUR, d: DAY }[rel[2].toLowerCase()];
    return now - Number(rel[1]) * mult;
  }
  const num = Number(s);
  if (Number.isFinite(num) && /^\d{10,}$/.test(s)) {
    return num < 1e12 ? num * 1000 : num;
  }
  const t = Date.parse(s.includes('T') || s.includes(':') ? s : `${s}T00:00:00`);
  return Number.isFinite(t) ? t : null;
}

export function resolvePath(p) {
  return path.resolve(p);
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
}
