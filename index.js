const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const os = require('os');
const axios = require('axios');
const { randomBytes, createHash } = require('crypto');
const { version } = require('./package.json');
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
    this.cameraName = typeof this.config.name === 'string' && this.config.name.trim() ? this.config.name.trim() : 'Camera';
    this.videoSource = this.config.videoSource || '-i /dev/video0';
    this.snapshotIntervalSeconds = Math.max(10, Math.min(600, this.#toPositiveInt(this.config.snapshotInterval, 30)));

    // Prusa auth
    this.token = typeof this.config.token === 'string' ? this.config.token.trim() : '';
    this.fingerprint = typeof this.config.fingerprint === 'string' ? this.config.fingerprint.trim() : '';

    // Optional rebroadcast settings
    this.rebroadcastEnabled = this.config.rebroadcastEnabled === true;
    this.rebroadcastPort = Math.min(65535, this.#toPositiveInt(this.config.rebroadcastPort, 8088));
    this.streamFps = Math.min(60, this.#toPositiveInt(this.config.streamFrameRate ?? this.config.streamFps, 15));

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
    this.abortController = new AbortController();
    this.snapshotProcesses = new Set();
    this.pendingSleeps = new Map();
    this.ffmpegPath = this.config.ffmpegPath || 'ffmpeg';
    this.cameraInfoSent = false;
    this.hasUploadedSnapshot = false;
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
      maxRedirects: 0,
      maxBodyLength: 1000000,
      maxContentLength: 65536,
      signal: this.abortController.signal,
      headers: {
        'Content-Type': 'image/jpeg',
        'User-Agent': `homebridge-prusa-connect-camera/${version}`,
      },
    });

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
    this.log(`${COLORS.red}${this.redact(message)}${COLORS.reset}`);
  }

  logWarn(message) {
    this.log(`${COLORS.yellow}${this.redact(message)}${COLORS.reset}`);
  }

  debug(message) {
    if (this.debugLogging) {
      this.log(`[DEBUG] ${this.redact(message)}`);
    }
  }

  logUploadSuccess(suffixText = '') {
    if (!this.debugLogging && this.hasUploadedSnapshot) return;
    this.hasUploadedSnapshot = true;
    const t = new Date().toLocaleTimeString();
    this.log(
      `[${t}] ${COLORS.green}Uploaded ${this.cameraName} snapshot successfully${COLORS.reset}${suffixText ? ` ${suffixText}` : ''}`
    );
  }

  // ---------- Helpers ----------
  #toPositiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n)) : fallback;
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

  // Store identity separately; never rewrite Homebridge's configuration file.
  async ensureFingerprint() {
    if (this.fingerprint) {
      if (!/^[\x21-\x7e]{16,64}$/.test(this.fingerprint)) {
        throw new Error('Fingerprint must contain 16–64 printable non-space ASCII characters. Keep the original fingerprint for an existing camera.');
      }
      return this.fingerprint;
    }
    const storage = this.api?.user?.storagePath?.();
    if (!storage) throw new Error('Homebridge storage unavailable; configure a persistent fingerprint manually.');
    const directory = path.join(storage, 'prusa-connect-camera');
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(this.token).digest('hex');
    const file = path.join(directory, `${key}.json`);
    try {
      const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!/^[a-f0-9]{32}$/.test(saved.fingerprint)) throw new Error('Invalid saved camera identity');
      this.fingerprint = saved.fingerprint;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const fingerprint = randomBytes(16).toString('hex');
      // Publish the complete file atomically, without replacing an existing identity.
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await fsp.writeFile(temporary, JSON.stringify({ fingerprint }), { mode: 0o600, flag: 'wx' });
        try { await fsp.link(temporary, file); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      } finally { await fsp.unlink(temporary).catch(() => {}); }
      const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!/^[a-f0-9]{32}$/.test(saved.fingerprint)) throw new Error('Invalid saved camera identity');
      this.fingerprint = saved.fingerprint;
    }
    return this.fingerprint;
  }

  redact(value) {
    let text = String(value);
    for (const secret of [this.token, this.fingerprint]) {
      if (secret) text = text.split(secret).join('[redacted]');
    }
    return text.replace(/(\w+:\/\/)[^\s/@]+@/g, '$1[redacted]@').replace(/([?&](?:token|password|key)=)[^&\s]+/gi, '$1[redacted]');
  }

  // ---------- Rebroadcast ----------
  startCapturePipeline() {
    if (!this.rebroadcastEnabled || this.isShuttingDown) {
      return;
    }

    this.stopCapturePipeline();

    const sourceArgs = this.#splitCommandLine(this.videoSource);
    const wantsNativeMJPEG =
      /(?:^|\s)-input_format\s+mjpe?g\b/i.test(this.videoSource) ||
      /(?:^|\s)-f\s+mjpe?g\b/i.test(this.videoSource);

    let args;
    if (wantsNativeMJPEG) {
      args = [
        ...sourceArgs,
        '-fflags', 'nobuffer',
        '-f', 'mjpeg',
        '-c:v', 'copy',
        // USB/AVI MJPEG can omit Huffman tables needed by browser JPEG decoders.
        '-bsf:v', 'mjpeg2jpeg',
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

    this.debug('Starting continuous FFmpeg capture.');

    const capture = this.captureProcess = spawn(this.ffmpegPath, ['-hide_banner', '-loglevel', 'warning', '-nostdin', ...args], {
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

    capture.on('error', (error) => {
      this.logError(`FFmpeg could not start: ${error.code || 'unknown error'}. Check ffmpegPath and installation.`);
    });

    capture.on('close', (code, signal) => {
      if (this.captureProcess !== capture) return;
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
        this.frameBuffer = lastSoi >= 0 && this.frameBuffer.length - lastSoi <= MAX_BUFFER_BYTES ? this.frameBuffer.subarray(lastSoi) : Buffer.alloc(0);
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
      const child = this.captureProcess;
      this.captureProcess = null;
      this.terminateProcess(child);
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
          'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        });

        res.on('error', () => { this.streamClients.delete(res); res.destroy(); });
        this.streamClients.add(res);

        res.on('close', () => {
          this.streamClients.delete(res);
        });

        if (this.latestFrame && Date.now() - this.latestFrameAt <= this.maxFrameAgeMs) {
          this.writeMjpegFrame(res, this.latestFrame);
        }

        return;
      }

      if (req.url === '/snapshot.jpg') {
        if (this.latestFrame && Date.now() - this.latestFrameAt <= this.maxFrameAgeMs) {
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
    if (res.destroyed || res.writableEnded) { this.streamClients.delete(res); return; }
    // Disconnect slow viewers before their output queue can grow indefinitely.
    if (res.writableLength > 2 * 1024 * 1024) {
      this.streamClients.delete(res);
      res.destroy();
      return;
    }
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
  async registerCamera() {
    const fingerprint = await this.ensureFingerprint();
    await this.uploadClient.put('https://camera-service.prusa3d.com/v1/camera-info', {
      config: { name: this.cameraName.slice(0, 32) },
      features: ['snapshot'],
      device: {
        type: 'WEB',
        manufacturer: 'Homebridge',
        model: 'Prusa Connect Camera',
        firmware_version: version,
        hardware_version: `${os.platform()}-${os.arch()}`.slice(0, 32),
      },
    }, { headers: { Token: this.token, Fingerprint: fingerprint, 'Content-Type': 'application/json' } });
    this.cameraInfoSent = true;
    this.log('Camera registered with Prusa Camera Service.');
  }

  async uploadSnapshot(buffer) {
    if (this.isShuttingDown) return;
    if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) {
      throw new Error('Capture is not a complete JPEG image.');
    }
    if (buffer.length > 1000000) throw new Error('Snapshot exceeds Prusa’s 1 MB limit. Reduce camera resolution or stream quality.');
    if (!this.cameraInfoSent) await this.registerCamera();
    await this.uploadClient.put('https://camera-service.prusa3d.com/v1/snapshot', buffer, {
      headers: { Token: this.token, Fingerprint: this.fingerprint, 'Content-Length': String(buffer.length) },
    });
  }

  terminateProcess(child) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }

  async captureSnapshotToBuffer(maxRetries = 3, retryDelayMs = 3000, timeoutMs = 15000) {
    const sourceArgs = this.#splitCommandLine(this.videoSource);

    for (let attempt = 1; attempt <= maxRetries && !this.isShuttingDown; attempt++) {
      try {
        const buffer = await new Promise((resolve, reject) => {
          const args = [
            ...sourceArgs,
            '-frames:v', '1',
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            '-',
          ];

          this.debug('Capturing a snapshot with FFmpeg.');

          const child = spawn(this.ffmpegPath, ['-hide_banner', '-loglevel', 'warning', '-nostdin', ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          this.snapshotProcesses.add(child);
          child.once('close', () => this.snapshotProcesses.delete(child));
          let outputBytes = 0;
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
              this.terminateProcess(child);
            } catch (_) {
              // ignore
            }
            finish(reject, new Error('Capture timed out'));
          }, timeoutMs);

          child.stdout.on('data', (chunk) => {
            if (finished) return;
            outputBytes += chunk.length;
            if (outputBytes > 1000000) {
              this.terminateProcess(child);
              finish(reject, new Error('Snapshot exceeds Prusa’s 1 MB limit. Reduce camera resolution.'));
              return;
            }
            stdoutBuffers.push(chunk);
          });

          child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk.toString()).slice(-8192);
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
    if (!/^[A-Za-z0-9]{20}$/.test(this.token)) {
      this.logError('Configure a Prusa camera token: exactly 20 letters and numbers.');
      return;
    }

    const loop = async () => {
      let failures = 0;
      while (!this.isShuttingDown) {

        let retryAfterMs = 0;
        try {
          if (!this.cameraInfoSent) await this.registerCamera();
          if (this.isShuttingDown) break;
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
          failures = 0;
        } catch (error) {
          if (this.isShuttingDown) break;
          failures++;
          const status = error.response?.status;
          if ([401, 403].includes(status)) {
            this.logError(`Prusa rejected camera credentials (${status}). Keep your existing fingerprint. If the token is invalid or its 15-minute registration window expired, create a new camera token, save it, and restart Homebridge.`);
            return;
          }
          retryAfterMs = Math.min(300000, 10000 * 2 ** Math.min(failures - 1, 5));
          const retryHeader = error.response?.headers?.['retry-after'];
          if (retryHeader) {
            const seconds = Number(retryHeader);
            const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryHeader) - Date.now();
            if (Number.isFinite(delay)) retryAfterMs = Math.max(retryAfterMs, Math.min(86400000, delay));
          }
          if (error && error.response) {
            this.logError(`Prusa request failed (${error.response.status}). Request ID: ${String(error.response.data?.requestId || 'unavailable').slice(0, 128)}. Check credentials/configuration for 4xx errors; retrying with backoff.`);
          } else {
            this.logError(`Upload error: ${error.message || error}`);
          }
        }

        const delayMs = Math.max(retryAfterMs, this.snapshotIntervalSeconds * 1000);
        await this.sleep(delayMs);
      }
    };

    this.snapshotLoop = loop().catch((error) => {
      this.logError(`Snapshot loop crashed: ${error.message || error}`);
    });
  }

  sleep(ms) {
    if (this.isShuttingDown) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pendingSleeps.delete(timer); resolve(); }, ms);
      this.pendingSleeps.set(timer, resolve);
    });
  }

  shutdown() {
    this.isShuttingDown = true;
    this.abortController.abort();
    for (const [timer, resolve] of this.pendingSleeps) { clearTimeout(timer); resolve(); }
    this.pendingSleeps.clear();
    for (const child of this.snapshotProcesses) this.terminateProcess(child);
    this.stopCapturePipeline();
    this.stopHttpServer();
  }
}
