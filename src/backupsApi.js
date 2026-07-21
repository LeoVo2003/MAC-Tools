import fs from 'fs';
import path from 'path';
import { DOWNLOADS_DIR } from './utils.js';

function safeResolveUnder(root, ...parts) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, ...parts);
  const rel = path.relative(rootAbs, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Đường dẫn không hợp lệ.');
  }
  return target;
}

export function listBackupFolders() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return [];
  return fs
    .readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(DOWNLOADS_DIR, d.name);
      const st = fs.statSync(dir);
      const files = fs
        .readdirSync(dir)
        .filter((f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
      return {
        name: d.name,
        mtime: st.mtime.toISOString(),
        fileCount: files.length,
      };
    })
    .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
}

export function listBackupFiles(folderName) {
  const dir = safeResolveUnder(DOWNLOADS_DIR, String(folderName || ''));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('Không tìm thấy folder backup.');
  }
  return fs
    .readdirSync(dir)
    .filter((f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    });
}

export function resolveBackupFile(folderName, fileName) {
  const base = path.basename(String(fileName || ''));
  if (!base || base !== String(fileName)) {
    throw new Error('Tên file không hợp lệ.');
  }
  const filePath = safeResolveUnder(DOWNLOADS_DIR, String(folderName || ''), base);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error('File không tồn tại.');
  }
  return filePath;
}
