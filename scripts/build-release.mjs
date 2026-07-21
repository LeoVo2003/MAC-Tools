/**
 * Một folder gửi chung Windows + macOS:
 *   npm run build:release
 * → release/F User Guide Tool/
 *   - FOR-WINDOWS-Start.bat  (+ .vbs)
 *   - FOR-MAC-Start.command
 *   - runtime/win | mac-arm64 | mac-x64
 *   - app/
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE_VERSION = process.env.PORTABLE_NODE || 'v20.18.1';
const APP_NAME = 'F User Guide Tool';
const releaseRoot = path.join(root, 'release', APP_NAME);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          file.close();
          try {
            fs.unlinkSync(dest);
          } catch {
            /* ignore */
          }
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed ${res.statusCode} ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', reject);
  });
}

function copyDir(src, dest, { skip = [] } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skip.includes(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to, { skip });
    else fs.copyFileSync(from, to);
  }
}

function copyApp(appDir) {
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  for (const f of ['server.js', 'package.json', 'package-lock.json', '.env.example']) {
    const from = path.join(root, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(appDir, f));
  }
  copyDir(path.join(root, 'public'), path.join(appDir, 'public'));
  copyDir(path.join(root, 'src'), path.join(appDir, 'src'));
  copyDir(path.join(root, 'node_modules'), path.join(appDir, 'node_modules'), {
    skip: ['.bin'],
  });
  const binSrc = path.join(root, 'node_modules', '.bin');
  if (fs.existsSync(binSrc)) {
    copyDir(binSrc, path.join(appDir, 'node_modules', '.bin'));
  }
}

async function ensureNodeWin() {
  const runtime = path.join(releaseRoot, 'runtime', 'win');
  const nodeExe = path.join(runtime, 'node.exe');
  if (fs.existsSync(nodeExe)) {
    console.log('OK runtime/win/node.exe (cache)');
    return;
  }
  fs.mkdirSync(runtime, { recursive: true });
  const zipName = `node-${NODE_VERSION}-win-x64.zip`;
  const zipPath = path.join(root, 'release', zipName);
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${zipName}`;
  if (!fs.existsSync(zipPath)) {
    console.log('Tải Node Windows...', url);
    await download(url, zipPath);
  }
  const extractTo = path.join(root, 'release', '_extract_win');
  fs.rmSync(extractTo, { recursive: true, force: true });
  fs.mkdirSync(extractTo, { recursive: true });
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractTo.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'inherit' }
  );
  if (ps.status !== 0) throw new Error('Giải nén Node Windows thất bại');
  const extracted = path.join(extractTo, `node-${NODE_VERSION}-win-x64`);
  for (const f of fs.readdirSync(extracted)) {
    const from = path.join(extracted, f);
    if (fs.statSync(from).isFile() && /\.(exe|dll|pdb)$/i.test(f)) {
      fs.copyFileSync(from, path.join(runtime, f));
    }
  }
  if (!fs.existsSync(nodeExe)) throw new Error('Thiếu node.exe');
  fs.rmSync(extractTo, { recursive: true, force: true });
  console.log('OK runtime/win/node.exe');
}

async function ensureNodeMac(arch) {
  const runtime = path.join(releaseRoot, 'runtime', `mac-${arch}`);
  const nodeBin = path.join(runtime, 'bin', 'node');
  if (fs.existsSync(nodeBin)) {
    console.log(`OK runtime/mac-${arch}/bin/node (cache)`);
    return;
  }
  fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
  const tarName = `node-${NODE_VERSION}-darwin-${arch}.tar.gz`;
  const tarPath = path.join(root, 'release', tarName);
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${tarName}`;
  if (!fs.existsSync(tarPath)) {
    console.log(`Tải Node macOS ${arch}...`, url);
    await download(url, tarPath);
  }
  const listed = spawnSync('tar', ['-tzf', tarPath], { encoding: 'utf-8' });
  if (listed.status !== 0) throw new Error(`Không đọc archive mac ${arch}`);
  const entry = String(listed.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => /\/bin\/node$/.test(s) && !s.includes('node_modules'));
  if (!entry) throw new Error(`Không thấy bin/node (${arch})`);

  const extractTo = path.join(root, 'release', `_extract_mac_${arch}`);
  fs.rmSync(extractTo, { recursive: true, force: true });
  fs.mkdirSync(extractTo, { recursive: true });
  const tar = spawnSync('tar', ['-xzf', tarPath, '-C', extractTo, entry], {
    stdio: 'inherit',
  });
  if (tar.status !== 0) throw new Error(`Extract mac ${arch} thất bại`);
  fs.copyFileSync(path.join(extractTo, entry), nodeBin);
  try {
    fs.chmodSync(nodeBin, 0o755);
  } catch {
    /* ignore on Windows */
  }
  fs.rmSync(extractTo, { recursive: true, force: true });
  console.log(`OK runtime/mac-${arch}/bin/node`);
}

