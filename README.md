# homebridge-prusa-connect-camera

[![npm version](https://img.shields.io/npm/v/homebridge-prusa-connect-camera.svg?style=flat-square)](https://www.npmjs.com/package/homebridge-prusa-connect-camera)  
[![License](https://img.shields.io/npm/l/homebridge-prusa-connect-camera.svg?style=flat-square)](LICENSE)

A Homebridge plugin to upload webcam snapshots from your Raspberry Pi (or compatible Linux device) to [Prusa Connect](https://connect.prusa3d.com/), enabling remote monitoring of your 3D printer’s build via the Prusa Connect interface.

---

## Features

- Captures images from a connected webcam or Raspberry Pi camera.
- Periodically uploads snapshots to the Prusa Connect backend.
- Automatically generates and persists a unique camera fingerprint.
- Simple single-camera setup.
- Configurable snapshot interval (10–60 seconds).
- User-configurable ffmpeg input options for video device and resolution.
- Works on Raspberry Pi and Linux devices with V4L2-compatible cameras.
- Handles device busy errors gracefully with retry logic.

---

## Installation

Install the plugin globally using npm:

```bash
sudo npm install -g homebridge-prusa-connect-camera
```

Then add the plugin to your Homebridge config.

## Configuration

Add the following platform section to your `config.json`:

```json
{
"platforms": [
{
"platform": "PrusaConnectCamera",
"name": "Prusa MK3.5S",
"token": "",
"videoSource": "-f v4l2 -video_size 1280x960 -i /dev/video0",
"snapshotInterval": 10
}
]
}
```

Field descriptions:
- platform: Must be "PrusaConnectCamera" (required)
- name: Friendly camera name used in logs (optional, defaults to "snapshot")
- token: Your Prusa Connect API token, must be 20 or more characters (required)
- videoSource: Full ffmpeg input string specifying device and options (optional, default is "-f v4l2 -video_size 1280x720 -i /dev/video0")
- snapshotInterval: Interval between snapshots in seconds, between 10 and 60 (optional, default is 10)

Note: The videoSource field lets you fully customize your ffmpeg input options, for example to change resolution or device path. Currently, the plugin supports only one camera.

---

## Usage
- After installation and configuration, start or restart Homebridge.
- The plugin will automatically generate and save a unique fingerprint in your Homebridge `config.json`.
- Snapshots will be taken and uploaded to Prusa Connect at the configured interval.
- If the video device is busy, the plugin will retry a few times before skipping that snapshot to avoid conflicts.

---

## Compatibility
- Designed for Linux systems with V4L2-compatible video devices such as Raspberry Pi, many NAS devices, and Linux desktops.
- Does not currently support Windows or macOS webcams.
- Intended for USB webcams or Raspberry Pi camera modules.

---

## Troubleshooting
- Ensure your camera device path (e.g., /dev/video0) is correct and accessible by the Homebridge user.
- Use ffmpeg with the command "ffmpeg -list_formats all -f v4l2 -i /dev/video0" to verify supported formats and resolutions.
- Check Homebridge logs for upload status and errors.
- If you encounter "Resource busy" errors, the plugin will handle them gracefully by retrying automatically.

---

## Contributing

Contributions and improvements are welcome! Please open issues or pull requests on [GitHub](https://github.com/jhdyck/homebridge-prusa-connect-camera).

License

MIT © Justin Dyck

---

## Acknowledgements

Thanks to the Homebridge and Prusa Connect communities for inspiration and support.
