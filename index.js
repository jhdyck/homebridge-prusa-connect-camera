// index.js
const fs = require('fs');
const http = require('http');
const path = require('path');
const axios = require('axios');
const { spawn, exec } = require('child_process');

// Simple ANSI color codes for console logs
const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  white: "\x1b[37m"
};

let logger, config, api;

module.exports = (homebridge) => {
  homebridge.registerPlatform(
    "homebridge-prusa-connect-camera",
    "PrusaConnectCamera",
    PrusaConnectCameraPlatform
  );
};

class PrusaConnectCameraPlatform {
  constructor(log, platformConfig, homebridgeApi) {
    logger = log;
    config = platformConfig || {};
    api = homebridgeApi;

    this.cameraName = config.name || 'Prusa Camera';
    this.configPath = '/var/lib/homebridge/config.json'; // Could be configurable or autodetected

    // --- Rebroadcast settings (UI-configurable) ---
    // Default: OFF until the user checks the box in the UI.
    this.rebroadcastEnabled = config.rebroadcastEnabled === true;
    this.rebroadcastPort = Number(config.rebroadcastPort || 8088);
    this.streamFps = Number(config.streamFps || 15);           // MJPEG stream fps
    this.mjpegQuality = Number(config.mjpegQuality || 7);       // 2..31 (lower = better)
    this.maxFrameAgeMs = Number(config.maxFrameAgeMs || 5000);  // acceptable frame age for upload (ms)

    // Camera source (string of ffmpeg args)
    // Keep your previous default style, but ensure v4l2 flags are present for typical USB cams.
    this.videoSource = config.videoSource || '-f v4l2 -video_size 960x720 -i /dev/video0';

    // Prusa auth
    this.token = config.token;
    this.fingerprint = config.fingerprint;

    // Buffers & clients for rebroadcast
    this._frameBuf = Buffer.alloc(0);
    this._latestFrame = null;
    this._latestAt = 0;
    this._clients = new Set();
    this._capture = null;

    logger(`PrusaConnectCameraPlatform initialized with config: ${JSON.stringify({
      name: this.cameraName,
      videoSource: this.videoSource,
      rebroadcastEnabled: this.rebroadcastEnabled,
      rebroadcastPort: this.rebroadcastPort,
      streamFps: this.streamFps,
      mjpegQuality: this.mjpegQuality,
      maxFrameAgeMs: this.maxFrameAgeMs,
      hasToken: !!this.token,
      hasFingerprint: !!this.fingerprint
    })}`);

    // Start the single-owner capture & HTTP server if rebroadcasting is enabled
    if (this.rebroadcastEnabled) {
      this.startCapturePipeline();
      this.startHttpServer();
    }

    // Start the periodic upload loop (uses the live buffer when rebroadcasting)
    this.startSnapshotLoop();
  }

  logSuccess(msg){ logger(`${COLORS.green}${msg}${COLORS.reset}`); }
  logError(msg){ logger(`${COLORS.red}${msg}${COLORS.reset}`); }
  logWarn(msg){ logger(`${COLORS.yellow}${msg}${COLORS.reset}`); }

