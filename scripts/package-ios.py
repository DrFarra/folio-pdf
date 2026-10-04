"""Verify an unsigned DEVICE IPA and package it separately from simulator .app."""
from pathlib import Path
import argparse, hashlib, json, os, plistlib, shutil, stat, subprocess, sys, tempfile, zipfile

ROOT = Path(__file__).resolve().parent.parent
MUPDF_SHA = 'dc94c60b2537e2ac9a2d379dd3801545f84a3a302d15c9da358362a1270707c3'
parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True, type=Path)
parser.add_argument('--build-dir', required=True, type=Path)
parser.add_argument('--mupdf-source', required=True, type=Path)
args = parser.parse_args()
if sys.platform != 'darwin': raise SystemExit('La entrega iOS se verifica en macOS con las herramientas Mach-O de Apple.')
version = json.loads((ROOT / 'package.json').read_text())['version']
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
build = args.build_dir.resolve()
source_ipa = build / f'Folio_{version}_iphone_arm64_unsigned.ipa'
simulator_app = build / 'simulator/Folio.app'

def require(condition, message):
    if not condition: raise RuntimeError(message)

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def run(*cmd):
    result = subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True, text=True)
    return (result.stdout + '\n' + result.stderr).strip()

def report(name):
    path = ROOT / 'test-results/ios' / name
    result = json.loads(path.read_text())
    require(result.get('passed') and result.get('version') == version, f'No pasó la prueba nativa {name} de esta versión.')
    return result

