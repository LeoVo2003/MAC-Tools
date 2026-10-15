/**
 * SFTP manager: tự động cài mu-plugin tạm trước job, xóa sau job.
 * User không muốn plugin nằm sẵn trên web.
 */
import Client from 'ssh2-sftp-client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SFTP_HOST = process.env.QR_SFTP_HOST || '';
const SFTP_PORT = Number(process.env.QR_SFTP_PORT) || 22;
const SFTP_USER = process.env.QR_SFTP_USER || '';
const SFTP_PASSWORD = process.env.QR_SFTP_PASSWORD || '';
const SFTP_PATH = (process.env.QR_SFTP_PATH || '/public_html/wp-content/mu-plugins').replace(/\/$/, '');

const PLUGIN_FILENAME = 'qr-bridge-temp.php';
const LOCAL_PLUGIN = path.join(__dirname, 'qr-bridge.php');

export function sftpConfigured() {
  return Boolean(SFTP_HOST && SFTP_USER && (SFTP_PASSWORD || process.env.QR_SFTP_KEY));
}

async function connect() {
  const client = new Client();
  const config = {
    host: SFTP_HOST,
    port: SFTP_PORT,
    username: SFTP_USER,
    password: SFTP_PASSWORD || undefined,
    privateKey: process.env.QR_SFTP_KEY ? fs.readFileSync(process.env.QR_SFTP_KEY) : undefined,
  };
  await client.connect(config);
  return client;
}

/** Upload mu-plugin tạm lên server */
export async function installBridge(onLog = () => {}) {
  if (!sftpConfigured()) {
    onLog('[qr-bridge] SFTP chưa cấu hình, bỏ qua (dùng template cache).');
    return false;
  }
  const client = await connect();
  try {
    const remotePath = `${SFTP_PATH}/${PLUGIN_FILENAME}`;
    const localContent = fs.readFileSync(LOCAL_PLUGIN, 'utf8');
    // Đảm bảo thư mục mu-plugins tồn tại
    try { await client.mkdir(SFTP_PATH, true); } catch {}
    await client.put(Buffer.from(localContent), remotePath);
    onLog('[qr-bridge] Đã cài plugin tạm.');
    return true;
  } finally {
    await client.end();
  }
}

/** Xóa mu-plugin tạm khỏi server */
export async function removeBridge(onLog = () => {}) {
  if (!sftpConfigured()) return false;
  const client = await connect();
  try {
    const remotePath = `${SFTP_PATH}/${PLUGIN_FILENAME}`;
    try {
      await client.delete(remotePath);
      onLog('[qr-bridge] Đã xóa plugin tạm.');
      return true;
    } catch {
      onLog('[qr-bridge] Plugin tạm không tồn tại (đã xóa trước đó?).');
      return false;
    }
  } finally {
    await client.end();
  }
}
