"""Package the Windows build, corresponding source, licenses and actual evidence."""
from pathlib import Path
import argparse, hashlib, json, os, shutil, zipfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True, type=Path)
parser.add_argument('--build-dir', type=Path, default=root / 'src-tauri/target/release')
parser.add_argument('--build-logs', type=Path)
parser.add_argument('--mupdf-source', required=True, type=Path)
args = parser.parse_args()
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
prefix = f'folio-{version}'
installer = args.build_dir / f'bundle/nsis/Folio_{version}_x64-setup.exe'
assert installer.is_file() and installer.read_bytes()[:2] == b'MZ', 'Falta el instalador Windows.'
portable = out / 'folio-pdf.exe'
assert portable.is_file(), 'Extrae el ejecutable portátil del instalador de producción antes de empaquetar.'
# Tauri embeds NSS in the NSIS payload, then restores UNK in its build directory.
portable_bytes = portable.read_bytes()
build_bytes = (args.build_dir / 'folio-pdf.exe').read_bytes()
assert portable_bytes == build_bytes or portable_bytes.replace(b'__TAURI_BUNDLE_TYPE_VAR_NSS', b'__TAURI_BUNDLE_TYPE_VAR_UNK', 1) == build_bytes, 'El ejecutable portátil no corresponde a esta compilación.'
for marker in ['FOLIO_NATIVE_QA_BUILD', 'org.folio.pdf.qa', '--remote-debugging-port=9367']:
    assert all(marker.encode(encoding) not in portable_bytes for encoding in ['utf-8', 'utf-16-le']), f'El ejecutable contiene configuración QA: {marker}.'
shutil.copy2(installer, out / installer.name)
for filename in ['LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.txt', 'SOURCE-BUILD.txt', 'dependency-licenses.json']:
    shutil.copy2(root / filename, out / filename)
excluded = {'node_modules', 'dist', 'target', '.git', '.openai', '.fixtures',
            'test-results', 'artifacts', '__pycache__', '.migration', '.tools',
            'entrega-original', 'release'}
