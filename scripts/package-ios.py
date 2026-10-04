"""Verify an unsigned DEVICE IPA and package it separately from simulator .app."""
from pathlib import Path
import argparse, hashlib, json, os, plistlib, shutil, stat, subprocess, sys, tempfile, zipfile
from ios_icon_audit import verify_compiled_icons

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
    require(info.get('UIFileSharingEnabled') is True and info.get('LSSupportsOpeningDocumentsInPlace') is False and
            info.get('UISupportsDocumentBrowser') is False, 'El bundle no declara importación por copia y acceso desde Archivos.')
    supported = [kind for t in info.get('CFBundleDocumentTypes', []) for kind in t.get('LSItemContentTypes', [])]
    require('com.adobe.pdf' in supported, 'Falta la asociación pública de PDF.')
    for key, expected_files in [('CFBundleIcons', {'AppIcon60x60'}), ('CFBundleIcons~ipad', {'AppIcon60x60', 'AppIcon76x76'})]:
        primary = info.get(key, {}).get('CFBundlePrimaryIcon', {})
        require(primary.get('CFBundleIconName') == 'AppIcon' and
                expected_files.issubset(set(primary.get('CFBundleIconFiles', []))),
                'El bundle no declara los iconos principales de Folio para iPhone e iPad.')
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
for name, smoke in [('QA', qa), ('producción', production)]:
    fresh = smoke.get('relaunch', {})
    before, after = fresh.get('previousRevision'), fresh.get('freshRevision')
    require(smoke.get('sandboxPersistenceVerified') is True and
            type(before) is int and before > 0 and type(after) is int and after > before and
            type(fresh.get('startedAt')) is int and fresh['startedAt'] > 0 and
            fresh.get('fixtureBookmarkSeededWhileStopped') is True and
            isinstance(fresh.get('restoredFixtureBookmark'), str) and fresh['restoredFixtureBookmark'].startswith('native-smoke-'),
            f'Falta evidencia nueva de lectura y escritura tras reabrir la app de {name}.')
fresh_qa = qa['relaunch']
require(all(fresh_qa.get(key) is True for key in ['selectionVerified', 'searchVerified', 'nativeBridgeVerified', 'nativeClipboardVerified']) and
        type(fresh_qa.get('freshDiagnosticAt')) is int and fresh_qa['freshDiagnosticAt'] >= fresh_qa['startedAt'] and
        type(fresh_qa.get('freshChecksStartedAt')) is int and fresh_qa['freshChecksStartedAt'] >= fresh_qa['startedAt'],
        'La reapertura QA no repitió selección, búsqueda, Swift y portapapeles con evidencia nueva.')
relaunch_diagnostic = json.loads((ROOT / 'test-results/ios/native-qa-ios-relaunch.json').read_text())
require(relaunch_diagnostic.get('buildMarker') == 'FOLIO_NATIVE_QA_BUILD' and
        not relaunch_diagnostic.get('errors') and not relaunch_diagnostic.get('persistError') and
        relaunch_diagnostic.get('snapshot', {}).get('at') == fresh_qa['freshDiagnosticAt'] and
        relaunch_diagnostic.get('iosNative', {}).get('platform') == 'iOS' and
        relaunch_diagnostic.get('iosNative', {}).get('uiAvailable') is True and
        any(d.get('checksCompleted') is True and not d.get('error') and
            d.get('startedAt') == fresh_qa['freshChecksStartedAt'] and
            d.get('selectionMatchesSpan') is True and d.get('search', {}).get('found') is True and
            d.get('nativeClipboardWritten') is True for d in relaunch_diagnostic.get('documents', {}).values()),
        'El diagnóstico QA de reapertura no coincide con las verificaciones declaradas.')
require(source_ipa.is_file(), 'Falta la IPA de dispositivo compilada por Tauri.')
native_files = qa.get('nativeFileProbe', {})
native_files_evidence = report('native-pdfkit-ios.json')
require(native_files == native_files_evidence and native_files.get('swiftImportExecuted') is True and
        native_files.get('pdfKitExecuted') is True and native_files.get('wholeDocumentIPC') is False,
        'Falta la importación Swift y la lectura PDFKit reales por archivo.')
native_documents = native_files.get('documents', [])
require(len(native_documents) == 2 and any(d.get('document', {}).get('size', 0) > 2 * 1024**3 for d in native_documents),
        'Falta la lectura real del fixture PDF de más de 2 GiB.')
