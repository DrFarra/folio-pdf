# Entorno de compilación portátil de esta estación. Solo modifica el proceso actual.
$folioRoot = Split-Path $PSScriptRoot -Parent
$folioTools = Join-Path $folioRoot '.tools'
$env:RUSTUP_HOME = Join-Path $folioTools 'rustup'
$env:CARGO_HOME = Join-Path $folioTools 'cargo'
$folioToolchain = Join-Path $env:RUSTUP_HOME 'toolchains\stable-x86_64-pc-windows-msvc'
$folioSysroot = Join-Path $folioTools 'windows-sysroot'
$folioVc = Join-Path $folioSysroot 'VC\Tools\MSVC\14.44.17.14'
$folioSdk = Join-Path $folioSysroot 'Windows Kits\10'
$folioSdkBin = Join-Path $folioTools 'sdk-buildtools\bin\10.0.26100.0\x64'
$folioClangBin = Join-Path $folioTools 'clang\bin'
$folioLld = Join-Path $folioTools 'llvm\lld-link.exe'
if (!(Test-Path -LiteralPath $folioLld)) {
    New-Item -ItemType Directory -Path (Split-Path $folioLld -Parent) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $folioToolchain 'lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe') -Destination $folioLld
}
$env:PATH = "$(Join-Path $env:CARGO_HOME 'bin');$folioSdkBin;$folioClangBin;$(Split-Path $folioLld -Parent);$env:PATH"
$env:LIB = @(
    (Join-Path $folioVc 'lib\x64'),
    (Join-Path $folioSdk 'Lib\10.0.26100\um\x64'),
    (Join-Path $folioSdk 'Lib\10.0.26100\ucrt\x64')
) -join ';'
$env:INCLUDE = @(
    (Join-Path $folioVc 'include'),
    (Join-Path $folioSdk 'Include\10.0.26100\ucrt'),
    (Join-Path $folioSdk 'Include\10.0.26100\um'),
    (Join-Path $folioSdk 'Include\10.0.26100\shared'),
    (Join-Path $folioSdk 'Include\10.0.26100\winrt')
) -join ';'
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $folioLld
$env:CC = Join-Path $folioClangBin 'clang-cl.exe'
$env:CXX = $env:CC
$env:AR = Join-Path $folioClangBin 'llvm-lib.exe'
$env:VSCMD_ARG_TGT_ARCH = 'x64'
$env:RC = Join-Path $folioSdkBin 'rc.exe'
$env:WindowsSdkDir = "$folioSdk\"
$env:WindowsSDKVersion = '10.0.26100\'
