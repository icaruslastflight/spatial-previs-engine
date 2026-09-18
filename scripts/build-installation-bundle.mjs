import { existsSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import archiver from 'node:child_process'; // or use node zip / powershell

const ROOT = resolve('.');
const BUNDLE_DIR = join(ROOT, 'installation-bundle');
const DIST_DIR = join(ROOT, 'dist');
const ZIP_OUT = join(ROOT, 'SpatialPrevis-Universal-Installation-Bundle.zip');

console.log('=== Building Spatial Previs Multi-Platform Installation Bundle ===');

// 1. Build production web distribution if missing or stale
if (!existsSync(DIST_DIR)) {
  console.log('Building production web app (npm run build)...');
  execSync('npm run build', { stdio: 'inherit', cwd: ROOT });
}

// 2. Clean and create bundle directories
if (existsSync(BUNDLE_DIR)) {
  rmSync(BUNDLE_DIR, { recursive: true, force: true });
}
mkdirSync(BUNDLE_DIR, { recursive: true });
mkdirSync(join(BUNDLE_DIR, 'app'), { recursive: true });
mkdirSync(join(BUNDLE_DIR, 'server'), { recursive: true });
mkdirSync(join(BUNDLE_DIR, 'windows'), { recursive: true });
mkdirSync(join(BUNDLE_DIR, 'apple-macos'), { recursive: true });
mkdirSync(join(BUNDLE_DIR, 'ios'), { recursive: true });
mkdirSync(join(BUNDLE_DIR, 'android'), { recursive: true });
mkdirSync(join(BUNDLE_DIR, 'linux'), { recursive: true });
mkdirSync(join(BUNDLE_DIR, 'chromeos'), { recursive: true });

// 3. Copy app assets from dist
console.log('Copying production assets from dist/ to app/...');
cpSync(DIST_DIR, join(BUNDLE_DIR, 'app'), { recursive: true });

// Copy icon to linux directory for desktop file
if (existsSync(join(DIST_DIR, 'favicon.svg'))) {
  cpSync(join(DIST_DIR, 'favicon.svg'), join(BUNDLE_DIR, 'linux', 'spatial-previs.svg'));
}

// 4. Create zero-dependency Node.js offline server (server/serve.js)
const serveJsContent = `#!/usr/bin/env node
/**
 * Zero-dependency local server for Spatial Previs Engine.
 * Serves the offline PWA, 3D assets (GLB), Cesium workers, and video.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '../app');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5173;
const HOST = process.env.HOST || '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain',
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  let filePath = path.join(APP_DIR, reqPath);

  // Security: prevent escaping APP_DIR
  if (!filePath.startsWith(APP_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err) {
      // Fallback for subpaths to index.html if file doesn't exist
      if (!path.extname(filePath)) {
        filePath = path.join(APP_DIR, 'index.html');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
    } else if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    fs.stat(filePath, (statErr, realStats) => {
      if (statErr || !realStats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const range = req.headers.range;

      // Handle video/audio Range requests
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : realStats.size - 1;
        const chunksize = end - start + 1;
        const fileStream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
          'Content-Range': \`bytes \${start}-\${end}/\${realStats.size}\`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
        });
        fileStream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': realStats.size,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Service-Worker-Allowed': '/',
          'Cache-Control': ext === '.html' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=31536000',
        });
        fs.createReadStream(filePath).pipe(res);
      }
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log('=======================================================');
  console.log(' Spatial Previs Engine - Offline Local Server Running');
  console.log('=======================================================');
  console.log(\`  Local Viewport:      http://localhost:\${PORT}/\`);
  console.log(\`  Production (R0):     http://localhost:\${PORT}/r0.html\`);
  console.log(\`  Stage Showcase:      http://localhost:\${PORT}/showcase/concert-stage-demo.html\`);
  console.log(\`  Network Access:      http://<your-lan-ip>:\${PORT}/\`);
  console.log('=======================================================');
  console.log(' Press Ctrl+C to stop.');
});
`;
writeFileSync(join(BUNDLE_DIR, 'server', 'serve.js'), serveJsContent, 'utf8');

// 5. Create zero-dependency Python 3 offline server (server/serve.py)
const servePyContent = `#!/usr/bin/env python3
"""
Zero-dependency Python 3 HTTP server for Spatial Previs Engine.
Supports byte-range requests for video, proper MIME types, and PWA headers.
"""
import sys
import os
import mimetypes
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get('PORT', 5173))
HOST = os.environ.get('HOST', '0.0.0.0')
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, '..', 'app'))

# Ensure extended MIME types are registered
mimetypes.add_type('application/manifest+json', '.webmanifest')
mimetypes.add_type('model/gltf-binary', '.glb')
mimetypes.add_type('model/gltf+json', '.gltf')
mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('video/mp4', '.mp4')

class PrevisHTTPRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Service-Worker-Allowed', '/')
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

if __name__ == '__main__':
    os.chdir(APP_DIR)
    server = HTTPServer((HOST, PORT), PrevisHTTPRequestHandler)
    print("=======================================================")
    print(" Spatial Previs Engine - Offline Python Server Running")
    print("=======================================================")
    print(f"  Local Viewport:      http://localhost:{PORT}/")
    print(f"  Production (R0):     http://localhost:{PORT}/r0.html")
    print(f"  Stage Showcase:      http://localhost:{PORT}/showcase/concert-stage-demo.html")
    print("=======================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\\nShutting down server.")
        server.server_close()
`;
writeFileSync(join(BUNDLE_DIR, 'server', 'serve.py'), servePyContent, 'utf8');

// 6. Windows Deliverables
const winStartCmd = `@echo off
setlocal
cd /d "%~dp0"
title Spatial Previs Engine - Windows
echo =======================================================
echo     Spatial Previs Engine - Windows Launcher
echo =======================================================
echo Starting local offline server...

where node >nul 2>nul
if %errorlevel% equ 0 (
    start /b "" node ..\\server\\serve.js
) else (
    where python >nul 2>nul
    if %errorlevel% equ 0 (
        start /b "" python ..\\server\\serve.py
    ) else (
        echo [ERROR] Neither Node.js nor Python was found on your system.
        echo Please install Node.js (https://nodejs.org) or Python 3.
        pause
        exit /b 1
    )
)

timeout /t 2 /nobreak >nul

echo Select launch view:
echo   [1] Concert Stage Showcase (with Sharpy Rig & EDM Video)
echo   [2] Production Workspace (R0 Shared State)
echo   [3] Main Viewport (Point State Park Sample)
echo.
set /p choice="Selection [1-3] (default 1): "
if "%choice%"=="" set choice=1
if "%choice%"=="2" start "" "http://localhost:5173/r0.html" & exit /b 0
if "%choice%"=="3" start "" "http://localhost:5173/" & exit /b 0
start "" "http://localhost:5173/showcase/concert-stage-demo.html"
exit /b 0
`;
writeFileSync(join(BUNDLE_DIR, 'windows', 'start-windows.cmd'), winStartCmd, 'utf8');

const winInstallEdgeCmd = `@echo off
setlocal
cd /d "%~dp0"
echo Installing / Opening Spatial Previs as a Windows Standalone PWA via Microsoft Edge...
start msedge --app="http://localhost:5173/showcase/concert-stage-demo.html"
exit /b 0
`;
writeFileSync(join(BUNDLE_DIR, 'windows', 'install-pwa-edge.cmd'), winInstallEdgeCmd, 'utf8');

const winInstallChromeCmd = `@echo off
setlocal
cd /d "%~dp0"
echo Installing / Opening Spatial Previs as a Windows Standalone PWA via Google Chrome...
start chrome --app="http://localhost:5173/showcase/concert-stage-demo.html"
exit /b 0
`;
writeFileSync(join(BUNDLE_DIR, 'windows', 'install-pwa-chrome.cmd'), winInstallChromeCmd, 'utf8');

const winShortcutVbs = `' Create Desktop Shortcut for Spatial Previs Engine
Set oWS = WScript.CreateObject("WScript.Shell")
sLinkFile = oWS.SpecialFolders("Desktop") & "\\Spatial Previs Engine.lnk"
Set oLink = oWS.CreateShortcut(sLinkFile)
oLink.TargetPath = oWS.CurrentDirectory & "\\start-windows.cmd"
oLink.WorkingDirectory = oWS.CurrentDirectory
oLink.Description = "Spatial Previs Engine - Offline Live Event Previsualization"
oLink.Save
WScript.Echo "Desktop shortcut created successfully on Desktop!"
`;
writeFileSync(join(BUNDLE_DIR, 'windows', 'create-desktop-shortcut.vbs'), winShortcutVbs, 'utf8');

// 7. Apple macOS Deliverables
const macLaunchScript = `#!/usr/bin/env bash
# Spatial Previs Engine - macOS Launcher
cd "$(dirname "$0")"

echo "=== Spatial Previs Engine (Apple macOS) ==="

# Check for Node.js or Python 3
if command -v node >/dev/null 2>&1; then
    node ../server/serve.js &
    SERVER_PID=$!
elif command -v python3 >/dev/null 2>&1; then
    python3 ../server/serve.py &
    SERVER_PID=$!
else
    echo "Error: Neither node nor python3 is installed. Please install Node.js or Python 3."
    exit 1
fi

sleep 2

# Open in default browser or Google Chrome in app mode if present
if [ -d "/Applications/Google Chrome.app" ]; then
    open -na "Google Chrome" --args --app="http://localhost:5173/showcase/concert-stage-demo.html"
else
    open "http://localhost:5173/showcase/concert-stage-demo.html"
fi

echo "Server running (PID $SERVER_PID). Press Ctrl+C to stop."
wait $SERVER_PID
`;
writeFileSync(join(BUNDLE_DIR, 'apple-macos', 'launch-macos.command'), macLaunchScript, 'utf8');

const macReadme = `# Spatial Previs Engine — Apple macOS Installation Guide

## Option 1: Native Dock App (macOS Sonoma 14+ or later)
1. Start the local server by double-clicking \`launch-macos.command\` or running:
   \`\`\`bash
   node ../server/serve.js
   \`\`\`
2. Open Safari and navigate to:
   \`http://localhost:5173/\` or \`http://localhost:5173/showcase/concert-stage-demo.html\`
3. In Safari's menu bar, click **File** → **Add to Dock...**.
4. Set the name to **Spatial Previs** and click **Add**.
5. The application is now installed as a native standalone macOS application in your Dock and Launchpad!

## Option 2: Chrome / Edge PWA App
1. Open Google Chrome or Microsoft Edge on macOS.
2. Navigate to \`http://localhost:5173/\`.
3. In the address bar (omnibox), click the **Install Spatial Previs** icon (computer icon with down arrow).
4. Click **Install**. The app will now launch in its own independent, borderless macOS application window.

## Option 3: Double-Click Launcher
Double-click \`launch-macos.command\` at any time to automatically start the background server and launch the app.
`;
writeFileSync(join(BUNDLE_DIR, 'apple-macos', 'README-MACOS.md'), macReadme, 'utf8');

// 8. Apple iOS / iPadOS Deliverables
const iosReadme = `# Spatial Previs Engine — Apple iOS & iPadOS Installation Guide

The Spatial Previs Engine viewport and production workspace are fully optimized for touch, gesture manipulation, and mobile viewing on iPhone and iPad.

## How to Install on iPhone & iPad (Safari Standalone PWA)

1. **Host the app on your local network or server**:
   Run the offline server on your computer with host access:
   \`\`\`bash
   HOST=0.0.0.0 node server/serve.js
   \`\`\`
   Note your computer's local Wi-Fi IP address (e.g. \`http://192.168.1.50:5173/\`).

2. **Open Safari on your iPhone or iPad**:
   Navigate to your computer's IP address:
   \`http://<your-ip>:5173/\` (or \`http://<your-ip>:5173/r0.html\`)

3. **Install to Home Screen**:
   - Tap the **Share** button (the square icon with an upward arrow at the bottom or top of Safari).
   - Scroll down the share sheet and tap **Add to Home Screen**.
   - Tap **Add** in the top right corner.

4. **Launch from Home Screen**:
   - Tap the new **Spatial Previs** icon on your home screen.
   - The app launches in **full-bleed, standalone landscape mode** without any Safari browser chrome or URL bar.
   - All assets, models, and UI are cached locally via the built-in Service Worker for fast and offline operation.

## Touch Controls Contract:
- **One finger on an object**: Drag to move and snap (150 mm capture).
- **One finger on empty space**: Orbit the camera.
- **Two fingers**: Pinch-zoom and pan.
- A second finger landing mid-drag smoothly aborts drag and transfers control to the camera.
`;
writeFileSync(join(BUNDLE_DIR, 'ios', 'README-IOS.md'), iosReadme, 'utf8');

// 9. Android Deliverables
const androidInstallHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Install Spatial Previs on Android</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0c1014; color: #e8eaf0; padding: 24px; text-align: center; }
    .card { max-width: 480px; margin: 40px auto; background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; }
    h1 { color: #6ee7ff; font-size: 1.4rem; }
    button { background: #9d4edd; color: white; border: none; padding: 14px 28px; font-size: 1rem; font-weight: bold; border-radius: 8px; cursor: pointer; margin-top: 16px; }
    button:hover { background: #b05eff; }
    .steps { text-align: left; margin-top: 20px; font-size: 0.9rem; line-height: 1.6; color: #8b949e; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Install Spatial Previs App</h1>
    <p>Install the live-event spatial twin and pre-visualization client to your Android device.</p>
    <button id="btn-install" style="display:none;">Install App to Device</button>
    <div class="steps">
      <p><b>Manual Install via Chrome:</b></p>
      <ol>
        <li>Tap the Chrome menu (three dots in top-right).</li>
        <li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li>
        <li>Open the app from your home screen or app drawer for fullscreen landscape view.</li>
      </ol>
    </div>
  </div>
  <script>
    let deferredPrompt;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      const btn = document.getElementById('btn-install');
      btn.style.display = 'inline-block';
      btn.addEventListener('click', () => {
        btn.style.display = 'none';
        deferredPrompt.prompt();
      });
    });
  </script>
</body>
</html>
`;
writeFileSync(join(BUNDLE_DIR, 'android', 'install-android.html'), androidInstallHtml, 'utf8');

const androidReadme = `# Spatial Previs Engine — Android Installation Guide

Spatial Previs Engine is built with **mobile touch as the primary target** (CLAUDE.md §1.3).

## Method 1: Instant Chrome WebAPK Installation (Recommended)
1. Ensure your Android phone is connected to the same Wi-Fi network as the workstation hosting the bundle, or host it publicly.
2. In **Google Chrome for Android**, navigate to:
   \`http://<workstation-ip>:5173/\` or \`http://<workstation-ip>:5173/r0.html\`
3. Chrome will automatically display an **Install app** / **Add Spatial Previs to Home screen** banner, or tap the **⋮ (three vertical dots)** menu in Chrome and select **Install app**.
4. Confirm installation. Android will automatically compile a native **WebAPK** package and place the Spatial Previs icon in your App Drawer and Home Screen.
5. Launching from the icon opens the app in **standalone landscape mode** with full hardware acceleration, touch gestures, and offline service-worker caching.

## Method 2: Packaging as standalone APK (via Bubblewrap / Android CLI)
For deploying an independent standalone \`.apk\` or uploading to the Google Play Store:
1. Install Node.js and Google's official Bubblewrap CLI:
   \`\`\`bash
   npm install -g @bubblewrap/cli
   \`\`\`
2. Generate an Android Studio project from the app manifest:
   \`\`\`bash
   bubblewrap init --manifest=http://localhost:5173/manifest.webmanifest
   bubblewrap build
   \`\`\`
3. Install directly to your connected device via ADB:
   \`\`\`bash
   adb install app-release-signed.apk
   \`\`\`
`;
writeFileSync(join(BUNDLE_DIR, 'android', 'README-ANDROID.md'), androidReadme, 'utf8');

// 10. Linux Deliverables
const linuxDesktopEntry = `[Desktop Entry]
Version=1.0
Type=Application
Name=Spatial Previs Engine
Comment=Live-event design and pre-visualization spatial twin
Exec=sh -c '"$(dirname "%k")/launch-linux.sh"'
Icon=spatial-previs
Terminal=false
Categories=Graphics;3DGraphics;AudioVideo;Development;
StartupWMClass=spatial-previs-engine
`;
writeFileSync(join(BUNDLE_DIR, 'linux', 'spatial-previs.desktop'), linuxDesktopEntry, 'utf8');

const linuxLaunchScript = `#!/usr/bin/env bash
# Spatial Previs Engine - Linux Launcher
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

echo "=== Spatial Previs Engine (Linux) ==="

# Check for Node.js or Python 3
if command -v node >/dev/null 2>&1; then
    node ../server/serve.js &
    SERVER_PID=$!
elif command -v python3 >/dev/null 2>&1; then
    python3 ../server/serve.py &
    SERVER_PID=$!
else
    echo "Error: Neither node nor python3 is installed. Please install Node.js or Python 3."
    exit 1
fi

sleep 2

URL="http://localhost:5173/showcase/concert-stage-demo.html"

# Launch browser in app mode if supported
if command -v google-chrome >/dev/null 2>&1; then
    google-chrome --app="$URL"
elif command -v chromium >/dev/null 2>&1; then
    chromium --app="$URL"
elif command -v chromium-browser >/dev/null 2>&1; then
    chromium-browser --app="$URL"
elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
else
    echo "Please open in your browser: $URL"
fi

wait $SERVER_PID
`;
writeFileSync(join(BUNDLE_DIR, 'linux', 'launch-linux.sh'), linuxLaunchScript, 'utf8');

const linuxInstallScript = `#!/usr/bin/env bash
# Spatial Previs Engine - Linux Desktop Integration Installer
set -e
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

echo "Installing Spatial Previs desktop menu item and icons..."

APPS_DIR="\${XDG_DATA_HOME:-\$HOME/.local/share}/applications"
ICONS_DIR="\${XDG_DATA_HOME:-\$HOME/.local/share}/icons/hicolor/scalable/apps"

mkdir -p "$APPS_DIR"
mkdir -p "$ICONS_DIR"

cp "$DIR/spatial-previs.svg" "$ICONS_DIR/spatial-previs.svg" 2>/dev/null || true

# Generate desktop entry with absolute path to launch-linux.sh
cat <<EOF > "$APPS_DIR/spatial-previs.desktop"
[Desktop Entry]
Version=1.0
Type=Application
Name=Spatial Previs Engine
Comment=Live-event design and pre-visualization spatial twin
Exec="$DIR/launch-linux.sh"
Icon=spatial-previs
Terminal=false
Categories=Graphics;3DGraphics;AudioVideo;Development;
StartupWMClass=spatial-previs-engine
EOF

chmod +x "$APPS_DIR/spatial-previs.desktop"
chmod +x "$DIR/launch-linux.sh"

echo "Spatial Previs has been added to your application menu!"
`;
writeFileSync(join(BUNDLE_DIR, 'linux', 'install-linux.sh'), linuxInstallScript, 'utf8');

// 11. ChromeOS Deliverables
const chromeosReadme = `# Spatial Previs Engine — ChromeOS Installation Guide

Chromebooks natively support Progressive Web Applications as first-class windowed apps with full hardware WebGL acceleration.

## Installation on ChromeOS (Chromebook):

1. **Access the application**:
   Open Chrome on your Chromebook and navigate to the application URL:
   \`http://<host-ip>:5173/\` or the hosted URL.

2. **Install as Native ChromeOS App**:
   - Look at the right side of the address bar (omnibox). An **Install app** icon (a screen with a down arrow) will appear.
   - Click **Install app**.
   - In the confirmation pop-up, click **Install**.

3. **Using on ChromeOS**:
   - The Spatial Previs Engine icon will now appear in your **ChromeOS App Launcher (Everything Button)** and Shelf.
   - Right-click the app icon on your Shelf and select **Pin** for instant one-click access.
   - Running the app opens in an independent, hardware-accelerated standalone window without browser tabs or toolbars.
   - Fully supports both mouse/trackpad keyboard controls (WASD, Space/Shift, RMB-orbit) and Chromebook touchscreen gestures.
`;
writeFileSync(join(BUNDLE_DIR, 'chromeos', 'README-CHROMEOS.md'), chromeosReadme, 'utf8');

// 12. Master INSTALL.md Documentation
const masterInstallMd = `# Spatial Previs Engine — Multi-Platform Installation Manual

Universal installation bundle for **Apple (macOS & iOS)**, **Windows**, **Android**, **Linux**, and **ChromeOS**.

---

## What is in this Bundle?

\`\`\`
installation-bundle/
├── INSTALL.md                 # This multi-platform installation manual
├── app/                       # Complete offline production build (HTML, JS, CSS, 3D GLBs, Cesium, Video)
├── server/
│   ├── serve.js               # Zero-dependency Node.js offline server
│   └── serve.py               # Zero-dependency Python 3 offline server
├── windows/
│   ├── start-windows.cmd      # One-click Windows desktop launcher
│   ├── install-pwa-edge.cmd   # Microsoft Edge Standalone PWA runner
│   ├── install-pwa-chrome.cmd # Google Chrome Standalone PWA runner
│   └── create-desktop-shortcut.vbs # Desktop shortcut creator
├── apple-macos/
│   ├── launch-macos.command   # Clickable macOS shell launcher
│   └── README-MACOS.md        # macOS Sonoma Dock App guide
├── ios/
│   └── README-IOS.md          # iPhone / iPad Safari Home Screen install guide
├── android/
│   ├── install-android.html   # Android PWA install helper
│   └── README-ANDROID.md      # Android Chrome WebAPK install guide
├── linux/
│   ├── install-linux.sh       # Installs .desktop menu launcher and icons
│   ├── launch-linux.sh        # Linux application runner
│   └── spatial-previs.desktop # Desktop entry file
└── chromeos/
    └── README-CHROMEOS.md     # Chromebook installation guide
\`\`\`

---

## 1. Windows Installation
- **Quick Run:** Double-click \`windows/start-windows.cmd\`. It starts the offline server and prompts you to open the Concert Stage Showcase, R0 Production Workspace, or 3D Viewport.
- **Standalone App (Microsoft Edge):** Run \`windows/install-pwa-edge.cmd\`.
- **Desktop Shortcut:** Double-click \`windows/create-desktop-shortcut.vbs\` to place a launch icon on your Windows Desktop.
- **Native Unreal Engine 5.8:** Project files reside in \`native/SpatialPrevis/SpatialPrevis.uproject\`.

## 2. Apple macOS Installation
- **One-Click Run:** Double-click \`apple-macos/launch-macos.command\`.
- **Add to Dock (macOS Sonoma 14+):** In Safari, open \`http://localhost:5173/\` and choose **File** → **Add to Dock...**.

## 3. Apple iOS & iPadOS Installation
- Host the bundle on your Wi-Fi network: \`HOST=0.0.0.0 node server/serve.js\`.
- In Safari on your iPhone/iPad, open \`http://<your-ip>:5173/\`.
- Tap **Share** (square with arrow) → **Add to Home Screen** → **Add**.
- Launches full-bleed in landscape with touch gestures.

## 4. Android Installation
- Open Chrome for Android and navigate to the application URL.
- Tap **⋮** (Menu) → **Install app** (or **Add to Home screen**).
- Android automatically compiles an official WebAPK and installs it to your app drawer.

## 5. Linux Installation
- Run \`bash linux/install-linux.sh\` to register the application with your desktop environment (GNOME, KDE, XFCE).
- Launch from your application menu or run \`bash linux/launch-linux.sh\`.

## 6. ChromeOS (Chromebook) Installation
- Open Chrome and navigate to the application URL.
- Click the **Install app** icon in the address bar omnibox.
- Pin to your ChromeOS Shelf for instant access.
`;
writeFileSync(join(BUNDLE_DIR, 'INSTALL.md'), masterInstallMd, 'utf8');

console.log('Bundle files written successfully.');

// 13. Create master ZIP archive using PowerShell
console.log(`Creating master archive ${ZIP_OUT}...`);
if (existsSync(ZIP_OUT)) {
  rmSync(ZIP_OUT, { force: true });
}

execSync(`powershell.exe -NoProfile -Command "Compress-Archive -Path '${BUNDLE_DIR}\\*' -DestinationPath '${ZIP_OUT}' -Force"`, {
  stdio: 'inherit',
  cwd: ROOT
});

console.log('=== Installation Bundle Build Complete ===');
console.log('Bundle directory:', BUNDLE_DIR);
console.log('Archive location:', ZIP_OUT);
