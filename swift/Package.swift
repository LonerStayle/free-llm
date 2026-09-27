// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "FreeLLMRouter",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "FreeLLMRouter", targets: ["FreeLLMRouter"]),
    ],
    targets: [
        .target(name: "FreeLLMRouter"),
        .testTarget(name: "FreeLLMRouterTests", dependencies: ["FreeLLMRouter"]),
    ],
    swiftLanguageModes: [.v6]
)
