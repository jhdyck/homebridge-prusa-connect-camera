# Homebridge Prusa Connect Camera

Upload JPEG snapshots from an FFmpeg-compatible camera to Prusa Connect using the [Prusa Camera Service](https://camera-service.prusa3d.com/docs/).

Optional MJPEG rebroadcasting shares one camera capture process with other local camera consumers. This plugin uploads still images; it does not create a HomeKit camera accessory.

## Upgrade from 1.2.2

Keep your existing `token`, `fingerprint`, and `videoSource`. Version 1.3.0 uses `/v1/camera-info` and `/v1/snapshot` on `camera-service.prusa3d.com`, replacing the old webcam upload host. No legacy endpoint fallback is used.

**Do not clear or change an existing fingerprint.** Prusa binds it to the camera token. Existing fingerprints of 16–64 printable ASCII characters are accepted. If you need a replacement token, create a new camera in Prusa Connect and restart this plugin within 15 minutes.

New automatically generated identities are saved in `<Homebridge storage>/prusa-connect-camera/`. Keep this directory with your Homebridge backups. The plugin no longer edits `config.json` automatically. Rebroadcast URLs are printed in the logs; older helper fields in your configuration can be ignored.

## Requirements

- Homebridge 1.6+ or 2.x (see `package.json` for the exact engine range).
- A Node.js release supported by your Homebridge installation; use Node.js 22 or 24 for current deployments. The package retains its previous Node.js 18.20.4 minimum for compatibility.
- FFmpeg installed and available **inside the environment running Homebridge**, with access to the camera input. Set `ffmpegPath` if it is not on PATH.
- An FFmpeg-compatible source. USB device paths are Linux-specific; network cameras, macOS and other hosts require their own FFmpeg input options. Not every camera or host has been hardware-tested.
- Outbound HTTPS to `camera-service.prusa3d.com`.

## Install and configure

1. In Homebridge, open **Plugins**, search for `homebridge-prusa-connect-camera`, and install it.
2. Set your camera source and name in the plugin settings.
3. In Prusa Connect open your printer → Camera → Add new camera → other camera, then copy the token. See [Prusa’s token guide](https://camera-service.prusa3d.com/docs/guide/getting-a-token).
4. Paste the token into Homebridge. Leave the fingerprint blank **only for a new camera**.
5. Save and restart Homebridge within 15 minutes of creating the token.
6. Look for `Camera registered with Prusa Camera Service.` and confirm a new image appears in Prusa Connect. Enable debug logging temporarily for individual upload confirmations.

Example platform entry (add to the existing `platforms` array):

```json
{
  "platform": "PrusaConnectCamera",
  "name": "Printer Camera",
  "token": "YOUR_CAMERA_TOKEN_HERE",
  "fingerprint": "",
  "videoSource": "-i /dev/video0",
  "ffmpegPath": "ffmpeg",
  "snapshotInterval": 30,
  "debugLogging": false,
  "rebroadcastEnabled": false,
  "rebroadcastPort": 8088,
  "streamFrameRate": 15,
  "streamQuality": 7,
  "snapshotUploadLimitSec": 5
}
```

Replace the token placeholder with exactly 20 letters/numbers. Keep tokens private.

## Docker / NAS (including UGREEN DXP2800)

The camera and FFmpeg must be accessible **inside the Homebridge container**, not just on the NAS host. Preserve your existing working `videoSource` during migration.

- Keep the container’s Homebridge storage volume persistent (commonly mounted at `/homebridge`). Recreating a container without its storage can lose a generated identity.
- For a Linux USB webcam, map the actual camera device into the container, for example `/dev/video0:/dev/video0`, and give the Homebridge user permission to read it. Device paths and permissions vary by NAS; broad privileged mode is not required by the plugin.
- For a network camera, use its FFmpeg input URL instead of USB device mapping.
- If rebroadcast is enabled with bridge networking, publish the configured port (default TCP 8088). Other consumers must use the NAS address and published port. With host networking, use the NAS address directly.
- Back up Homebridge through its web UI before installing a development version. Keep the NAS-side storage folder as well.

## Camera input and efficiency

The Linux default is `-i /dev/video0`. A compatible USB camera may support:

```text
-f v4l2 -input_format mjpeg -video_size 960x720 -i /dev/video0
```

Rebroadcast uses MJPEG passthrough for explicit MJPEG inputs, avoiding re-encoding. Otherwise it encodes a shared stream at `streamFrameRate` (1–60) and `streamQuality` (1–10). These controls do not change passthrough input resolution or frame rate; configure those in `videoSource`.

For snapshots only, FFmpeg captures one image per upload. When other plugins need the same USB camera, enable rebroadcast here and point them at this plugin’s URLs so only one process opens the device.

Prusa accepts JPEG images up to **1,000,000 bytes**, with at most **six uploads per minute**. Intervals are clamped to 10–600 seconds and measured after capture/upload completes. Reduce input resolution if an image is too large. The plugin rejects oversized images locally rather than repeatedly sending the same invalid image.

## Local rebroadcast

Enable `rebroadcastEnabled`, restart, and read the URLs from the logs:

- `http://HOST:8088/stream.mjpg`
- `http://HOST:8088/snapshot.jpg`

Use the container/NAS address reachable by the consumer. Logged IP detection can pick a container address when bridge networking is used. These URLs are **unauthenticated**: use a trusted local network and do not expose the port to the internet. Stale snapshots return 503; slow streaming viewers are disconnected to bound memory use. `snapshotUploadLimitSec` controls freshness (default five seconds).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Old-host 404 | Confirm the installed version is 1.3.0 or later, then restart Homebridge. |
| 401 or 403 | Check token and original fingerprint. An unused token expires after 15 minutes; create a replacement camera if necessary. Upload retries stop until restart. |
| 422 | Check credentials and camera metadata; quote the request ID when reporting an issue. |
| Image exceeds 1 MB | Lower camera input resolution; lower quality for encoded rebroadcast streams. |
| FFmpeg ENOENT | Install FFmpeg inside the container or set `ffmpegPath`. |
| Device busy | Stop other direct camera consumers, enable rebroadcast, and give them its URL. |
| No frames | Check device mapping/permissions and FFmpeg input options in the container. |
| 429 / 503 / network failure | The plugin retries with increasing delay, up to five minutes, and honours longer Retry-After values up to 24 hours. |

Camera metadata currently uses `WEB` as a compatibility choice for this software uploader. Prusa documents WEB specifically as a browser webcam and does not provide an OTHER type; verify the resulting camera display during your live test. LINK is reserved for cameras registered by a printer. See [camera types](https://camera-service.prusa3d.com/docs/guide/camera-types).

## Development and publishing

See [MAINTAINING.md](MAINTAINING.md) for a beginner-friendly test, release, and rollback guide. Tests include real FFmpeg synthetic capture and rebroadcast, with mocked Prusa requests. They do not prove that a physical camera or a particular Prusa account works.

MIT © Justin Dyck
