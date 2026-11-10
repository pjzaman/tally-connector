# Tally PC: what to run

This file is the only set of instructions for the Tally PC. It arrives with every `git pull`.

- Code is changed only on the APE side, then pushed here.
- On the Tally PC: pull, run the steps under **Current step**, and send back the output.
- Don't edit code on the Tally PC. If something fails, send the output instead.

All commands are PowerShell, as the Windows user that owns the connector key (NABILA PC). TallyPrime must be open with every company loaded: the connector can only read Tally while it is running.

The connector folder is:

```
C:\Users\NABILA PC\Documents\Codex\2026-10-26\tak\outputs\tally-connector
```

If that ever changes, `(Get-ScheduledTask -TaskName 'Tally Firestore Connector').Actions.Arguments` shows the current one: it's the path before `\run-connector.ps1`.

---

## Current step (10 Nov 2026, second try): switch the folder to `main`

The first try stashed this PC's edits, but the folder was on a local branch (`tally-connector/2026-11-10-resume-and-sweeps`) with no link to GitHub. So `git pull` downloaded the new code without applying it, and the connector restarted on old 0.1.1, which syncs only Apon Enterprise. These commands switch to `main` and apply the already-downloaded code. No new pull is needed.

```powershell
Stop-ScheduledTask -TaskName 'Tally Firestore Connector'
cd "C:\Users\NABILA PC\Documents\Codex\2026-10-26\tak\outputs\tally-connector"
git checkout main
git merge --ff-only origin/main
git branch --set-upstream-to=origin/main main
git log --oneline -3
npm ci
npm test
Start-ScheduledTask -TaskName 'Tally Firestore Connector'
```

Expect `git log` to start with the commit that added this section, `npm test` to end with `pass 13` and `fail 0`, and `tally-firestore-connector@0.2.1` in the test header.

## Previous step (done 10 Nov): make this folder a clean copy of GitHub

GitHub now holds exactly the code this PC runs (0.2.1, commit `44e501a`), plus test fixes and this file. Nothing about how the connector behaves changes. This step only turns the folder's uncommitted edits into the committed version, so that later updates are a plain `git pull`.

The repo must be **public** while you pull (GitHub, Settings, Change visibility). Make it private again afterwards.

The folder was created by a different Windows user (CodexSandboxOnline), so git refuses to work in it ("detected dubious ownership"). The `safe.directory` line tells git to trust this one folder. It is needed once.

```powershell
Stop-ScheduledTask -TaskName 'Tally Firestore Connector'
cd "C:\Users\NABILA PC\Documents\Codex\2026-10-26\tak\outputs\tally-connector"
git config --global --add safe.directory "C:/Users/NABILA PC/Documents/Codex/2026-10-26/tak/outputs/tally-connector"
git stash push --include-untracked -m "Tally PC 0.2.1 before first pull"
git pull
git log --oneline -3
npm ci
npm test
Start-ScheduledTask -TaskName 'Tally Firestore Connector'
```

Expect:
- `git log` shows `TALLY_PC.md` and the test-fix commit on top of `44e501a`.
- `npm test` ends with `pass 13` and `fail 0`.

The stash keeps this PC's old copy as a backup (`git stash list`). Load progress in `state\` and the logs in `logs\` are not touched, so the initial loads resume where they stopped.

If `git pull` refuses or `npm test` fails, run `Start-ScheduledTask -TaskName 'Tally Firestore Connector'` to keep the old code running, and send the output.

---

## Every later update

When told there's a new version:

```powershell
Stop-ScheduledTask -TaskName 'Tally Firestore Connector'
cd "C:\Users\NABILA PC\Documents\Codex\2026-10-26\tak\outputs\tally-connector"
git pull
npm ci
npm test
Start-ScheduledTask -TaskName 'Tally Firestore Connector'
```

Then follow the new **Current step** above, if it asks for more.

## Checking it's running

```powershell
Get-Content .\logs\connector.log -Tail 20
```

A healthy log has no `fetch failed` lines; that error means TallyPrime isn't open or isn't answering on port 9000.
