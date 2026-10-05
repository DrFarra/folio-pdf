"""Restore a same-repository CI simulator candidate for focused UIKit checks.

This never converts a diagnostic candidate into a release. It rejects changed
production sources and verifies the archived bundle before running any app.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import plistlib
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
ALLOWED_CHANGES = {
    '.github/workflows/ios.yml', '.github/workflows/ios-ui-check.yml',
    'scripts/tests/ios-ui-candidate.py', 'scripts/tests/ios-ui-restore.py',
    'scripts/tests/iphone-native-import-ui.py',
    'scripts/tests/iphone-native-import/ImportTests.swift',
    'scripts/tests/iphone-native-import/Host.swift',
    'scripts/tests/iphone-native-import/project.yml', 'docs/releases.md',
}


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def main():
    assert sys.platform == 'darwin', 'The simulator requires macOS.'
    run_id = os.environ['CANDIDATE_RUN']
    assert re.fullmatch(r'[0-9]+', run_id), 'Expected a numeric workflow run ID.'
    repository = os.environ['GITHUB_REPOSITORY']
    run = json.loads(command('gh', 'api', f'repos/{repository}/actions/runs/{run_id}'))
    assert run['repository']['full_name'] == repository
    assert run['path'] == '.github/workflows/ios.yml', 'Expected the full iOS workflow.'
    assert run['event'] == 'workflow_dispatch'
    out = ROOT / 'test-results/ios-ui-candidate'
    out.mkdir(parents=True, exist_ok=False)
    command('gh', 'run', 'download', run_id, '--repo', repository,
            '--name', 'Folio-iOS-candidate', '--dir', str(out))
    manifest = json.loads((out / 'candidate.json').read_text())
    assert manifest['gitCommit'] == run['head_sha']
    assert manifest['productionSimulator'] is True
    assert manifest['releaseVerified'] is False
    assert manifest['UIKitAcceptancePending'] is True
    version = json.loads((ROOT / 'package.json').read_text())['version']
    assert manifest['version'] == version
    changed = set(command('git', 'diff', '--name-only', manifest['gitCommit'], 'HEAD').splitlines())
    assert changed <= ALLOWED_CHANGES, 'Production sources changed: ' + repr(changed - ALLOWED_CHANGES)
    archive = out / 'Folio-simulator.app.zip'
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest['archiveSha256']
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            path = PurePosixPath(entry.filename)
            assert not path.is_absolute() and '..' not in path.parts
            assert path.parts[0] in {'Folio.app', '__MACOSX'}
    restored = ROOT / 'test-results/ios-ui-restored'
    restored.mkdir(parents=True, exist_ok=False)
    command('ditto', '-x', '-k', str(archive), str(restored))
    app = restored / 'Folio.app'
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    assert info['CFBundleIdentifier'] == 'org.folio.pdf'
    assert info['CFBundleShortVersionString'] == version
    executable = app / info['CFBundleExecutable']
    binary = executable.read_bytes()
    assert hashlib.sha256(binary).hexdigest() == manifest['executableSha256']
    assert b'FOLIO_NATIVE_QA_BUILD' not in binary
    assert 'IOSSIMULATOR' in command('vtool', '-show-build', str(executable)).upper()
    assert command('lipo', '-archs', str(executable)).split() == ['arm64']
    evidence = ROOT / 'test-results/ios'
    evidence.mkdir(parents=True, exist_ok=True)
    manifest.update({'candidateRun': int(run_id), 'testCommit': command('git', 'rev-parse', 'HEAD'),
                     'sourceChanges': sorted(changed), 'archiveAndBinaryVerified': True})
    (evidence / 'restored-candidate.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest))


if __name__ == '__main__':
    main()
