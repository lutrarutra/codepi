# Changelog

All notable changes to CodePi are documented in this file.

## 0.4.1

- **Fix broken 0.4.0 release**: the GitHub Actions publish workflow passed
  `vsce package --no-dependencies`, so the published vsix shipped without
  `node_modules`. The extension died at activation (`Cannot find module
  '@earendil-works/pi-coding-agent'`) and every command failed with
  "command 'codepi.openPanel' not found". Packaging now bundles production
  dependencies again, and CI verifies the vsix contains them before
  publishing.

## 0.2.1

- Add GitHub Actions publishing workflow (tag-triggered, automated vsix build + publish)
- CI: run on Node 22 (jsdom 30 and undici 8 require Node >= 22.19; Node 20 crashes
  undici's CacheStorage with `webidl.util.markAsUncloneable is not a function`)
- Require VS Code >= 1.105 (first stable release whose extension host ships
  Node >= 22.19, required by undici 8)
- Slim the vsix: exclude dev-only files (docs, patches, build configs, CI files)

## 0.2.0

- Update to pi 0.84.0
- Packaging: vsix version syncs to the latest git tag (`make vsix`)

## 0.1.0

- Initial release
