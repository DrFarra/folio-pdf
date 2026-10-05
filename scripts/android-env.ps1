# Toolchain paths are local to this process. Existing Android Studio paths win.
$folioAndroidRoot = Join-Path (Split-Path $PSScriptRoot -Parent) '.tools/android'
if (!$env:JAVA_HOME -and (Test-Path "$folioAndroidRoot/java")) { $env:JAVA_HOME = (Get-ChildItem -Directory "$folioAndroidRoot/java" | Select-Object -First 1).FullName }
if (!$env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $folioAndroidRoot 'sdk' }
if (!$env:NDK_HOME) { $env:NDK_HOME = Join-Path $env:ANDROID_HOME 'ndk/29.0.14206865' }
$folioPortable = Join-Path (Split-Path $PSScriptRoot -Parent) '.tools'
if (Test-Path "$folioPortable/cargo/bin") { $env:CARGO_HOME = Join-Path $folioPortable 'cargo'; $env:RUSTUP_HOME = Join-Path $folioPortable 'rustup'; $env:PATH = "$env:CARGO_HOME/bin;$env:PATH" }
$env:PATH = "$env:JAVA_HOME/bin;$env:ANDROID_HOME/platform-tools;$env:PATH"
# Native TLS dependencies (ring) need Android's compiler, while build scripts
# still use the host compiler configured by windows-env.ps1.
$folioNdkBin = Join-Path $env:NDK_HOME 'toolchains/llvm/prebuilt/windows-x86_64/bin'
if (Test-Path -LiteralPath $folioNdkBin) {
    $env:CC_aarch64_linux_android = Join-Path $folioNdkBin 'aarch64-linux-android26-clang.cmd'
    $env:CXX_aarch64_linux_android = Join-Path $folioNdkBin 'aarch64-linux-android26-clang++.cmd'
    $env:AR_aarch64_linux_android = Join-Path $folioNdkBin 'llvm-ar.exe'
    $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = $env:CC_aarch64_linux_android
}
