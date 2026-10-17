# Design: several remotes at once

How Remotely Save Lite syncs one vault with more than one remote at a time. This is the spec the routing was built
from, kept true to the code; "Where the build differs" at the end lists each place the build settled something the
first draft left open or changed it, and why.

## The goal

One sync, more than one remote live together, each folder of the vault routed to exactly one of them. The case it's
built for: personal folders to Dropbox, one work folder to a private GitHub repo (a network that blocks consumer
cloud storage often still reaches GitHub). A remote type is a `FakeFs`; this design adds routing above the engine and
one new remote type, GitHub.

## What the engine is today

`syncer()` (in `src/sync.ts`) syncs the whole vault with **one** remote and **one** settings object. It walks the
local vault and the remote, compares both with the previous-sync records kept in the local database under a
**profile id** (keyed `vault, profile, path`), plans an action per path, and runs the plan. Paths are skipped by
`isSkipItemByName()`: `ignorePaths` (regular expressions), the route filter (below), and a few built-in skips. Local
deletions go to the trash (`deleteToWhere`). The engine never renames on a remote: a moved file is a deletion plus an
upload.

## How folders route

**Options:**
1. **Per-remote lists, as asked:** each remote has a mode, *allow* (only these folders) or *deny* (everything but
   these), and the plugin refuses a setup where a path matches two remotes. Two deny-mode remotes always overlap, so
   at most one remote may be in deny mode.
2. **One route table:** rows of `folder → remote` (or `→ local only`), plus one **default** row for everything no row
   names. The longest matching folder wins, so `areas → Dropbox` and `areas/job → GitHub` can sit together. Each
   folder appears once, so no path can reach two remotes; the default means no path reaches none by accident.

**Built: option 2, shown as option 1.** An overlap is impossible by construction rather than by a check, and the
default row answers "to none it should" outright: a remote or, explicitly, `local only`. The settings page reads per
remote ("Dropbox: everything except `work`. GitHub: only `work`."), generated from the table (`src/routes.ts`,
`describeTarget()`).

**The rules** (`src/routes.ts`):
- A route is a folder path relative to the vault root (`work`, `areas/job`), matched on whole segments (`work`
  matches `work/a.md`, not `workshop/a.md`), case-sensitive as the vault is. No regular expressions in routes.
- Root files go to the default.
- **Two parts, stored in two places.** *Ownership* (which folder belongs to which remote, by the remote's name) is
  shared: each remote keeps a small routes file (`.remotely-save-lite/routes.json` on that remote, through its
  encryption when it has a password) listing the folders it owns and when the table that wrote it changed, written
  when it differs from this device's. *Per device:* which remotes this device uses, their credentials, enabled flags,
  and the default row (a work laptop holding only `work` sets `default → local only`). At the start of each sync a
  device compares its ownership with the remotes': an older table is updated with a notice; a contradiction (one
  folder claimed by two remotes' files of the same time) stops the runs until it's fixed in settings. A folder a
  newer file no longer lists, and no newer file claims, becomes `local only` on this device, never the default.
- A route to a **disabled** remote still owns its folders: they sync nowhere until it's enabled again, and never
  fall through to the default. A remote that still owns folders (or the default row) can't be removed: its folders
  are routed elsewhere first.
- **A route changed** (a folder moved from one remote to another in the settings): the old profile's records under
  that folder are cleared, and the plugin offers to delete the old remote's copies (otherwise they stay there,
  stale).
- The config folder (`.obsidian/`) isn't routed; syncing it is off by default and may be on for one remote only. (The
  plugin's own folder, with every credential, is never synced: the config walk already skips it.)
- With one remote and no routes the routing is off: no route filter and no routes file, so a setup migrated from the
  single-remote plugin syncs exactly as before.

**Refused setups** (the settings page shows the reason and won't save): the same folder twice; a route to a remote
that doesn't exist; config-folder sync on two remotes; no default row; two remotes with one id or one name; an
encrypted GitHub remote (below).

## How a sync runs

One trigger (manual, a timer, on save) takes the plugin's one sync lock (`isSyncing`, which sync-on-save already
checks) and runs **each enabled remote in turn**, in the list's order (`src/multiSync.ts`), each a normal `syncer()`
run with:
- **its own settings slice:** each remote carries its own service settings, encryption password, concurrency,
  sync direction, conflict choice, and percentage guard; the orchestrator builds the settings object for each run. A
  per-remote setting left unset falls back to the top-level one, which is how the migrated remote keeps its settings;
  a new remote is created with its own;
