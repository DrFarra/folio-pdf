"""Run the actual Folio WKWebView and Rust persistence in an iPhone Simulator.

This is a simulator smoke, never a physical-device/Feather installation claim.
UIKit dialog and AirPrint availability are distinct from interaction testing.
"""
from pathlib import Path
import argparse, hashlib, json, os, plistlib, shutil, subprocess, sys, time, uuid, importlib.util, re

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
process_id = None
rss_samples = []
last_memory_sample = 0

def observe_memory():
    global last_memory_sample
    if not process_id or time.monotonic() - last_memory_sample < 1: return
    last_memory_sample = time.monotonic()
    sample = subprocess.run(['ps', '-p', str(process_id), '-o', 'rss='], capture_output=True, text=True)
    if sample.returncode == 0 and sample.stdout.strip().isdigit(): rss_samples.append(int(sample.stdout.strip()) * 1024)

def run(*cmd):
    return subprocess.run(cmd, cwd=root, check=True, capture_output=True, text=True).stdout.strip()

def wait_file(folder, filename, condition, timeout=80):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        observe_memory()
        for p in folder.rglob(filename):
            try:
                value = json.loads(p.read_text())
                if condition(value): return value
            except (OSError, ValueError): pass
        time.sleep(.3)
    raise AssertionError(f'El WKWebView no completó {filename}.')

