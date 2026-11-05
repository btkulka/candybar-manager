# Track Lab (candybar-manager)

## Every push to main ships a release

Installed copies of Track Lab (the .dmg from GitHub Releases) only update when
a GitHub Release with a **higher version** than theirs exists. A push to `main`
on its own reaches nobody, so every push to `main` is followed by a release:

1. Check it: `npx vitest run`, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p tsconfig.mcp.json`, `npm run build`.
2. Bump the version (package.json and package-lock.json together):
   `npm version <x.y.z> --no-git-tag-version`. Patch for fixes, minor for
   new features (still 0.x).
3. Commit it as `Track Lab <x.y.z>` and push `main`.
4. Tag and push the tag: `git tag v<x.y.z> && git push origin v<x.y.z>`.
   `.github/workflows/release.yml` builds the arm64 and x64 .dmgs and
   publishes the release; it fails if the tag doesn't match package.json.
5. Watch it finish (`gh run watch <id> --exit-status`), then check
   `gh release view v<x.y.z>` lists both `Track-Lab-<x.y.z>-arm64.dmg` and
   `Track-Lab-<x.y.z>-x64.dmg`. Give the release link when reporting.

Never move or reuse a tag. If a release build fails, fix it, bump to the next
patch and tag that.

The one exception: a push that changes nothing the app ships (only this file,
README.md or tests) needs no release. Say so when pushing.
