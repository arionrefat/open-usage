# Releasing

`open-usage` ships as six npm packages plus a set of GitHub release binaries.

| Package                    | Contents                                  |
| -------------------------- | ----------------------------------------- |
| `open-usage`               | a ~17 kB Node launcher, no runtime deps    |
| `@open-usage/darwin-arm64` | the compiled binary for that platform      |
| `@open-usage/darwin-x64`   | "                                          |
| `@open-usage/linux-x64`    | "                                          |
| `@open-usage/linux-arm64`  | "                                          |
| `@open-usage/win32-x64`    | "                                          |

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

### 2. Create the publish token

Use a **Granular Access Token**, not a classic one.
Classic tokens with 2FA enabled will prompt for an OTP and hang the workflow.

1. npm → Access Tokens → Generate New Token → Granular Access Token.
2. Permission: **Read and write**.
3. Packages and scopes: select the `@open-usage` scope *and* the `open-usage` package.
   The token must cover packages that do not exist yet, so grant it at scope level rather than per package.
4. Set an expiry you will actually track, and note the renewal date.

### 3. Store it in the repository

GitHub → Settings → Secrets and variables → Actions → New repository secret.

- Name: `NPM_TOKEN`
- Value: the token from step 2

### 4. Check the provenance requirements

The workflow publishes with `--provenance`, which attaches a signed link from the package back to the commit and workflow that built it.
It needs all of the following, and the publish step fails if any is missing:

- the repository is **public**
- the workflow has `id_token: write` (already set in [`release.yml`](../.github/workflows/release.yml))
- the run happens on a GitHub-hosted runner

If you want to keep the repository private for now, drop `--provenance` from both publish steps.

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