source_files = []
with zipfile.ZipFile(out / f'{prefix}-fuente.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for directory, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in excluded and (Path(directory) / d).resolve() != out)
        for filename in sorted(files):
            p = Path(directory) / filename
            if p.name.endswith('.tsbuildinfo'):
                continue
            relative = p.relative_to(root).as_posix()
            archive.write(p, 'folio-pdf/' + relative)
            source_files.append(relative)
upstream_hash = hashlib.sha256(args.mupdf_source.read_bytes()).hexdigest()
assert upstream_hash == 'dc94c60b2537e2ac9a2d379dd3801545f84a3a302d15c9da358362a1270707c3'
(out / 'sources').mkdir(exist_ok=True)
shutil.copy2(args.mupdf_source, out / 'sources/mupdf-1.28.1-source.tar.gz')
evidence = out / 'evidence'
evidence.mkdir(exist_ok=True)
(out / 'docs').mkdir(exist_ok=True)
for filename in ['acceptance-windows.md', 'security.md', 'build-environment.txt']:
    shutil.copy2(root / 'docs' / filename, out / 'docs' / filename)
if args.build_logs:
    def has_failed(value):
        if isinstance(value, dict):
            return value.get('status') == 'failed' or value.get('passed') is False or any(has_failed(item) for item in value.values())
        return isinstance(value, list) and any(has_failed(item) for item in value)

    for filename in ['highlighting-results.json', 'tabs-results.json', 'bookmarks-results.json',
                     'selection-menu-results.json', 'highlight-mode-results.json', 'native-smoke.json',
                     'installed-smoke.json', 'production-state.json', 'reading-settings-results.json',
                     'remove-highlights-results.json', 'bookmark-drag-results.json', 'native-build-windows.json']:
        report = json.loads((args.build_logs / filename).read_text(encoding='utf-8'))
        assert not has_failed(report), f'Hay pruebas fallidas en {filename}.'
        if filename in ['native-smoke.json', 'installed-smoke.json', 'production-state.json', 'native-build-windows.json']:
            assert report['version'] == version, f'Evidencia de otra versión en {filename}.'
        if filename in ['reading-settings-results.json', 'remove-highlights-results.json', 'bookmark-drag-results.json']:
            assert report.get('results') and not report.get('errors'), f'Evidencia incompleta en {filename}.'
            assert all(result.get('status') == 'passed' or result.get('passed') is True for result in report['results']), f'Hay pruebas sin confirmar en {filename}.'
        if filename == 'native-build-windows.json':
            assert all(report.get(flag) is True for flag in ['productionBuild', 'nativeQaFeatureAbsent', 'qaIdentifierAbsent', 'qaDebugPortAbsent']), 'La compilación Windows no acredita producción sin QA.'
            for name, data in [('application', build_bytes), ('installer', installer.read_bytes())]:
                artifact = report['artifacts'][name]
                assert artifact['bytes'] == len(data) and artifact['sha256'] == hashlib.sha256(data).hexdigest(), f'Evidencia de compilación obsoleta: {name}.'
    for filename in ['windows-build.log', 'layout-results.json', 'native-tests.json',
                     'native-smoke.json', 'interfaz-compacta.png', 'interfaz-compacta-oscura.png',
                     'folio-windows.png', 'engine-results.json', 'operations-results.json',
                     'signatures-results.json', 'workbench-results.json', 'interop-operations.json',
                     'npm-audit.json', 'comparison-ui.png', 'production-state.json', 'installed-smoke.json',
                     'highlighting-results.json', 'tabs-results.json', 'bookmarks-results.json', 'selection-menu-results.json', 'highlight-mode-results.json',
                     'highlighting-real-paragraph.png', 'highlighting-multi-forward.png',
                     'highlighting-multi-reverse.png', 'tabs-open-documents.png', 'bookmarks-tree.png',
                     'highlight-color-palette.png', 'highlight-automatic-colors.png', 'selection-menu-narrow.png',
                     'reading-settings-results.json', 'reading-settings.png', 'remove-highlights-results.json',
                     'remove-highlights-contextual-menu.png', 'remove-highlights-after-zoom.png',
                     'bookmark-drag-results.json', 'bookmark-drag-destination.png', 'bookmark-drag-restored.png',
                     'native-build-windows.json']:
        p = args.build_logs / filename
        if p.is_file():
            shutil.copy2(p, evidence / filename)
records = []
bundle_name = f'{prefix}-entrega.zip'
for p in sorted(out.rglob('*')):
    if p.is_file() and p.name not in {'SHA256SUMS.txt', 'entrega-manifest.json', bundle_name}:
        records.append({'path': p.relative_to(out).as_posix(), 'bytes': p.stat().st_size,
                        'sha256': hashlib.sha256(p.read_bytes()).hexdigest()})
(out / 'SHA256SUMS.txt').write_text(''.join(f"{r['sha256']}  {r['path']}\n" for r in records), encoding='utf-8')
(out / 'entrega-manifest.json').write_text(json.dumps({
    'version': version, 'unsignedDevelopmentInstaller': True,
    'windowsFullAcceptanceComplete': False, 'nativeModulesTested': ['editing', 'ocr', 'cms-signing', 'signature-verification', 'binary-draft-recovery', 'multiple-document-tabs', 'bookmark-tree', 'text-selection-highlight', 'automatic-highlighting-and-colors', 'selection-menu', 'reading-preferences', 'contextual-highlight-removal', 'zoom-render-continuity', 'bookmark-branch-drag-and-history'], 'sourceFileCount': len(source_files),
    'sourceFiles': source_files, 'artifacts': records,
}, ensure_ascii=False, indent=2), encoding='utf-8')
with zipfile.ZipFile(out / bundle_name, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for p in sorted(out.rglob('*')):
        if p.is_file() and p.name != bundle_name:
            archive.write(p, prefix + '/' + p.relative_to(out).as_posix())
print(json.dumps({'version': version, 'sourceFiles': len(source_files),
                  'installerMiB': round(installer.stat().st_size / 1024**2, 2),
                  'completeBundleMiB': round((out / bundle_name).stat().st_size / 1024**2, 2)}))
