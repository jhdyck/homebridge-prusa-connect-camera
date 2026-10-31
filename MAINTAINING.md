# Maintaining and releasing this plugin

GitHub stores the source code and review history. npm distributes the installable package that Homebridge downloads. Updating GitHub alone does not update npm installations.

## Test the proposed 1.3.0 release on your NAS

1. Download a Homebridge backup from the web UI. Save a copy of the existing platform configuration, especially the fingerprint.
2. Copy the prepared `homebridge-prusa-connect-camera-1.3.0.tgz` file into your persistent Homebridge folder on the NAS. Inside the container that folder is usually `/homebridge`.
3. Open the Homebridge web UI terminal and run:

   ```sh
   npm install -g /homebridge/homebridge-prusa-connect-camera-1.3.0.tgz
   ```

   Adjust the path to where you placed the file. If the UI terminal lacks installation permissions, use the container terminal with the same user/permissions used for normal Homebridge plugin installs. Do not install on the NAS host by mistake.
4. Restart Homebridge. Keep your existing token/fingerprint initially. Confirm registration in the logs and a new snapshot in Prusa Connect.
5. Temporarily enable debug logging and confirm several upload cycles. Disable debug logging afterward.
6. Restart again and confirm uploads still work. Test rebroadcast consumers if enabled; check both still image and streaming URLs.
7. If registration returns 403, preserve the original fingerprint. If necessary create a new camera token and restart within 15 minutes. Do not delete a functioning old camera until the replacement is confirmed.

Record the Homebridge/Node/FFmpeg versions, camera source, result, and any errors in the pull request. Never post tokens or camera URL passwords.

## Publish after the live test passes

Use Terminal on your Mac. The source folder prepared by Codex is in this chat’s workspace under `work/source`; alternatively clone GitHub after merging the pull request:

```sh
git clone https://github.com/jhdyck/homebridge-prusa-connect-camera.git
cd homebridge-prusa-connect-camera
```

1. Merge the reviewed pull request on GitHub. For an existing checkout, run `git switch main` and `git pull --ff-only`.
2. Install dependencies and run checks (FFmpeg must be installed):

   ```sh
   npm ci
   npm run check
   npm test
   npm pack --dry-run
   ```

3. Confirm `package.json` says `1.3.0` and npm has not already used that version:

   ```sh
   npm view homebridge-prusa-connect-camera version
   ```

   npm versions cannot be reused. If 1.3.0 already exists, choose a higher version, update the changelog, and commit it before publishing.
4. Sign in yourself; complete the browser and two-factor prompts privately:

   ```sh
   npm login
   npm whoami
   ```

5. Publish the reviewed code:

   ```sh
   npm publish --access public
   ```

   The prepublish check runs syntax checks and tests automatically. Complete npm’s authentication prompt if requested. Do not send authentication codes or tokens through chat.
6. Verify npm reports 1.3.0, then tag the exact released commit and push the tag:

   ```sh
   npm view homebridge-prusa-connect-camera version
   git tag -a v1.3.0 -m "1.3.0: migrate to Prusa Camera Service"
   git push origin v1.3.0
   ```

7. On GitHub, open Releases → Draft a new release, select `v1.3.0`, paste the changelog entry, and publish the release. Homebridge users can then update through Plugins.

For future changes: create a branch, edit code, run checks, open/merge a pull request, increment the version, and repeat the release steps. CI checks Node 22 and 24 on Linux; it does not publish automatically.

## Rollback

To reinstall the previous package inside the Homebridge container:

```sh
npm install -g homebridge-prusa-connect-camera@1.2.2
```

Restart Homebridge. This restores the older code, but its obsolete upload URL may still fail with 404. Preserve the configuration backup and camera identity. A faulty published version should normally be followed by a corrected higher version, not an attempt to reuse its version number.

## Scope of verification

Automated tests cover API request structure, persistent identity, image validation, retry scheduling, credential redaction, FFmpeg startup/capture, stream buffering, and shutdown. Real Prusa authentication, camera classification/display, NAS permissions, all camera formats, and all hardware require live validation. No audit can guarantee zero bugs.
