const { app, BrowserWindow, ipcMain, screen, desktopCapturer, clipboard, Menu } = require('electron');
try {
    Menu.setApplicationMenu(null);
} catch (e) {}

// Disable Chromium occlusion and timer throttling for background/hidden windows
if (app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
    app.commandLine.appendSwitch('disable-background-timer-throttling');
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

const { io } = require('socket.io-client');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const os = require('os');
let isInputBlocked = false;
let privacyWindow = null;
let psProcess = null;
let socket = null;
let currentSupportCode = null;
let currentSessionId = null;
let currentDisplayIndex = 0;
let clipboardInterval = null;
let lastClipboardText = '';
let agentWindow = null;
let rtcWindow = null;

let agentState = {
    code: '------',
    connected: false,
    statusText: 'Sunucuya bağlanılıyor...',
    technicianName: '',
    consentPending: false,
    sessionActive: false,
    needManualCode: false
};

let hasBeenAccepted = false;
let selfDestructTriggered = false;

const SERVER_URL = process.env.SUPPORT_API_URL || 'https://support-api.homaklab.com';

process.on('uncaughtException', (err) => {
    log('Uncaught Exception: ' + (err ? err.stack || err.message : err));
});

process.on('unhandledRejection', (reason) => {
    log('Unhandled Rejection: ' + (reason ? reason.stack || reason.message : reason));
});

function log(msg) {
    const formatted = `[HomakAgent ${new Date().toISOString()}] ${msg}`;
    console.log(formatted);
    try {
        const logFile = path.join(os.homedir(), 'homak-agent.log');
        fs.appendFileSync(logFile, formatted + '\r\n');
    } catch(e) {}
}

function updateAgentUi() {
    if (agentWindow && !agentWindow.isDestroyed()) {
        agentWindow.webContents.send('agent-state', agentState);
    }
}

function selfDestruct() {
    if (selfDestructTriggered) return;
    selfDestructTriggered = true;

    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    if (!exePath || !fs.existsSync(exePath)) {
        log('Self-destruct: exe path not found, skipping cleanup.');
        return;
    }

    log('Self-destruct: scheduling deletion of ' + exePath);

    // Windows locks the running exe file, so we spawn a detached cmd that waits
    // for this process to fully exit (via timeout + retry loop), then deletes it.
    const batContent = '@echo off\r\n'
        + ':loop\r\n'
        + 'del /f /q "' + exePath + '" >nul 2>&1\r\n'
        + 'if exist "' + exePath + '" (\r\n'
        + '  timeout /t 1 /nobreak >nul\r\n'
        + '  goto loop\r\n'
        + ')\r\n'
        + '(goto) 2>nul & del /f /q "%~f0"\r\n';

    try {
        const batPath = path.join(app.getPath('temp'), 'homak_cleanup_' + Date.now() + '.bat');
        fs.writeFileSync(batPath, batContent);

        const child = spawn('cmd.exe', ['/c', batPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        child.unref();

        log('Self-destruct: cleanup script launched, exe will be deleted after exit.');
    } catch (e) {
        log('Self-destruct error: ' + e.message);
    }
}

function extractSupportCode() {
    const pathsToCheck = [
        process.env.PORTABLE_EXECUTABLE_FILE || '',
        process.env.PORTABLE_EXECUTABLE_DIR || '',
        app.getPath('exe') || '',
        process.execPath || '',
        ...(process.argv || [])
    ];

    for (const p of pathsToCheck) {
        if (!p) continue;
        const exeName = path.basename(p);
        const match = exeName.match(/(\d{6})/);
        if (match) return match[1];
    }

    if (process.env.SUPPORT_CODE) {
        const envMatch = process.env.SUPPORT_CODE.match(/(\d{6})/);
        if (envMatch) return envMatch[1];
    }
    return null;
}

function startInputSimulator() {
    stopInputSimulator();
    log('Spawning PowerShell input simulator with Win32 KbdUtil SendInput (Zero-Freeze)...');
    const inputPs1 = path.join(app.getPath('userData'), 'input.ps1');

    const ps1Content = `$csharp = @'
using System;
using System.Runtime.InteropServices;

namespace Win32 {
    public class KbdUtil {
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT {
            public uint type;
            public MOUSEKEYBDHARDWAREINPUT mkhi;
        }
        [StructLayout(LayoutKind.Explicit)]
        struct MOUSEKEYBDHARDWAREINPUT {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);

        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        public static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [DllImport("user32.dll")]
        public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

        public static void SendUnicode(char c) {
            INPUT[] inputs = new INPUT[2];
            inputs[0].type = 1;
            inputs[0].mkhi.ki.wVk = 0;
            inputs[0].mkhi.ki.wScan = (ushort)c;
            inputs[0].mkhi.ki.dwFlags = 0x0004;

            inputs[1].type = 1;
            inputs[1].mkhi.ki.wVk = 0;
            inputs[1].mkhi.ki.wScan = (ushort)c;
            inputs[1].mkhi.ki.dwFlags = 0x0004 | 0x0002;

            SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        public static void KeyDown(byte vk) {
            byte scan = (byte)MapVirtualKey(vk, 0);
            keybd_event(vk, scan, 0, UIntPtr.Zero);
        }

        public static void KeyUp(byte vk) {
            byte scan = (byte)MapVirtualKey(vk, 0);
            keybd_event(vk, scan, 2, UIntPtr.Zero);
        }

        public static void PressKey(byte vk) {
            KeyDown(vk);
            KeyUp(vk);
        }

        public static void Combo(params byte[] keys) {
            foreach (byte vk in keys) {
                KeyDown(vk);
            }
            for (int i = keys.Length - 1; i >= 0; i--) {
                KeyUp(keys[i]);
            }
        }
    }
}
'@

Add-Type -TypeDefinition $csharp

$vkMap = @{
  'ctrl'=[byte]0x11; 'control'=[byte]0x11; 'shift'=[byte]0x10; 'alt'=[byte]0x12; 'menu'=[byte]0x12;
  'win'=[byte]0x5B; 'lwin'=[byte]0x5B; 'rwin'=[byte]0x5C; 'esc'=[byte]0x1B; 'escape'=[byte]0x1B;
  'tab'=[byte]0x09; 'enter'=[byte]0x0D; 'return'=[byte]0x0D; 'backspace'=[byte]0x08;
  'delete'=[byte]0x2E; 'del'=[byte]0x2E; 'space'=[byte]0x20;
  'up'=[byte]0x26; 'down'=[byte]0x28; 'left'=[byte]0x25; 'right'=[byte]0x27;
  'home'=[byte]0x24; 'end'=[byte]0x23; 'pageup'=[byte]0x21; 'pagedown'=[byte]0x22;
  'f1'=[byte]0x70; 'f2'=[byte]0x71; 'f3'=[byte]0x72; 'f4'=[byte]0x73; 'f5'=[byte]0x74; 'f6'=[byte]0x75;
  'f7'=[byte]0x76; 'f8'=[byte]0x77; 'f9'=[byte]0x78; 'f10'=[byte]0x79; 'f11'=[byte]0x7A; 'f12'=[byte]0x7B;
  'a'=[byte]0x41; 'c'=[byte]0x43; 'v'=[byte]0x56; 'x'=[byte]0x58; 'z'=[byte]0x5A; 'd'=[byte]0x44; 'e'=[byte]0x45; 'r'=[byte]0x52
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    if ($line -match '^m (-?\\d+) (-?\\d+)') { [Win32.KbdUtil]::SetCursorPos([int]$Matches[1], [int]$Matches[2]) }
    elseif ($line -match '^c (\\w+) down (-?\\d+) (-?\\d+)') {
      [Win32.KbdUtil]::SetCursorPos([int]$Matches[2], [int]$Matches[3])
      if ($Matches[1] -eq 'right') { [Win32.KbdUtil]::mouse_event(0x0008,0,0,0,0) } else { [Win32.KbdUtil]::mouse_event(0x0002,0,0,0,0) }
    }
    elseif ($line -match '^c (\\w+) up (-?\\d+) (-?\\d+)') {
      [Win32.KbdUtil]::SetCursorPos([int]$Matches[2], [int]$Matches[3])
      if ($Matches[1] -eq 'right') { [Win32.KbdUtil]::mouse_event(0x0010,0,0,0,0) } else { [Win32.KbdUtil]::mouse_event(0x0004,0,0,0,0) }
    }
    elseif ($line -eq 'c left down')  { [Win32.KbdUtil]::mouse_event(0x0002,0,0,0,0) }
    elseif ($line -eq 'c left up')    { [Win32.KbdUtil]::mouse_event(0x0004,0,0,0,0) }
    elseif ($line -eq 'c right down') { [Win32.KbdUtil]::mouse_event(0x0008,0,0,0,0) }
    elseif ($line -eq 'c right up')   { [Win32.KbdUtil]::mouse_event(0x0010,0,0,0,0) }
    elseif ($line -match '^w (-?\\d+)') { [Win32.KbdUtil]::mouse_event(0x0800,0,0,[int]$Matches[1],0) }
    elseif ($line -match '^u ([0-9a-fA-F]+)') {
      $charCode = [Convert]::ToInt32($Matches[1], 16)
      [Win32.KbdUtil]::SendUnicode([char]$charCode)
    }
    elseif ($line -match '^kd (\\w+)') {
      $k = $Matches[1].ToLower()
      if ($vkMap.ContainsKey($k)) { [Win32.KbdUtil]::KeyDown($vkMap[$k]) }
    }
    elseif ($line -match '^ku (\\w+)') {
      $k = $Matches[1].ToLower()
      if ($vkMap.ContainsKey($k)) { [Win32.KbdUtil]::KeyUp($vkMap[$k]) }
    }
    elseif ($line -match '^pk (\\w+)') {
      $k = $Matches[1].ToLower()
      if ($vkMap.ContainsKey($k)) { [Win32.KbdUtil]::PressKey($vkMap[$k]) }
    }
    elseif ($line -match '^combo (.+)') {
      $c = $Matches[1].ToLower().Trim()
      if ($c -eq 'ctrl-alt-esc' -or $c -eq 'ctrl-shift-esc') {
        [Win32.KbdUtil]::Combo([byte]0x11, [byte]0x10, [byte]0x1B)
      } elseif ($c -eq 'alt-tab') {
        [Win32.KbdUtil]::Combo([byte]0x12, [byte]0x09)
      } elseif ($c -eq 'alt-f4') {
        [Win32.KbdUtil]::Combo([byte]0x12, [byte]0x73)
      } elseif ($c -eq 'win-d') {
        [Win32.KbdUtil]::Combo([byte]0x5B, [byte]0x44)
      } elseif ($c -eq 'win-e') {
        [Win32.KbdUtil]::Combo([byte]0x5B, [byte]0x45)
      } elseif ($c -eq 'win-r') {
        [Win32.KbdUtil]::Combo([byte]0x5B, [byte]0x52)
      } elseif ($c -eq 'ctrl-a') {
        [Win32.KbdUtil]::Combo([byte]0x11, [byte]0x41)
      } elseif ($c -eq 'ctrl-c') {
        [Win32.KbdUtil]::Combo([byte]0x11, [byte]0x43)
      } elseif ($c -eq 'ctrl-v') {
        [Win32.KbdUtil]::Combo([byte]0x11, [byte]0x56)
      } elseif ($c -eq 'ctrl-z') {
        [Win32.KbdUtil]::Combo([byte]0x11, [byte]0x5A)
      }
    }
    elseif ($line -match '^affinity (\\d+)') {
      [Win32.KbdUtil]::SetWindowDisplayAffinity([IntPtr][int64]$Matches[1], [uint32]0x00000011)
    }
  } catch {}
}
`;

    try {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(inputPs1, ps1Content, 'utf8');
    } catch (e) {
        log('Error writing input.ps1: ' + e.message);
    }

    psProcess = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', inputPs1]);
    psProcess.stdin.setDefaultEncoding('ascii');
    psProcess.stderr.on('data', (d) => log('[PS Error] ' + d.toString().trim()));
}

function stopInputSimulator() {
    if (psProcess && !psProcess.killed) {
        psProcess.kill();
        psProcess = null;
    }
}

function stopClipboardSync() {
    if (clipboardInterval) {
        clearInterval(clipboardInterval);
        clipboardInterval = null;
    }
}

function startClipboardSync() {
    stopClipboardSync();
    lastClipboardText = clipboard.readText();
    clipboardInterval = setInterval(() => {
        try {
            const currentText = clipboard.readText();
            if (currentText && currentText !== lastClipboardText && currentText.trim().length > 0) {
                lastClipboardText = currentText;
                if (socket && socket.connected && currentSessionId) {
                    socket.emit('remote:clipboard', { sessionId: currentSessionId, text: currentText, sender: 'agent' });
                }
            }
        } catch(e) {}
    }, 1000);
}

function sendSystemInfo() {
    if (!socket || !socket.connected || !currentSessionId) return;
    try {
        const cpus = os.cpus();
        const totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024));
        const freeMem = Math.round(os.freemem() / (1024 * 1024 * 1024));
        const uptimeHours = (os.uptime() / 3600).toFixed(1);

        const info = {
            os: `${os.type()} ${os.release()} (${os.arch()})`,
            hostname: os.hostname(),
            cpu: cpus[0] ? cpus[0].model : 'Unknown CPU',
            cpuCores: cpus.length,
            memory: `${totalMem - freeMem} GB / ${totalMem} GB (${freeMem} GB Boş)`,
            uptime: `${uptimeHours} saat`,
            user: os.userInfo() ? os.userInfo().username : 'User'
        };

        socket.emit('remote:sysinfo', { sessionId: currentSessionId, info });
    } catch(e) {
        log('Error sending sysinfo: ' + e.message);
    }
}

function togglePrivacyScreen(enable) {
    if (enable) {
        if (privacyWindow) return;
        const primary = screen.getPrimaryDisplay();
        privacyWindow = new BrowserWindow({
            x: primary.bounds.x,
            y: primary.bounds.y,
            width: primary.bounds.width,
            height: primary.bounds.height,
            frame: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            backgroundColor: '#020617',
            webPreferences: { contextIsolation: false }
        });

        try {
            // privacyWindow.setContentProtection(true); - excluded to avoid capture blackout
            const handleBuf = privacyWindow.getNativeWindowHandle();
            let hwnd = 0;
            if (process.arch === 'x64') {
                hwnd = Number(handleBuf.readBigInt64LE(0));
            } else {
                hwnd = handleBuf.readInt32LE(0);
            }
            if (psProcess && psProcess.stdin) {
                psProcess.stdin.write(`affinity ${hwnd}\r\n`);
            }
        } catch (e) {
            log('Privacy window affinity error: ' + e.message);
        }

        privacyWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
            <html>
                <body style="background:#020617;color:#38bdf8;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;user-select:none;">
                    <div style="font-size:56px;margin-bottom:16px;">🛡️</div>
                    <h1 style="margin:0;font-size:24px;color:#ffffff;">Homak Güvenli Bakım Modu</h1>
                    <p style="color:#94a3b8;font-size:14px;margin-top:10px;">Teknisyeniniz şu anda bilgisayarınızda uzaktan bakım yapmaktadır.</p>
                    <p style="color:#64748b;font-size:12px;margin-top:4px;">Gizliliğiniz için yerel ekranınız geçici olarak karartılmıştır.</p>
                </body>
            </html>
        `));
    } else {
        if (privacyWindow) {
            try { privacyWindow.close(); } catch(e) {}
            privacyWindow = null;
        }
    }
}


function getDisplaysList() {
    try {
        const displays = screen.getAllDisplays();
        const primary = screen.getPrimaryDisplay();
        return displays.map((d, index) => ({
            index: index,
            id: d.id,
            name: `Monitör ${index + 1}${d.id === primary.id ? ' (Birincil)' : ''}`,
            width: d.bounds.width,
            height: d.bounds.height,
            scaleFactor: d.scaleFactor || 1,
            isPrimary: d.id === primary.id,
            bounds: d.bounds
        }));
    } catch (e) {
        log('Error getting displays list: ' + e.message);
        return [];
    }
}

function sendDisplaysInfo() {
    if (socket && socket.connected && currentSessionId) {
        const list = getDisplaysList();
        log(`Sending displays info: ${list.length} display(s) detected. Active: ${currentDisplayIndex}`);
        socket.emit('remote:displays', {
            sessionId: currentSessionId,
            displays: list,
            screens: list,
            activeDisplayIndex: currentDisplayIndex
        });
        socket.emit('remote:screen-list', {
            sessionId: currentSessionId,
            screens: list,
            displays: list,
            activeDisplayIndex: currentDisplayIndex
        });
    }
}

function startScreenCaptureWindow(sessionId) {
    if (rtcWindow) {
        try { rtcWindow.close(); } catch(e) {}
        rtcWindow = null;
    }

    log('Opening screen capture renderer window for session ' + sessionId);
    try {
        rtcWindow = new BrowserWindow({
            width: 160,
            height: 100,
            x: 0,
            y: 0,
            show: true,
            frame: false,
            transparent: true,
            hasShadow: false,
            focusable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            opacity: 0.02,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                backgroundThrottling: false
            }
        });
        if (typeof rtcWindow.setIgnoreMouseEvents === 'function') {
            rtcWindow.setIgnoreMouseEvents(true);
        }

        rtcWindow.loadFile(path.join(__dirname, 'remote.html'));

        rtcWindow.webContents.on('did-finish-load', () => {
            log('Screen capture renderer loaded. Sending start-capture for session ' + sessionId);
            if (rtcWindow && !rtcWindow.isDestroyed()) {
                rtcWindow.webContents.send('start-capture', { sessionId });
            }
        });

        rtcWindow.on('closed', () => {
            rtcWindow = null;
        });
    } catch(err) {
        log('Error creating screen capture window: ' + (err ? err.stack || err.message : err));
    }
}

function stopScreenCaptureWindow() {
    if (rtcWindow) {
        try {
            rtcWindow.webContents.send('rd-stop');
            rtcWindow.close();
        } catch(e) {}
        rtcWindow = null;
    }
}

ipcMain.handle('get-screen-source', async () => {
    try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        if (sources && sources.length > 0) {
            const idx = (currentDisplayIndex >= 0 && currentDisplayIndex < sources.length) ? currentDisplayIndex : 0;
            return sources[idx].id;
        }
    } catch(e) {
        log('getSources error: ' + e.message);
    }
    return null;
});

ipcMain.on('rd-frame', (event, data) => {
    if (socket && socket.connected) {
        socket.emit('remote:frame', data);
    }
});

ipcMain.on('rd-ready', (event, data) => {
    log('Renderer screen capture ready for session ' + data.sessionId);
});

ipcMain.on('rd-log', (event, msg) => {
    log('[Renderer] ' + msg);
});

ipcMain.on('rd-error', (event, data) => {
    log('Renderer screen capture error: ' + data.error);
    agentState.statusText = 'Ekran yakalama hatası: ' + data.error;
    updateAgentUi();
});

function initSocketConnection(supportCode) {
    currentSupportCode = supportCode;
    agentState.code = supportCode;
    agentState.needManualCode = false;
    agentState.statusText = 'Sunucuya bağlanılıyor...';
    updateAgentUi();

    log(`Connecting to ${SERVER_URL}/support-ws with supportCode ${supportCode}...`);

    socket = io(`${SERVER_URL}/support-ws`, {
        transports: ['websocket', 'polling'],
        reconnection: true
    });

    socket.on('connect', () => {
        log(`Connected to websocket. Registering supportCode: ${supportCode}`);
        agentState.connected = true;
        agentState.statusText = 'Bağlandı. Teknisyen bekleniyor...';
        updateAgentUi();

        socket.emit('agent:register', { supportCode }, (res) => {
            log(`Register response: ${JSON.stringify(res)}`);
            if (res && res.ok) {
                currentSessionId = res.sessionId;
            } else {
                log('Register failed: ' + (res?.error || 'Unknown error'));
                agentState.statusText = 'Kayıt başarısız: ' + (res?.error || 'Geçersiz destek kodu');
                updateAgentUi();
            }
        });
    });

    socket.on('remote:consent-request', (data) => {
        log(`Received consent request from technician: ${data.technicianName} for session ${data.sessionId}`);
        currentSessionId = data.sessionId;

        agentState.consentPending = true;
        agentState.technicianName = data.technicianName || 'Teknisyen';
        hasBeenAccepted = true;
        updateAgentUi();

        if (agentWindow && !agentWindow.isDestroyed()) {
            if (agentWindow.isMinimized()) agentWindow.restore();
            agentWindow.show();
            agentWindow.setAlwaysOnTop(true, 'screen-saver');
            agentWindow.focus();
            setTimeout(() => {
                if (agentWindow && !agentWindow.isDestroyed()) {
                    agentWindow.setAlwaysOnTop(false);
                }
            }, 3000);
        }
    });

    socket.on('remote:control', (data) => {
        if (!psProcess) return;
        try {
            const allDisplays = screen.getAllDisplays();
            const currentDisp = (currentDisplayIndex >= 0 && currentDisplayIndex < allDisplays.length) 
                ? allDisplays[currentDisplayIndex] 
                : screen.getPrimaryDisplay();

            // Multi-monitor origin offset + scaled width/height
            const b = currentDisp.bounds;
            const absX = b.x + Math.round(data.x * b.width);
            const absY = b.y + Math.round(data.y * b.height);

            if (data.action === 'mousemove') {
                if (isInputBlocked) return;
                psProcess.stdin.write('m ' + absX + ' ' + absY + '\r\n');
            } else if (data.action === 'mousedown') {
                if (isInputBlocked) return;
                const btn = data.button === 'right' ? 'right' : 'left';
                if (typeof data.x === 'number' && typeof data.y === 'number') {
                    psProcess.stdin.write(`c ${btn} down ${absX} ${absY}\r\n`);
                } else {
                    psProcess.stdin.write(`c ${btn} down\r\n`);
                }
            } else if (data.action === 'mouseup') {
                if (isInputBlocked) return;
                const btn = data.button === 'right' ? 'right' : 'left';
                if (typeof data.x === 'number' && typeof data.y === 'number') {
                    psProcess.stdin.write(`c ${btn} up ${absX} ${absY}\r\n`);
                } else {
                    psProcess.stdin.write(`c ${btn} up\r\n`);
                }
            } else if (data.action === 'wheel') {
                if (isInputBlocked) return;
                const delta = typeof data.delta === 'number' ? data.delta : 0;
                psProcess.stdin.write('w ' + delta + '\r\n');
            } else if (data.action === 'char') {
                if (isInputBlocked) return;
                const charStr = data.char || '';
                for (let i = 0; i < charStr.length; i++) {
                    const hex = charStr.charCodeAt(i).toString(16);
                    psProcess.stdin.write('u ' + hex + '\r\n');
                }
            } else if (data.action === 'special-key') {
                if (isInputBlocked) return;
                const sk = (data.key || '').toLowerCase();
                const map = {
                    'enter': 'enter',
                    'escape': 'esc',
                    'esc': 'esc',
                    'backspace': 'backspace',
                    'tab': 'tab',
                    'delete': 'delete',
                    'space': 'space',
                    'arrowup': 'up',
                    'arrowdown': 'down',
                    'arrowleft': 'left',
                    'arrowright': 'right',
                    'home': 'home',
                    'end': 'end',
                    'pageup': 'pageup',
                    'pagedown': 'pagedown',
                    'f1': 'f1', 'f2': 'f2', 'f3': 'f3', 'f4': 'f4', 'f5': 'f5', 'f6': 'f6',
                    'f7': 'f7', 'f8': 'f8', 'f9': 'f9', 'f10': 'f10', 'f11': 'f11', 'f12': 'f12'
                };
                const mapped = map[sk] || sk;
                psProcess.stdin.write('pk ' + mapped + '\r\n');
            } else if (data.action === 'keydown') {
                if (isInputBlocked) return;
                psProcess.stdin.write('kd ' + (data.key || '') + '\r\n');
            } else if (data.action === 'keyup') {
                if (isInputBlocked) return;
                psProcess.stdin.write('ku ' + (data.key || '') + '\r\n');
            } else if (data.action === 'combo') {
                if (isInputBlocked) return;
                psProcess.stdin.write('combo ' + (data.combo || '') + '\r\n');
            } else if (data.action === 'keypress') {
                if (isInputBlocked) return;
                const k = data.key || '';
                if (k.length === 1) {
                    const hex = k.charCodeAt(0).toString(16);
                    psProcess.stdin.write('u ' + hex + '\r\n');
                } else if (k.startsWith('{') && k.endsWith('}')) {
                    const cleanKey = k.slice(1, -1).toLowerCase();
                    const map = {
                        'enter': 'enter', 'esc': 'esc', 'backspace': 'backspace',
                        'tab': 'tab', 'delete': 'delete', 'up': 'up', 'down': 'down',
                        'left': 'left', 'right': 'right', 'home': 'home', 'end': 'end',
                        'pgup': 'pageup', 'pgdn': 'pagedown'
                    };
                    psProcess.stdin.write('pk ' + (map[cleanKey] || cleanKey) + '\r\n');
                } else {
                    psProcess.stdin.write('pk ' + k.toLowerCase() + '\r\n');
                }
            } else if (data.action === 'ctrl-alt-del') {
                exec('taskmgr.exe');
            } else if (data.action === 'run-cmd') {
                if (data.cmd === 'devmgmt') exec('devmgmt.msc');
                else if (data.cmd === 'services') exec('services.msc');
                else if (data.cmd === 'eventvwr') exec('eventvwr.msc');
                else if (data.cmd === 'cmd') exec('start cmd.exe');
            } else if (data.action === 'block-input') {
                isInputBlocked = !!data.enable;
                log(`Local input block set to ${isInputBlocked}`);
            } else if (data.action === 'privacy-screen') {
                togglePrivacyScreen(!!data.enable);
                log(`Privacy screen set to ${data.enable}`);
            } else if (data.action === 'request-sysinfo') {
                sendSystemInfo();
            } else if (data.action === 'get-displays' || data.action === 'get-screens') {
                sendDisplaysInfo();
            } else if (data.action === 'switch-display' || data.action === 'switch-screen') {
                const targetIdx = typeof data.displayIndex === 'number' ? data.displayIndex : (typeof data.screenIndex === 'number' ? data.screenIndex : 0);
                const displays = screen.getAllDisplays();
                if (targetIdx >= 0 && targetIdx < displays.length) {
                    currentDisplayIndex = targetIdx;
                    log(`Switching active display via remote:control to Monitör ${targetIdx + 1}`);
                    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then(sources => {
                        const source = sources[targetIdx] || sources[0];
                        if (rtcWindow && !rtcWindow.isDestroyed()) {
                            rtcWindow.webContents.send('switch-source', { sourceId: source.id });
                        }
                    }).catch(e => log('Error switching source: ' + e.message));
                    sendDisplaysInfo();
                }
            }
        } catch(e) {
            log('Control write error: ' + e.message);
        }
    });
    socket.on('remote:get-displays', (data) => {
        if (data.sessionId === currentSessionId) {
            sendDisplaysInfo();
        }
    });

    socket.on('remote:switch-display', async (data) => {
        if (data.sessionId !== currentSessionId) return;
        const targetIdx = typeof data.displayIndex === 'number' ? data.displayIndex : 0;
        currentDisplayIndex = targetIdx;
        log(`Requested switch to displayIndex: ${targetIdx}`);
        try {
            const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
            log(`desktopCapturer sources: ${sources.length} sources found`);
            const source = sources[targetIdx] || sources[0];
            if (source && rtcWindow && !rtcWindow.isDestroyed()) {
                log(`Switching active display stream to: ${source.name} (${source.id})`);
                rtcWindow.webContents.send('switch-source', { sourceId: source.id });
            }
        } catch(e) {
            log('Error switching display source: ' + e.message);
        }
        sendDisplaysInfo();
    });


    socket.on('remote:stop', () => {
        log('Received remote:stop signal');
        stopScreenCaptureWindow();
        stopInputSimulator();
        agentState.sessionActive = false;
        agentState.consentPending = false;
        agentState.statusText = 'Oturum teknisyen tarafından sonlandırıldı. Program 5 saniye içinde kapanacak...';
        updateAgentUi();

        if (hasBeenAccepted) {
            selfDestruct();
            setTimeout(() => {
                if (agentWindow && !agentWindow.isDestroyed()) agentWindow.close();
                app.quit();
            }, 5000);
        }
    });

    socket.on('chat:message', (data) => {
        log(`Received chat message from ${data.senderName}: ${data.text}`);
        if (agentWindow && !agentWindow.isDestroyed()) {
            try {
                if (agentWindow.isMinimized()) agentWindow.restore();
                agentWindow.show();
                agentWindow.focus();
                agentWindow.setAlwaysOnTop(true);
                setTimeout(() => {
                    try {
                        if (agentWindow && !agentWindow.isDestroyed()) {
                            agentWindow.setAlwaysOnTop(false);
                        }
                    } catch(e) {}
                }, 4000);
                agentWindow.flashFrame(true);
            } catch(e) {
                log('Window focus error on chat: ' + e.message);
            }
            agentWindow.webContents.send('chat-message', data);
        }
    });

    socket.on('webrtc:signal', (data) => {
        log('Relaying WebRTC voice signal to agent UI...');
        if (agentWindow && !agentWindow.isDestroyed()) {
            agentWindow.webContents.send('webrtc-signal', data);
        }
    });

    socket.on('disconnect', () => {
        log('Socket disconnected.');
        stopScreenCaptureWindow();
        stopInputSimulator();
        agentState.connected = false;
        agentState.sessionActive = false;
        agentState.consentPending = false;
        agentState.statusText = 'Sunucu bağlantısı kesildi.';
        updateAgentUi();
    });
}

function createAgentWindow() {
    agentWindow = new BrowserWindow({
        width: 440,
        height: 620,
        minWidth: 400,
        minHeight: 560,
        resizable: true,
        minimizable: true,
        maximizable: false,
        autoHideMenuBar: true,
        backgroundColor: '#0a0f1d',
        title: 'Homak Uzaktan Destek',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    try {
        agentWindow.setMenuBarVisibility(false);
    } catch (e) {}

    if (agentWindow.webContents && agentWindow.webContents.session) {
        agentWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
            if (permission === 'media') return callback(true);
            callback(false);
        });
    }

    agentWindow.loadFile(path.join(__dirname, 'agent.html'));

    agentWindow.webContents.on('did-finish-load', () => {
        updateAgentUi();
    });

    agentWindow.on('closed', () => {
        agentWindow = null;
        stopScreenCaptureWindow();
        stopInputSimulator();
        app.quit();
    });
}

ipcMain.on('user-consent-choice', (event, choice) => {
    log(`User consent choice: ${choice}, currentSessionId: ${currentSessionId}, socketConnected: ${socket && socket.connected}`);
    agentState.consentPending = false;

    // Send consent response to server immediately so technician UI updates instantly
    if (socket && socket.connected && currentSessionId) {
        log(`Emitting remote:consent-response for session ${currentSessionId} with result ${choice}`);
        socket.emit('remote:consent-response', { sessionId: currentSessionId, result: choice });
    } else {
        log(`WARNING: Cannot emit consent-response: socket=${!!socket}, connected=${socket?.connected}, sessionId=${currentSessionId}`);
    }

    if (choice === 'accepted') {
        hasBeenAccepted = true;
        agentState.sessionActive = true;
        if (agentWindow && !agentWindow.isDestroyed()) {
            agentWindow.setSize(420, 580);
        }
        agentState.statusText = `🟢 ${agentState.technicianName || 'Teknisyen'} Bağlandı`;
        updateAgentUi();

        try { startInputSimulator(); } catch(e) { log('Error in startInputSimulator: ' + e); }
        try { startClipboardSync(); } catch(e) { log('Error in startClipboardSync: ' + e); }
        try { sendSystemInfo(); } catch(e) { log('Error in sendSystemInfo: ' + e); }
        try { sendDisplaysInfo(); } catch(e) { log('Error in sendDisplaysInfo: ' + e); }
        setInterval(() => {
            try {
                if (socket && socket.connected && currentSessionId) {
                    sendDisplaysInfo();
                }
            } catch(e) {}
        }, 4000);
        try {
            if (currentSessionId) {
                startScreenCaptureWindow(currentSessionId);
            }
        } catch(e) { log('Error in startScreenCaptureWindow: ' + e); }
    } else {
        agentState.sessionActive = false;
        agentState.statusText = 'Bağlantı reddedildi.';
        updateAgentUi();
    }
});

ipcMain.on('user-disconnect', () => {
    log('User clicked disconnect button.');
    if (socket && socket.connected && currentSessionId) {
        socket.emit('remote:stop', { sessionId: currentSessionId });
    }
    stopScreenCaptureWindow();
    stopInputSimulator();
    stopClipboardSync();
    togglePrivacyScreen(false);
    if (hasBeenAccepted) {
        selfDestruct();
    }
    app.quit();
});

ipcMain.on('manual-code-submit', (event, code) => {
    if (code && code.length === 6) {
        log(`Manual support code submitted: ${code}`);
        initSocketConnection(code);
    }
});

ipcMain.on('send-chat-message', (event, text) => {
    if (!text || !currentSessionId) return;
    log(`Sending chat message: ${text}`);
    if (socket && socket.connected) {
        socket.emit('chat:message', {
            sessionId: currentSessionId,
            text: text,
            sender: 'agent',
            senderName: 'Müşteri'
        });
    }
});

ipcMain.on('webrtc-signal', (event, data) => {
    if (socket && socket.connected && currentSessionId) {
        socket.emit('webrtc:signal', { sessionId: currentSessionId, signal: data.signal || data });
    }
});

app.whenReady().then(() => {
    createAgentWindow();

    const code = extractSupportCode();
    if (code) {
        log(`Extracted supportCode: ${code}`);
        initSocketConnection(code);
    } else {
        log('Destek kodu tespit edilemedi, kullanicidan manuel giriş istenecek.');
        agentState.needManualCode = true;
        updateAgentUi();
    }
});

app.on('window-all-closed', () => {
    app.quit();
});
