// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "Tiny",
  targets: [
    .target(name: "Tiny"),
    .testTarget(name: "TinyTests", dependencies: ["Tiny"]),
  ]
)
