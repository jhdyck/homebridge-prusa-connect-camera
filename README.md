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
- Handles device busy errors gracefully with retry logic.

---

## Installation

Install the plugin globally using npm:

```bash
sudo npm install -g homebridge-prusa-connect-camera
```

## Configuration

Configuration can be done via the configuration UI in the plugin, or you can add the following platform section to your `config.json`, and replace the values as needed:

## Configuration

Configuration can be done via the configuration UI in the plugin, or you can add the following platform section to your `config.json`, and replace the values as needed:

```json
{
  "platforms": [
    {
      "platform": "PrusaConnectCamera",
      "name": "InsertCameraNameHere",
      "token": "InsertCameraTokenHere",
      "videoSource": "InsertVideoSourceHere",
      "snapshotInterval": 30
    }
  ]
}
```

Field descriptions:
- `platform`: Must be "PrusaConnectCamera"
- `name`: Friendly camera name used in logs
- `token`: Your Prusa Connect API token, must be 20 or more characters
- `videoSource`: Full ffmpeg input string specifying device and options (eg. -i /dev/video0)
- `snapshotInterval`: Interval between snapshots in seconds, between 10 and 60

Note: The videoSource field lets you fully customize your ffmpeg input options, for example to change resolution or device path. Currently, the plugin supports only one camera.

---

## Usage
- After installation, configure the plugin with your camera name, video source, and the token from Prusa Connect, then restart Homebridge.
- To obtain the token from Prusa Connect, navigate to the camera tab in the desired printer, and click `Add new other camera`. A token will appear that you can copy.
- The plugin will automatically generate and save a unique fingerprint in your Homebridge `config.json` after saving and restarting.
- Snapshots will be taken and uploaded to Prusa Connect at the configured interval.
- If the video device is busy, the plugin will retry a few times before skipping that snapshot to avoid conflicts.

---

## Compatibility
- Designed for devices such as Raspberry Pi, many NAS devices, and Linux desktops.
- This has not been tested on macOS or Windows systems.
- Intended for USB webcams or Raspberry Pi camera modules.

---

## Troubleshooting
- Ensure your camera device path (e.g., -i /dev/video0) is correct and accessible by the Homebridge user.
- If you're already using `homebridge-camera-ffmpeg`, try using the same video source value that you're using there.
- Check Homebridge logs for upload status and errors.
- If you encounter "Resource busy" errors, the plugin will handle them by retrying 3 times automatically before skipping the current snapshot.

---

## Contributing

Contributions and improvements are welcome! Please open issues or pull requests on [GitHub](https://github.com/jhdyck/homebridge-prusa-connect-camera). I'm very new to the world of coding, so please be patient as I work to improve this plugin!

License

MIT © Justin Dyck

---

## Acknowledgements

Thanks to the Homebridge and Prusa Connect communities for inspiration and support.
