# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The first release of Remotely Save Lite, 0.6.0, a free fork of Remotely Save
0.5.25.

### Added

- Tests for the sync plan's decision on each file, and a test that fails if
  the test suite touches the network.
- A `NOTICE` naming upstream and what this fork changed.

### Changed

- The plugin id is `remotely-save-lite`, so it installs beside Remotely Save
  with its own settings, local database, protocol actions, and Dropbox
  redirect (`obsidian://remotely-save-lite-cb-dropbox`).
- The sync engine is restored from upstream's Apache-2.0 history, before it
  moved into a source-available folder. Saved settings it can't honour fall
  back: a smart-conflict choice to "keep newer", and the "and delete" sync
  directions to their incremental forms.
- The whole repository is Apache-2.0.
- Biome is replaced by oxlint and oxfmt, and the code is reformatted.

### Removed

- The source-available `pro/` folder and everything that used it: the paid
  account, Smart Conflict, file content history, and the paid backends.
- The S3, WebDAV, Webdis, and OneDrive backends. Dropbox is the one backend.
- The settings the restored engine can't honour: only-allow paths, bookmark
  sync, and the "and delete" sync directions.
- The CLA.
