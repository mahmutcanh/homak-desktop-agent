const { app, BrowserWindow, ipcMain, screen, desktopCapturer, clipboard } = require('electron');
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
    console.log(`[HomakAgent ${new Date().toISOString()}] ${msg}`);
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
    log('Spawning PowerShell input simulator...');
    const inputPs1 = path.join(app.getPath('userData'), 'input.ps1');
    const ps1Content = "Add-Type -AssemblyName System.Windows.Forms\r\n"
        + "$sig = @'\r\n"
        + "[DllImport(\"user32.dll\")]\r\n"
        + "public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);\r\n"
        + "[DllImport(\"user32.dll\")]\r\n"
        + "public static extern bool SetCursorPos(int X, int Y);\r\n"
        + "'@\r\n"
        + "$u = Add-Type -MemberDefinition $sig -Name 'U32' -Namespace 'Win32' -PassThru\r\n"
        + "while ($true) {\r\n"
        + "  $line = [Console]::In.ReadLine()\r\n"
        + "  if ($null -eq $line) { break }\r\n"
        + "  try {\r\n"
        + "    if ($line -match '^m (\\d+) (\\d+)') { [void]$u::SetCursorPos([int]$Matches[1], [int]$Matches[2]) }\r\n"
        + "    elseif ($line -eq 'c left down')  { $u::mouse_event(0x0002,0,0,0,0) }\r\n"
        + "    elseif ($line -eq 'c left up')    { $u::mouse_event(0x0004,0,0,0,0) }\r\n"
        + "    elseif ($line -eq 'c right down') { $u::mouse_event(0x0008,0,0,0,0) }\r\n"
        + "    elseif ($line -eq 'c right up')   { $u::mouse_event(0x0010,0,0,0,0) }\r\n"
        + "    elseif ($line -match '^k (.+)')   { [System.Windows.Forms.SendKeys]::SendWait($Matches[1]) }\r\n"
        + "  } catch {}\r\n"
        + "}\r\n";
    try {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(inputPs1, ps1Content);
    } catch (e) {
        log('Error writing input.ps1: ' + e.message);
    }

    psProcess = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', inputPs1]);
    psProcess.stdin.setDefaultEncoding('utf8');
    psProcess.stderr.on('data', (d) => log('[PS Error] ' + d.toString().trim()));
}

function stopInputSimulator() {
    if (psProcess && !psProcess.killed) {
        psProcess.kill();
        psProcess = null;
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
        privacyWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
            <html>
                <body style="background:#020617;color:#38bdf8;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;">
                    <div style="font-size:48px;margin-bottom:16px;">🛡️</div>
                    <h1 style="margin:0;font-size:24px;">Homak Remote Secure Maintenance Mode</h1>
                    <p style="color:#94a3b8;font-size:14px;margin-top:8px;">Teknisyeniniz şu anda bilgisayarınızda bakım yapmaktadır. Ekran geçici olarak gizlendi.</p>
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

function startScreenCaptureWindow(sessionId) {
    if (rtcWindow) {
        try { rtcWindow.close(); } catch(e) {}
        rtcWindow = null;
    }

    log('Opening screen capture renderer window for session ' + sessionId);
    try {
        rtcWindow = new BrowserWindow({
            width: 320,
            height: 180,
            show: true,
            x: -2000,
            y: -2000,
            focusable: false,
            skipTaskbar: true,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                backgroundThrottling: false
            }
        });

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
            return sources[0].id;
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
            if (data.action === 'mousemove') {
                if (isInputBlocked) return;
                const disp = screen.getPrimaryDisplay();
                const sf = disp.scaleFactor || 1;
                const absX = Math.round(data.x * disp.bounds.width * sf);
                const absY = Math.round(data.y * disp.bounds.height * sf);
                psProcess.stdin.write('m ' + absX + ' ' + absY + '\r\n');
            } else if (data.action === 'mousedown') {
                if (isInputBlocked) return;
                const clickCmd = data.button === 'right' ? 'c right down\r\n' : 'c left down\r\n';
                psProcess.stdin.write(clickCmd);
            } else if (data.action === 'mouseup') {
                if (isInputBlocked) return;
                const clickCmd = data.button === 'right' ? 'c right up\r\n' : 'c left up\r\n';
                psProcess.stdin.write(clickCmd);
            } else if (data.action === 'keypress') {
                if (isInputBlocked) return;
                psProcess.stdin.write('k ' + data.key + '\r\n');
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
            }
        } catch(e) {
            log('Control write error: ' + e.message);
        }
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
        height: 460,
        resizable: false,
        minimizable: true,
        maximizable: false,
        title: 'Homak Remote Support',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

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
    log(`User consent choice: ${choice}, currentSessionId: ${currentSessionId}`);
    agentState.consentPending = false;

    if (choice === 'accepted') {
        hasBeenAccepted = true;
        agentState.sessionActive = true;
        agentState.statusText = '🟢 Ekran Paylaşımı Aktif';
        startInputSimulator();
        startClipboardSync();
        sendSystemInfo();
        if (currentSessionId) {
            startScreenCaptureWindow(currentSessionId);
        }
    } else {
        agentState.sessionActive = false;
        agentState.statusText = 'Bağlantı reddedildi.';
    }
    updateAgentUi();

    if (socket && socket.connected && currentSessionId) {
        socket.emit('remote:consent-response', { sessionId: currentSessionId, result: choice });
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
        socket.emit('webrtc:signal', { sessionId: currentSessionId, ...data });
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
