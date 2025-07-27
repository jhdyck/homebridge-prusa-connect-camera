# homebridge-prusa-connect-camera

[![npm version](https://img.shields.io/npm/v/homebridge-prusa-connect-camera.svg?style=flat-square)](https://www.npmjs.com/package/homebridge-prusa-connect-camera)
[![License](https://img.shields.io/npm/l/homebridge-prusa-connect-camera.svg?style=flat-square)](LICENSE)

A Homebridge plugin to upload webcam snapshots from your Raspberry Pi (or compatible device) to [Prusa Connect](https://connect.prusa3d.com/), enabling remote monitoring of your 3D printer’s build via the Prusa Connect interface.

---

## Features

- Captures images from a connected webcam or Raspberry Pi camera.
- Periodically uploads snapshots to Prusa Connect backend.
- Automatically generates and persists a unique camera fingerprint.
- Simple single-camera configuration.
- Configurable snapshot interval (10-60 seconds).
- Works on Raspberry Pi and Linux devices with V4L2-compatible cameras.

---

## Installation

Install the plugin globally using npm:

```bash
sudo npm install -g homebridge-prusa-connect-camera
