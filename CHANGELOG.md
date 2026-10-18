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
- A list of remotes in the settings, each with its own service settings,
  encryption password, concurrency, sync direction, conflict choice, and
  percentage guard. A single-remote setup becomes the remote `dropbox` with
  the table `default → dropbox`, and its records move to that remote's
  profile (`remote-dropbox`), so it syncs exactly as before. The Dropbox
  credentials stay in one place, the top-level `dropbox`, which Revoke,
  Clear local, and a reconnect write; a Dropbox remote holds no copy.
- Three engine hooks, all unused by a single remote: a route filter applied
  beside `ignorePaths`; a set of folders the empty-folder cleanup keeps (those
  above a route, so one remote's run never trashes the notes another remote
  owns below them); and `FakeFs.finishSync()`, called once the plan has run,
  for a remote that commits its writes in one batch.
- Several remotes in one sync (`src/multiSync.ts`): under the one sync lock,
  each enabled remote runs in turn with its own settings, profile, and route
  filter, and one failing doesn't stop the next. Before the runs: the
  remotes' ownership files (encrypted on an encrypted remote) are compared, a
  newer one adopted with a notice and a contradiction stopping the runs; a
  routed folder gone while the plugin wasn't watching holds its runs and asks
  once; this device's ownership files are written; and then routed folders
  renamed in Obsidian are renamed on their remote and in its records, after
  the ownership files so another device never sees the folder gone with no
  claim on it. A rename the remote already made before the plugin stopped goes on to the
  records instead of failing that remote at every sync. A rename stays
  pending until every remote in the list has it (a switched-off remote gets it
  when it's on again), and one recorded while a sync runs isn't lost. Dropbox's
  folder move now reports its failure (upstream only logged it), so a failed
  move keeps its rename pending and the records where they were. A dry run writes
  nothing: no renames, no routes files, no adopted table, and no question.
  After
  a run, the records of anything a batching remote didn't commit go back to
  what they were, and their Smart Conflict bases are cleared. A commit that
  fails never hides the plan's own error, and the result always says how many
  changes weren't committed.
- A GitHub remote (`src/fsGithub.ts`) over GitHub's REST API through
  Obsidian's `requestUrl`: one listing of the branch head's tree, every
  write in a run staged as a blob and committed once at its end, a moved
  branch rebuilt with only the paths changed there dropped, file times kept
  in `.remotely-save-lite/times.json` (a file edited on github.com gets its
  last commit's time once, recorded by a commit of its own when need be), the
  loaded tree reused while the head holds, and a routed folder renamed in one
  commit. Encryption on a GitHub remote is refused for now.
- The settings page's "Remotes and routes": each remote read from the table
  ("everything except …", "only …") with its on/off switch, a GitHub
  remote's owner, repo, branch, token, folder, and connection check, and the
  table's rows, saved only when the setup isn't refused (the reason shown).
  A route change forgets the old remote's records under the folder and
  offers to delete its copies there; so does a change of the default row,
  for everything no route names. A GitHub remote's place (owner, repo,
  branch, folder) is saved with a Save button, asks first when the remote has
  synced before, and then forgets its records; Remove clears them too, and a
  new remote's id is never reused.
- The status bar marks each remote's last run when there are several
  (`Dropbox ✓ · GitHub ✗`, the error on hover), names the remote syncing,
  and opens the per-remote detail on a click. A refused setup, a stopped
  sync, or a remote that failed before its run is said in one notice and
  marked on the bar even with one remote.
- The routing's design (`docs/design.md`), a click-through list for trying
  several remotes and the GitHub remote on a scratch vault
  (`docs/click-through.md`), and a README section, "Several remotes", with
  how to set up GitHub.
- Smart Conflict, rebuilt from upstream's public description and now the
  default conflict choice. A Markdown file of 64 KB or less changed on both
  sides is merged by lines from its last-synced copy; any other conflict, or a
  merge where both sides changed the same lines, keeps the local file and
  saves the remote one beside it as a conflict copy, with a notice.
- Tests for the sync plan's decision on each file, and a test that fails if
  the test suite touches the network.
- A `NOTICE` naming upstream and what this fork changed.

### Changed

- The settings export (QR code and URI) leaves out the list of remotes (their
  tokens and encryption passwords), the routes, and the pending renames, all
  per-device state; its type admits `basic_and_advanced` and `dropbox` only.
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
- The S3, WebDAV, Webdis, and OneDrive backends. Dropbox is the one backend
  kept.
- The settings the restored engine can't honour: only-allow paths, bookmark
  sync, and the "and delete" sync directions.
- The CLA.
