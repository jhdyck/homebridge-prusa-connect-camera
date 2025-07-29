const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');

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
    config = platformConfig;
    api = homebridgeApi;

    this.cameraName = config.name || 'snapshot';
    this.configPath = '/var/lib/homebridge/config.json'; // Could be configurable or autodetected

    logger(`PrusaConnectCameraPlatform initialized with config: ${JSON.stringify(config)}`);

    this.startSnapshotLoop();
  }

  logSuccess(message) {
    logger(`${COLORS.green}${message}${COLORS.reset}`);
  }

  logError(message) {
    logger(`${COLORS.red}${message}${COLORS.reset}`);
  }

  logWarning(message) {
    logger(`${COLORS.yellow}${message}${COLORS.reset}`);
  }

  updateConfigFingerprint(newFingerprint) {
    try {
      const data = fs.readFileSync(this.configPath, 'utf8');
      const configObj = JSON.parse(data);

      if (!configObj.platforms) {
        this.logError('No platforms section found in config.json');
        return;
      }

      const platform = configObj.platforms.find(p => p.platform === 'PrusaConnectCamera');
      if (!platform) {
        this.logError('PrusaConnectCamera platform not found in config.json');
        return;
      }

      platform.fingerprint = newFingerprint;
      fs.writeFileSync(this.configPath, JSON.stringify(configObj, null, 2), 'utf8');
      this.logSuccess(`Updated fingerprint in config.json: ${newFingerprint}`);
    } catch (err) {
      this.logError(`Error updating config.json fingerprint: ${err.message}`);
    }
  }

  captureSnapshot(tmpFile, videoSource, maxRetries = 3, retryDelayMs = 3000) {
    let attempt = 0;

    const tryCapture = () => {
      return new Promise((resolve, reject) => {
        const cmd = `ffmpeg ${videoSource} -frames 1 ${tmpFile} -y`;
        // Removed the ffmpeg command log line here for cleaner logs
        exec(cmd, (error, stdout, stderr) => {
          if (error) {
            // Check for resource busy error (case insensitive)
            if (/resource busy/i.test(stderr)) {
              attempt++;
              if (attempt <= maxRetries) {
                this.logWarning(`Resource busy detected (attempt ${attempt}/${maxRetries}), retrying in ${retryDelayMs / 1000}s...`);
                setTimeout(() => {
                  tryCapture().then(resolve).catch(reject);
                }, retryDelayMs);
              } else {
                this.logWarning(`Resource busy persists after ${maxRetries} attempts, skipping snapshot.`);
                resolve(false); // resolve false to indicate skipped
              }
            } else {
              this.logError(`FFmpeg exec error: ${error.message}`);
              logger(`FFmpeg stderr: ${stderr}`);
              reject(error);
            }
          } else {
            resolve(true); // success
          }
        });
      });
    };

    return tryCapture();
  }

  startSnapshotLoop() {
    const token = config.token;
    let fingerprint = config.fingerprint;
    const videoSource = config.videoSource || '-f v4l2 -video_size 1280x720 -i /dev/video0';
    const snapshotIntervalSeconds = config.snapshotInterval || 10;

    logger(`[PrusaConnectCamera] Token received: "${token}" (length: ${token ? token.length : 'undefined'})`);

    if (!fingerprint || fingerprint.length < 20) {
      fingerprint = Buffer.from(
        'homebridge-' + Math.random().toString(36).slice(2) + Date.now().toString()
      ).toString('base64').slice(0, 24);
      this.logWarning(`[PrusaConnectCamera] No valid fingerprint provided. Generated fingerprint: ${fingerprint}`);

      this.updateConfigFingerprint(fingerprint);
    }

    if (!token || token.length < 20) {
      this.logError('You must configure a valid Prusa Connect token (20+ characters) in config.json!');
      return;
    }

    const url = 'https://webcam.connect.prusa3d.com/c/snapshot';

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    const captureAndUpload = async () => {
      while (true) {
        await new Promise(async (resolve) => {
          const tmpFile = `prusa-snap-${Date.now()}.jpg`;

          try {
            const captured = await this.captureSnapshot(tmpFile, videoSource);
            if (!captured) {
              // Resource busy: skipped snapshot, just resolve and wait next interval
              return resolve();
            }

            fs.readFile(tmpFile, (err, data) => {
              if (!err && data) {
                fs.unlinkSync(tmpFile);

                axios.put(
                  url,
                  data,
                  {
                    headers: {
                      'Content-Type': 'image/jpg',
                      'token': token,
                      'fingerprint': fingerprint
                    }
                  }
                ).then(res => {
                  if (res.status === 204 || (res.status === 200 && res.data && res.data.status_code === 204)) {
                    const reset = COLORS.reset;
                    const green = COLORS.green;
                    const white = COLORS.white;
                    const timeStr = new Date().toLocaleTimeString();
                    this.logSuccess(
                      `${white}[${timeStr}]${reset} ${green}Uploaded ${this.cameraName} snapshot successfully${reset} ${white}(file: ${tmpFile})${reset}`
                    );
                  } else {
                    this.logWarning(`[${new Date().toLocaleTimeString()}] Unexpected response: ${res.status}`);
                  }
                  resolve();
                }).catch(err => {
                  if (err.response) {
                    this.logError(`[${new Date().toLocaleTimeString()}] Upload error: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
                  } else {
                    this.logError(`[${new Date().toLocaleTimeString()}] Upload error: ${err.message}`);
                  }
                  resolve();
                });
              } else {
                this.logError('Failed to read captured image file.');
                resolve();
              }
            });
          } catch (ffmpegError) {
            this.logError(`FFmpeg capture failed: ${ffmpegError.message}`);
            resolve();
          }
        });

        await sleep(snapshotIntervalSeconds * 1000);
      }
    };

    captureAndUpload();
  }
}
