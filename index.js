const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const os = require('os');
const axios = require('axios');
const { spawn } = require('child_process');

// ANSI color codes for console logs
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

module.exports = (homebridge) => {
  homebridge.registerPlatform(
    'homebridge-prusa-connect-camera',
    'PrusaConnectCamera',
    PrusaConnectCameraPlatform
  );
};

class PrusaConnectCameraPlatform {
  constructor(log, platformConfig, homebridgeApi) {
    this.log = log;
    this.config = platformConfig || {};
    this.api = homebridgeApi;

    // Defaults aligned with UI expectations
    this.cameraName = this.config.name || 'Camera';
    this.videoSource = this.config.videoSource || '-i /dev/video0';
    this.snapshotIntervalSeconds = this.#toPositiveInt(this.config.snapshotInterval, 30);

    // Prusa auth
    this.token = typeof this.config.token === 'string' ? this.config.token.trim() : '';
    this.fingerprint = typeof this.config.fingerprint === 'string' ? this.config.fingerprint.trim() : '';

    // Optional rebroadcast settings
    this.rebroadcastEnabled = this.config.rebroadcastEnabled === true;
    this.rebroadcastPort = this.#toPositiveInt(this.config.rebroadcastPort, 8088);
    this.streamFps = this.#toPositiveInt(this.config.streamFrameRate ?? this.config.streamFps, 15);

    // Stream quality UI scale (1-10) -> ffmpeg q:v scale (2-31, lower is better)
    const uiQuality = this.#toPositiveInt(this.config.streamQuality ?? this.config.mjpegQuality, 7);
    this.mjpegQscale = Math.max(2, Math.min(31, Math.round(31 - (uiQuality - 1) * (29 / 9))));

    // Freshness limit for uploading from rebroadcast buffer
    if (this.config.snapshotUploadLimitSec != null) {
      this.maxFrameAgeMs = this.#toPositiveInt(this.config.snapshotUploadLimitSec, 5) * 1000;
    } else if (this.config.maxFrameAgeMs != null) {
      this.maxFrameAgeMs = this.#toPositiveInt(this.config.maxFrameAgeMs, 5000);
    } else {
      this.maxFrameAgeMs = 5000;
    }

    this.debugLogging = this.config.debugLogging === true;

    // Internal state
    this.configPath = this.#resolveConfigPath();
    this.httpServer = null;
    this.captureProcess = null;
    this.captureRestartTimer = null;
    this.isShuttingDown = false;

    this.frameBuffer = Buffer.alloc(0);
    this.latestFrame = null;
    this.latestFrameAt = 0;
    this.streamClients = new Set();

    this.uploadClient = axios.create({
      timeout: 15000,
      headers: {
        'Content-Type': 'image/jpg',
      },
    });

    this.debug(`Init config: ${JSON.stringify({
      cameraName: this.cameraName,
      videoSource: this.videoSource,
      snapshotIntervalSeconds: this.snapshotIntervalSeconds,
      rebroadcastEnabled: this.rebroadcastEnabled,
      rebroadcastPort: this.rebroadcastPort,
      streamFps: this.streamFps,
      mjpegQscale: this.mjpegQscale,
      maxFrameAgeMs: this.maxFrameAgeMs,
      hasToken: Boolean(this.token),
      hasFingerprint: Boolean(this.fingerprint),
      configPath: this.configPath || null,
    })}`);

    if (this.api && typeof this.api.on === 'function') {
      this.api.on('shutdown', () => this.shutdown());
    }

    if (this.rebroadcastEnabled) {
      this.startCapturePipeline();
      this.startHttpServer();
    }

    this.startSnapshotLoop();
  }

  // ---------- Logging ----------
  logError(message) {
    this.log(`${COLORS.red}${message}${COLORS.reset}`);
  }

  logWarn(message) {
    this.log(`${COLORS.yellow}${message}${COLORS.reset}`);
  }

  debug(message) {
    if (this.debugLogging) {
      this.log(`[DEBUG] ${message}`);
    }
  }

  logUploadSuccess(suffixText = '') {
    const t = new Date().toLocaleTimeString();
    this.log(
      `[${t}] ${COLORS.green}Uploaded ${this.cameraName} snapshot successfully${COLORS.reset}${suffixText ? ` ${suffixText}` : ''}`
    );
  }

