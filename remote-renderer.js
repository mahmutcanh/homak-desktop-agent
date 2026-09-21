const { ipcRenderer } = require('electron');

const video = document.getElementById('v');
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false });

let captureInterval = null;
let streaming = false;
let frameCount = 0;

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

        captureInterval = setInterval(() => {
            if (!streaming) return;
            try {
                if (video.paused) {
                    video.play().catch(() => {});
                }
                if (video.videoWidth > 0 && video.videoHeight > 0) {
                    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
                    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
                    const base64 = dataUrl.split(',')[1];
                    if (base64) {
                        frameCount++;
                        if (frameCount % 30 === 1) {
                            ipcRenderer.send('rd-log', 'Sent frame ' + frameCount + ' (' + canvas.width + 'x' + canvas.height + ')');
                        }
                        ipcRenderer.send('rd-frame', {
                            sessionId,
                            frame: base64,
                            width: canvas.width,
                            height: canvas.height
                        });
                    }
                }
            } catch(e) {
                ipcRenderer.send('rd-error', { sessionId, error: e.message });
            }
        }, 100); // 10 FPS
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