  updateConfigFingerprint(newFingerprint) {
    try {
      const data = fs.readFileSync(this.configPath, 'utf8');
      const cfg = JSON.parse(data);

      if (!cfg.platforms) {
        this.logError('No platforms section found in config.json');
        return;
      }
      const platform = cfg.platforms.find(p => p.platform === 'PrusaConnectCamera');
      if (!platform) {
        this.logError('PrusaConnectCamera platform not found in config.json');
        return;
      }
      platform.fingerprint = newFingerprint;
      fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), 'utf8');
      this.logSuccess(`Updated fingerprint in config.json: ${newFingerprint}`);
    } catch (err) {
      this.logError(`Error updating config.json fingerprint: ${err.message}`);
    }
  }

  // ========== CAPTURE & REBROADCAST ==========

  startCapturePipeline() {
    // Single persistent ffmpeg that owns /dev/video0 and outputs MJPEG frames on stdout.
    // Consumers (HomeKit via Camera-ffmpeg and our snapshot uploader) never touch /dev/video0.
    const args = [
      ...this.videoSource.trim().split(/\s+/),
      '-r', String(this.streamFps),
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', String(this.mjpegQuality),
      '-' // stdout
    ];

    this._capture = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this._capture.stderr.on('data', d => {
      const s = d.toString();
      if (/Error|fail|ioctl|resource busy|No such file/i.test(s)) {
        this.logWarn(`[Capture] ffmpeg: ${s.trim()}`);
      }
    });

    this._capture.on('exit', (code, sig) => {
      this.logWarn(`[Capture] ffmpeg exited (code=${code}, sig=${sig}). Will retry in 5s.`);
      // Clear frame buffer so uploads don't use stale frames forever
      this._latestFrame = null;
      this._latestAt = 0;
      setTimeout(() => this.startCapturePipeline(), 5000);
    });

    // Parse concatenated JPEGs from stdout (image2pipe)
    const SOI = Buffer.from([0xFF, 0xD8]); // start of image
    const EOI = Buffer.from([0xFF, 0xD9]); // end of image

    this._capture.stdout.on('data', chunk => {
      this._frameBuf = Buffer.concat([this._frameBuf, chunk]);
      let start = this._frameBuf.indexOf(SOI);
      while (start !== -1) {
        const end = this._frameBuf.indexOf(EOI, start + 2);
        if (end === -1) break; // incomplete frame; wait for more
        const frame = this._frameBuf.slice(start, end + 2);

        // store latest frame for uploads
        this._latestFrame = frame;
        this._latestAt = Date.now();

        // push to MJPEG clients
        this._clients.forEach((res) => this._writeMjpegFrame(res, frame));

        // consume buffer
        this._frameBuf = this._frameBuf.slice(end + 2);
        start = this._frameBuf.indexOf(SOI);
      }
    });
  }

  startHttpServer() {
    const srv = http.createServer((req, res) => {
      if (req.url === '/stream.mjpg') {
        res.writeHead(200, {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Connection': 'close',
          'Content-Type': 'multipart/x-mixed-replace; boundary=--frame'
        });
        this._clients.add(res);
        req.on('close', () => this._clients.delete(res));
        if (this._latestFrame) this._writeMjpegFrame(res, this._latestFrame);
        return;
      }

      if (req.url === '/snapshot.jpg') {
        if (this._latestFrame) {
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': this._latestFrame.length });
          return res.end(this._latestFrame);
        } else {
          res.statusCode = 503;
          return res.end('No frame yet');
        }
      }

      res.statusCode = 404;
      res.end('Not found');
    });

    srv.listen(this.rebroadcastPort, '0.0.0.0', () => {
      this.logSuccess(`[Rebroadcast] MJPEG: http://127.0.0.1:${this.rebroadcastPort}/stream.mjpg  |  Snapshot: http://127.0.0.1:${this.rebroadcastPort}/snapshot.jpg`);
    });
  }

  _writeMjpegFrame(res, frame) {
    try {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');
    } catch {
      this._clients.delete(res);
    }
  }

  // ========== PRUSA SNAPSHOT LOOP ==========

  startSnapshotLoop() {
    let token = this.token;
    let fingerprint = this.fingerprint;

    logger(`[PrusaConnectCamera] Token received: "${token}" (length: ${token ? token.length : 'undefined'})`);

    if (!fingerprint || fingerprint.length < 20) {
      fingerprint = Buffer.from('homebridge-' + Math.random().toString(36).slice(2) + Date.now().toString())
        .toString('base64').slice(0, 24);
      this.logWarn(`[PrusaConnectCamera] No valid fingerprint provided. Generated: ${fingerprint}`);
      this.updateConfigFingerprint(fingerprint);
    }

    if (!token || token.length < 20) {
      this.logError('You must configure a valid Prusa Connect token (20+ characters) in config.json!');
      return;
    }

    const url = 'https://webcam.connect.prusa3d.com/c/snapshot';
    const snapshotIntervalSeconds = Number(config.snapshotInterval || 10);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    const uploadOnce = async () => {
      try {
        if (this.rebroadcastEnabled) {
          // Use the most recent frame from the capture pipeline
          const age = Date.now() - this._latestAt;
          if (!this._latestFrame || age > this.maxFrameAgeMs) {
            this.logWarn(`[Prusa] No fresh frame available (age=${age}ms). Skipping this cycle.`);
            return;
          }
          await axios.put(url, this._latestFrame, {
            headers: {
              'Content-Type': 'image/jpg',
              'token': token,
              'fingerprint': fingerprint
            }
          });
          const t = new Date().toLocaleTimeString();
          this.logSuccess(`${COLORS.white}[${t}]${COLORS.reset} Uploaded ${this.cameraName} snapshot successfully (buffer)`);
          return;
        }

        // Fallback path (rebroadcast disabled): one-off ffmpeg capture (may contend if other plugins open the device)
        const tmpFile = `prusa-snap-${Date.now()}.jpg`;
        const ok = await this.captureSnapshot(tmpFile, this.videoSource);
        if (!ok) return; // resource busy logged inside
        const data = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        await axios.put(url, data, {
          headers: {
            'Content-Type': 'image/jpg',
            'token': token,
            'fingerprint': fingerprint
          }
        });
        const t = new Date().toLocaleTimeString();
        this.logSuccess(`${COLORS.white}[${t}]${COLORS.reset} Uploaded ${this.cameraName} snapshot successfully (file: ${tmpFile})`);
      } catch (err) {
        if (err && err.response) {
          this.logError(`[${new Date().toLocaleTimeString()}] Upload error: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
        } else {
          this.logError(`[${new Date().toLocaleTimeString()}] Upload error: ${err?.message || err}`);
        }
      }
    };

    const loop = async () => {
      while (true) {
        const start = Date.now();
        await uploadOnce();
        const elapsed = Date.now() - start;
        const delay = snapshotIntervalSeconds * 1000 - elapsed;
        await sleep(Math.max(0, delay));
      }
    };

    loop().catch(e => this.logError(`Snapshot loop crashed: ${e?.message || e}`));
  }

  // Back-compat single-capture function (used only when rebroadcastDisabled)
  captureSnapshot(tmpFile, videoSource, maxRetries = 3, retryDelayMs = 3000) {
    let attempt = 0;
    const tryCap = () => new Promise((resolve, reject) => {
      const cmd = `ffmpeg ${videoSource} -frames 1 ${tmpFile} -y`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          if (/resource busy/i.test(stderr || '')) {
            attempt++;
            if (attempt <= maxRetries) {
              this.logWarn(`Resource busy (attempt ${attempt}/${maxRetries}), retrying in ${retryDelayMs/1000}s.`);
              return setTimeout(() => tryCap().then(resolve).catch(reject), retryDelayMs);
            }
            this.logWarn(`Resource busy persists after ${maxRetries} attempts; skipping snapshot.`);
            return resolve(false);
          }
          this.logError(`FFmpeg exec error: ${error.message}`);
          logger(`FFmpeg stderr: ${stderr}`);
          return reject(error);
        }
        resolve(true);
      });
    });
    return tryCap();
  }
}
