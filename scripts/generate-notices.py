"""Generate exact dependency notices from the installed, locked build sources.

Usage: python scripts/generate-notices.py --cargo-metadata metadata.json
  [--cargo-licenses extracted-registry-directory] [--mupdf-source archive.tar.gz]
Cargo metadata should be filtered for the release's target platform.
"""
from pathlib import Path
import argparse, json, tarfile, hashlib

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--cargo-metadata', required=True, type=Path)
parser.add_argument('--cargo-licenses', type=Path)
parser.add_argument('--mupdf-source', type=Path)
parser.add_argument('--platform', choices=['windows', 'macos'], default='windows')
args = parser.parse_args()
metadata = json.loads(args.cargo_metadata.read_text(encoding='utf-8-sig'))
lock = json.loads((root/'package-lock.json').read_text(encoding='utf-8'))
version = json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
platform_name = 'macOS' if args.platform == 'macos' else 'Windows'
runtime_notice = ("macOS uses Apple's system WKWebView. This development build has ad-hoc\n"
                  "code signing and is not notarized by Apple. Folio does not upload PDF documents.\n"
                  if args.platform == 'macos' else
                  "Microsoft WebView2 is a separate runtime under Microsoft's license terms.\n"
                  "The installer downloads the official bootstrapper only if WebView2 is missing.\n"
                  "The installer is unsigned. Folio does not upload PDF documents.\n")
parts = [f"""Folio {version} — Third-party notices
Folio is licensed under AGPL-3.0-or-later; see LICENSE.
No commercial PDF SDK or paid service is required for local reading/annotations.

MuPDF.js 1.28.1 is used unmodified from its npm package. Corresponding C, WASM,
TypeScript and third-party build sources are in mupdf-1.28.1-source.tar.gz,
provided alongside this release. The source archive includes platform/wasm and
thirdparty sources. Build instructions and hashes: SOURCE-BUILD.txt.
Upstream: https://github.com/ArtifexSoftware/mupdf
Archive: https://mupdf.com/downloads/archive/mupdf-1.28.1-source.tar.gz
Alternative commercial licensing is offered separately by Artifex.

The following notices cover the locked npm and {platform_name} Cargo build dependency
sets, including build tools. Inclusion here does not imply every component is
linked into the executable. The source archive notices also cover optional
MuPDF components. License alternatives are quoted as declared by each package.

{runtime_notice}
"""]
index = {'platform': args.platform, 'npm': [], 'cargo': [], 'mupdfSource': None}

def notice_name(p):
    return any(k in p.name.lower() for k in ('license', 'licence', 'copying', 'copyright', 'notice'))

def add_text(label, text):
    parts.append('\n'+'='*78+'\n'+label+'\n'+'='*78+'\n'+text.strip()+'\n')

missing = []
for key, entry in sorted(lock['packages'].items()):
    if not key.startswith('node_modules/'):
        continue
    folder = root/key
    if not folder.is_dir():
        # Optional dependencies for other host architectures are not installed.
        continue
    manifest = json.loads((folder/'package.json').read_text(encoding='utf-8'))
    name, version = manifest['name'], manifest['version']
    record = {'name': name, 'version': version, 'license': entry.get('license', manifest.get('license')), 'source': entry.get('resolved'), 'buildTool': bool(entry.get('dev'))}
    index['npm'].append(record)
    files = sorted(p for p in folder.iterdir() if p.is_file() and notice_name(p))
    header = f"npm: {name} {version}\nLicense: {record['license']}\nSource package: {record['source']}"
    add_text(header, '\n\n'.join(f'{p.name}\n{p.read_text(encoding='utf-8', errors="replace")}' for p in files) or 'License declared in the package manifest; source package URL above.')
    if not files:
        missing.append('npm:'+name)

for package in sorted(metadata['packages'], key=lambda p: (p['name'], p['version'])):
    if package.get('source') is None:
        continue
    folder = Path(package['manifest_path']).parent
    if not folder.exists() and args.cargo_licenses:
        folder = args.cargo_licenses/Path(package['manifest_path']).relative_to('/usr/local/cargo/registry/src').parent
    record = {'name': package['name'], 'version': package['version'], 'license': package.get('license'), 'authors': package.get('authors', []), 'source': f"https://crates.io/api/v1/crates/{package['name']}/{package['version']}/download"}
    index['cargo'].append(record)
    files = sorted(p for p in folder.rglob('*') if p.is_file() and notice_name(p)) if folder.exists() else []
    header = f"Cargo: {record['name']} {record['version']}\nLicense: {record['license']}\nAuthors: {', '.join(record['authors'])}\nSource package: {record['source']}"
    add_text(header, '\n\n'.join(f'{p.relative_to(folder)}\n{p.read_text(encoding='utf-8', errors="replace")}' for p in files) or 'License declared in Cargo manifest; source package URL above.')
    if not files:
        missing.append('cargo:'+record['name'])

for p in sorted((root/'public/pdfjs').rglob('*')):
    if p.is_file() and notice_name(p):
        add_text('Bundled PDF.js resource: '+str(p.relative_to(root)), p.read_text(encoding='utf-8', errors='replace'))
add_text('DM Sans — SIL Open Font License 1.1', (root/'public/fonts/OFL.txt').read_text(encoding='utf-8'))
index['ocrModels'] = json.loads((root/'public/ocr/models.json').read_text(encoding='utf-8'))
add_text('Bundled tessdata_fast models — pinned source URLs and hashes', json.dumps(index['ocrModels'], indent=2))
add_text('tessdata_fast — Apache-2.0', (root/'public/ocr/LICENSE').read_text(encoding='utf-8'))
nsis_notice=root/'docs/nsis/COPYRIGHT.txt'
if nsis_notice.exists():
    add_text('NSIS packaging tool and upstream RestartManager header — Debian NSIS copyright file', nsis_notice.read_text(encoding='utf-8'))

if args.mupdf_source:
    index['mupdfSource'] = {'name': args.mupdf_source.name, 'sha256': hashlib.sha256(args.mupdf_source.read_bytes()).hexdigest()}
    with tarfile.open(args.mupdf_source) as archive:
        for member in archive:
            p = Path(member.name)
            selected_readme = member.name.endswith(('/thirdparty/README', '/thirdparty/libjpeg/README'))
            if member.isfile() and (notice_name(p) or p.name.upper() == 'FTL.TXT' or selected_readme) and ('/thirdparty/' in member.name or '/resources/' in member.name):
                if member.size <= 512_000:
                    add_text('MuPDF source archive: '+member.name, archive.extractfile(member).read().decode('utf-8', errors='replace'))

index['packagesWithoutSeparateNoticeFile'] = missing
(root/'THIRD-PARTY-NOTICES.txt').write_text('\n'.join(parts), encoding='utf-8')
(root/'dependency-licenses.json').write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'npmPackages': len(index['npm']), 'cargoPackages': len(index['cargo']), 'withoutSeparateFile': missing, 'noticeBytes': (root/'THIRD-PARTY-NOTICES.txt').stat().st_size}))
