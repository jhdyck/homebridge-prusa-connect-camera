# homebridge-prusa-connect-camera

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm version](https://img.shields.io/npm/v/homebridge-prusa-connect-camera.svg?style=flat-square)](https://www.npmjs.com/package/homebridge-prusa-connect-camera)
[![npm](https://img.shields.io/npm/dt/homebridge-prusa-connect-camera.svg)](https://www.npmjs.com/package/homebridge-prusa-connect-camera)
[![License](https://img.shields.io/npm/l/homebridge-prusa-connect-camera.svg?style=flat-square)](LICENSE)

## Description

A Homebridge plugin that uploads webcam snapshots from your Raspberry Pi or other Linux device to [Prusa Connect](https://connect.prusa3d.com/), making it easy to monitor your 3D printer remotely. It also includes an optional rebroadcasting mode so this plugin can own the camera device and expose a stream for other plugins, avoiding common device conflict issues.

## Features

- Uploads snapshots to Prusa Connect on a configurable interval
- Automatically generates and persists a camera fingerprint if one is not provided
- Simple single-camera setup
- Configurable FFmpeg input arguments
- Optional rebroadcast mode for sharing one camera with other plugins
- Optional low-CPU MJPEG passthrough mode for supported webcams
- Debug logging for troubleshooting
- Graceful retry handling when the camera device is busy
- Homebridge Verified

## Compatibility and Requirements

- Homebridge v1.6 or newer
- Node.js 18 or newer
- Linux-based systems such as Raspberry Pi, NAS devices, and other Linux hosts
- FFmpeg must be installed and available to the Homebridge process
- Intended for USB webcams or Raspberry Pi camera modules

## Installation

Install from the Homebridge Plugins tab, or with npm:

```bash
sudo npm install -g homebridge-prusa-connect-camera
```

Then configure the plugin in the Homebridge UI and restart Homebridge.

## Configuration

You can configure the plugin in the Homebridge UI, or add the following platform block to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "PrusaConnectCamera",
      "name": "Camera",
      "token": "YOUR_20_CHARACTER_PRUSA_CONNECT_TOKEN",
      "fingerprint": "",
      "videoSource": "-i /dev/video0",
      "snapshotInterval": 30,
      "debugLogging": false,
      "rebroadcastEnabled": false,
      "rebroadcastPort": 8088,
      "streamFrameRate": 15,
      "streamQuality": 7,
      "snapshotUploadLimitSec": 5,
      "rebroadcastStreamUrl": "http://LAN_IP:8088/stream.mjpg",
      "rebroadcastSnapshotUrl": "http://LAN_IP:8088/snapshot.jpg"
    }
  ]
}
```

### Field descriptions

- `platform`: Must be `"PrusaConnectCamera"`
- `name`: Friendly camera name used in logs
- `token`: Your Prusa Connect camera token
- `fingerprint`: Leave blank to auto-generate and save on first run
- `videoSource`: Full FFmpeg input arguments for your camera. Default: `-i /dev/video0`
- `snapshotInterval`: How often snapshots are uploaded to Prusa Connect, in seconds
- `debugLogging`: Enables detailed debug logs
- `rebroadcastEnabled`: Lets this plugin own the camera and expose a rebroadcast stream and still image for other plugins
- `rebroadcastPort`: Port used by the rebroadcast HTTP server
- `streamFrameRate`: Rebroadcast frame rate in FPS. Ignored in MJPEG passthrough mode
- `streamQuality`: Rebroadcast image quality from 1 to 10. Ignored in MJPEG passthrough mode
- `snapshotUploadLimitSec`: When rebroadcasting, only upload to Prusa if the latest buffered frame is newer than this many seconds
- `rebroadcastStreamUrl`: Read-only helper field populated automatically at startup
- `rebroadcastSnapshotUrl`: Read-only helper field populated automatically at startup

## Video Source Tips

The default `videoSource` is:

```bash
-i /dev/video0
```

Many webcams support lower-CPU MJPEG input, which can improve efficiency. For example:

```bash
-f v4l2 -input_format mjpeg -video_size 960x720 -i /dev/video0
```

If your webcam supports MJPEG, using that form is usually recommended.

## Rebroadcast Mode

When rebroadcasting is enabled, this plugin becomes the only process talking directly to the camera. It then exposes:

- an MJPEG stream URL
- a still snapshot URL

This is especially useful if you also use plugins such as `homebridge-camera-ffmpeg`, because it avoids camera access conflicts such as `resource busy` and similar device errors.

### Suggested use case

- Enable rebroadcasting in this plugin
- Copy the generated rebroadcast stream or snapshot URL from the Homebridge UI
- Use that URL in other camera consumers instead of pointing them directly at `/dev/video0`

## Usage

- Install the plugin
- Add your camera token from Prusa Connect
- Set your desired `videoSource`
- Restart Homebridge
- The plugin will begin uploading snapshots automatically
- If needed, it will generate and persist a fingerprint on first run

To obtain a token from Prusa Connect, open the camera section for your printer and choose the option to add a new external or other camera.

## Troubleshooting

- Check the Homebridge logs for upload and FFmpeg errors
- Confirm that FFmpeg can access your camera device with your chosen `videoSource`
- Make sure your Prusa Connect token is correct
- If the camera is frequently busy, enable rebroadcast mode so this plugin is the only process using the device directly
- If CPU usage is higher than expected, try an MJPEG-based `videoSource`, reduce rebroadcast frame rate, or lower resolution

## Contributing

Contributions and improvements are welcome. Please open issues or pull requests on [GitHub](https://github.com/jhdyck/homebridge-prusa-connect-camera).

## License

MIT © Justin Dyck

## Acknowledgements

Thanks to the Homebridge and Prusa Connect communities for inspiration and support.
