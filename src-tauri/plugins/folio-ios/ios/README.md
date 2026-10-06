# UIKit implementation

Requires iOS 17. Native Swift sources are included by the Tauri plugin build script through Swift Package Manager. No certificate or provisioning profile is stored in this package. `PrivacyInfo.xcprivacy` is the application's privacy manifest; scripts/build-ios.mjs adds it to the Xcode app target. See docs/ios.md in the project root for building and Feather signing.
