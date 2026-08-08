# Releasing

`open-usage` ships as six npm packages plus a set of GitHub release binaries.

| Package                    | Contents                                  |
| -------------------------- | ----------------------------------------- |
| `open-usage`               | a ~17 kB Node launcher, no runtime deps    |
| `@open-usage/darwin-arm64` | the compiled binary for that platform      |
| `@open-usage/linux-x64`    | "                                          |
| `@open-usage/linux-arm64`  | "                                          |
| `@open-usage/win32-x64`    | "                                          |
| `@open-usage/win32-arm64`  | "                                          |

Installing `open-usage` pulls exactly one platform package, because each declares `os` and `cpu` and all five are optional dependencies.
The launcher resolves the matching binary and execs it.
This is why the published package needs no Bun, no Node version floor beyond 18, and no postinstall script.

## One-time setup

Nothing below is automated, and the first release cannot succeed until all of it is done.

### 1. Claim the `@open-usage` scope

The scope is an npm **organization**, not a username.

1. Sign in at [npmjs.com](https://www.npmjs.com).
2. Create an organization named `open-usage` (Add Organization → free plan, which allows unlimited public packages).
3. Confirm `https://www.npmjs.com/org/open-usage` loads for you.

If the name is taken, the fallback is your personal scope.
Change the `@open-usage/` prefix in two places and everything else follows:

- `PLATFORM_PACKAGES` in [`bin/open-usage.js`](../bin/open-usage.js)
- the manifest `name` and the pin in [`scripts/build-npm-packages.ts`](../scripts/build-npm-packages.ts)

The unscoped `open-usage` name is already free, so the root package is unaffected either way.

### 2. Configure trusted publishing

There is no npm token in this repository.
The workflow authenticates through GitHub's OIDC identity, so there is no secret to rotate, expire, or leak.

npm has to be told which workflow may publish each package, and that is set per package.
Repeat for all six: `open-usage` and the five `@open-usage/*` packages.

1. Open the package on npm, then Settings.
2. Under **Trusted Publisher**, pick GitHub Actions and fill in:
   - Organization or user: `arionrefat`
   - Repository: `open-usage`
   - Workflow filename: `release.yml`
   - Environment: leave empty
3. Save.

Every field is case-sensitive and must match exactly, including the `.yml` extension.

Trusted publishing needs npm 11.5.1 or newer on Node 22.14.0 or newer.
Node 22 still bundles npm 10, which is why the publish job installs `npm@latest` before it publishes anything.

### 3. Provenance

Provenance is attached automatically under trusted publishing, so the workflow no longer passes `--provenance`.
It still requires a public repository, `id-token: write` in the workflow, and a GitHub-hosted runner.

### 4. Adding a platform package later

A trusted publisher can only be attached to a package that already exists, which leaves a new target with nothing to authenticate against on its very first publish.
Publish that one package manually with `npm publish --access public`, configure its trusted publisher, and the workflow takes over from the next release.

## Cutting a release

```bash
bun run version:set 0.4.0
git commit -am "Release v0.4.0"
git push origin main
git tag v0.4.0 && git push origin v0.4.0
```

The tag triggers `release.yml`, which:

1. **verify** - reruns typecheck and the test suite, and fails if the tag does not match `package.json`.
2. **build** - compiles one binary per platform on its own runner.
3. **publish** - assembles the platform packages, publishes them **first**, then publishes `open-usage`, then creates the GitHub release with the binaries attached.

The order matters.
`open-usage` pins exact platform versions, so publishing it first would briefly advertise packages that do not exist.

`optionalDependencies` are deliberately **not** committed to `package.json`.
They are injected during the publish step by `scripts/build-npm-packages.ts`, because a committed pin would reference unpublished versions and break `bun install --frozen-lockfile` for contributors.

## Verifying a release

```bash
npm view open-usage version
npm install -g open-usage && open-usage --version
```

On a machine with no Bun installed, confirm the binary still runs.
That is the whole point of the platform-package layout.

## If a release goes wrong

npm forbids republishing a version, so bump the patch rather than trying to overwrite.

```bash
npm deprecate open-usage@0.4.0 "Broken release, use 0.4.1"
```

Unpublishing is only possible within 72 hours and breaks anyone who already installed.
Prefer `deprecate`.
