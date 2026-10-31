# Maintaining and releasing this plugin

GitHub stores source code and review history. npm distributes the package Homebridge downloads. Updating GitHub alone does not update npm installations.

## Release process: beta first

1. Commit reviewed changes to a GitHub branch and open a pull request.
2. Set the version to an unused prerelease such as `1.3.0-beta.1` in both package.json and package-lock.json. Keep `publishConfig.tag` set to `beta` during beta development.
3. Run `npm ci`, `npm run check`, `npm test`, and `npm pack --dry-run`. FFmpeg must be available for the integration tests. Check that GitHub CI passes.
4. Sign in privately with `npm login`, and check the account with `npm whoami`.
5. Publish from the reviewed branch:

   ```sh
   npm publish --tag beta --access public
   npm view homebridge-prusa-connect-camera dist-tags --json
   ```

   Confirm `beta` points to `1.3.0-beta.1` and `latest` still points to the existing stable release. Never publish a beta with the latest tag.
6. Tag the exact published GitHub commit `v1.3.0-beta.1` and create a GitHub prerelease with the same name. Further beta fixes must use a new version (`beta.2`, etc.); npm versions cannot be reused.

npm may require browser or two-factor authentication during publishing. Complete prompts privately, never share passwords or authentication codes in chat.

## Install the published beta through Homebridge

The maintainer installs it personally; there is no direct installation by Codex onto their hardware.

1. Download a Homebridge backup from its web UI. Keep the existing token, fingerprint and videoSource.
2. Open Plugins and this plugin’s version menu. Depending on the UI version it may be labelled **Install Previous Version** or **Install Alternate Version**. Select `1.3.0-beta.1` and install it.
3. If the UI has no suitable picker, run the following in the Homebridge UI terminal (inside the container for Docker installs), then restart Homebridge:

   ```sh
   npm install -g homebridge-prusa-connect-camera@beta
   ```

4. Confirm `Camera registered with Prusa Camera Service.` in the logs and a fresh image in Prusa Connect. Enable debug logging temporarily to confirm several upload cycles, then disable it.
5. Restart Homebridge and confirm uploads still work. Test the stream and still image URLs if rebroadcast is enabled.
6. If registration returns 403, keep the original fingerprint. If necessary create a replacement camera token and restart within 15 minutes.

Record Homebridge/Node/FFmpeg versions, host architecture, camera source and results in the pull request. Never post camera credentials. On Docker/NAS, FFmpeg and the camera must be accessible inside the container, and Homebridge storage must be persistent.

## Promote the working beta to stable

After the maintainer confirms the beta works:

1. Set the version to `1.3.0` (a new npm package version) in package.json and package-lock.json. Change `publishConfig.tag` to `latest`. Update the changelog and README to describe the stable release.
2. Run the checks again, merge the reviewed pull request, and publish that exact source with `npm publish --tag latest --access public`.
3. Verify `npm view homebridge-prusa-connect-camera dist-tags --json` reports `latest: 1.3.0`.
4. Tag the published commit `v1.3.0` and create a normal GitHub release. Regular Homebridge plugin updates will then receive it.

Simply moving the latest tag to `1.3.0-beta.1` does not turn its version into stable 1.3.0. Publish a proper stable version instead.

## Future maintenance

Clone the repository if needed:

```sh
git clone https://github.com/jhdyck/homebridge-prusa-connect-camera.git
cd homebridge-prusa-connect-camera
```

For an existing checkout, use `git switch main` and `git pull --ff-only` before starting a new branch. Make changes, update the version, run checks, open a pull request, publish a beta, test it, then publish stable. GitHub CI checks Node 22 and 24 on Linux; it does not publish automatically.

## Rollback

Use Homebridge’s version picker to reinstall 1.2.2, or run inside the Homebridge environment:

```sh
npm install -g homebridge-prusa-connect-camera@1.2.2
```

Restart Homebridge. The older upload URL may still fail with 404. Preserve configuration backups and the camera identity. Fix a faulty published beta by releasing a higher beta version.

## Hardware compatibility and verification

The plugin ships JavaScript, with no native add-ons or bundled CPU-specific executable. FFmpeg is provided by the host. Raspberry Pi (armv7/arm64), x86 NAS/Docker and other Homebridge hardware are intended targets when Node, Homebridge, FFmpeg and the camera driver are supported. Camera input arguments and device permissions vary by platform; Linux `/dev/video0` is not a universal default for every OS.

Automated tests cover API requests, identity persistence, image validation, retry timing, redaction, FFmpeg startup/capture, stream buffering and shutdown. They do not replace physical-camera/Prusa-account testing, nor certify every hardware or OS combination.
