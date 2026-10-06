"""Check the real bundled WKWebView application on an ephemeral macOS runner."""
from pathlib import Path
import argparse, hashlib, json, os, platform, plistlib, re, signal, subprocess, sys, time, unicodedata

parser = argparse.ArgumentParser()
parser.add_argument('--app', required=True, type=Path)
parser.add_argument('--dmg', type=Path, help='Optional DMG integrity check; app-only smoke never claims DMG validation.')
parser.add_argument('--qa', action='store_true', help='Verify the feature-gated native-qa build and capture actual WKWebView errors.')
args = parser.parse_args()
if sys.platform != 'darwin':
    raise SystemExit('La prueba nativa Mac requiere macOS; no se simula desde Windows.')
root = Path(__file__).resolve().parents[2]
output = root / 'test-results'
output.mkdir(exist_ok=True)
app, dmg = args.app.resolve(), args.dmg.resolve() if args.dmg else None
version = json.loads((root / 'package.json').read_text())['version']
info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
executable = app / 'Contents/MacOS' / info['CFBundleExecutable']
identifier = info['CFBundleIdentifier']
profile = Path.home() / 'Library/Application Support' / identifier
if args.qa:
    profile = profile / 'native-qa'
diagnostic_path = profile / 'sessions' / ('f' * 64 + '.json')
started_at = int(time.time() * 1000)
result = {'version': version, 'platform': 'macOS', 'testedArchitecture': platform.machine(),
          'nativeWKWebView': True, 'nativeQA': args.qa, 'passed': False}
owned_pids = []

def run(*command):
    return subprocess.run(command, check=True, capture_output=True, text=True, cwd=root).stdout.strip()

def pids():
    found = subprocess.run(['pgrep', '-f', re.escape(str(executable))], capture_output=True, text=True)
    return [int(value) for value in found.stdout.split() if value.isdigit()]

def wait_session(pdf):
    identity = hashlib.sha256(pdf.read_bytes()).hexdigest()
    target = profile / 'sessions' / (identity + '.json')
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if target.exists():
            try:
                session = json.loads(target.read_text())
                if session.get('version') == 3 and session.get('documentRevision') == identity:
                    return identity, session
            except (OSError, ValueError):
                pass
        time.sleep(.2)
    raise AssertionError(f'WKWebView no abrió ni guardó la sesión de {pdf.name}.')

def read_diagnostics():
    try:
        diagnostic = json.loads(diagnostic_path.read_text())
        if diagnostic.get('nativeQA') and diagnostic.get('snapshot', {}).get('at', 0) >= started_at:
            return diagnostic
    except (OSError, ValueError):
        pass
    return None

def assert_qa_clean(diagnostic):
    errors = diagnostic.get('errors', [])
    assert not errors, 'WKWebView registró errores de ejecución: ' + json.dumps(errors, ensure_ascii=False)
    assert not diagnostic.get('persistError'), 'No se pudo guardar el diagnóstico QA: ' + json.dumps(diagnostic['persistError'], ensure_ascii=False)

def wait_diagnostics(pdf):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        diagnostic = read_diagnostics()
        if diagnostic:
            (output / 'native-qa-diagnostics.json').write_text(json.dumps(diagnostic, indent=2), encoding='utf-8')
            # macOS filesystem/Finder names can use decomposed accents. Compare
            # canonical names while retaining the actual reported filename.
            canonical_name = unicodedata.normalize('NFC', pdf.name)
            report = next((value for name, value in diagnostic.get('documents', {}).items()
                           if unicodedata.normalize('NFC', name) == canonical_name), {})
            if report.get('checksCompleted'):
                result.setdefault('documentDiagnostics', {})[pdf.name] = report
                assert_qa_clean(diagnostic)
                assert diagnostic.get('buildMarker') == 'FOLIO_NATIVE_QA_BUILD', 'El bundle no contiene el marcador QA esperado.'
                assert report.get('before', {}).get('textSpanCount', 0) > 0, f'TextLayer no contiene texto seleccionable en {pdf.name}: {json.dumps(report, ensure_ascii=False)}'
                assert report.get('selectionMatchesSpan'), f'La selección WKWebView no coincide con el texto de {pdf.name}: {json.dumps(report, ensure_ascii=False)}'
                assert report.get('search', {}).get('found'), f'Buscar Folio no devolvió resultados en {pdf.name}: {json.dumps(report, ensure_ascii=False)}'
                alerts = report.get('after', {}).get('alerts', [])
                assert not any('indexar' in alert for alert in alerts), f'Error real del índice en {pdf.name}: {json.dumps(report, ensure_ascii=False)}'
                return report
        time.sleep(.2)
    raise AssertionError(f'No se recibió el diagnóstico nativo QA para {pdf.name}; buildMarker/plugin feature puede estar ausente.')