native_build = json.loads((ROOT / 'test-results/ios/mupdf-ios-build.json').read_text())
require(native_build.get('passed') is True and native_build.get('version') == '1.28.1' and
        native_build.get('sourceHash') == MUPDF_SHA and native_build.get('sourceModified') is False and
        native_build.get('minimumIOS') == '17.0' and
        native_build.get('buildScriptSha256') == sha(ROOT / 'scripts/build-mupdf-ios.mjs'),
        'El escritor nativo no corresponde a la fuente MuPDF y al builder fijados.')
wrapper = native_build.get('wrapper', {})
for name in ['NativeExport/FolioMuPDF.c', 'NativeExport/include/FolioMuPDF.h', 'NativeExport/include/module.modulemap']:
    require(wrapper.get(name) == sha(ROOT / 'src-tauri/plugins/folio-ios/ios' / name),
            'El ABI/escritor C compilado no coincide con la fuente entregada.')
libraries = native_build.get('libraries', [])
require(len(libraries) == 2 and {(v.get('sdk'), v.get('triple')) for v in libraries} ==
        {('iphoneos', 'arm64-apple-ios17.0'), ('iphonesimulator', 'arm64-apple-ios17.0-simulator')},
        'Faltan las bibliotecas MuPDF arm64 separadas de dispositivo y simulador.')
for library in libraries:
    path = Path(library['path'])
    require(path.is_file() and library.get('bytes') == path.stat().st_size and
            library.get('sha256') == sha(path) and run('lipo', '-archs', str(path)).split() == ['arm64'],
            'Una biblioteca MuPDF no conserva su arquitectura, tamaño y SHA-256 verificados.')
outputs = native_build.get('outputs', [])
require(outputs and all(Path(v['path']).is_file() and v.get('bytes') == Path(v['path']).stat().st_size and
        v.get('sha256') == sha(Path(v['path'])) for v in outputs), 'El XCFramework/tool compilado no conserva sus hashes.')
framework_info = plistlib.loads((Path(native_build['framework']) / 'Info.plist').read_bytes())
slices = framework_info.get('AvailableLibraries', [])
require(len(slices) == 2 and all(s.get('SupportedPlatform') == 'ios' and s.get('SupportedArchitectures') == ['arm64'] for s in slices) and
        {s.get('SupportedPlatformVariant', 'device') for s in slices} == {'device', 'simulator'},
        'El XCFramework no distingue las slices iPhone y simulador arm64.')
host_mutool = Path(native_build['hostMutool'])
require(host_mutool.is_file() and sha(host_mutool) == native_build.get('hostMutoolSha256') and
        '1.28.1' in run(str(host_mutool), '-v'), 'El validador independiente no corresponde al mutool fijado.')
for document in native_documents:
    require(document.get('annotationWriter') == 'MuPDF 1.28.1' and document.get('incremental') is True and
            all(document.get(flag) is True for flag in ['removedSourceAnnotation', 'addedNote', 'addedHighlightDefaultOpacity', 'unseenHighlightPreserved', 'unseenNonOverlayPreserved', 'originalOpacityAndNamePreserved', 'sourceUnchanged']) and
            document.get('independentExportVerification', {}).get('passed') is True and
            document.get('independentExportVerification', {}).get('nativeHostVerifier') is True and
            document.get('independentExportVerification', {}).get('engine') == 'MuPDF 1.28.1 native mutool' and
            document.get('independentExportVerification', {}).get('fileBacked') is True and
            document.get('independentExportVerification', {}).get('incrementalVersions', 0) >= 2 and
            document.get('independentExportVerification', {}).get('hostMutoolSha256') == native_build['hostMutoolSha256'] and
            document.get('independentExportVerification', {}).get('hostArchitectures') and
            set(document['independentExportVerification']['hostArchitectures']) <= {'arm64','x86_64'} and
            document.get('independentExportVerification', {}).get('unseenNonOverlayPreserved') is True and
            document.get('independentExportVerification', {}).get('addedHighlightDefaultOpacity') is True and
            document.get('independentExportVerification', {}).get('originalAppearanceAndWidgetPreserved') is True and
            document.get('originalPrefixPreserved') is True and document.get('originalPrefixSha256') == document.get('document', {}).get('id') and
            document.get('metadata', {}).get('numPages') == 2 and
            len(document.get('text', {}).get('lines', [])) > 1 and
            {r.get('rotation') for r in document.get('rasters', [])} == {0, 90, 180, 270} and
            {r.get('rotation') for r in document.get('rasters', []) if r.get('page') == 2 and r.get('intrinsicRotationVerified') == 90 and r.get('nonOverlayAnnotationVisible') is True} == {90,270} and
            all(r.get('geometryVerified') is True and (ROOT / 'test-results/ios' / r.get('inspectionFile', '')).is_file() for r in document.get('rasters', [])),
            'La evidencia PDFKit no demuestra texto, rotación, exportación y conservación del original.')
    if document['document']['size'] > 2*1024**3:
        require(document['independentExportVerification'].get('previousXrefOffset', 0) > 2147483647 and
                document['independentExportVerification'].get('xrefBeyond2GiB') is True,
                'El inspector nativo no validó una xref situada después de 2 GiB.')
