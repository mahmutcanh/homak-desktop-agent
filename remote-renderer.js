const { ipcRenderer } = require('electron');

const video = document.getElementById('v');
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false });

let captureInterval = null;
let streaming = false;
let frameCount = 0;
let isFrameBusy = false;

// Prevent video playback from pausing in background
video.addEventListener('pause', () => {
    if (streaming) {
        video.play().catch(() => {});
    }
});

ipcRenderer.on('start-capture', async (event, data) => {
    const { sessionId } = data;
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
        ipcRenderer.send('rd-ready', { sessionId });
        ipcRenderer.send('rd-log', 'rd-ready sent for session ' + sessionId);

        if (captureInterval) clearInterval(captureInterval);

        // Ultra-low latency, smooth ~25 FPS pipeline with adaptive resolution
        const targetIntervalMs = 40; // 25 FPS (smooth & low lag)

        captureInterval = setInterval(() => {
            if (!streaming || isFrameBusy) return;
            try {
                if (video.paused) {
                    video.play().catch(() => {});
                }
                const vw = video.videoWidth;
                const vh = video.videoHeight;
                if (vw <= 0 || vh <= 0) return;

                isFrameBusy = true;

                // Adaptive resolution: cap at 1280px width for fast encoding & sharp readability
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

                // Quality 0.42 yields ~35KB per frame with crisp text & zero lag
                const dataUrl = canvas.toDataURL('image/jpeg', 0.42);
                const commaIdx = dataUrl.indexOf(',');
                if (commaIdx !== -1) {
                    const base64 = dataUrl.slice(commaIdx + 1);
                    if (base64) {
                        frameCount++;
                        if (frameCount % 60 === 1) {
                            ipcRenderer.send('rd-log', 'Sent frame ' + frameCount + ' (' + cw + 'x' + ch + ')');
                        }
                        ipcRenderer.send('rd-frame', {
                            sessionId,
                            frame: base64,
                            width: cw,
                            height: ch
                        });
                    }
                }
            } catch(e) {
                ipcRenderer.send('rd-error', { sessionId, error: e.message });
            } finally {
                isFrameBusy = false;
            }
        }, targetIntervalMs);
    } catch(err) {
        ipcRenderer.send('rd-error', { sessionId, error: err.message });
    }
});

ipcRenderer.on('rd-stop', () => {
    streaming = false;
    if (captureInterval) {
        clearInterval(captureInterval);
        captureInterval = null;
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
