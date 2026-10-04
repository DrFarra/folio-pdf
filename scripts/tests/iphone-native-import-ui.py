"""Actual UIKit picker and Open In UI tests against a prebuilt Folio Simulator app.

The isolated Xcode project compiles only a small sender host and XCTest runner;
it never rebuilds Rust or injects a picker delegate/JS opening event. The picker
launch flag changes its initial provider directory only. No physical iPhone or
Feather result is inferred from these simulator tests.
"""
from pathlib import Path
import argparse, hashlib, json, os, plistlib, shutil, subprocess, sys, tempfile, time, unicodedata, uuid

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).with_name('iphone-native-import')
OUT = ROOT / 'test-results/ios'
FIXTURES = [
    ('Folio selección uno.PDF', 'FOLIO PICKER UNO'),
    ('Folio selección dos.pdf', 'FOLIO PICKER DOS'),
    ('Folio envío frío.PDF', 'FOLIO OPENIN FRIO'),
    ('Folio envío caliente.pdf', 'FOLIO OPENIN CALIENTE'),
]

def write_pdf(path, text):
    stream = f'BT /F1 22 Tf 32 455 Td ({text}) Tj ET'.encode('ascii')
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 560] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
               b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream']
    with Path(path).open('wb') as file:
        file.write(b'%PDF-1.7\n%Folio real UIKit import fixture\n')
        offsets = [0]
        for number, body in enumerate(objects, 1):
            offsets.append(file.tell()); file.write(str(number).encode() + b' 0 obj\n' + body + b'\nendobj\n')
        xref = file.tell(); file.write(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
        for offset in offsets[1:]: file.write(f'{offset:010d} 00000 n \n'.encode())
        file.write(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())

def run(*command, cwd=ROOT):
    process = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    if process.returncode:
        raise RuntimeError(' '.join(command) + '\n' + (process.stdout + '\n' + process.stderr)[-5000:])
    return process.stdout.strip()

def session_for(data, digest, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for file in data.rglob(digest + '.json'):
            try:
                session = json.loads(file.read_text())
                if session.get('version') == 3 and session.get('documentRevision') == digest and int(session.get('revision', 0)) > 0:
                    return session
            except (ValueError, OSError): pass
        time.sleep(.25)
    raise AssertionError('No real Rust session was published for imported PDF ' + digest)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'darwin': raise SystemExit('Actual UIKit UI testing requires macOS, Xcode and iPhone Simulator.')
    OUT.mkdir(parents=True, exist_ok=True)
    version = json.loads((ROOT / 'package.json').read_text())['version']
    report = {'version': version, 'passed': False, 'platform': 'iOS Simulator', 'architecture': 'arm64',
              'UIKitDialogInteractionTested': False, 'OSOpenInInteractionTested': False,
              'physicalDeviceTested': False, 'FeatherInstallationTested': False,
              'pickerDelegateInjected': False, 'javascriptOpenEventInjected': False,
              'startupFixturePassedAsArgument': False, 'fixtureInitialDirectoryOnly': True,
              'pickerProvider': 'Apple local file provider; separate Folio Import Host Documents'}
    device = None
    try:
        assert shutil.which('xcodegen'), 'The isolated UIKit runner requires XcodeGen (also used by Tauri ios init).'
        original_app = args.app.resolve()
        info = plistlib.loads((original_app / 'Info.plist').read_bytes())
        assert info['CFBundleIdentifier'] == 'org.folio.pdf' and info['CFBundleShortVersionString'] == version
        original_executable = original_app / info['CFBundleExecutable']
        assert 'IOSSIMULATOR' in run('vtool', '-show-build', str(original_executable)).upper()
        assert run('lipo', '-archs', str(original_executable)).split() == ['arm64']
        runtimes = json.loads(run('xcrun', 'simctl', 'list', 'runtimes', '--json'))['runtimes']
        runtimes = [r for r in runtimes if r.get('isAvailable') and 'iOS' in r['name'] and tuple(map(int, r['version'].split('.'))) < (19,)]
        assert runtimes, 'No compatible iOS 17/18 simulator runtime.'
        runtime = next((r for r in runtimes if r['version'] == '18.5'), sorted(runtimes, key=lambda r: tuple(map(int, r['version'].split('.'))))[-1])
        types = json.loads(run('xcrun', 'simctl', 'list', 'devicetypes', '--json'))['devicetypes']
        phone = next((d for d in types if d['name'] == 'iPhone 16 Pro'), next(d for d in types if 'iPhone' in d['name']))
        device = run('xcrun', 'simctl', 'create', 'Folio-UIKit-Import-' + uuid.uuid4().hex[:6], phone['identifier'], runtime['identifier'])
        report.update({'runtime': runtime['name'], 'device': phone['name']})
        run('xcrun', 'simctl', 'boot', device); run('xcrun', 'simctl', 'bootstatus', device, '-b')
        run('xcrun', 'simctl', 'status_bar', device, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100')
        # Ad hoc signing is local to the simulator copy. The source bundle and
        # the executable hash referenced by the delivery smoke stay unchanged.
        with tempfile.TemporaryDirectory(prefix='folio-actual-import-ui-') as directory:
            directory = Path(directory)
            app = directory / 'Folio.app'; shutil.copytree(original_app, app)
            run('codesign', '--force', '--deep', '--sign', '-', str(app))
            report['sourceExecutableSha256'] = hashlib.sha256(original_executable.read_bytes()).hexdigest()
            report['installedExecutableSha256'] = hashlib.sha256((app / info['CFBundleExecutable']).read_bytes()).hexdigest()
            run('xcrun', 'simctl', 'install', device, str(app))
            data = Path(run('xcrun', 'simctl', 'get_app_container', device, 'org.folio.pdf', 'data'))
            documents = data / 'Documents'; documents.mkdir(exist_ok=True)
            project = directory / 'ImportUI'; shutil.copytree(SOURCE, project)
            resources = project / 'Fixtures'; resources.mkdir()
            fixtures = []
            for filename, text in FIXTURES:
                fixture = resources / filename; write_pdf(fixture, text)
                digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
                fixtures.append({'name': filename, 'text': text, 'sha256': digest, 'bytes': fixture.stat().st_size})
            run('xcodegen', 'generate', '--spec', str(project / 'project.yml'), '--project', str(project), cwd=project)
            result_path = OUT / ('import-ui-' + uuid.uuid4().hex + '.xcresult')
            arguments = ['-project', str(project / 'FolioImportUI.xcodeproj'), '-scheme', 'FolioImportUI',
                       '-sdk', 'iphonesimulator', '-destination', 'platform=iOS Simulator,id=' + device,
                       '-derivedDataPath', str(directory / 'DerivedData'),
                       '-parallel-testing-enabled', 'NO', '-maximum-concurrent-test-simulator-destinations', '1',
                       'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'ARCHS=arm64']
            # Verify the actual compiled provider configuration before any UI
            # test. Xcode silently omitted UIFileSharingEnabled when supplied
            # only as an INFOPLIST_KEY build setting in the first real run.
            build_process = subprocess.run(['xcodebuild', 'build-for-testing', *arguments], cwd=project, capture_output=True, text=True)
            (OUT / 'iphone-native-import-ui-build.log').write_text(build_process.stdout + '\n' + build_process.stderr)
            report['xcodebuildBuildExitCode'] = build_process.returncode
            assert build_process.returncode == 0, 'The actual UIKit host/test build failed; see iphone-native-import-ui-build.log.'
            host_app = directory / 'DerivedData/Build/Products/Debug-iphonesimulator/FolioImportHost.app'
            assert host_app.is_dir(), 'The UIKit build did not produce the independent provider host.'
            host_info = plistlib.loads((host_app / 'Info.plist').read_bytes())
            report['hostProviderConfiguration'] = {key: host_info.get(key) for key in (
                'CFBundleIdentifier', 'CFBundleName', 'CFBundleDisplayName',
                'UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace', 'UISupportsDocumentBrowser')}
            assert host_info.get('CFBundleIdentifier') == 'org.folio.import-ui-host'
            assert host_info.get('UIFileSharingEnabled') is True and host_info.get('LSSupportsOpeningDocumentsInPlace') is True and host_info.get('UISupportsDocumentBrowser') is False, 'The compiled UIKit host must expose its real Documents through the Apple local file provider.'
            bundled = list(host_app.iterdir())
            report['hostBundledFixtures'] = []
            for fixture in fixtures:
                same = [p for p in bundled if p.is_file() and unicodedata.normalize('NFC', p.name) == unicodedata.normalize('NFC', fixture['name'])]
                report['hostBundledFixtures'].append({'name': fixture['name'], 'present': len(same) == 1,
                    'originalBytesVerified': len(same) == 1 and hashlib.sha256(same[0].read_bytes()).hexdigest() == fixture['sha256']})
            assert len(report['hostBundledFixtures']) == 4 and all(item['present'] and item['originalBytesVerified'] for item in report['hostBundledFixtures']), 'The compiled provider must contain all four original fixture PDFs.'
            command = ['xcodebuild', 'test-without-building', *arguments, '-resultBundlePath', str(result_path)]
            process = subprocess.run(command, cwd=project, capture_output=True, text=True)
            (OUT / 'iphone-native-import-ui.log').write_text(process.stdout + '\n' + process.stderr)
            report['xcodebuildExitCode'] = process.returncode
            report['resultBundle'] = result_path.name
            if result_path.exists():
                try:
                    summary = json.loads(run('xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(result_path)))
                    (OUT / 'iphone-native-import-xctest-summary.json').write_text(json.dumps(summary, indent=2))
                    report['xctest'] = {'passed': summary.get('passedTests'), 'failed': summary.get('failedTests'), 'skipped': summary.get('skippedTests'), 'status': summary.get('result')}
                    attachments = directory / 'Attachments'
                    run('xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(result_path), '--output-path', str(attachments))
                    exported = []
                    for p in attachments.rglob('*'):
                        if not p.is_file(): continue
                        if p.suffix.lower() == '.png':
                            target = OUT / ('import-ui-' + p.parent.name + '-' + p.name); shutil.copy2(p, target)
                        elif p.stat().st_size < 5 * 1024 * 1024:
                            try: text = p.read_text(encoding='utf-8')
                            except (UnicodeDecodeError, OSError): continue
                            # The existing evidence upload includes .log/.json;
                            # retain actual AX text instead of only screenshots.
                            suffix = '.json' if p.suffix.lower() == '.json' else '.log'
                            target = OUT / ('import-ui-' + p.parent.name + '-' + p.name + suffix)
                            target.write_text(text, encoding='utf-8')
                        else: continue
                        exported.append(target.name)
                    report['exportedUIKitAttachments'] = exported
                except Exception as error: report['resultExtractionError'] = str(error)
            assert process.returncode == 0, 'The actual UIKit tests failed; see iphone-native-import-ui.log and xcresult.'
            metrics = report.get('xctest', {})
            assert metrics.get('passed') == 2 and metrics.get('failed') == 0 and metrics.get('skipped') == 0, 'Both actual picker and Open In XCTest methods must run and pass.'
            verified = []
            host_data = Path(run('xcrun', 'simctl', 'get_app_container', device, 'org.folio.import-ui-host', 'data'))
            for fixture in fixtures:
                same_name = lambda p: unicodedata.normalize('NFC', p.name) == unicodedata.normalize('NFC', fixture['name'])
                copies = [p for p in (documents / 'Imports').rglob('*') if p.is_file() and same_name(p)]
                assert copies and all(hashlib.sha256(p.read_bytes()).hexdigest() == fixture['sha256'] for p in copies), 'The native importer did not copy original PDF bytes: ' + fixture['name']
                originals = [p for p in (host_data / 'Documents').iterdir() if p.is_file() and same_name(p)]
                assert len(originals) == 1 and hashlib.sha256(originals[0].read_bytes()).hexdigest() == fixture['sha256'], 'The external provider source changed: ' + fixture['name']
                session = session_for(data, fixture['sha256'])
                assert session.get('lastPage') == 1
                assert hashlib.sha256((resources / fixture['name']).read_bytes()).hexdigest() == fixture['sha256']
                verified.append({**fixture, 'nativeImportCopies': len(copies), 'nativeSessionVersion': session['version'],
                                 'nativeSessionRevision': session['revision'], 'nativeDocumentRevision': session['documentRevision']})
            report.update({'passed': True, 'UIKitDialogInteractionTested': True, 'OSOpenInInteractionTested': True,
                           'cancelWithoutDocumentVerified': True, 'pickerRepeatAndTwoTabsVerified': True,
                           'coldAndWarmModalOpenInVerified': True, 'nativeCopyBytesAndRustSessionsVerified': True, 'fixtures': verified})
    except Exception as error:
        report['failure'] = type(error).__name__ + ': ' + str(error)
        raise
    finally:
        if device:
            if not report['passed']:
                subprocess.run(['xcrun', 'simctl', 'io', device, 'screenshot', str(OUT / 'iphone-native-import-ui-failure.png')], capture_output=True)
            subprocess.run(['xcrun', 'simctl', 'shutdown', device], capture_output=True)
            subprocess.run(['xcrun', 'simctl', 'delete', device], capture_output=True)
        (OUT / 'iphone-native-import-ui-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == '__main__': main()