memory = native_files.get('memory', {})
require(type(memory.get('peakBytes')) is int and 0 < memory['peakBytes'] < 768*1024**2 and
        type(memory.get('samples')) is int and memory['samples'] > 0 and memory.get('physicalDeviceMeasured') is False,
        'Falta la medida acotada de memoria residente del lector de 2 GiB en simulador.')
large_reader = qa.get('largeFrontendReader', {})
require(all(large_reader.get(flag) is True for flag in ['actualWKWebView','fileBackedAdapter','selectionVerified','searchVerified','sessionVerified','nativeClipboardVerified']) and
        large_reader.get('sourceBytes',0) > 2*1024**3 and
        large_reader.get('freshDiagnosticAt',0) >= large_reader.get('startedAt',1) and
        large_reader.get('checksStartedAt',0) >= large_reader.get('startedAt',1) and
        0 < large_reader.get('peakNativeProcessRSSBytes',0) < 768*1024**2,
        'Falta la apertura del PDF de 2 GiB en la interfaz WK/PDFKit real, con selección/búsqueda y memoria acotada.')
ui_imports = report('iphone-native-import-ui-results.json')
require(ui_imports.get('UIKitDialogInteractionTested') is True and ui_imports.get('OSOpenInInteractionTested') is True and
        ui_imports.get('sourceExecutableSha256') == production.get('executableSha256') and
        ui_imports.get('sourceBuildRole') == 'production' and ui_imports.get('sourceContainsNativeQA') is False and
        ui_imports.get('startupFixturePassedAsArgument') is False and ui_imports.get('pickerDelegateInjected') is False and
        ui_imports.get('javascriptOpenEventInjected') is False and
        ui_imports.get('xctest', {}).get('passed') == 2 and ui_imports.get('xctest', {}).get('failed') == 0 and
        ui_imports.get('xctest', {}).get('skipped') == 0 and len(ui_imports.get('fixtures', [])) == 4 and
        all(f.get('nativeImportCopies', 0) > 0 and f.get('nativeSessionVersion') == 3 and
            f.get('nativeDocumentRevision') == f.get('sha256') for f in ui_imports.get('fixtures', [])),
        'Faltan pruebas reales de selección con UIKit y Open In de iOS, con copias y sesiones persistidas.')
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
        icons = verify_compiled_icons(device_app, ROOT / 'src-tauri/icons/ios', ROOT / 'test-results/ios')
        device['compiledIconsVerified'] = icons['passed']
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
            'UIKitDialogInteractionTested': ui_imports['UIKitDialogInteractionTested'],
            'OSOpenInInteractionTested': ui_imports['OSOpenInInteractionTested'], 'AirPrintJobTested': False,
            'nativeFileBackedPDFKitVerified': True, 'nativeTwoGiBFixtureVerified': True, 'nativeIncrementalWriterVerified': True,
            'nativeSimulatorQA': qa['passed'], 'nativeSimulatorProduction': production['passed'],
            'gitCommit': run('git', 'rev-parse', 'HEAD'), 'sourceFiles': count,
            'correspondingMuPDFSourceSha256': MUPDF_SHA,
            'swiftDependencies': swift_dependencies, 'swiftLocksVerified': True,
            'artifacts': [{'path': str(p.relative_to(out)).replace('\\', '/'), 'bytes': p.stat().st_size, 'sha256': sha(p)}
                          for p in sorted(out.rglob('*')) if p.is_file() and p.name not in {'release-manifest.json', 'SHA256SUMS.txt'}]}
(out / 'release-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
(out / 'SHA256SUMS.txt').write_text(''.join(f'{sha(p)}  {p.relative_to(out).as_posix()}\n' for p in sorted(out.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS.txt'))
print(json.dumps({'passed': True, 'out': str(out), 'device': device, 'sourceFiles': count}, indent=2))
