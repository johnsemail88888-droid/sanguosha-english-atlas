# Working on this repo

The game is **三国杀·枪火乱世 / Sanguo Warlords** in `warlords/` (the rest of the repo is the older atlas app).
The owner is not a developer. He wants every change to reach players by itself — no manual downloads, no
settings to fill in — and he wants to hear about it without asking. **Reply to him in Chinese.**

## After any user-facing change
1. Test (`cd warlords && npx tsc -b && npx vitest run <the suites you touched>`), commit, and merge to `main`
   (PR, squash). Merging *is* the release — don't stop at a branch:
   - web: `warlords-pages.yml` deploys GitHub Pages;
   - desktop: `warlords-desktop.yml` builds Windows / macOS / Linux and publishes the latest GitHub release
     (`warlords-build-<run>`, version `0.1.<run>`); installed apps update themselves (`warlords/electron/updater.cjs`);
   - server: the Mac mini updates itself to the newest `main` commit that passed `warlords-ci.yml`, on its own
     schedule. That cadence is the owner's decision — don't change `deploy/` defaults (e.g. `SGWL_UPDATE_INTERVAL`).
2. Tell the owner in 1–3 Chinese lines what changed and whether he has to do anything (normally 「不用做任何事」).
3. Follow through on consequences without being asked: a protocol / compat change → the server must run it too
   (check the Mac mini's auto-update will pick it up; say so); a new default → it has to ship in a desktop release;
   a server / deploy behaviour change → update `warlords/src/net/official.ts`, `warlords/deploy/MAC_MINI.md` and
   `warlords/README.md` together.

## Rules
- Tests and CI never talk to the real server: test builds use `VITE_OFFICIAL_RELAY=''` (vite.config.ts `test.env`,
  `warlords-mac.yml`). Never add it to `warlords-desktop.yml` or `warlords-pages.yml` — shipped builds must default
  to the official server (a fresh profile plays on 官方服务器 with zero setup; `tests/unit/ui/zeroSetup.test.ts`).
- Settings are a last resort: make it work by default. If something needs a setting, fix the default instead.
- Desktop releases: warlords builds stay the repo's "latest" release (the update feed is
  `releases/latest/download/latest*.yml`); don't publish other releases as latest. Keep the versioned artifact
  names in `package.json` `build.*.artifactName` in step with `electron/updater.cjs` (tests check).
- Solve problems yourself; ask only for a real decision or permission (accounts, money, sudo / System Settings on
  the Mac, the server's update cadence).
- The Mac mini (official server): use the `deploy-mac-mini` skill (`.claude/skills/deploy-mac-mini`) and follow
  `warlords/deploy/MAC_MINI.md`; never run its installer with sudo — hand sudo steps to the owner.
