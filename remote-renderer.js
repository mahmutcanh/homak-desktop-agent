const { ipcRenderer } = require('electron');

const video = document.getElementById('v');
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

let captureInterval = null;
let streaming = false;

ipcRenderer.on('start-capture', async (event, data) => {
    const { sessionId } = data;
    try {
        const sourceId = await ipcRenderer.invoke('get-screen-source');
        if (!sourceId) {
            ipcRenderer.send('rd-error', { sessionId, error: 'Ekran kaynağı bulunamadı' });
            return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId
                }
            }
        });

        video.srcObject = stream;
        video.onloadedmetadata = () => {
            video.play().catch(e => console.error(e));
        };

        streaming = true;
        ipcRenderer.send('rd-ready', { sessionId });

        captureInterval = setInterval(() => {
            if (!streaming) return;
            try {
                if (video.readyState >= 2) {
                    canvas.width = video.videoWidth || 1280;
                    canvas.height = video.videoHeight || 720;
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
                    const base64 = dataUrl.split(',')[1];
                    ipcRenderer.send('rd-frame', {
                        sessionId,
                        frame: base64,
                        width: canvas.width,
                        height: canvas.height
                    });
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
    if (captureInterval) clearInterval(captureInterval);
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
    }
});
