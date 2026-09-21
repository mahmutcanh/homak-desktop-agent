const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function loadAgent(source) {
    const windows = [];
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.messages = [];
            this.webContents = new EventEmitter();
            this.webContents.send = (...args) => this.messages.push(args);
            windows.push(this);
        }
        loadFile(file) { this.file = file; }
        close() { this.closed = true; this.emit('closed'); }
        isDestroyed() { return !!this.closed; }
    }
    const context = vm.createContext({
        require(name) {
            if (name === 'electron') return {
                app: { whenReady: () => ({ then() {} }), on() {} },
                BrowserWindow,
                ipcMain: { on() {}, handle() {} }
            };
            if (name === 'socket.io-client') return { io() { throw new Error('Unexpected network connection'); } };
            return require(name);
        },
        process: { env: {}, on: () => {} },
        console: { log() {} },
        __dirname: path.resolve(__dirname, '..')
    });
    vm.runInContext(source, context);
    return { context, windows };
}

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('first capture creates a renderer and delivers the accepted session after loading', () => {
    const { context, windows } = loadAgent(source);
    vm.runInContext("startScreenCaptureWindow('accepted-session')", context);
    assert.equal(windows.length, 1);
    assert.equal(path.basename(windows[0].file), 'remote.html');
    windows[0].webContents.emit('did-finish-load');
    assert.equal(windows[0].messages[0][0], 'start-capture');
    assert.equal(windows[0].messages[0][1].sessionId, 'accepted-session');
});

test('capture can stop before starting, then restart without retaining the old window', () => {
    const { context, windows } = loadAgent(source);
    vm.runInContext("stopScreenCaptureWindow(); startScreenCaptureWindow('first'); startScreenCaptureWindow('second'); stopScreenCaptureWindow()", context);
    assert.equal(windows.length, 2);
    assert.equal(windows[0].closed, true);
    assert.equal(windows[1].closed, true);
    assert.equal(vm.runInContext('rtcWindow', context), null);
});

test('regression check: the previous missing declaration prevents all screen capture', () => {
    const { context } = loadAgent(source.replace('let rtcWindow = null;', ''));
    assert.throws(() => vm.runInContext("startScreenCaptureWindow('accepted-session')", context), /rtcWindow is not defined/);
});
