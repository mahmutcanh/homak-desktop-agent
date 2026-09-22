const { ipcRenderer } = require('electron');

const video = document.getElementById('v');
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false });

let captureTimeout = null;
let streaming = false;
let frameCount = 0;
let isFrameBusy = false;
let activeSessionId = null;

// Prevent video playback from pausing in background
video.addEventListener('pause', () => {
    if (streaming) {
        video.play().catch(() => {});
    }
});

function scheduleNextFrame(delay = 33) {
    if (!streaming) return;
    if (captureTimeout) clearTimeout(captureTimeout);
    captureTimeout = setTimeout(captureFrame, delay);
}

function captureFrame() {
    if (!streaming || isFrameBusy) return;
    try {
        if (video.paused) {
            video.play().catch(() => {});
        }
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (vw <= 0 || vh <= 0) {
            scheduleNextFrame(50);
            return;
        }

        isFrameBusy = true;
        const startTime = performance.now();

        // Adaptive resolution: cap at 1280px width for smooth encoding & crisp text
        let cw = vw;
        let ch = vh;
        const maxW = 1280;
        if (cw > maxW) {
            ch = Math.round((ch * maxW) / cw);
            cw = maxW;
        }

        if (canvas.width !== cw) canvas.width = cw;
        if (canvas.height !== ch) canvas.height = ch;

        ctx.drawImage(video, 0, 0, cw, ch);

        // Asynchronous JPEG encoding off the main JS thread to eliminate V8 GC freezes
        canvas.toBlob(async (blob) => {
            try {
                if (!blob || !streaming) {
                    isFrameBusy = false;
                    scheduleNextFrame(33);
                    return;
                }
                const arrayBuffer = await blob.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');
                frameCount++;
                if (frameCount % 60 === 1) {
                    ipcRenderer.send('rd-log', 'Sent frame ' + frameCount + ' (' + cw + 'x' + ch + ')');
                }
                ipcRenderer.send('rd-frame', {
                    sessionId: activeSessionId,
                    frame: base64,
                    width: cw,
                    height: ch
                });
            } catch (err) {
                ipcRenderer.send('rd-log', 'Blob frame processing error: ' + err.message);
            } finally {
                isFrameBusy = false;
                const elapsed = performance.now() - startTime;
                // Target ~28 FPS smoothly with zero backlog
                const nextDelay = Math.max(12, 35 - Math.round(elapsed));
                scheduleNextFrame(nextDelay);
            }
        }, 'image/jpeg', 0.45);
    } catch(e) {
        isFrameBusy = false;
        ipcRenderer.send('rd-error', { sessionId: activeSessionId, error: e.message });
        scheduleNextFrame(60);
    }
}

ipcRenderer.on('start-capture', async (event, data) => {
    const { sessionId } = data;
    activeSessionId = sessionId;
    ipcRenderer.send('rd-log', 'start-capture event received for session ' + sessionId);
    try {
        const sourceId = await ipcRenderer.invoke('get-screen-source');
        ipcRenderer.send('rd-log', 'Screen source id: ' + sourceId);
        if (!sourceId) {
            ipcRenderer.send('rd-error', { sessionId, error: 'Ekran kaynağı bulunamadı' });
            return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId,
                    maxWidth: 1920,
                    maxHeight: 1080
                }
            }
        });

        video.srcObject = stream;
        video.muted = true;
        video.onloadedmetadata = async () => {
            try {
                await video.play();
                ipcRenderer.send('rd-log', 'video.play() metadata loaded');
            } catch(e) {
                ipcRenderer.send('rd-log', 'video.play error: ' + e.message);
            }
        };
        try {
            await video.play();
        } catch(e) {}

        streaming = true;
        isFrameBusy = false;
        ipcRenderer.send('rd-ready', { sessionId });
        ipcRenderer.send('rd-log', 'rd-ready sent for session ' + sessionId);

        if (captureTimeout) clearTimeout(captureTimeout);
        scheduleNextFrame(10);
    } catch(err) {
        ipcRenderer.send('rd-error', { sessionId, error: err.message });
    }
});

ipcRenderer.on('rd-stop', () => {
    streaming = false;
    isFrameBusy = false;
    if (captureTimeout) {
        clearTimeout(captureTimeout);
        captureTimeout = null;
    }
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }
});

ipcRenderer.on('switch-source', async (event, data) => {
    const { sourceId } = data;
    ipcRenderer.send('rd-log', 'Switching screen capture source to ' + sourceId);
    try {
        if (video.srcObject) {
            const oldTracks = video.srcObject.getTracks();
            oldTracks.forEach(t => t.stop());
        }
        const newStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId,
                    maxWidth: 1920,
                    maxHeight: 1080
                }
            }
        });
        video.srcObject = newStream;
        await video.play().catch(() => {});
        ipcRenderer.send('rd-log', 'Successfully switched screen stream to ' + sourceId);
    } catch(err) {
        ipcRenderer.send('rd-error', { error: 'Failed to switch screen source: ' + err.message });
    }
});