- **its own profile id** (`remote-<id>`), so its records are its own; the single-remote profile's records
  (`dropbox-default-1`) move to `remote-dropbox` when the plugin loads;
- **a route filter inside `isSkipItemByName()`,** beside `ignorePaths`, so the local list, the remote list, and the
  previous-sync records all agree on what's in the run (filtering the walks instead would trip the engine's
  "empty local list" hard reset when a routed folder is deleted). A path is in the run when the table routes it to
  this remote, **plus the ancestor folders of each of its routes** (`areas` for a route `areas/job`): folder entries
  only, which the planner needs as parents and which create nothing on their own.

Before the runs, in this order: routed-folder renames recorded since the last sync are finished (below); the
ownership check; the hold rule (below). One remote failing (offline, a bad token) doesn't stop the others; each
reports its own result. Local deletions keep going to the trash, the net under every case below.

**Options considered:** one run with a composite `FakeFs` that dispatches each path to its backend. It would plan
everything at once, but the percentage guard, the error path, and the profile all assume one remote per run; running
the tested engine once per remote keeps each run as it was.

## Moves and renames across a boundary

- **A note moved** from `personal` (Dropbox) to `work` (GitHub): Dropbox's run sees it gone locally and deletes its
  remote copy; GitHub's sees a new local file and uploads it. If one run fails, the file is still on the device and
  the next run finishes the job.
- **A routed folder renamed in Obsidian** (`work` to `job`): the plugin listens to the rename event and renames the
  route at once, and records the rename; the next sync, under the lock and before its runs, renames the folder on
  each remote that holds it (one Dropbox move, one GitHub commit) and then rewrites that profile's records under the
  old folder to the new one, so the run finds everything equal. A remote whose rename fails keeps it pending and
  doesn't run that sync, unless it already holds the new folder and not the old one (renamed before the plugin
  stopped), when the records move as if the rename had just gone through. An encrypted remote names each path on its own, so it gets no folder move: its run deletes
  and uploads, which the percentage guard may stop.
- **A routed folder gone when the plugin wasn't watching** (renamed in Finder, restored from a backup, renamed on
  another device): before the runs, when a routed folder is missing locally while its remote still holds files
  there (its profile has records under it), that remote's run is **held**, and so is the default's when a new,
  never-synced top-level folder has appeared. One question: "`work` is gone and `job` is new: renamed? [Rename the
  route] [It's new] [Delete `work` everywhere]". *Rename the route* renames it as above; *It's new* lets the
  default's run go and keeps `work`'s held; *Delete* lets the run delete `work` on its remote; closing it leaves both
  held, and the next sync asks again. This is the one prompt the design allows; everything else stays silent.

## Conflicts

Each file has one remote, so a conflict is always between this device and that remote, handled by the engine as
today (Smart Conflict, or keep the newer or the larger). Two remotes never conflict with each other.

## The GitHub remote

A `FakeFs` over GitHub's REST API (`src/fsGithub.ts`; no native git, so it runs on desktop and phone; Obsidian's
`requestUrl` avoids CORS, wrapped in `src/fsGithubRequest.ts` so tests swap it). Settings: owner, repo, branch, a
fine-grained personal access token limited to that one repo with contents read and write, and an optional folder
inside the repo. Vault paths are kept whole in the repo. The token goes in the `Authorization` header only and is
never logged.
- **Listing:** one call for the branch head, one for its commit, one for its tree (`git/trees/<sha>?recursive=1`),
  and the times file's blob. A truncated tree stops the run.
