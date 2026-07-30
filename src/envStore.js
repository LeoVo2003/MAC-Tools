import path from 'path';
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
