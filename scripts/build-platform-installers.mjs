import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const SERVER_DIR = path.join(ROOT_DIR, 'installation-bundle', 'server');
const BUILD_DIR = path.join(ROOT_DIR, 'installer-build');

console.log('=== Building Cross-Platform Installers ===');

// Ensure directories exist
if (!fs.existsSync(BUILD_DIR)) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
}

// ----------------------------------------------------
// 1. macOS .app Bundle -> SpatialPrevis-macOS.zip
// ----------------------------------------------------
console.log('Building macOS SpatialPrevis.app bundle...');
const macAppDir = path.join(BUILD_DIR, 'macos', 'SpatialPrevis.app');
const macContentsDir = path.join(macAppDir, 'Contents');
const macBinDir = path.join(macContentsDir, 'MacOS');
const macResourcesDir = path.join(macContentsDir, 'Resources');
const macAppResources = path.join(macResourcesDir, 'app');
const macServerResources = path.join(macResourcesDir, 'server');

fs.rmSync(path.join(BUILD_DIR, 'macos'), { recursive: true, force: true });
fs.mkdirSync(macBinDir, { recursive: true });
fs.mkdirSync(macAppResources, { recursive: true });
fs.mkdirSync(macServerResources, { recursive: true });

// Copy app and server files
fs.cpSync(DIST_DIR, macAppResources, { recursive: true });
fs.cpSync(SERVER_DIR, macServerResources, { recursive: true });

// Write Info.plist
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>SpatialPrevis</string>
    <key>CFBundleDisplayName</key>
    <string>Spatial Previs Engine</string>
    <key>CFBundleIdentifier</key>
    <string>com.spatialprevis.engine</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>SpatialPrevis</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.13</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
`;
fs.writeFileSync(path.join(macContentsDir, 'Info.plist'), infoPlist, 'utf8');

// Write macOS launcher script
const macLauncher = `#!/bin/bash
DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )/.." && pwd )"
RESOURCES="$DIR/Resources"

# Find free port starting at 5180
PORT=5180
while lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1 ; do
    PORT=$((PORT+1))
done

# Start server using node or python3
if command -v node >/dev/null 2>&1; then
    node "$RESOURCES/server/serve.js" "$RESOURCES/app" $PORT &
    SERVER_PID=$!
elif command -v python3 >/dev/null 2>&1; then
    python3 "$RESOURCES/server/serve.py" "$RESOURCES/app" $PORT &
    SERVER_PID=$!
else
    osascript -e 'display dialog "Neither Node.js nor Python 3 was found on this Mac. Please install Node.js (nodejs.org) or Python 3 to run Spatial Previs offline." buttons {"OK"} default button "OK" with icon stop'
    exit 1
fi

trap "kill -9 $SERVER_PID 2>/dev/null" EXIT
sleep 0.8

URL="http://127.0.0.1:$PORT"
if [ -d "/Applications/Google Chrome.app" ]; then
    open -na "Google Chrome" --args --app="$URL"
elif [ -d "/Applications/Microsoft Edge.app" ]; then
    open -na "Microsoft Edge" --args --app="$URL"
elif [ -d "/Applications/Brave Browser.app" ]; then
    open -na "Brave Browser" --args --app="$URL"
else
    open "$URL"
fi

wait $SERVER_PID
`;

fs.writeFileSync(path.join(macBinDir, 'SpatialPrevis'), macLauncher.replace(/\r\n/g, '\n'), 'utf8');

// Zip macOS app
const macZipPath = path.join(ROOT_DIR, 'SpatialPrevis-macOS.zip');
if (fs.existsSync(macZipPath)) fs.unlinkSync(macZipPath);

console.log('Archiving SpatialPrevis-macOS.zip...');
// Use tar.exe to create zip
execSync(`tar -a -c -f "${macZipPath}" -C "${path.join(BUILD_DIR, 'macos')}" SpatialPrevis.app`);
console.log(`Created: ${macZipPath} (${(fs.statSync(macZipPath).size / 1024 / 1024).toFixed(2)} MB)`);

// ----------------------------------------------------
// 2. Linux Single-File Self-Extracting Installer
// ----------------------------------------------------
console.log('Building Linux SpatialPrevis-Linux-Installer.sh...');
const linuxPayloadDir = path.join(BUILD_DIR, 'linux_payload');
fs.rmSync(linuxPayloadDir, { recursive: true, force: true });
fs.mkdirSync(linuxPayloadDir, { recursive: true });

fs.cpSync(DIST_DIR, path.join(linuxPayloadDir, 'app'), { recursive: true });
fs.cpSync(SERVER_DIR, path.join(linuxPayloadDir, 'server'), { recursive: true });

// Create payload tar.gz
const payloadTarGz = path.join(BUILD_DIR, 'linux_payload.tar.gz');
if (fs.existsSync(payloadTarGz)) fs.unlinkSync(payloadTarGz);
execSync(`tar -czf "${payloadTarGz}" -C "${linuxPayloadDir}" app server`);

const installerScriptHeader = `#!/bin/bash
# ==============================================================================
# Spatial Previs Engine - Linux Single-File Installer
# ==============================================================================
set -e

