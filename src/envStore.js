import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

/** Thư mục gốc app (chứa server.js, public/, .env). */
export function getAppRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function getEnvPath() {
  return path.join(getAppRoot(), '.env');
}

export function getPublicDir() {
  return path.join(getAppRoot(), 'public');
}

/** Đọc .env dạng key=value (giữ comment / key khác). */
export function readEnvFile() {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) return { lines: [], map: {} };
  const text = fs.readFileSync(envPath, 'utf-8');
  const lines = text.split(/\r?\n/);
  const map = {};
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    map[m[1]] = val;
  }
  return { lines, map, envPath };
}

/** Ghi/cập nhật một số key trong .env, giữ nguyên dòng khác. */
export function upsertEnvVars(updates) {
  const envPath = getEnvPath();
  let lines = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  } else {
    lines = [
      '# F User Guide Tool — cấu hình local',
      '# File này lưu trên máy bạn, không commit lên git',
      '',
    ];
  }

  const keys = Object.keys(updates);
  const seen = new Set();

  const escapeVal = (v) => {
    const s = String(v ?? '');
    if (/[\s#"'\\]/.test(s)) return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return s;
  };

  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return line;
    const key = m[1];
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${escapeVal(updates[key])}`;
  });

  for (const key of keys) {
    if (seen.has(key)) continue;
    if (next.length && next[next.length - 1] !== '') next.push('');
    next.push(`${key}=${escapeVal(updates[key])}`);
  }

  fs.writeFileSync(envPath, next.join('\n').replace(/\n+$/, '\n'), 'utf-8');

  // Cập nhật process.env ngay cho job tiếp theo
  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = String(v ?? '');
  }

  return envPath;
}
