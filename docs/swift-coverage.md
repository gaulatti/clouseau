# Swift coverage

Swift is read through the existing `lcov` part with declared `.swift` sources. There is no
Swift-specific adapter and no instrumenter owned by Clouseau: the producer is the toolchain's own
`llvm-cov`, and Clouseau validates what it writes.

## Producer recipe

SwiftPM, macOS (Xcode toolchain). The commands are qualified against Apple Swift 6.4 / LLVM 21 by
`src/coverage-swift.test.cjs`, which runs them on `test/fixtures/swift/pkg` when the toolchain is installed.

```sh
swift test --enable-code-coverage
products="$(dirname "$(dirname "$(swift test --show-codecov-path)")")"   # .build/.../Debug
xcrun llvm-cov export -format=lcov \
  -instr-profile="$products/codecov/default.profdata" \
  "$products/<Bundle>.xctest/Contents/MacOS/<Bundle>" > coverage/swift.lcov
```

On Linux the test bundle is a single `.build/debug/<Bundle>.xctest` executable and the tool is
`llvm-cov` from the same toolchain; the report format is the same, but only macOS is qualified here.

Recipe part (see [changed-line coverage](changed-line-coverage.md#swift-rust-and-other-lcov-languages) for the
suffix rules):

```json
{"format": "lcov", "report": "coverage/swift.lcov", "source_directory": "Sources", "source_suffixes": [".swift"]}
```

Point `source_directory` at the sources (`Sources`), not the package root: `Package.swift` is a `.swift` file
that no report contains and would fail as missing coverage. `Tests` directories and the SwiftPM `.build`
directory are excluded; generated files such as `test_entry_point.swift` live outside the source directory and are ignored.

## What the gate measures

- `lines` is the report's distinct `DA` records, covered when the hit count is positive. An application
  `.swift` file the report omits fails (`Missing application source coverage`); it never leaves the denominator.
- `branches` is **not measured**. Swift's compiler emits code and skipped regions, not branch outcomes
  ([swiftlang/swift#81730](https://github.com/swiftlang/swift/issues/81730)), so `llvm-cov` writes `BRF:0` and no
  `BRDA`. Branches stay `0/0`, never 100%, and every command prints a note saying so. The exact gate
  therefore **fails a pure Swift part with `No branches measured`**, even when every line is covered. Region,
  function or line counts are not converted into branches.
- A plan that also contains a part with measured branches can include a Swift part; its branches still count
  as not measured, and the note identifies it. That does not prove any Swift branch outcome.

A genuine Swift branch route needs a named, versioned instrumenter that records branch outcomes; it is tracked in
gaulatti/clouseau#73. Until one is qualified, a pure Swift repository cannot satisfy the exact gate.
