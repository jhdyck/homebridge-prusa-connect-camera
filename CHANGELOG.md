# Changelog

## 1.3.0-beta.2

- Repair MJPEG passthrough frames with FFmpeg’s mjpeg2jpeg bitstream filter, adding missing JPEG Huffman tables without re-encoding. Fixes broken browser snapshots from cameras that output abbreviated AVI1 JPEG frames.
- Log the first successful snapshot upload even when debug logging is disabled.
- Remove Docker/container and Linux-specific guidance from settings descriptions; keep platform examples in documentation.
- Add a regression test for abbreviated MJPEG input.

## 1.3.0-beta.1

- Migrate to Prusa Camera Service camera-info and snapshot endpoints with explicit User-Agent, JPEG type and Content-Length.
- Register camera information on startup; retain existing fingerprints and store new identities separately from Homebridge configuration.
- Enforce upload interval and 1 MB image limits; add request cancellation, error backoff and Retry-After handling.
- Fix MJPEG passthrough detection and multipart boundary; disconnect slow viewers and reject stale still images.
- Handle missing FFmpeg, bound capture output/log buffers, and stop capture processes and timers on shutdown.
- Update Axios; add regression tests, real FFmpeg synthetic capture tests, Linux CI and Docker/release documentation.

Published for opt-in beta testing. Live validation on a physical camera and Prusa account is required before the stable 1.3.0 release.
