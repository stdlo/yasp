# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The first release of Remotely Save Lite, 0.6.0, a free fork of Remotely Save
0.5.25.

### Added

- A route table for several remotes (`src/routes.ts`): each folder routes to
  one remote or stays local only, by the longest whole-segment match, with a
  default row for everything else; the refused setups, the per-remote reading
  of the table, the ownership file's merge, and the hold rule for a routed
  folder gone while the plugin wasn't watching.
- Smart Conflict, rebuilt from upstream's public description and now the
  default conflict choice. A Markdown file of 64 KB or less changed on both
  sides is merged by lines from its last-synced copy; any other conflict, or a
  merge where both sides changed the same lines, keeps the local file and
  saves the remote one beside it as a conflict copy, with a notice.
- Tests for the sync plan's decision on each file, and a test that fails if
  the test suite touches the network.
- A `NOTICE` naming upstream and what this fork changed.

### Changed

- The plugin id is `remotely-save-lite`, so it installs beside Remotely Save
  with its own settings, local database, protocol actions, and Dropbox
  redirect (`obsidian://remotely-save-lite-cb-dropbox`).
- The sync engine is restored from upstream's Apache-2.0 history, before it
  moved into a source-available folder. Saved settings it can't honour fall
  back: an unknown conflict choice to Smart Conflict, and the "and delete"
  sync directions to their incremental forms.
- The whole repository is Apache-2.0.
- Biome is replaced by oxlint and oxfmt, and the code is reformatted.

### Removed

- The source-available `pro/` folder and everything that used it: the paid
  account, upstream's Smart Conflict (rebuilt, above), file content history,
  and the paid backends.
- The S3, WebDAV, Webdis, and OneDrive backends. Dropbox is the one backend.
- The settings the restored engine can't honour: only-allow paths, bookmark
  sync, and the "and delete" sync directions.
- The CLA.
