# Click-through: several remotes and the GitHub remote

A by-hand check of the routing and the GitHub remote before they touch real notes. The tests mock GitHub's API from
its documentation, unchecked against the live service, so each GitHub step below also confirms one premise the code
makes about a reply (named in brackets). Tick each box; anything that doesn't match is a bug to report with the step's
number.

## 0. Before you start

- [ ] 0.1 **The policy.** If any of this will ever hold work notes, check your employer's policy on keeping them in a
  personal GitHub repository first. It's their call, not a technical one; stop here if the answer is no.
- [ ] 0.2 A **scratch vault**, not your real one, with a few notes: `personal/a.md`, `personal/b.md`, `work/c.md`,
  `work/d.md`, `areas/e.md`, `areas/job/f.md`, and a root `g.md`.
- [ ] 0.3 A **scratch private GitHub repository** with one commit (tick "Add a README" when creating it).
- [ ] 0.4 A **fine-grained token** for that repository only, Contents: Read and write, a short expiry.
- [ ] 0.5 A Dropbox build of the plugin connected to Dropbox (README, "Build with your own Dropbox app key").
- [ ] 0.6 The developer console open (Ctrl+Shift+I, or Cmd+Option+I on a Mac) to read errors.

## 1. One remote, as before

- [ ] 1.1 With only Dropbox set up and no routes, sync. Everything lands in Dropbox as it did before the routing
  existed, and the status bar reads as it always has, with no per-remote marks.
- [ ] 1.2 Edit `personal/a.md`, sync: one upload, nothing else.
- [ ] 1.3 Search the console output for `.remotely-save-lite/routes.json`: with one remote and no routes, none is
  written to Dropbox.

## 2. Add GitHub

- [ ] 2.1 "Remotes and routes", "Add a GitHub remote". It appears switched off. Fill in the owner, the repo, `main`,
  and press "Save" under them, then enter the token. "Check connection" says it connected. [The ref read: `GET /repos/{owner}/{repo}/git/ref/heads/main`
  gives `object.sha`.]
- [ ] 2.2 Put a wrong character in the token and check again: it fails. Sync with the remote on and the bad token: the
  notice says the token was refused (401), Dropbox's run still finishes, and the status bar shows `GitHub ✗`. Put
  the right token back.
- [ ] 2.3 Set the repo to one that doesn't exist and press "Save" (the place is saved only then, not as you type):
  the notice says there's no access (404) on the next check. Set it back and save.
- [ ] 2.4 Search the console output and the exported sync plan for the token's first few characters: they appear
  nowhere.

## 3. Routing

- [ ] 3.1 Add the route `work → GitHub`, leave the default on Dropbox, save. It offers to delete Dropbox's copies of
  `work`; choose "Delete from Dropbox". Dropbox reads "everything except `work`", GitHub "only `work`".
- [ ] 3.2 Try a second `work` row and a route with no folder: each is refused with its reason and nothing saves.
  "Remove" on GitHub is refused while it owns `work`.
- [ ] 3.3 Switch GitHub on and sync. On github.com: one new commit, "Sync from <vault>, <n> changes", holding
  `work/c.md`, `work/d.md`, `.remotely-save-lite/times.json`, and `.remotely-save-lite/routes.json`, and no other
  note. [Blobs: `POST git/blobs` gives `sha`. The tree: `POST git/trees` with `base_tree` and `tree[]` entries. The
  commit: `POST git/commits` with `parents`. The branch: `PATCH git/refs/heads/main` with `force: false`.]
- [ ] 3.4 Dropbox no longer holds `work` (deleted at 3.1) and still holds everything else. The status bar shows `Dropbox ✓ · GitHub ✓`; clicking it shows each remote's last run.
- [ ] 3.5 Sync again with nothing changed: no new commit on GitHub. [The listing: `GET git/trees/{sha}?recursive=1`
  gives `tree[]` with `path`, `type`, `sha`, and `size`, and `truncated` false.]
- [ ] 3.6 Add `areas/job → GitHub`, save, sync: `areas/job/f.md` goes to GitHub, `areas/e.md` stays on Dropbox, and
  no error mentions a missing folder.
