"""Run the actual Folio WKWebView and Rust persistence in an iPhone Simulator.

This is a simulator smoke, never a physical-device/Feather installation claim.
UIKit dialog and AirPrint availability are distinct from interaction testing.
"""
from pathlib import Path
import argparse, hashlib, json, os, plistlib, shutil, subprocess, sys, time

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--app', required=True, type=Path)
parser.add_argument('--qa', action='store_true')
args = parser.parse_args()
if sys.platform != 'darwin': raise SystemExit('La prueba iOS nativa requiere macOS y un simulador iPhone real.')
out = root / 'test-results/ios'
out.mkdir(parents=True, exist_ok=True)
version = json.loads((root / 'package.json').read_text())['version']
app = args.app.resolve()
info = plistlib.loads((app / 'Info.plist').read_bytes())
report = {'version': version, 'platform': 'iOS Simulator', 'nativeWKWebView': True,
          'architecture': 'arm64', 'nativeQA': args.qa, 'passed': False,
          'physicalDeviceTested': False, 'FeatherSigningTested': False,
          'UIKitDialogInteractionTested': False, 'AirPrintJobTested': False}
device = None
data = None

def run(*cmd):
    return subprocess.run(cmd, cwd=root, check=True, capture_output=True, text=True).stdout.strip()

def wait_file(folder, filename, condition, timeout=80):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for p in folder.rglob(filename):
            try:
                value = json.loads(p.read_text())
                if condition(value): return value
            except (OSError, ValueError): pass
        time.sleep(.3)
    raise AssertionError(f'El WKWebView no completó {filename}.')