try:
    assert identifier == 'org.folio.pdf', 'Solo se verifica el bundle Folio en el runner limpio.'
    assert info['CFBundleShortVersionString'] == version
    assert info['LSMinimumSystemVersion'] == '14.0'
    # AppKit and WebKit show system panels and menus in the bundle's language.
    assert info.get('CFBundleDevelopmentRegion') == 'es' and info.get('CFBundleLocalizations') == ['es'], 'El bundle no declara el español.'
    assert not pids(), 'Hay una instancia ajena abierta; no se automatiza ni cierra.'
    architectures = sorted(run('lipo', '-archs', str(executable)).split())
    assert architectures == ['arm64', 'x86_64']
    run('codesign', '--verify', '--deep', '--strict', str(app))
    result['applicationExecutableSha256'] = hashlib.sha256(executable.read_bytes()).hexdigest()
    if dmg and not args.qa:
        run('hdiutil', 'verify', str(dmg))
    result.update(universalArchitectures=architectures, bundleVersionVerified=True,
                  signatureVerified=True, dmgIntegrityVerified=bool(dmg and not args.qa), notarized=False)
    sample = (root / 'public/sample.pdf').resolve()
    sample_hash = hashlib.sha256(sample.read_bytes()).hexdigest()
    # Open via LaunchServices on a cold start, then send file URL events to the
    # existing process. These checks exercise Finder and the listener handshake.
    run('open', '-n', '-a', str(app), str(sample))
    deadline = time.monotonic() + 10
    while not pids() and time.monotonic() < deadline:
        time.sleep(.1)
    owned_pids = pids()
    assert len(owned_pids) == 1
    wait_session(sample)
    if args.qa:
        wait_diagnostics(sample)
    result['coldFinderOpenAndRustSession'] = True
    fixture = output / 'Clínica renal #1.pdf'
    second = output / 'Segundo documento.pdf'
    code = """import { PDFDocument, StandardFonts } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';
for (const [filename, text] of [['Clínica renal #1.pdf', 'Folio Mac Finder Unicode'], ['Segundo documento.pdf', 'Folio Mac second document']]) {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([400, 500]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 30, y: 430, font, size: 18 });
  await writeFile('test-results/' + filename, await pdf.save());
} """
    run('node', '--input-type=module', '-e', code)
    if args.qa:
        # Exercise the same concurrent Finder batch as production, then focus
        # its first tab so both documents receive a complete text/search probe.
        run('open', '-a', str(app), str(fixture), str(second))
        for pdf in [fixture, second]:
            _, session = wait_session(pdf)
            assert session['lastPage'] == 1
        wait_diagnostics(second)
        run('open', '-a', str(app), str(fixture))
        wait_diagnostics(fixture)
        diagnostic = read_diagnostics()
        assert diagnostic, 'Falta el diagnóstico final de WKWebView.'
        assert_qa_clean(diagnostic)
        result['runtimeAndPersistenceErrorsAbsent'] = True
        result['warmConcurrentTextAndSearchVerified'] = True
    else:
        run('open', '-a', str(app), str(fixture), str(second))
        for pdf in [fixture, second]:
            _, session = wait_session(pdf)
            assert session['lastPage'] == 1
    assert pids() == owned_pids, 'Finder creó otra instancia de Folio.'
    assert hashlib.sha256(sample.read_bytes()).hexdigest() == sample_hash
    result.update(warmFinderMultiplePDFs=True, unicodeSpacesAndHashFilename=True,
                  singleInstancePreserved=True, originalPdfUnchanged=True, passed=True)
    # A screenshot is optional because some runners deny screen capture. The
    # session assertions above require the actual app, PDF.js and MuPDF to load.
    subprocess.run(['screencapture', '-x', str(output / ('folio-macos-qa.png' if args.qa else 'folio-macos.png'))], capture_output=True)
except Exception as error:
    result['error'] = str(error)
    subprocess.run(['screencapture', '-x', str(output / ('folio-macos-qa.png' if args.qa else 'folio-macos.png'))], capture_output=True)
    raise
finally:
    if args.qa:
        diagnostic = read_diagnostics()
        if diagnostic:
            result['diagnostics'] = diagnostic
            (output / 'native-qa-diagnostics.json').write_text(json.dumps(diagnostic, indent=2), encoding='utf-8')
            if diagnostic.get('errors') or diagnostic.get('persistError'):
                result['passed'] = False
                result.setdefault('error', 'El diagnóstico final de WKWebView contiene errores de ejecución o persistencia.')
    if owned_pids:
        subprocess.run(['osascript', '-e', f'tell application id "{identifier}" to quit'], capture_output=True)
        deadline = time.monotonic() + 8
        while pids() and time.monotonic() < deadline:
            time.sleep(.2)
        for pid in owned_pids:
            if pid in pids():
                os.kill(pid, signal.SIGTERM)
    report_name = 'native-smoke-macos-qa.json' if args.qa else 'native-smoke-macos.json'
    (output / report_name).write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))

if not result['passed']:
    raise SystemExit(1)