  // ---------- Helpers ----------
  #toPositiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
  }

  #resolveConfigPath() {
    const candidates = [
      '/var/lib/homebridge/config.json',
      path.join(os.homedir(), '.homebridge', 'config.json'),
      path.join(process.cwd(), 'config.json'),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch (_) {
        // ignore
      }
    }

    return null;
  }

  #splitCommandLine(input) {
    if (!input || typeof input !== 'string') {
      return [];
    }

    const tokens = [];
    const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s]+)/g;

    let match;
    while ((match = regex.exec(input)) !== null) {
      const token = match[1] ?? match[2] ?? match[3] ?? '';
      tokens.push(token.replace(/\\(["'])/g, '$1'));
    }

    return tokens;
  }

  #scheduleCaptureRestart(delayMs = 5000) {
    if (this.isShuttingDown || !this.rebroadcastEnabled) {
      return;
    }

    if (this.captureRestartTimer) {
      clearTimeout(this.captureRestartTimer);
    }

    this.captureRestartTimer = setTimeout(() => {
      this.captureRestartTimer = null;
      if (!this.isShuttingDown && this.rebroadcastEnabled) {
        this.startCapturePipeline();
      }
    }, delayMs);
  }

  #getLanIp() {
    const interfaces = os.networkInterfaces();

    const isPrivateIPv4 = (ip) => {
      if (/^10\./.test(ip)) return true;
      if (/^192\.168\./.test(ip)) return true;
      if (/^172\./.test(ip)) {
        const secondOctet = Number(ip.split('.')[1]);
        return secondOctet >= 16 && secondOctet <= 31;
      }
      return false;
    };

    let fallback = null;

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          if (isPrivateIPv4(iface.address)) {
            return iface.address;
          }
          if (!fallback) {
            fallback = iface.address;
          }
        }
      }
    }

    return fallback || '127.0.0.1';
  }

  // ---------- Config persistence ----------
  async updateConfig(nextProps) {
    if (!this.configPath) {
      this.debug('Skipping config.json update because config path could not be resolved.');
      return;
    }

    try {
      const raw = await fsp.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed.platforms)) {
        this.logWarn('No platforms section found in config.json; skipping config update.');
        return;
      }

      const platform = parsed.platforms.find((p) => p.platform === 'PrusaConnectCamera');
      if (!platform) {
        this.logWarn('PrusaConnectCamera platform not found in config.json; skipping config update.');
        return;
      }

      let changed = false;

      for (const [key, value] of Object.entries(nextProps)) {
        if (platform[key] !== value) {
          platform[key] = value;
          changed = true;
        }
      }

      if (changed) {
        await fsp.writeFile(this.configPath, JSON.stringify(parsed, null, 2), 'utf8');
        this.debug(`Updated config.json fields: ${Object.keys(nextProps).join(', ')}`);
      }
    } catch (error) {
      this.logWarn(`Could not update config.json automatically: ${error.message}`);
    }
  }

  async ensureFingerprint() {
    if (this.fingerprint && this.fingerprint.length >= 20) {
      return this.fingerprint;
    }

    this.fingerprint = Buffer.from(
      `homebridge-${Math.random().toString(36).slice(2)}${Date.now().toString()}`
    )
      .toString('base64')
      .slice(0, 24);

    this.logWarn(`[PrusaConnectCamera] No valid fingerprint provided. Generated: ${this.fingerprint}`);
    await this.updateConfig({ fingerprint: this.fingerprint });

    return this.fingerprint;
  }

  async updateConfigRebroadcastUrls() {
    const lanIp = this.#getLanIp();
    await this.updateConfig({
      rebroadcastStreamUrl: `http://${lanIp}:${this.rebroadcastPort}/stream.mjpg`,
      rebroadcastSnapshotUrl: `http://${lanIp}:${this.rebroadcastPort}/snapshot.jpg`,
    });
  }

  // ---------- Rebroadcast ----------
  startCapturePipeline() {
    if (!this.rebroadcastEnabled || this.isShuttingDown) {
      return;
    }

    this.stopCapturePipeline();

    const sourceArgs = this.#splitCommandLine(this.videoSource);
    const wantsNativeMJPEG =
      /\b-input_format\b\s*mjpe?g\b/i.test(this.videoSource) ||
      /\b-f\b\s*mjpe?g\b/i.test(this.videoSource);

    let args;
    if (wantsNativeMJPEG) {
      args = [
        ...sourceArgs,
        '-fflags', 'nobuffer',
        '-f', 'mjpeg',
        '-c:v', 'copy',
        '-',
      ];
      this.debug('Capture mode: MJPEG passthrough (no re-encode).');
    } else {
      args = [
        ...sourceArgs,
        '-r', String(this.streamFps),
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', String(this.mjpegQscale),
        '-',
      ];
      this.debug('Capture mode: re-encode to MJPEG.');
    }

    this.debug(`Starting capture ffmpeg with args: ${JSON.stringify(args)}`);

    this.captureProcess = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.captureProcess.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (!message) return;

      if (/error|fail|ioctl|resource busy|no such file|not found|i\/o error/i.test(message)) {
        this.logWarn(`[Capture] ffmpeg: ${message}`);
      } else {
        this.debug(`[Capture] ${message}`);
      }
    });

    this.captureProcess.on('exit', (code, signal) => {
      this.captureProcess = null;

      if (this.isShuttingDown || !this.rebroadcastEnabled) {
        return;
      }

      this.logWarn(`[Capture] ffmpeg exited (code=${code}, signal=${signal}). Retrying in 5s.`);
      this.latestFrame = null;
      this.latestFrameAt = 0;
      this.frameBuffer = Buffer.alloc(0);

      this.#scheduleCaptureRestart(5000);
    });

    const SOI = Buffer.from([0xff, 0xd8]);
    const EOI = Buffer.from([0xff, 0xd9]);
    const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

    this.captureProcess.stdout.on('data', (chunk) => {
      this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);

      if (this.frameBuffer.length > MAX_BUFFER_BYTES) {
        const lastSoi = this.frameBuffer.lastIndexOf(SOI);
        this.frameBuffer = lastSoi >= 0 ? this.frameBuffer.slice(lastSoi) : Buffer.alloc(0);
        this.debug('Capture frame buffer exceeded limit; trimmed buffer.');
      }

      let start = this.frameBuffer.indexOf(SOI);

      while (start !== -1) {
        const end = this.frameBuffer.indexOf(EOI, start + 2);
        if (end === -1) {
          break;
        }

        const frame = this.frameBuffer.slice(start, end + 2);
        this.latestFrame = frame;
        this.latestFrameAt = Date.now();

        for (const res of this.streamClients) {
          this.writeMjpegFrame(res, frame);
        }

        this.frameBuffer = this.frameBuffer.slice(end + 2);
        start = this.frameBuffer.indexOf(SOI);
      }
    });
  }

  stopCapturePipeline() {
    if (this.captureRestartTimer) {
      clearTimeout(this.captureRestartTimer);
      this.captureRestartTimer = null;
    }

    if (this.captureProcess) {
      try {
        this.captureProcess.kill('SIGTERM');
      } catch (_) {
        // ignore
      }
      this.captureProcess = null;
    }
  }

  startHttpServer() {
    if (!this.rebroadcastEnabled || this.isShuttingDown) {
      return;
    }

    if (this.httpServer) {
      return;
    }

    this.httpServer = http.createServer((req, res) => {
      if (req.url === '/stream.mjpg') {
        res.writeHead(200, {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          Connection: 'close',
          'Content-Type': 'multipart/x-mixed-replace; boundary=--frame',
        });

        this.streamClients.add(res);

        req.on('close', () => {
          this.streamClients.delete(res);
        });

        if (this.latestFrame) {
          this.writeMjpegFrame(res, this.latestFrame);
        }

        return;
      }

      if (req.url === '/snapshot.jpg') {
        if (this.latestFrame) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': this.latestFrame.length,
          });
          res.end(this.latestFrame);
        } else {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('No frame yet');
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    this.httpServer.listen(this.rebroadcastPort, '0.0.0.0', async () => {
      const lanIp = this.#getLanIp();
      const streamUrl = `http://${lanIp}:${this.rebroadcastPort}/stream.mjpg`;
      const snapshotUrl = `http://${lanIp}:${this.rebroadcastPort}/snapshot.jpg`;

      this.log(`[Rebroadcast] LAN: ${streamUrl} | ${snapshotUrl}`);
      await this.updateConfigRebroadcastUrls();
    });

    this.httpServer.on('error', (error) => {
      this.logError(`[Rebroadcast] HTTP server error: ${error.message}`);
    });
  }

  stopHttpServer() {
    if (!this.httpServer) {
      return;
    }

    for (const res of this.streamClients) {
      try {
        res.end();
      } catch (_) {
        // ignore
      }
    }
    this.streamClients.clear();

    try {
      this.httpServer.close();
    } catch (_) {
      // ignore
    }

    this.httpServer = null;
  }

  writeMjpegFrame(res, frame) {
    try {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');
    } catch (_) {
      this.streamClients.delete(res);
      try {
        res.end();
      } catch (_) {
        // ignore
      }
    }
  }

  // ---------- Snapshot upload ----------
  async uploadSnapshot(buffer) {
    const fingerprint = await this.ensureFingerprint();

    await this.uploadClient.put('https://webcam.connect.prusa3d.com/c/snapshot', buffer, {
      headers: {
        token: this.token,
        fingerprint,
      },
    });
  }

  async captureSnapshotToBuffer(maxRetries = 3, retryDelayMs = 3000, timeoutMs = 15000) {
    const sourceArgs = this.#splitCommandLine(this.videoSource);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const buffer = await new Promise((resolve, reject) => {
          const args = [
            ...sourceArgs,
            '-frames:v', '1',
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            '-',
          ];

          this.debug(`Running one-off capture with args: ${JSON.stringify(args)}`);

          const child = spawn('ffmpeg', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stdoutBuffers = [];
          let stderr = '';
          let finished = false;

          const finish = (fn, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            fn(value);
          };

          const timer = setTimeout(() => {
            try {
              child.kill('SIGTERM');
            } catch (_) {
              // ignore
            }
            finish(reject, new Error('Capture timed out'));
          }, timeoutMs);

          child.stdout.on('data', (chunk) => {
            stdoutBuffers.push(chunk);
          });

          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
          });

          child.on('error', (error) => {
            finish(reject, error);
          });

          child.on('close', (code) => {
            if (code !== 0) {
              const err = new Error(stderr.trim() || `ffmpeg exited with code ${code}`);
              err.stderr = stderr;
              finish(reject, err);
              return;
            }

            const output = Buffer.concat(stdoutBuffers);
            if (!output.length) {
              finish(reject, new Error('Capture returned no image data'));
              return;
            }

            finish(resolve, output);
          });
        });

        return buffer;
      } catch (error) {
        const stderr = error.stderr || error.message || '';
        if (/resource busy/i.test(stderr)) {
          if (attempt < maxRetries) {
            this.logWarn(`Resource busy (attempt ${attempt}/${maxRetries}); retrying in ${retryDelayMs / 1000}s`);
            await this.sleep(retryDelayMs);
            continue;
          }

          this.logWarn(`Resource busy persists after ${maxRetries} attempts; skipping snapshot.`);
          return null;
        }

        throw error;
      }
    }

    return null;
  }

  startSnapshotLoop() {
    if (!this.token || this.token.length < 20) {
      this.logError('You must configure a valid Prusa Connect token (20+ characters) in config.json.');
      return;
    }

    const loop = async () => {
      while (!this.isShuttingDown) {
        const startedAt = Date.now();

        try {
          if (this.rebroadcastEnabled) {
            const age = Date.now() - this.latestFrameAt;

            if (!this.latestFrame || age > this.maxFrameAgeMs) {
              this.debug(`Skipping upload because no fresh frame is available (age=${age}ms).`);
            } else {
              await this.uploadSnapshot(this.latestFrame);
              this.logUploadSuccess();
            }
          } else {
            const frameBuffer = await this.captureSnapshotToBuffer();
            if (frameBuffer) {
              await this.uploadSnapshot(frameBuffer);
              this.logUploadSuccess('(captured directly)');
            }
          }
        } catch (error) {
          if (error && error.response) {
            this.logError(`Upload error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
          } else {
            this.logError(`Upload error: ${error.message || error}`);
          }
        }

        const elapsed = Date.now() - startedAt;
        const delayMs = Math.max(0, this.snapshotIntervalSeconds * 1000 - elapsed);
        await this.sleep(delayMs);
      }
    };

    loop().catch((error) => {
      this.logError(`Snapshot loop crashed: ${error.message || error}`);
    });
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  shutdown() {
    this.isShuttingDown = true;
    this.stopCapturePipeline();
    this.stopHttpServer();
  }
}
