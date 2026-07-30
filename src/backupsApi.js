import fs from 'fs';
import path from 'path';
import { DOWNLOADS_DIR } from './utils.js';

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
