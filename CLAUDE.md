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

## Shared packages (BPM)

Ben's shared packages are linked from `../packages` as **devDependencies**:
`@btkulka/media-kit` (ffmpeg, ffprobe, yt-dlp), `@btkulka/proc-kit` (media-kit's
process helpers), `@btkulka/spotify-client`, `@btkulka/soundcloud-client`,
`@btkulka/ableton-als` and `@btkulka/electron-kit`. electron-vite inlines
devDependencies into `dist/main` (`externalizeDepsPlugin` leaves only
`dependencies` as require()s), and the checkout scripts (`splice-recover.mjs`,
`yt-vocal-split.mjs` with `lib/youtubeDl.mjs`, `apply-xml-matches.mjs`,
`scripts/`) load them from `node_modules`.

The release build (`.github/workflows/release.yml`) checks out btkulka/packages
beside the app and builds only these packages, proc-kit first. Linking a new
shared package means adding it to that build step too, after anything it
depends on.

Never import one from code the .dmg runs unbundled: `src/mcp-server.ts` and
everything `tsconfig.mcp.json` compiles with it into `dist/mcp`, or the `lib/`
and `bin/` files the app loads at runtime. The .dmg ships only
`dependencies`, and electron-builder 26 can't ship a `file:` package there (it
fails with "dependency path is undefined" on media-kit's proc-kit). That's why
`trackConverter.ts` (in the MCP build) and `lib/sourcing/` (downloads,
previews, playlist, soundcloud) keep their own ffmpeg, Spotify and SoundCloud
code. `npx tsc -p tsconfig.mcp.json --noEmit --listFiles | grep btkulka` must
print nothing.
