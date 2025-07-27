const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Homebridge API entrypoint
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

    logger('PrusaConnectCameraPlatform initialized with config:', config);

    this.startSnapshotLoop();
  }

  updateConfigFingerprint(newFingerprint) {
    const configPath = '/var/lib/homebridge/config.json'; // Adjust if needed

    try {
      const data = fs.readFileSync(configPath, 'utf8');
      const configObj = JSON.parse(data);

      if (!configObj.platforms) {
        this.log('No platforms section found in config.json');
        return;
      }

      // Find this plugin platform config
      const platform = configObj.platforms.find(p => p.platform === 'PrusaConnectCamera');
      if (!platform) {
        this.log('PrusaConnectCamera platform not found in config.json');
        return;
      }

      // Update fingerprint field
      platform.fingerprint = newFingerprint;

      // Write back updated config
      fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2), 'utf8');
      this.log(`Updated fingerprint in config.json: ${newFingerprint}`);
    } catch (err) {
      this.log(`Error updating config.json fingerprint: ${err.message}`);
    }
  }

  startSnapshotLoop() {
    // Read config fields directly (single-camera)
    const token = config.token;
    let fingerprint = config.fingerprint;
    const videoSource = config.videoSource || '/dev/video0';
    const snapshotIntervalSeconds = config.snapshotInterval || 10;

    logger(`[PrusaConnectCamera] Token received: "${token}" (length: ${token ? token.length : 'undefined'})`);

    if (!fingerprint || fingerprint.length < 20) {
      fingerprint = Buffer.from(
        'homebridge-' + Math.random().toString(36).slice(2) + Date.now().toString()
      ).toString('base64').slice(0, 24);
      logger.warn(`[PrusaConnectCamera] No valid fingerprint provided. Generated fingerprint: ${fingerprint}`);

      this.updateConfigFingerprint(fingerprint);
    }

    if (!token || token.length < 20) {
      logger.error('You must configure a valid Prusa Connect token (20+ characters) in config.json!');
      return;
    }

    const url = 'https://webcam.connect.prusa3d.com/c/snapshot';

    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    const captureAndUpload = async () => {
      while (true) {
        await new Promise(resolve => {
          const tmpFile = 'prusa-snap.jpg';
          ffmpeg()
            .input(videoSource)
            .inputFormat('v4l2')
            .size('1280x720')
            .frames(1)
            .output(tmpFile)
            .on('end', () => {
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
                      logger(`[${new Date().toLocaleTimeString()}] ✅ Uploaded successfully`);
                    } else {
                      logger(`[${new Date().toLocaleTimeString()}] ⚠️  Unexpected response:`, res.status, res.data);
                    }
                    resolve();
                  }).catch(err => {
                    if (err.response) {
                      logger.error(`[${new Date().toLocaleTimeString()}] ❌ Upload error:`, err.response.status, '-', err.response.data);
                    } else {
                      logger.error(`[${new Date().toLocaleTimeString()}] ❌ Upload error:`, err.message);
                    }
                    resolve();
                  });
                } else {
                  logger.error('Failed to capture image from camera.');
                  resolve();
                }
              });
            })
            .on('error', (err) => {
              logger.error('FFmpeg error:', err.message);
              resolve();
            })
            .run();
        });
        await sleep(snapshotIntervalSeconds * 1000);
      }
    };

    captureAndUpload();
  }
}