- [ ] 3.6a With `areas → Dropbox` and `areas/job → GitHub`, delete `areas/e.md` and sync, then restore it and delete
  `areas/job/f.md` and sync (Obsidian's "Deleted files" setting at its default). Each time the other folder's notes
  stay in the vault and on their remote.
- [ ] 3.7 Switch GitHub off and edit `work/c.md`, sync: the edit goes nowhere (not to Dropbox), and the bar shows
  `GitHub –`. Switch it back on, sync: the edit reaches GitHub.

## 4. Moves and renames across a boundary

- [ ] 4.1 Move `personal/b.md` into `work/`, sync. GitHub gains `work/b.md`; Dropbox loses `personal/b.md`; the file
  is in the vault once.
- [ ] 4.2 Rename the folder `work` to `job` in Obsidian. The route now reads `job → GitHub`. Sync: one GitHub commit
  renames every file, nothing is deleted locally, and nothing goes to Dropbox.
- [ ] 4.3 Close Obsidian, rename `job` back to `work` in your file manager, open Obsidian, sync. A question appears:
  "`job` is gone and `work` is new: renamed?". Close it without answering: nothing syncs to either remote, and the
  bar shows `⏸`. Sync again and answer "Rename the route": the route follows, GitHub renames in one commit, nothing
  is deleted.
- [ ] 4.4 Repeat 4.3, answering "It's new": Dropbox's run goes, GitHub's stays held. Then answer "Delete `job`
  everywhere" on the next sync: GitHub's copies go, the local folder stays as it is.
- [ ] 4.5 Change the route `work → GitHub` to `work → Dropbox`, save. It offers to delete GitHub's copies; choose
  "Keep them". Sync: `work` reaches Dropbox, GitHub keeps its old copies untouched. Route it back to GitHub and
  answer "Delete from GitHub" this time; Dropbox's copies stay, stale, until you delete them yourself.
- [ ] 4.5a Change the default row from Dropbox to GitHub and save: it offers to delete Dropbox's copies of everything
  outside the routed folders; choose "Keep them". Sync: the unrouted notes (`g.md`, `areas/e.md`) reach GitHub, nothing
  in the vault is deleted, and Dropbox still holds its old copies. Set the default back and answer "Delete from
  GitHub": its copies of those notes go, the routed folders stay.

- [ ] 4.6 After GitHub has synced, change its folder (or repo or branch) and press "Save": it asks first, then
  forgets the old records. Sync: nothing in the vault is deleted, and the new place gets the routed notes. "Remove"
  on a remote, then "Add a GitHub remote" again: the new one starts with no records.

## 5. Two devices

Use a second scratch vault (or a second device) with the same two remotes.

- [ ] 5.1 Change a route on the first, sync there, then sync on the second: a notice says the routes were updated from
  another device, and the second's settings show the new table.
- [ ] 5.2 Edit a different note in `work` on each, sync the first, then the second: both edits reach GitHub, in two
  commits, nothing lost. [A moved branch: the ref update answers 422 when it isn't a fast-forward, and the second
  device rebuilds on the new head.]
- [ ] 5.3 Edit the same note in `work` on both, sync both: Smart Conflict merges it or keeps a conflict copy, as with
  Dropbox.

## 6. GitHub edge cases

- [ ] 6.0 Create a branch named `feature/x` in the scratch repository, point the GitHub remote's branch at it, press
  "Save", and sync: "Check connection" connects and the sync commits to `feature/x`. [A branch with a slash: the ref
  paths `git/ref/heads/feature/x` and `PATCH git/refs/heads/feature/x` take the slash as it is, each segment encoded.]

- [ ] 6.1 Edit `work/c.md` on github.com, sync: the edit arrives, and a notice says a file changed outside the plugin
  takes the time of its last commit. [`GET commits?path=work/c.md&per_page=1` gives `commit.committer.date`.] Sync once
  more: GitHub gains a "Record file times" commit (or the sync's own commit holds them), and the next sync makes no
  such lookup and no commit.
- [ ] 6.2 A file over 100 MB in `work`: a notice says it isn't synced; the rest of the run commits.
- [ ] 6.3 Not easy to provoke, skip unless it happens: when the hourly limit runs out, the notice names the limit
  rather than a generic failure. [A 403 or 429 with `x-ratelimit-remaining: 0`.]

## 7. After

- [ ] 7.1 Delete the scratch repository and revoke the token.
- [ ] 7.2 Before pointing it at real notes: back up the vault (README, top), and re-read 0.1.
