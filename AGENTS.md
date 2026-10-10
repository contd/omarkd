# Testing requirements

- Put every new or updated unit test in `tests/`, including Rust tests loaded with
  `#[cfg(test)]` path modules. Do not add inline test modules to production code.
- Cover new features, functions, failure paths, and regressions with unit tests.
- Put Playwright feature tests and their browser bridge in `e2e/`. Use the real Rust
  renderer for document fixtures; mock only native desktop APIs in browser tests.
- Add or update Playwright coverage for each user-facing feature. Native OS dialogs,
  Finder associations, and single-instance/window lifecycle behavior require a
  separate native smoke check; browser mocks do not verify those integrations.
- Store intentional feature screenshots in `assets/screenshots/` and reference
  them in the README Features section. Generate them with `bun run test:screenshots`;
  never overwrite documentation screenshots in ordinary test runs.
- Run `bun run test:unit`, `bun run test:e2e`, `bun run test:types`, and
  `bun run build` before completing a feature change. See README for setup.
- Unit runs enforce per-file TypeScript coverage: 100% functions, 95% lines and
  statements, and 85% branches. Do not reduce thresholds to accommodate a change.
