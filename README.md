# homebridge-prusa-connect-camera

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm version](https://img.shields.io/npm/v/homebridge-prusa-connect-camera.svg?style=flat-square)](https://www.npmjs.com/package/homebridge-prusa-connect-camera)
[![npm](https://img.shields.io/npm/dt/homebridge-prusa-connect-camera.svg)](https://www.npmjs.com/package/homebridge-prusa-connect-camera)
[![License](https://img.shields.io/npm/l/homebridge-prusa-connect-camera.svg?style=flat-square)](LICENSE)

## Description

A Homebridge plugin to upload webcam snapshots from your Raspberry Pi (or compatible Linux device) to [Prusa Connect](https://connect.prusa3d.com/), enabling remote monitoring of your 3D printer’s build via the Prusa Connect interface. It now includes an optional rebroadcasting mode so this plugin can exclusively own the camera device and share the video to other plugins without device conflicts. This plugin is Homebridge Verified.

## Features

- Captures images from a connected webcam or Raspberry Pi camera.
- Periodically uploads snapshots to the Prusa Connect backend.
- Automatically generates and persists a unique camera fingerprint.
- Simple single-camera setup.
- Configurable snapshot interval (10–60 seconds).
- User-configurable FFmpeg input options for video device and resolution.
- Video rebroadcasting (experimental): exposes an MJPEG stream and snapshot for other plugins (e.g., [homebridge-camera-ffmpeg](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg)).
- Low-CPU MJPEG passthrough: recommend `-input_format mjpeg` to avoid re-encoding.
- Debug logging.
- Handles device busy errors gracefully with retry logic.

## Compatibility and Requirements

- Homebridge v1.6+; tested with Homebridge UI v5.x.
- Designed for devices such as Raspberry Pi, many NAS devices, and Linux desktops.
- Intended for USB webcams or Raspberry Pi camera modules.
- Requires FFmpeg to be installed and available to the Homebridge process.

## Installation

- Install from the Homebridge Plugins tab, or using npm:

```bash
sudo npm install -g homebridge-prusa-connect-camera
```
- Configure via the plugin config UI.
- Restart Homebridge.

## Configuration

Configuration can be done via the configuration UI in the plugin, or you can add the following platform section to your `config.json`, and replace the values as needed:

```json
{
  "platforms": [
    {
      "platform": "PrusaConnectCamera",
      "name": "InsertCameraNameHere",
      "token": "InsertCameraTokenHere",
      "fingerprint": "",

      "videoSource": "-f v4l2 -input_format mjpeg -video_size 960x720 -i /dev/video0",
      "snapshotInterval": 30,
      "debugLogging": false,

      "rebroadcastEnabled": false,
      "rebroadcastPort": "8088",
      "streamFrameRate": "15",
      "streamQuality": "7",
      "snapshotUploadLimitSec": "5",

      "rebroadcastStreamUrl": "http://LAN_IP:8088/stream.mjpg",
      "rebroadcastSnapshotUrl": "http://LAN_IP:8088/snapshot.jpg"
    }
  ]
}
```

Field descriptions:

- `platform`: Must be "PrusaConnectCamera"
- `name`: Friendly camera name used in logs
- `token`: Your Prusa Connect API token, must be 20 or more characters
- `fingerprint`: A requirement from Prusa for validating incoming images. Leave blank to auto-generate; the plugin writes it back into config.json.
- `videoSource`: Full FFmpeg input string specifying device and options (e.g., -f v4l2 -input_format mjpeg -video_size 960x720 -i /dev/video0). Use -input_format mjpeg when supported to avoid re-encoding and lower CPU.
- `snapshotInterval`: How often to upload snapshots to Prusa Connect, e.g., 30
- `debugLogging`: Set to `true` to print detailed debug lines; leave `false` for normal operation.
- `rebroadcastEnabled`: Enable to let this plugin exclusively own the camera and expose an MJPEG stream and a snapshot URL for other plugins to use, preventing errors caused by multiple plugins trying to access the device simultaneously. This is recommended if you also run `homebridge-camera-ffmpeg` or any other process that would open the webcam directly.
- `rebroadcastPort`: Port for the internal HTTP MJPEG server (default `8088`).
- `streamFrameRate`: Target FPS for the rebroadcast stream. Ignored in MJPEG passthrough mode.
- `streamQuality`: 1–10, higher means better quality (and higher bandwidth). Ignored in MJPEG passthrough mode.
- `snapshotUploadLimitSec`: Skip a Prusa upload if the latest captured frame is older than this many seconds (prevents stale uploads after reconnects).
- `rebroadcastStreamUrl` and `rebroadcastSnapshotUrl`: Read-only helper fields; on startup the plugin detects your LAN IP and writes the actual URLs here so you can copy them into other plugins.

Note: The videoSource field lets you fully customize your FFmpeg input options, for example to change resolution or device path. Currently, the plugin supports only one camera.

## Video Rebroadcasting (Experimental Feature)

What it is:
When enabled, the plugin becomes the single owner of the camera device and runs a lightweight HTTP server, preventing "resource busy" and I/O errors caused by multiple processes trying to open the resource at the same time. This feature provides a multipart MJPEG live stream and a still image snapshot URL for other plugins and processes to use.

How to enable:
- Set rebroadcastEnabled to true.
- Optionally adjust rebroadcastPort, streamFrameRate, streamQuality, snapshotUploadLimitSec.
- Use the Stream URL and Snapshot URL shown in the Homebridge UI in other consumers like homebridge-camera-ffmpeg.

Low-CPU performance tips (recommended):
- Use native MJPEG from the webcam when possible to avoid re-encoding (e.g. `-input_format mjpeg`)
- With MJPEG passthrough enabled, the plugin copies frames instead of re-encoding JPEGs, significantly reducing CPU usage.
- Reduce `streamFrameRate` (for example, 10) if you don’t need 15 fps.
- Use a smaller video resolution if acceptable (for example, 640x480).

## Usage

- After installation, configure the plugin with your camera name, video source, and the token from Prusa Connect, then restart Homebridge.
- To obtain the token from Prusa Connect, navigate to the camera tab in the desired printer, and click `Add new other camera`. A token will appear that you can copy.
- The plugin will automatically generate and save a unique fingerprint in your Homebridge `config.json` after saving and restarting.
- Snapshots will be taken and uploaded to Prusa Connect at the configured interval.
- If the video device is busy, the plugin will retry a few times before skipping that snapshot to avoid conflicts.

## Troubleshooting

- Check Homebridge logs for upload status and errors.
- Ensure your camera device path (e.g., -i /dev/video0) is correct and accessible by the Homebridge user, and check that FFmpeg can read the device with your videoSource arguments.
- Confirm you have the correct token from Prusa.
- If you encounter "Resource busy" errors, the plugin will handle them by retrying 3 times automatically before skipping the current snapshot.
- If the device is frequently busy or the camera is not responding, try enabling rebroadcasting and point other plugins to the new stream and snapshot URLs so this plugin is the only one accessing the device.
- To reduce CPU usage, ensure `-input_format mjpeg` is present (if supported), lower `streamFrameRate`, and/or reduce the video resolution.

## Contributing

Contributions and improvements are welcome! Please open issues or pull requests on [GitHub](https://github.com/jhdyck/homebridge-prusa-connect-camera). I'm very new to the world of coding, so please be patient as I work to improve this plugin!

License

MIT © Justin Dyck

## Acknowledgements

Thanks to the Homebridge and Prusa Connect communities for inspiration and support.