- **Writing, batched:** the engine uploads five files at once, and parallel writes to one branch through the
  Contents API race (409), so `writeFile` creates a blob and stages it, `rm` stages a deletion, and at the end of the
  run an optional engine hook, `FakeFs.finishSync()`, makes one tree, one commit ("Sync from <vault>, <n>
  changes"), and moves the branch (`force: false`). The engine calls it after the plan even when the plan stopped
  partway, so what did run is committed. Git keeps no empty folders: `mkdir` and a folder's `rm` do nothing.
- **A moved branch** (another device committed first, the ref update refused): the tree is rebuilt on the new head;
  only paths that changed there are dropped from this commit, and only those roll back (below). Three tries, then
  the run fails and everything rolls back.
- **Rolling back:** the engine writes a previous-sync record as soon as `writeFile` returns and clears it after `rm`,
  before the commit. So the GitHub fs reports the keys it couldn't commit (all of them when the commit fails), and the
  orchestrator puts their records under that profile back to what they were before the run: the next run sees them
  as local changes (re-upload) or unchanged deletions (re-delete), never as "deleted on the remote".
- **Times:** git keeps no file times, and the engine compares them. The remote keeps
  `.remotely-save-lite/times.json` (path → modified time, size, blob sha) in each commit, merged by path with the
  head's copy on a moved branch (never counted as an overlap). A file whose blob sha doesn't match it (edited on
  github.com) gets the time of the last commit touching that path (one request each, rare), and a notice says so.
- **Limits:** 5,000 requests an hour, about one per changed file plus a few per run; a 403 or 429 with no requests
  remaining is reported as the limit. Files over 100 MB are skipped with a notice (that file's upload fails).
- **Encryption** isn't allowed on a GitHub remote yet: the rollback finds records by vault path, and an encrypted
  remote stages encrypted names.
- **Tests:** a mocked API (an in-memory repo behind a fake request function): listing, a batched commit, a moved
  branch with and without overlapping paths (times file merged), a failed commit rolling back its records, a 401 and
  a 403 rate-limit reply, a file edited on github.com, a folder rename in one commit, and the token never logged.
- **Policy:** whether work notes may sit in a personal GitHub repo is an employer's policy, not a technical
  question; the README says what syncs where, and the click-through list asks to check before pointing it at work
  notes.

## What the status bar shows

With several remotes, one item: the last run's time and a mark per remote, `Synced 2m ago · Dropbox ✓ · GitHub ✓`;
a failed or stopped remote shows `✗` and its error on hover, a held one `⏸`, a disabled one `–`; clicking shows the
per-remote detail (last run, result, last error, a held question) as a notice. While a run is going: `Syncing
GitHub…`. With one remote it reads as before.

## Tests the routing needs

The table's longest match and whole-segment matching; each refused setup; a two-level route (`areas` and
`areas/job` on two remotes) syncing without the engine's `keptFolder` error; a move across a boundary; a route rename
rewriting records with no deletions; a folder gone while unwatched holding both runs; a newer ownership file adopted;
a contradicting one stopping the runs; a disabled remote's folders reaching no other remote. All in
`tests/routes.test.ts`, `tests/remotes.test.ts`, and `tests/multiSync.test.ts`, the last over the real engine.

## Not in this design

Proton Drive (whether it offers an API a plugin can use is unchecked), a remote for the config folder per device, and
syncing one folder to two remotes on purpose (a backup); each could come later as its own piece.

## Where the build differs

1. **A released folder becomes local only.** The draft said an older table "is updated"; a folder a newer routes
   file drops, with no newer claim on it, would otherwise fall to the default and upload elsewhere.
2. **A contradiction is two claims of the same time.** Claims of different times are the newer one winning, which
   is how a change made on another device arrives.
3. **"The remote still holds files there"** is read from the profile's records, not a listing, so the hold costs no
   requests.
4. **The answers to the held question** are pinned down: *It's new* releases the default's run only.
5. **A rename in Obsidian is finished at the next sync,** under the lock, remote first and records second, so a
   failed remote rename can never leave records pointing at a folder the remote doesn't have.
6. **Rolling back restores** each record's state before the run rather than clearing it, so an uncommitted deletion
   is made again instead of the file coming back.
7. **No encryption on a GitHub remote yet,** and **no folder move on an encrypted remote** (above).
8. **Removing a remote that owns folders is refused** until they're routed elsewhere, rather than asking where they
   go.
9. **The per-remote detail is a notice** without counts.