try:
    assert info['CFBundleIdentifier'] == 'org.folio.pdf'
    assert info['CFBundleShortVersionString'] == version
    assert info['MinimumOSVersion'] == '17.0'
    executable = app / info['CFBundleExecutable']
    assert 'arm64' in run('lipo', '-archs', str(executable))
    assert 'IOSSIMULATOR' in run('vtool', '-show-build', str(executable)).upper()
    has_marker = b'FOLIO_NATIVE_QA_BUILD' in executable.read_bytes()
    assert has_marker == args.qa, 'La variante QA no coincide con el bundle.'
    # An unsigned simulator .app is signed ad hoc locally; it is never placed
    # inside the device IPA or represented as a Feather-installable artifact.
    run('codesign', '--force', '--deep', '--sign', '-', str(app))
    report['executableSha256'] = hashlib.sha256(executable.read_bytes()).hexdigest()
    runtimes = json.loads(run('xcrun', 'simctl', 'list', 'runtimes', '--json'))['runtimes']
    runtimes = [r for r in runtimes if r.get('isAvailable') and 'iOS' in r['name']]
    assert runtimes, 'No hay runtime iOS instalado en Xcode.'
    # This workflow uses Xcode 16.4; installed runtimes for Xcode 26 can also
    # appear in simctl's inventory but are not the intended tested platform.
    runtime = next((r for r in runtimes if r['version'] == '18.5'), None)
    if runtime is None:
        compatible = [r for r in runtimes if tuple(int(n) for n in r['version'].split('.')) < (19,)]
        assert compatible, 'No hay runtime iOS 17/18 compatible con Xcode 16 disponible.'
        runtime = sorted(compatible, key=lambda r: tuple(int(n) for n in r['version'].split('.')))[-1]
    types = json.loads(run('xcrun', 'simctl', 'list', 'devicetypes', '--json'))['devicetypes']
    phone = next((d for d in types if d['name'] == 'iPhone 16 Pro'), None)
    if phone is None:
        phone = next((d for d in types if d.get('productFamily') == 'iPhone' or 'iPhone' in d['name']), None)
    assert phone, 'No hay tipo de dispositivo iPhone disponible.'
    device = run('xcrun', 'simctl', 'create', 'Folio-iPhone-QA' if args.qa else 'Folio-iPhone', phone['identifier'], runtime['identifier'])
    report.update({'runtime': runtime['name'], 'device': phone['name']})
    run('xcrun', 'simctl', 'boot', device)
    run('xcrun', 'simctl', 'bootstatus', device, '-b')
    run('xcrun', 'simctl', 'status_bar', device, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100')
    run('xcrun', 'simctl', 'install', device, str(app))
    data = Path(run('xcrun', 'simctl', 'get_app_container', device, 'org.folio.pdf', 'data'))
    documents = data / 'Documents'
    documents.mkdir(exist_ok=True)
    fixture = root / 'public/sample.pdf'
    copied = documents / 'Folio iPhone.pdf'
    shutil.copy2(fixture, copied)
    digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
    started = int(time.time() * 1000)
    run('xcrun', 'simctl', 'launch', device, 'org.folio.pdf', str(copied))
    session = wait_file(data, f'{digest}.json', lambda s: s.get('version') == 3 and s.get('documentRevision') == digest)
    report['session'] = {'version': session['version'], 'documentRevision': session['documentRevision']}
    assert hashlib.sha256(copied.read_bytes()).hexdigest() == digest, 'El original cambió al leerlo.'
    if args.qa:
        diagnostic = wait_file(data, 'f' * 64 + '.json', lambda d: d.get('snapshot', {}).get('at', 0) >= started and any(r.get('checksCompleted') for r in d.get('documents', {}).values()))
        (out / 'native-qa-ios.json').write_text(json.dumps(diagnostic, ensure_ascii=False, indent=2))
        assert diagnostic['buildMarker'] == 'FOLIO_NATIVE_QA_BUILD'
        assert not diagnostic.get('errors'), json.dumps(diagnostic.get('errors'), ensure_ascii=False)
        assert not diagnostic.get('persistError'), diagnostic.get('persistError')
        checked = next(r for r in diagnostic['documents'].values() if r.get('checksCompleted'))
        assert checked.get('selectionMatchesSpan'), 'La selección nativa de texto no coincide.'
        assert checked.get('search', {}).get('found'), 'Buscar Folio no devolvió resultados en WKWebView.'
        native = diagnostic.get('iosNative')
        assert native and native.get('platform') == 'iOS' and native.get('uiAvailable'), 'No respondió el puente Swift/UIKit.'
        report['nativeBridge'] = native
        require_clipboard = checked.get('nativeClipboardWritten')
        assert require_clipboard, 'La copia nativa no se completó.'
        pasted = run('xcrun', 'simctl', 'pbpaste', device)
        assert pasted == checked['selectedText'].strip(), 'El portapapeles del simulador no coincide con el texto PDF.'
        report['nativeClipboardVerified'] = True
        viewport = diagnostic['snapshot']['document']
        assert viewport['scrollWidth'] <= viewport['width'] + 1, 'La aplicación completa desborda horizontalmente.'
        report['documentDiagnostic'] = checked
    time.sleep(2)
    screenshot = out / ('folio-iphone-qa.png' if args.qa else 'folio-iphone.png')
    run('xcrun', 'simctl', 'io', device, 'screenshot', str(screenshot))
    # Relaunch the same sandbox with the fixture: real persistence and startup
    # paths must survive, independent of Safari IndexedDB/browser mocks.
    run('xcrun', 'simctl', 'terminate', device, 'org.folio.pdf')
    run('xcrun', 'simctl', 'launch', device, 'org.folio.pdf', str(copied))
    wait_file(data, f'{digest}.json', lambda s: s.get('version') == 3)
    report['sandboxPersistenceVerified'] = True
    report['passed'] = True
except Exception as error:
    report['failure'] = f'{type(error).__name__}: {error}'
    raise
finally:
    # Never delete the only useful failure evidence with the ephemeral device.
    # A probe timeout must still retain the current rendered screen and partial
    # diagnostics, even when no document reached checksCompleted.
    if device and not report['passed']:
        if args.qa and data:
            for p in data.rglob('f' * 64 + '.json'):
                try:
                    (out / 'native-qa-ios-partial.json').write_bytes(p.read_bytes())
                    break
                except OSError: pass
        screenshot = out / ('folio-iphone-qa-failure.png' if args.qa else 'folio-iphone-failure.png')
        subprocess.run(['xcrun', 'simctl', 'io', device, 'screenshot', str(screenshot)], capture_output=True)
    (out / ('native-smoke-ios-qa.json' if args.qa else 'native-smoke-ios.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    if device:
        subprocess.run(['xcrun', 'simctl', 'shutdown', device], capture_output=True)
        subprocess.run(['xcrun', 'simctl', 'delete', device], capture_output=True)
print(json.dumps(report, ensure_ascii=False, indent=2))