INSTALL_DIR="$HOME/.local/share/SpatialPrevisEngine"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"

echo "=============================================================================="
echo "                   Spatial Previs Engine - Linux Setup"
echo "=============================================================================="
echo "Installing to: $INSTALL_DIR"

mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"
mkdir -p "$DESKTOP_DIR"

# Find payload boundary and extract
ARCHIVE_LINE=$(awk '/^__PAYLOAD_BELOW__/ {print NR + 1; exit 0; }' "$0")
tail -n +$ARCHIVE_LINE "$0" | tar -xz -C "$INSTALL_DIR"

# Create launcher executable
cat << 'EOF' > "$INSTALL_DIR/spatial-previs"
#!/bin/bash
DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
PORT=5180
while netstat -tuln 2>/dev/null | grep -q ":$PORT " || ss -tuln 2>/dev/null | grep -q ":$PORT " ; do
    PORT=$((PORT+1))
done

if command -v node >/dev/null 2>&1; then
    node "$DIR/server/serve.js" "$DIR/app" $PORT &
    PID=$!
elif command -v python3 >/dev/null 2>&1; then
    python3 "$DIR/server/serve.py" "$DIR/app" $PORT &
    PID=$!
else
    echo "Error: Neither Node.js nor Python 3 found. Please install either one."
    exit 1
fi

trap "kill -9 $PID 2>/dev/null" EXIT
sleep 0.8

URL="http://127.0.0.1:$PORT"
if command -v google-chrome >/dev/null 2>&1; then
    google-chrome --app="$URL"
elif command -v chromium >/dev/null 2>&1; then
    chromium --app="$URL"
elif command -v microsoft-edge >/dev/null 2>&1; then
    microsoft-edge --app="$URL"
elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
else
    echo "Spatial Previs running at: $URL"
fi
wait $PID
EOF

chmod +x "$INSTALL_DIR/spatial-previs"
ln -sf "$INSTALL_DIR/spatial-previs" "$BIN_DIR/spatial-previs"

# Create .desktop file for desktop app menus
cat << EOF > "$DESKTOP_DIR/spatial-previs.desktop"
[Desktop Entry]
Version=1.0
Type=Application
Name=Spatial Previs Engine
Comment=3D Spatial Previs & Virtual Production Engine
Exec=$INSTALL_DIR/spatial-previs
Terminal=false
Categories=Graphics;AudioVideo;Development;
EOF

chmod +x "$DESKTOP_DIR/spatial-previs.desktop"

echo ""
echo "[✓] Installation complete!"
echo "    - Application directory: $INSTALL_DIR"
echo "    - Terminal shortcut:     $BIN_DIR/spatial-previs"
echo "    - Application launcher:  $DESKTOP_DIR/spatial-previs.desktop"
echo ""
echo "Spatial Previs is now installed in your application menu."
echo ""
read -p "Launch Spatial Previs Engine now? [Y/n] " response
if [[ ! "$response" =~ ^[Nn] ]]; then
    "$INSTALL_DIR/spatial-previs" &
fi
exit 0
__PAYLOAD_BELOW__
`;

const linuxInstallerPath = path.join(ROOT_DIR, 'SpatialPrevis-Linux-Installer.sh');
const headerBuf = Buffer.from(installerScriptHeader.replace(/\\r\\n/g, '\\n'), 'utf8');
const payloadBuf = fs.readFileSync(payloadTarGz);

fs.writeFileSync(linuxInstallerPath, Buffer.concat([headerBuf, payloadBuf]));
console.log(`Created: ${linuxInstallerPath} (${(fs.statSync(linuxInstallerPath).size / 1024 / 1024).toFixed(2)} MB)`);

console.log('=== All Cross-Platform Installers Created Successfully ===');
