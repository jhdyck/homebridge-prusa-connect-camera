// index.js
const fs = require('fs');
const http = require('http');
const os = require('os');
const axios = require('axios');
const { spawn, exec } = require('child_process');

// ANSI color codes for console logs
const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
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

    this.cameraName = config.name || 'Prusa MK3.5S';
    this.configPath = '/var/lib/homebridge/config.json';

    // ---------- helpers ----------
    const num = (v, def) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : def;
    };

    // ---------- User-configurable settings ----------
    this.rebroadcastEnabled = config.rebroadcastEnabled === true; // OFF until enabled in UI
    this.rebroadcastPort = num(config.rebroadcastPort, 8088);

    // Text fields in UI; coerce here
    this.streamFps = num(config.streamFrameRate ?? config.streamFps, 15);

    // Stream Quality (1..10) → ffmpeg -q:v (2..31, lower=better)
    const uiQuality = num(config.streamQuality ?? config.mjpegQuality, 7);
    this.mjpegQscale = Math.max(2, Math.min(31, Math.round(31 - (uiQuality - 1) * (29 / 9))));
    // uiQuality=10 → q≈2 (best), uiQuality=1 → q≈31 (lowest)

    // Snapshot Upload Limit (seconds) → ms
    this.maxFrameAgeMs = (() => {
      if (config.snapshotUploadLimitSec != null) return num(config.snapshotUploadLimitSec, 5) * 1000;
      if (config.maxFrameAgeMs != null) return num(config.maxFrameAgeMs, 5000);
      return 5000;
    })();

    this.debugLogging = config.debugLogging === true;

    // Camera source for ffmpeg input
    this.videoSource = config.videoSource || '-f v4l2 -video_size 960x720 -i /dev/video0';

    // Prusa auth
    this.token = config.token;
    this.fingerprint = config.fingerprint;

    // Rebroadcast state
    this._frameBuf = Buffer.alloc(0);
    this._latestFrame = null;
    this._latestAt = 0;
    this._clients = new Set();
    this._capture = null;

    this.debug(`Init config: ${JSON.stringify({
      name: this.cameraName,
      rebroadcastEnabled: this.rebroadcastEnabled,
      rebroadcastPort: this.rebroadcastPort,
      streamFps: this.streamFps,
      streamQualityUi: uiQuality,
      mjpegQscale: this.mjpegQscale,
      maxFrameAgeMs: this.maxFrameAgeMs,
      hasToken: !!this.token,
      hasFingerprint: !!this.fingerprint,
      videoSource: this.videoSource
    })}`);

    if (this.rebroadcastEnabled) {
      this.startCapturePipeline();
      this.startHttpServer();
    }

    this.startSnapshotLoop();
  }

  // --- logging helpers ---
  logError(msg) { logger(`${COLORS.red}${msg}${COLORS.reset}`); }
  logWarn(msg)  { logger(`${COLORS.yellow}${msg}${COLORS.reset}`); }
  debug(msg)    { if (this.debugLogging) logger(`[DEBUG] ${msg}`); }

  // Success line formatter: only the phrase is green, everything else normal
  logUploadSuccess(suffixText) {
    const t = new Date().toLocaleTimeString();
    logger(`[${t}] ${COLORS.green}Uploaded ${this.cameraName} snapshot successfully${COLORS.reset}${suffixText ? ' ' + suffixText : ''}`);
  }

  // Persist fields back into config.json
  updateConfig(nextProps) {
    try {
      const data = fs.readFileSync(this.configPath, 'utf8');
      const cfg = JSON.parse(data);
      if (!cfg.platforms) return this.logError('No platforms section found in config.json');
      const p = cfg.platforms.find(p => p.platform === 'PrusaConnectCamera');
      if (!p) return this.logError('PrusaConnectCamera platform not found in config.json');

      let changed = false;
      Object.keys(nextProps).forEach(k => {
        if (p[k] !== nextProps[k]) {
          p[k] = nextProps[k];
          changed = true;
        }
      });

      if (changed) {
        fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), 'utf8');
        this.debug(`Updated config.json fields: ${Object.keys(nextProps).join(', ')}`);
      }
    } catch (e) {
      this.logError(`Error updating config.json: ${e.message}`);
    }
  }
  updateConfigFingerprint(newFingerprint) { this.updateConfig({ fingerprint: newFingerprint }); }
  updateConfigRebroadcastUrls(lanIp) {
    const port = this.rebroadcastPort;
    this.updateConfig({
      rebroadcastStreamUrl: `http://${lanIp}:${port}/stream.mjpg`,
      rebroadcastSnapshotUrl: `http://${lanIp}:${port}/snapshot.jpg`
    });
  }

  // LAN IP detection
  getLanIp() {
    const ifaces = os.networkInterfaces();
    const isPriv = ip =>
      /^10\./.test(ip) || /^192\.168\./.test(ip) ||
      (/^172\./.test(ip) && (() => { const o2 = Number(ip.split('.')[1]); return o2 >= 16 && o2 <= 31; })());

    let candidate = null;
    for (const name of Object.keys(ifaces)) {
      for (const i of ifaces[name] || []) {
        if (i.family === 'IPv4' && !i.internal) {
          if (isPriv(i.address)) return i.address;
          if (!candidate) candidate = i.address;
        }
      }
    }
    return candidate || '127.0.0.1';
  }

  // ========== CAPTURE & REBROADCAST ==========
  startCapturePipeline() {
    // Prefer MJPEG passthrough if requested in videoSource (zero re-encode CPU).
    const wantsNativeMJPEG = /\b-input_format\b\s*mjpe?g\b/i.test(this.videoSource) || /\b-f\b\s*mjpe?g\b/i.test(this.videoSource);

    let args;
    if (wantsNativeMJPEG) {
      // NOTE: we intentionally do NOT set -r here to avoid a re-timestamping step.
      args = [
        ...this.videoSource.trim().split(/\s+/),
        '-fflags', 'nobuffer',
        '-f', 'mjpeg',
        '-c:v', 'copy',
        '-'
      ];
      this.debug('Capture mode: MJPEG passthrough (no re-encode). streamFrameRate ignored.');
    } else {
      // Fallback: re-encode to MJPEG (higher CPU)
      args = [
        ...this.videoSource.trim().split(/\s+/),
        '-r', String(this.streamFps),
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', String(this.mjpegQscale),
        '-'
      ];
      this.debug('Capture mode: re-encode to MJPEG.');
    }

    this.debug(`Starting capture ffmpeg with args: ${JSON.stringify(args)}`);
    this._capture = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this._capture.stderr.on('data', d => {
      const s = d.toString();
      if (/Error|fail|ioctl|resource busy|No such file|not found/i.test(s)) {
        this.logWarn(`[Capture] ffmpeg: ${s.trim()}`);
      } else {
        this.debug(`[Capture] ${s.trim()}`);
      }
    });

    this._capture.on('exit', (code, sig) => {
      this.logWarn(`[Capture] ffmpeg exited (code=${code}, sig=${sig}). Will retry in 5s.`);
      this._latestFrame = null;
      this._latestAt = 0;
      setTimeout(() => this.startCapturePipeline(), 5000);
    });

    // Parse concatenated JPEGs from stdout
    const SOI = Buffer.from([0xFF, 0xD8]); // start of image
    const EOI = Buffer.from([0xFF, 0xD9]); // end of image

    this._capture.stdout.on('data', chunk => {
      this._frameBuf = Buffer.concat([this._frameBuf, chunk]);

      let start = this._frameBuf.indexOf(SOI);
      while (start !== -1) {
        const end = this._frameBuf.indexOf(EOI, start + 2);
        if (end === -1) break; // incomplete frame; wait for more
        const frame = this._frameBuf.slice(start, end + 2);

        // store latest for uploads
        this._latestFrame = frame;
        this._latestAt = Date.now();

        // push to stream clients
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
        this.debug('Client connected: /stream.mjpg');
        res.writeHead(200, {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Connection': 'close',
          'Content-Type': 'multipart/x-mixed-replace; boundary=--frame'
        });
        this._clients.add(res);
        req.on('close', () => {
          this._clients.delete(res);
          this.debug('Client disconnected: /stream.mjpg');
        });
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
      const lan = this.getLanIp();
      const lanStream = `http://${lan}:${this.rebroadcastPort}/stream.mjpg`;
      const lanSnap   = `http://${lan}:${this.rebroadcastPort}/snapshot.jpg`;

      // Log only LAN endpoints (as requested)
      logger(`[Rebroadcast]  LAN : ${lanStream}  |  ${lanSnap}`);

      // Write LAN URLs into config so the GUI shows the actual IP
      this.updateConfigRebroadcastUrls(lan);
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

    this.debug(`Token length: ${token ? token.length : 'undefined'}`);

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
          const age = Date.now() - this._latestAt;
          if (!this._latestFrame || age > this.maxFrameAgeMs) {
            this.debug(`[Prusa] Skipping upload, no fresh frame (age=${age}ms).`);
            return;
          }
          await axios.put(url, this._latestFrame, {
            headers: {
              'Content-Type': 'image/jpg',
              'token': token,
              'fingerprint': fingerprint
            }
          });
          // When rebroadcasting, omit the "(buffer)" suffix per preference.
          this.logUploadSuccess();
          return;
        }

        // Fallback: one-off capture (may contend with other processes)
        const tmpFile = `prusa-snap-${Date.now()}.jpg`;
        const ok = await this.captureSnapshot(tmpFile, this.videoSource);
        if (!ok) return;
        const data = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        await axios.put(url, data, {
          headers: {
            'Content-Type': 'image/jpg',
            'token': token,
            'fingerprint': fingerprint
          }
        });
        this.logUploadSuccess(`(file: ${tmpFile})`);
      } catch (err) {
        if (err && err.response) {
          this.logError(`Upload error: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
        } else {
          this.logError(`Upload error: ${err?.message || err}`);
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

  // One-off capture helper (used only when rebroadcast is disabled)
  captureSnapshot(tmpFile, videoSource, maxRetries = 3, retryDelayMs = 3000) {
    let attempt = 0;
    const tryCap = () => new Promise((resolve, reject) => {
      const cmd = `ffmpeg ${videoSource} -frames 1 ${tmpFile} -y`;
      this.debug(`Running capture: ${cmd}`);
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          if (/resource busy/i.test(stderr || '')) {
            attempt++;
            if (attempt <= maxRetries) {
              this.logWarn(`Resource busy (attempt ${attempt}/${maxRetries}); retrying in ${retryDelayMs/1000}s`);
              return setTimeout(() => tryCap().then(resolve).catch(reject), retryDelayMs);
            }
            this.logWarn(`Resource busy persists after ${maxRetries} attempts; skipping snapshot.`);
            return resolve(false);
          }
          this.logError(`FFmpeg exec error: ${error.message}`);
          if (this.debugLogging && stderr) logger(stderr);
          return reject(error);
        }
        resolve(true);
      });
    });
    return tryCap();
  }
}
