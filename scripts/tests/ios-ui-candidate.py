"""Preserve a production simulator bundle for focused UIKit diagnostics.

This is a CI candidate, not a verified release. The ZIP retains executable
permissions; its commit and binary hashes let a follow-up job reject stale code.
"""
from pathlib import Path
import hashlib, json, plistlib, subprocess, sys

root=Path(__file__).resolve().parents[2]
assert sys.platform=='darwin', 'The simulator bundle must be captured on macOS.'
app=root/'test-results/ios-build/simulator/Folio.app'
out=root/'test-results/ios-ui-candidate'; out.mkdir(parents=True,exist_ok=True)
info=plistlib.loads((app/'Info.plist').read_bytes())
version=json.loads((root/'package.json').read_text())['version']
assert info['CFBundleIdentifier']=='org.folio.pdf' and info['CFBundleShortVersionString']==version
executable=app/info['CFBundleExecutable']; binary=executable.read_bytes()
assert b'FOLIO_NATIVE_QA_BUILD' not in binary
archive=out/'Folio-simulator.app.zip'
subprocess.run(['ditto','-c','-k','--sequesterRsrc','--keepParent',str(app),str(archive)],check=True)
manifest={'version':version,'gitCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root).decode().strip(),
          'productionSimulator':True,'releaseVerified':False,'UIKitAcceptancePending':True,
          'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),
          'executableSha256':hashlib.sha256(binary).hexdigest()}
(out/'candidate.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps(manifest))