def validate_pdfkit_rasters(result):
    sys.path.insert(0, str(root / 'scripts'))
    from ios_icon_audit import decode_png
    for item in result['documents']:
        item['independentExportVerification'] = json.loads(run('node', 'scripts/tests/verify-pdfkit-export.mjs', item['exportedPath']))
        for raster in item['rasters']:
            page = raster.get('page', 1)
            view = item['pageInfo' if page == 1 else 'secondPageInfo']['view']
            boxes = [line['bounds'] for line in item['text' if page == 1 else 'secondPageText']['lines']]
            assert boxes, 'PDFKit no devolvió coordenadas de texto.'
            source = Path(raster['path'])
            destination = out / source.name
            shutil.copy2(source, destination)
            width, height, rgba, _ = decode_png(destination.read_bytes())
            assert [width, height] == [raster['width'], raster['height']]
            rotation = raster['rotation']
            def point(x, y):
                return {0: (x-view[0], view[3]-y), 90: (y-view[1], x-view[0]),
                        180: (view[2]-x, y-view[1]), 270: (view[3]-y, view[2]-x)}[rotation]
            corners = [point(x,y) for box in boxes for x in [box[0],box[2]] for y in [box[1],box[3]]]
            expected = [min(p[0] for p in corners), min(p[1] for p in corners), max(p[0] for p in corners), max(p[1] for p in corners)]
            dark = [(index % width, index // width) for index in range(width*height)
                    if max(rgba[index*4:index*4+3]) < 140]
            colored = sum(max(rgba[i*4:i*4+3]) - min(rgba[i*4:i*4+3]) > 30 for i in range(width*height))
            if page == 1:
                assert colored < 10, 'El bitmap conserva el color del resaltado/nota que se debe editar como overlay.'
            else:
                blue = sum(rgba[i*4] < 100 and rgba[i*4+1] < 100 and rgba[i*4+2] > 140 for i in range(width*height))
                cyan = sum(rgba[i*4] < 100 and rgba[i*4+1] > 140 and rgba[i*4+2] > 140 for i in range(width*height))
                assert blue > 10 and cyan < 10, 'El renderizado no conserva la anotación no editable o no suprime el resaltado editable.'
            assert len(dark) > 300, 'PDFKit generó una página vacía.'
            actual = [min(p[0] for p in dark), min(p[1] for p in dark), max(p[0] for p in dark), max(p[1] for p in dark)]
            assert all(abs(a-b) < 25 for a,b in zip(actual,expected)), f'Bitmap y texto no coinciden con crop/rotación {rotation}: {actual} versus {expected}'
            raster.update({'inspectionFile':destination.name,'textPixelBounds':actual,'expectedTextBounds':expected,'geometryVerified':True,
                           'editableSourceAnnotationsSuppressed':True,'coloredPixels':colored})
            if page == 2: raster.update({'intrinsicRotationVerified':90,'nonOverlayAnnotationVisible':True})

def fresh_diagnostic(started_at):
    diagnostic = wait_file(data, 'f' * 64 + '.json', lambda d:
        d.get('snapshot', {}).get('at', 0) >= started_at and
        any(r.get('checksCompleted') and r.get('startedAt', 0) >= started_at
            for r in d.get('documents', {}).values()))
    assert diagnostic['buildMarker'] == 'FOLIO_NATIVE_QA_BUILD'
    assert not diagnostic.get('errors'), json.dumps(diagnostic.get('errors'), ensure_ascii=False)
    assert not diagnostic.get('persistError'), diagnostic.get('persistError')
    checked = next(r for r in diagnostic['documents'].values()
                   if r.get('checksCompleted') and r.get('startedAt', 0) >= started_at)
    assert not checked.get('error'), json.dumps(checked.get('error'), ensure_ascii=False)
    assert checked.get('selectionMatchesSpan'), 'La selección nativa de texto no coincide.'
    assert checked.get('search', {}).get('found'), 'Buscar Folio no devolvió resultados en WKWebView.'
    native = diagnostic.get('iosNative')
    assert native and native.get('platform') == 'iOS' and native.get('uiAvailable'), 'No respondió el puente Swift/UIKit.'
    assert checked.get('nativeClipboardWritten'), 'La copia nativa no se completó.'
    pasted = run('xcrun', 'simctl', 'pbpaste', device)
    assert pasted == checked['selectedText'].strip(), 'El portapapeles del simulador no coincide con el texto PDF.'
    viewport = diagnostic['snapshot']['document']
    assert viewport['scrollWidth'] <= viewport['width'] + 1, 'La aplicación completa desborda horizontalmente.'
    return diagnostic, checked, native

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
    if args.qa:
        spec = importlib.util.spec_from_file_location('native_pdf_fixture', root / 'scripts/tests/native-pdf-fixture.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        fixtures = documents / 'FolioNativeFixtures'
        module.write_fixture(fixtures / 'Folio native pequeño.PDF')
        module.write_fixture(fixtures / 'Folio native 2GiB.pdf', large=True)
    fixture = root / 'public/sample.pdf'
    copied = documents / 'Folio iPhone.pdf'
    shutil.copy2(fixture, copied)
    digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
    started = int(time.time() * 1000)
    launch = run('xcrun', 'simctl', 'launch', device, 'org.folio.pdf', str(copied), *(['--folio-native-file-probe'] if args.qa else []))
    process_id = int(re.search(r':\s*(\d+)\s*$', launch).group(1))
    session = wait_file(data, f'{digest}.json', lambda s: s.get('version') == 3 and s.get('documentRevision') == digest)
    report['session'] = {'version': session['version'], 'documentRevision': session['documentRevision']}
    assert hashlib.sha256(copied.read_bytes()).hexdigest() == digest, 'El original cambió al leerlo.'
    if args.qa:
        diagnostic, checked, native = fresh_diagnostic(started)
        (out / 'native-qa-ios.json').write_text(json.dumps(diagnostic, ensure_ascii=False, indent=2))
        report['nativeBridge'] = native
        report['nativeClipboardVerified'] = True
        report['documentDiagnostic'] = checked
        file_diagnostic = wait_file(data, 'f' * 64 + '.json', lambda d: (d.get('nativeFiles') or {}).get('completed'), timeout=240)
        files = file_diagnostic['nativeFiles']
        assert not files.get('error'), json.dumps(files.get('error'), ensure_ascii=False)
        result = files['result']
        assert result['swiftImportExecuted'] and result['pdfKitExecuted'] and not result['wholeDocumentIPC']
        assert len(result['documents']) == 2 and any(d['document']['size'] > 2 * 1024**3 for d in result['documents'])
        validate_pdfkit_rasters(result)
        assert rss_samples, 'No se obtuvo memoria residente del proceso nativo.'
        result['memory'] = {'kind':'Simulator process resident memory sampled once per second', 'peakBytes':max(rss_samples),
                            'samples':len(rss_samples),'physicalDeviceMeasured':False, 'limitBytes':768*1024**2}
        assert max(rss_samples) < 768*1024**2, 'El lector excedió 768MiB de memoria residente con el fixture de 2GiB.'
        result.update({'version':version,'passed':True})
        report['nativeFileProbe'] = result
        (out / 'native-pdfkit-ios.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    time.sleep(2)
    screenshot = out / ('folio-iphone-qa.png' if args.qa else 'folio-iphone.png')
    run('xcrun', 'simctl', 'io', device, 'screenshot', str(screenshot))
    # Seed one valid bookmark only after the app is stopped. It is a test
    # fixture, not a claim that UIKit or this script created it through the UI.
    # A successful relaunch must read it and write a NEW session revision.
    # Merely finding the previous session file cannot satisfy this check.
    run('xcrun', 'simctl', 'terminate', device, 'org.folio.pdf')
    session_paths = list(data.rglob(f'{digest}.json'))
    assert len(session_paths) == 1, 'No se encontró una única sesión de la prueba.'
    session_path = session_paths[0]
    seeded = json.loads(session_path.read_text())
    baseline_revision = int(seeded.get('revision', 0))
    assert baseline_revision > 0, 'La sesión no contiene una revisión persistida.'
    canary = {'id': 'native-smoke-' + uuid.uuid4().hex, 'title': 'Folio relaunch persistence',
              'page': 1, 'parentId': None, 'color': '#bd4b38', 'order': len(seeded.get('bookmarks', []))}
    seeded['bookmarks'] = [*seeded.get('bookmarks', []), canary]
    temporary = session_path.with_suffix('.smoke-tmp')
    temporary.write_text(json.dumps(seeded, ensure_ascii=False))
    os.replace(temporary, session_path)
    relaunched_at = int(time.time() * 1000)
    report['relaunch'] = {'startedAt': relaunched_at, 'previousRevision': baseline_revision,
                          'restoredFixtureBookmark': canary['id'], 'fixtureBookmarkSeededWhileStopped': True}
    run('xcrun', 'simctl', 'launch', device, 'org.folio.pdf', str(copied))
    restored = wait_file(data, f'{digest}.json', lambda s:
        s.get('version') == 3 and s.get('documentRevision') == digest and
        int(s.get('revision', 0)) > baseline_revision and
        any(b.get('id') == canary['id'] and b.get('title') == canary['title']
            and b.get('page') == 1 for b in s.get('bookmarks', [])))
    assert hashlib.sha256(copied.read_bytes()).hexdigest() == digest, 'El original cambió al reabrirlo.'
    report['relaunch']['freshRevision'] = restored['revision']
    if args.qa:
        diagnostic, checked, native = fresh_diagnostic(relaunched_at)
        (out / 'native-qa-ios-relaunch.json').write_text(json.dumps(diagnostic, ensure_ascii=False, indent=2))
        report['relaunch'].update({'freshDiagnosticAt': diagnostic['snapshot']['at'],
                                  'freshChecksStartedAt': checked['startedAt'],
                                  'selectionVerified': True, 'searchVerified': True,
                                  'nativeBridgeVerified': native['uiAvailable'], 'nativeClipboardVerified': True})
    time.sleep(2)
    run('xcrun', 'simctl', 'io', device, 'screenshot', str(out / ('folio-iphone-qa-relaunch.png' if args.qa else 'folio-iphone-relaunch.png')))
    if args.qa:
        # Exercise the production frontend adapter with the large source too.
        # The dedicated UIKit tests cover picker/Open In, so this reader check
        # explicitly uses a launch argument and never claims user selection.
        run('xcrun', 'simctl', 'terminate', device, 'org.folio.pdf')
        large = next(d for d in report['nativeFileProbe']['documents'] if d['document']['size'] > 2*1024**3)
        large_started = int(time.time() * 1000)
        rss_samples = []
        launch = run('xcrun', 'simctl', 'launch', device, 'org.folio.pdf', large['sourcePath'])
        process_id = int(re.search(r':\s*(\d+)\s*$', launch).group(1))
        large_session = wait_file(data, large['document']['id'] + '.json', lambda s:
            s.get('version') == 3 and s.get('documentRevision') == large['document']['revision'], timeout=150)
        diagnostic, checked, native = fresh_diagnostic(large_started)
        assert diagnostic['snapshot']['textSpanCount'] > 1 and checked['selectionMatchesSpan'] and checked['search']['found']
        assert rss_samples and max(rss_samples) < 768*1024**2, 'El lector WK/PDFKit excedió la memoria residente acotada del simulador.'
        report['largeFrontendReader'] = {'sourceBytes':large['document']['size'], 'sourceId':large['document']['id'],
            'freshDiagnosticAt':diagnostic['snapshot']['at'], 'checksStartedAt':checked['startedAt'], 'startedAt':large_started,
            'actualWKWebView':True, 'fileBackedAdapter':True, 'selectionVerified':True,'searchVerified':True,
            'sessionVerified':True,'nativeClipboardVerified':True, 'launchArgumentUsed':True,
            'peakNativeProcessRSSBytes':max(rss_samples),'rssSamples':len(rss_samples),'physicalDeviceMeasured':False}
        (out / 'native-qa-ios-large-reader.json').write_text(json.dumps(diagnostic, ensure_ascii=False, indent=2))
        run('xcrun', 'simctl', 'io', device, 'screenshot', str(out / 'folio-iphone-2gib-reader.png'))
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
            # Keep bounded output copies when a native assertion fails after
            # export; inspecting actual /CA and /AP beats guessing SDK state.
            report['failedExportEvidence'] = []
            for index, p in enumerate(data.rglob('Folio modified.pdf')):
                if p.parent.parent.name != 'pdfkit-probe': continue
                try:
                    size = p.stat().st_size
                    item = {'size': size, 'copied': False}
                    if size <= 32 * 1024**2:
                        destination = out / f'native-pdfkit-failed-export-{index}.pdf'
                        shutil.copyfile(p, destination)
                        item.update({'copied': True, 'file': destination.name})
                    report['failedExportEvidence'].append(item)
                except OSError: pass
        screenshot = out / ('folio-iphone-qa-failure.png' if args.qa else 'folio-iphone-failure.png')
        subprocess.run(['xcrun', 'simctl', 'io', device, 'screenshot', str(screenshot)], capture_output=True)
    (out / ('native-smoke-ios-qa.json' if args.qa else 'native-smoke-ios.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    if device:
        subprocess.run(['xcrun', 'simctl', 'shutdown', device], capture_output=True)
        subprocess.run(['xcrun', 'simctl', 'delete', device], capture_output=True)
print(json.dumps(report, ensure_ascii=False, indent=2))