def verify_bundle(app, simulator=False):
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    require(info.get('CFBundleIdentifier') == 'org.folio.pdf', 'Identificador de aplicación inesperado.')
    require(info.get('CFBundleShortVersionString') == version and info.get('CFBundleVersion') == version, 'El bundle pertenece a otra versión.')
    require(info.get('MinimumOSVersion') == '17.0', 'El bundle no declara iOS 17 mínimo.')
    require(set(info.get('UIDeviceFamily', [])) == {1, 2}, 'El bundle no admite iPhone e iPad.')
    require(info.get('UIFileSharingEnabled') and info.get('LSSupportsOpeningDocumentsInPlace'), 'Faltan los ajustes de Archivos de iOS.')
    supported = [kind for t in info.get('CFBundleDocumentTypes', []) for kind in t.get('LSItemContentTypes', [])]
    require('com.adobe.pdf' in supported, 'Falta la asociación pública de PDF.')
    require(not any(k.endswith('UsageDescription') for k in info), 'La aplicación solicita permisos de privacidad innecesarios.')
    exe = app / info['CFBundleExecutable']
    require(exe.is_file() and exe.stat().st_mode & 0o111, 'Falta el ejecutable de iOS.')
    require(b'FOLIO_NATIVE_QA_BUILD' not in exe.read_bytes(), 'El bundle final incluye native-qa.')
    require(run('lipo', '-archs', str(exe)).split() == ['arm64'], 'El ejecutable no es arm64 nativo.')
    platforms = run('vtool', '-show-build', str(exe)).upper()
    expected = 'IOSSIMULATOR' if simulator else 'IOS'
    lines = [line.split()[-1] for line in platforms.splitlines() if line.strip().startswith('PLATFORM ')]
    require(lines and all(p == expected for p in lines), f'Mach-O con plataforma incorrecta; esperaba {expected}.')
    for resource in ['LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'SOURCE-BUILD.txt']:
        found = list(app.rglob(resource))
        require(found and any(p.is_file() for p in found), f'Falta el recurso legal {resource}.')
    require(not list(app.rglob('embedded.mobileprovision')), 'La entrega contiene un perfil de aprovisionamiento privado.')
    require(not any(p.suffix.lower() in {'.p12', '.pfx', '.pem', '.key'} for p in app.rglob('*') if p.is_file()), 'La entrega contiene material de firma.')
    return {'identifier': info['CFBundleIdentifier'], 'version': version, 'minimumIOS': '17.0', 'families': info['UIDeviceFamily'],
            'architecture': 'arm64', 'machoPlatform': expected, 'executableSha256': sha(exe)}

qa = report('native-smoke-ios-qa.json')
production = report('native-smoke-ios.json')
require(qa.get('nativeQA') and not production.get('nativeQA'), 'Las pruebas no distinguen QA y producción.')
require(source_ipa.is_file(), 'Falta la IPA de dispositivo compilada por Tauri.')
with tempfile.TemporaryDirectory(prefix='folio-ios-verify-') as directory:
    directory = Path(directory)
    with zipfile.ZipFile(source_ipa) as ipa:
        require(ipa.testzip() is None, 'La IPA contiene un archivo corrupto.')
        names = ipa.namelist()
        require(all(n.startswith('Payload/') and not n.startswith('/') and '..' not in Path(n).parts for n in names), 'La IPA contiene rutas fuera de Payload.')
        apps = {n.split('/')[1] for n in names if n.count('/') >= 2 and n.split('/')[1].endswith('.app')}
        require(len(apps) == 1, 'La IPA debe contener exactamente una aplicación.')
        ipa.extractall(directory)
        device_app = directory / 'Payload' / next(iter(apps))
        # Python ZipFile does not restore mode; use the checked executable's ZIP
        # Unix metadata to retain the permissions declared by Tauri.
        info = plistlib.loads((device_app / 'Info.plist').read_bytes())
        member = ipa.getinfo(f'Payload/{device_app.name}/{info["CFBundleExecutable"]}')
        require((member.external_attr >> 16) & 0o111, 'La IPA no preserva permisos de ejecución.')
        (device_app / info['CFBundleExecutable']).chmod(0o755)
        device = verify_bundle(device_app)
        signed = subprocess.run(['codesign', '-d', '--verbose=4', str(device_app)], capture_output=True, text=True)
        require('Authority=' not in signed.stderr, 'La IPA tiene un certificado de Apple incorporado.')
simulator = verify_bundle(simulator_app, simulator=True)
require(simulator['executableSha256'] == production['executableSha256'], 'El bundle de simulador no coincide con el smoke de producción.')
require(sha(args.mupdf_source) == MUPDF_SHA, 'El código MuPDF correspondiente no coincide con el esperado.')

shutil.copy2(source_ipa, out / source_ipa.name)
run('ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(simulator_app), str(out / f'Folio-{version}-ios-simulator-arm64.app.zip'))
for name in ['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'SOURCE-BUILD.txt', 'dependency-licenses.json']:
    shutil.copy2(ROOT / name, out / name)
require((ROOT / 'SOURCE-BUILD.txt').read_text().startswith(f'Folio {version} — iOS source'), 'Las instrucciones de fuente no corresponden a esta entrega iOS.')
require(f'folio-{version}-fuente.zip' in (ROOT / 'SOURCE-BUILD.txt').read_text(), 'Las instrucciones nombran una fuente de otra versión.')
require(f'Folio {version}' in (ROOT / 'docs/ios.md').read_text(), 'La guía iPhone pertenece a otra versión.')
swift_dependencies = json.loads((ROOT / 'scripts/ios-swift-dependencies.json').read_text())
swift_locks = json.loads((ROOT / 'test-results/ios/swift-package-locks.json').read_text())
require(swift_locks.get('verified'), 'No se verificó la revisión SwiftRs compilada.')
for item in swift_dependencies['SwiftRs']['licenses'].values():
    require(sha(ROOT / item['path']) == item['sha256'], 'La licencia SwiftRs no coincide.')
    shutil.copy2(ROOT / item['path'], out / ('SwiftRs-' + Path(item['path']).name))
shutil.copy2(ROOT / 'docs/ios.md', out / 'README_iPhone.md')
shutil.copy2(args.mupdf_source, out / args.mupdf_source.name)
source = out / f'folio-{version}-fuente.zip'
tracked = run('git', 'ls-files', '-z').split('\x00')
count = 0
with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED, compresslevel=7) as archive:
    for name in sorted(tracked):
        if not name: continue
        require(not any(part in {'node_modules', 'dist', 'target', '.git', '.tools', '.tauri', 'release', 'test-results', '.fixtures'} for part in Path(name).parts), 'La fuente contiene rutas excluidas.')
        require(Path(name).suffix.lower() not in {'.p12', '.pfx', '.pem', '.key'}, 'La fuente contiene material de firma.')
        archive.write(ROOT / name, name)
        count += 1
with zipfile.ZipFile(source) as archive: require(archive.testzip() is None, 'El ZIP de fuente no es íntegro.')

evidence = out / 'evidence'
evidence.mkdir(exist_ok=True)
for folder in [ROOT / 'test-results/ios', ROOT / 'test-results/iphone']:
    for p in folder.glob('*'):
        if p.is_file() and p.suffix in {'.json', '.png'} and not p.name.startswith('cargo-metadata'):
            shutil.copy2(p, evidence / p.name)
manifest = {'product': 'Folio', 'version': version, 'platform': 'iOS', 'device': device, 'simulator': simulator,
            'signing': 'unsigned device IPA; user signs with Feather and a valid certificate/profile',
            'AppleCertificateIncluded': False, 'ProvisioningProfileIncluded': False,
            'physicalDeviceTested': False, 'FeatherInstallationTested': False,
            'UIKitDialogInteractionTested': False, 'AirPrintJobTested': False,
            'nativeSimulatorQA': qa['passed'], 'nativeSimulatorProduction': production['passed'],
            'gitCommit': run('git', 'rev-parse', 'HEAD'), 'sourceFiles': count,
            'correspondingMuPDFSourceSha256': MUPDF_SHA,
            'swiftDependencies': swift_dependencies, 'swiftLocksVerified': True,
            'artifacts': [{'path': str(p.relative_to(out)).replace('\\', '/'), 'bytes': p.stat().st_size, 'sha256': sha(p)}
                          for p in sorted(out.rglob('*')) if p.is_file() and p.name not in {'release-manifest.json', 'SHA256SUMS.txt'}]}
(out / 'release-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
(out / 'SHA256SUMS.txt').write_text(''.join(f'{sha(p)}  {p.relative_to(out).as_posix()}\n' for p in sorted(out.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS.txt'))
print(json.dumps({'passed': True, 'out': str(out), 'device': device, 'sourceFiles': count}, indent=2))