function writeLaunchers() {
  // Xóa tên cũ nếu còn
  for (const old of [
    'Windows-Start.bat',
    'Windows-Start.vbs',
    'Mac-Start.command',
    '00-DOC-DOC.txt',
  ]) {
    const p = path.join(releaseRoot, old);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }

  const bat = `@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   F User Guide Tool  — FOR WINDOWS
echo ========================================
echo.

set "NODE=%~dp0runtime\\win\\node.exe"
set "APP=%~dp0app"

if not exist "%NODE%" (
  echo [ERROR] Thieu runtime\\win\\node.exe
  pause
  exit /b 1
)
if not exist "%APP%\\server.js" (
  echo [ERROR] Thieu app\\server.js
  pause
  exit /b 1
)

echo Starting... Keep this window OPEN.
echo.

cd /d "%APP%"
"%NODE%" server.js
echo.
pause
`;
  fs.writeFileSync(path.join(releaseRoot, 'FOR-WINDOWS-Start.bat'), bat, 'utf-8');

  const vbs = `Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
bat = dir & "\\FOR-WINDOWS-Start.bat"
sh.Run "cmd /k """ & bat & """", 1, False
`;
  fs.writeFileSync(path.join(releaseRoot, 'FOR-WINDOWS-Start.vbs'), vbs, 'utf-8');

  const command = `#!/bin/bash
cd "$(dirname "$0")"

echo "========================================"
echo "  F User Guide Tool  — FOR MAC"
echo "========================================"
echo ""

ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  NODE_BIN="./runtime/mac-arm64/bin/node"
elif [ "$ARCH" = "x86_64" ]; then
  NODE_BIN="./runtime/mac-x64/bin/node"
else
  echo "[ERROR] Arch khong ho tro: $ARCH"
  read -r -p "Enter de dong..."
  exit 1
fi

chmod +x "$NODE_BIN" 2>/dev/null
chmod +x "./FOR-MAC-Start.command" 2>/dev/null

if [ ! -f "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    echo "Dung Node he thong: $NODE_BIN"
  else
    echo "[ERROR] Thieu Node runtime cho Mac."
    read -r -p "Enter de dong..."
    exit 1
  fi
fi

if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "$HOME/Applications/Google Chrome.app" ]; then
  echo "[CANH BAO] Chua thay Google Chrome — hay cai truoc khi Run."
  echo ""
fi

echo "Starting... Giu cua so Terminal nay mo."
echo ""

cd "./app"
"$NODE_BIN" server.js
echo ""
read -r -p "Enter de dong..."
`;
  const cmdPath = path.join(releaseRoot, 'FOR-MAC-Start.command');
  fs.writeFileSync(cmdPath, command.replace(/\r\n/g, '\n'), 'utf-8');
  try {
    fs.chmodSync(cmdPath, 0o755);
  } catch {
    /* ignore */
  }

  const readme = `F User Guide Tool — 1 zip cho Windows + Mac
==========================================

CACH MO (chon dung file theo may):
----------------------------------
• WINDOWS  →  double-click   FOR-WINDOWS-Start.bat
              (hoac FOR-WINDOWS-Start.vbs)

• MAC      →  double-click   FOR-MAC-Start.command
  Neu Mac bao chan: chuot phai → Open → Open
  Neu permission denied:
    chmod +x "FOR-MAC-Start.command"

CAN CO: Google Chrome tren may.

LAN DAU: mo UI → "Tai khoan WPM" → nhap TK/MK → Luu
(.env luu tren may do, moi nguoi 1 TK)

UI: http://localhost:3847

Folder nay co du runtime Windows + Mac (Apple Silicon + Intel).
`;
  fs.writeFileSync(path.join(releaseRoot, '00-READ-ME-FIRST.txt'), readme, 'utf-8');
}

async function main() {
  console.log(`Build release → ${releaseRoot}`);
  fs.mkdirSync(releaseRoot, { recursive: true });
  await ensureNodeWin();
  await ensureNodeMac('arm64');
  await ensureNodeMac('x64');
  console.log('Copy app...');
  copyApp(path.join(releaseRoot, 'app'));
  writeLaunchers();
  console.log('');
  console.log('XONG. Zip folder nay gui moi nguoi:');
  console.log(' ', releaseRoot);
  console.log('');
  console.log('Windows → FOR-WINDOWS-Start.bat');
  console.log('macOS   → FOR-MAC-Start.command');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
