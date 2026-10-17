# Remotely Save Lite

**ALWAYS back up your vault before using this plugin.** A sync plugin moves
and deletes files on your behalf; a bug, a clock that's wrong, or a setting you
didn't mean can lose notes.

## What this is

Remotely Save Lite is a free fork of
[Remotely Save](https://github.com/remotely-save/remotely-save) 0.5.25, an
unofficial plugin that syncs an Obsidian vault with a cloud service. It keeps
the free, Apache-2.0 plugin going with Dropbox.

## Why

- Upstream has been quiet since November 2024.
- Upstream moved its sync engine into a paid, source-available `pro/` folder,
  so the free plugin no longer builds from open source alone.

## What changed

- **Kept:** Dropbox, end-to-end encryption (RClone Crypt and OpenSSL formats),
  scheduled auto sync, sync on save, skipping large files and paths, the
  conflict choices "keep newer" and "keep larger", the push-only and pull-only
  directions, mobile support, the sync plan export, and the profiler.
- **Dropped:** the S3, WebDAV, Webdis, and OneDrive backends; the paid account
  and every paid feature (Smart Conflict, file content history, and the paid
  backends); the settings the free engine can't honour (only-allow paths,
  bookmark sync, and the "and delete" directions); and the CLA.
- **Rebuilt:** Smart Conflict, written fresh (see below).
- **Restored:** the sync engine, from upstream's Apache-2.0 history before it
  moved into `pro/`, without its paid hooks. Tests now pin the engine's
  decision for each file.
- **Its own identity:** the plugin id is `remotely-save-lite`, so it installs
  beside Remotely Save with its own settings, local database, and Dropbox
  redirect. It doesn't share upstream's Dropbox app either (see building,
  below), so it starts from a fresh folder.

[`NOTICE`](./NOTICE) lists the changes, and each changed source file says what
changed at its top. The whole repository is Apache-2.0 ([`LICENSE`](./LICENSE)).

## Install

The plugin isn't in Obsidian's community list. Either:

- Install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat): add
  `stdlo/remotely-save-lite`.
- Or copy the three files from a release, `main.js`, `manifest.json`, and
  `styles.css`, into `<your vault>/.obsidian/plugins/remotely-save-lite/`, then
  enable the plugin in Obsidian's settings.

A release built without a Dropbox app key can't connect to Dropbox; build your
own as below.

## Build with your own Dropbox app key

The Dropbox app key is set at build time, never in the code.

