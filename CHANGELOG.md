# Changelog

All notable changes to CodePi are documented in this file.

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