1. Create an app in the [Dropbox App Console](https://www.dropbox.com/developers/apps):
   scoped access, "App folder" access, with the permissions in
   [the Dropbox notes](./docs/dropbox_review_material/README.md)
   (`account_info.read`, `files.content.read`, and `files.content.write`).
2. Add `obsidian://remotely-save-lite-cb-dropbox` to the app's OAuth 2
   redirect URIs.
3. Copy `.env.example.txt` to `.env` and put the app key after
   `DROPBOX_APP_KEY=`. `.env` is ignored by git.
4. With Node 24 (`.node-version`), run `npm ci` and `npm run build`. The
   plugin is `main.js`, with `manifest.json` and `styles.css`.

To build on GitHub Actions, set a `DROPBOX_APP_KEY` secret in the
`env-for-buildci` environment.

Your notes sync to `/Apps/<your app's name>/<vault name>` in your Dropbox.

## Paid features rebuilt

- **Smart Conflict:** built fresh from upstream's public description, and the
  default. A Markdown file of 64 KB or less edited on both sides is merged by
  lines from its last-synced copy. Any other conflict, or a merge where both
  sides changed the same lines, keeps the local file and saves the remote one
  beside it as `<name>.conflict-remote-<YYYYMMDD-HHmmss>.<ext>`, with a notice.
- **The paid backends** (Google Drive, Box, pCloud, Yandex Disk, Koofr, Azure
  Blob Storage, and OneDrive with full access) aren't rebuilt. A backend can be
  added through the `FakeFs` interface (`src/fsAll.ts`): one member of
  `SUPPORTED_SERVICES_TYPE`, one `src/fs*.ts`, and one part of the settings.

## Development

- `npm run build` builds the plugin with webpack; `npm run dev` watches.
- `npm test` runs the mocha tests. None may touch the network.
- `npm run lint` runs oxlint and checks formatting; `npm run format` formats
  with oxfmt.

## Disclaimer

- **This is NOT the [official sync service](https://obsidian.md/sync) provided
  by Obsidian.**
- **This plugin is NOT an official Dropbox product.** It uses Dropbox's public
  API.

## Features

- **Dropbox.** After you authorize it, the plugin can read your name and email
  (Dropbox's API doesn't let an app opt out of these), and read and write files
  in its own app folder in your Dropbox. More is in
  [the Dropbox notes](./docs/dropbox_review_material/README.md).
- **Obsidian Mobile supported.** Vaults can be synced across mobile and
  desktop devices with Dropbox as the "broker".
- **[End-to-end encryption](./docs/encryption/README.md).** Files are
  encrypted in the OpenSSL or RClone Crypt format before being sent to Dropbox
  **if** you set a password. The vault name itself isn't encrypted.
- **Scheduled auto sync.** You can also sync from the ribbon icon or the
  command palette (and bind a hotkey to the command).
- **[Minimal intrusive](./docs/minimal_intrusive_design.md).**
- **Skip large files** and **skip paths** by custom regex.
- **[The sync algorithm](./docs/sync_algorithm/v3/intro.md)** is documented
  for discussion.
- **[Conflict detection and handling](./docs/sync_algorithm/v3/intro.md):**
  Smart Conflict (merge small Markdown files, otherwise keep both), or keep
  the newer or the larger file.

## Limitations

- **Some limitations come from the browser environment.** More technical
  details are [in the doc](./docs/browser_env.md).
- **Protect your `data.json` file.** It holds sensitive information.
  - **Don't** share your `data.json` file with anyone.
  - It's usually **not** a good idea to check it into version control. By
    default, the plugin creates a `.gitignore` file inside its plugin folder,
    if there isn't one, to keep `data.json` out of git. If you know exactly
    what that means and want to change it, edit that `.gitignore` file.
- **Obsidian's API on mobile is slow syncing large files (50 MB or more).**
  The "Skip Large Files" option helps.

## Usage

- Enable the plugin, open its settings, and connect Dropbox.
- If you want end-to-end encryption, set a password in the settings. Without
  one, files and folders are synced as they are.
- Click the "circle arrow" icon on the ribbon (the left sidebar) **every time**
  you want to sync, or set up auto sync in the settings. While syncing, the
  icon becomes "two half-circle arrows". The same action is in the command
  palette.
- **Be patient while syncing,** especially the first time.
- To sync across devices, **your vault name should be the same** on each one
  while using the default settings.

## Scheduled Auto Sync

- You can set auto sync every N minutes in the settings.
- In auto sync mode, if any error occurs, the plugin **fails silently**.
- Auto sync only works while Obsidian is open. It's **technically
  impossible** to sync while Obsidian is in the background, because the plugin
  runs in the browser environment Obsidian provides.

## Sync On Save

- You can set sync on save in the settings.
- In sync on save mode, if any error occurs, the plugin **fails silently**.

## Config Folder

By default, the plugin doesn't sync Obsidian's config folder (normally
`.obsidian`), because it's hidden.

You can enable syncing the config folder in the settings. It's experimental:
some config files' modified times change every time Obsidian opens, which
breaks the plugin's assumptions, so some changes may not sync properly.

## Hidden Files Or Folders

**By default, every file or folder whose name starts with `.` (dot) or `_`
(underscore) is treated as hidden and is NOT synced.** That's useful for files
you want to keep on one device, but it also means themes, other plugins, and
this plugin's settings aren't synced.

You can change the settings to sync `_` files and folders, and the `.obsidian`
config folder as above (but no other `.` files or folders).

## How To Debug

If you see an error, see [the debugging doc](./docs/how_to_debug/README.md).

If the sync runs but slowly, you can check its performance by
[enabling the profiler](./docs/check_performance/README.md).

## Import And Export Settings By QR Code

See [the doc](./docs/import_export_some_settings.md).

## Questions Or Bugs

Open an issue on
[this repository](https://github.com/stdlo/remotely-save-lite/issues). Please
don't take this fork's problems to upstream.
