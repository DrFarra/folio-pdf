"""Package a verified universal macOS build, matching source and Mac evidence."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
MUPDF_SHA = 'dc94c60b2537e2ac9a2d379dd3801545f84a3a302d15c9da358362a1270707c3'
EXCLUDED = {'node_modules', 'dist', 'target', '.git', '.openai', '.fixtures',
            'test-results', 'artifacts', '__pycache__', '.migration', '.tools',
            'entrega-original', 'release'}
MAC_EVIDENCE = ['native-smoke-macos.json', 'native-smoke-macos-qa.json', 'mac-platform-results.json', 'mac-platform-tests.json',
                'macos-platform-tests.json', 'mac-build.log',
                'macos-application.png', 'macos-smoke.png',
                'folio-macos.png', 'folio-macos-qa.png', 'mac-webkit.png',
                'reading-settings-results.json', 'reading-settings.png',
                'remove-highlights-results.json', 'remove-highlights-contextual-menu.png', 'remove-highlights-after-zoom.png',
                'bookmark-drag-results.json', 'bookmark-drag-destination.png', 'bookmark-drag-restored.png']


class PackageError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise PackageError(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError) as error:
        raise PackageError(f'No se pudo leer {path.name}: {error}') from error


def command(arguments, input_text=None):
    try:
        result = subprocess.run(arguments, input=input_text, capture_output=True, text=True, check=False)
    except OSError as error:
        raise PackageError(f'No se pudo ejecutar {arguments[0]}: {error}') from error
    require(result.returncode == 0,
            f'{arguments[0]} no pudo validar la entrega.\n{result.stderr.strip() or result.stdout.strip()}')
    return (result.stdout + '\n' + result.stderr).strip()


def verify_dmg_application(dmg, app, executable_name):
    """Read the actual installer payload, then always detach our read-only volume."""
    with tempfile.TemporaryDirectory(prefix='folio-dmg-check-') as directory:
        volume = Path(directory) / 'volume'
        volume.mkdir()
        mounted = False
        try:
            # This DMG embeds Folio's AGPL license. hdiutil otherwise receives
            # EOF at its license prompt and cancels a noninteractive mount.
            command(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(volume), str(dmg)], input_text='y\n')
            mounted = True
            installed_app = volume / 'Folio.app'
            require(installed_app.is_dir(), 'El DMG no contiene Folio.app en su volumen de instalación.')
            require((installed_app / 'Contents/Info.plist').read_bytes() == (app / 'Contents/Info.plist').read_bytes(),
                    'El Info.plist del DMG no coincide con la aplicación final.')
            installed_executable = installed_app / 'Contents/MacOS' / executable_name
            require(installed_executable.is_file(), 'Falta el ejecutable dentro del DMG.')
            require(sha256(installed_executable) == sha256(app / 'Contents/MacOS' / executable_name),
                    'El DMG contiene un ejecutable de otra compilación.')
            require(b'FOLIO_NATIVE_QA_BUILD' not in installed_executable.read_bytes(),
                    'El DMG contiene la variante QA en lugar de la aplicación final.')
            command(['codesign', '--verify', '--deep', '--strict', '--verbose=2', str(installed_app)])
        finally:
            if mounted or os.path.ismount(volume):
                command(['hdiutil', 'detach', str(volume)])


def passed_report(data, name, native=False):
    require(isinstance(data, dict), f'{name} no contiene un informe válido.')
    if native:
        require(data.get('passed') is True,
                f'{name} debe indicar passed: true. Ejecuta las pruebas Mac antes de empaquetar.')
    else:
        require(data.get('passed') is not False, f'{name} contiene pruebas fallidas.')
        cases = [case for key in ('results', 'cases', 'tests')
                 for case in (data.get(key) if isinstance(data.get(key), list) else [])]
        require(data.get('passed') is True or cases and all(
                isinstance(case, dict) and (case.get('status') == 'passed' or case.get('passed') is True)
                for case in cases), f'{name} no acredita pruebas aprobadas.')
    for key in ('errors', 'uncaughtErrors'):
        require(not data.get(key), f'{name} contiene errores sin resolver.')
    for key in ('results', 'cases', 'tests'):
        values = data.get(key, [])
        if isinstance(values, list):
            require(not any(isinstance(case, dict) and
                            (case.get('status') == 'failed' or case.get('passed') is False)
                            for case in values), f'{name} contiene pruebas fallidas.')


def source_build(version):
    return f'''Folio {version} — macOS source and build information

Application source: folio-{version}-fuente.zip, supplied with this Mac delivery.
License: AGPL-3.0-or-later; full text in LICENSE.
Locked dependencies: package-lock.json and both Cargo.lock files.

Build on a Mac with Node.js 22+, Rust and Xcode Command Line Tools:
  xcode-select --install
  npm ci
  npm run desktop:macos
The script installs missing aarch64-apple-darwin and x86_64-apple-darwin Rust
targets, then builds a universal application and DMG for Intel and Apple Silicon.
Configuration: src-tauri/tauri.macos.conf.json; deployment target macOS 14.0.
Actual verified build and smoke evidence are in evidence/ and docs/.

This development build uses an ad-hoc signature. It is not notarized and does
not claim Apple-verified publisher identity. Opening a downloaded copy may
require approval in macOS Privacy & Security. No Apple account is required
to produce the ad-hoc build. See README_Mac.md for installation instructions.

MuPDF.js 1.28.1 is used without modification from its published npm package.
Complete official C, TypeScript, WASM and third-party build source:
  sources/mupdf-1.28.1-source.tar.gz
  https://mupdf.com/downloads/archive/mupdf-1.28.1-source.tar.gz
SHA-256: {MUPDF_SHA}
Repository/tag: https://github.com/ArtifexSoftware/mupdf/tree/1.28.1

To rebuild MuPDF.js, install Node and Emscripten, extract the archive and run:
  cd mupdf-1.28.1-source/platform/wasm
  npm install
  EMSDK=/path/to/emsdk bash tools/build.sh
The upstream script uses Emscripten 4.0.8 and BUILD=small. Rebuilding MuPDF
was not performed for this delivery; the published package is locked by npm
integrity. No byte-for-byte reproducibility claim is made for other machines.

Exact npm and macOS Cargo source package URLs, versions and license declarations
are recorded in dependency-licenses.json. Full notices are supplied in
THIRD-PARTY-NOTICES.txt. Keep the source, instructions and license information
available when redistributing the application as required by their licenses.
'''


def mac_readme(version):
    return f'''# Folio {version} para Mac

Aplicación universal para Mac con procesador Intel o Apple Silicon, desde macOS 14.

1. Abre el archivo DMG.
2. Arrastra **Folio** a **Aplicaciones**.
3. Abre Folio desde Aplicaciones y elige tus PDFs con el botón **+**.

Esta copia de desarrollo tiene firma ad hoc y no está notarizada. Si macOS
pide autorización, después de intentar abrirla entra en **Ajustes del Sistema →
Privacidad y seguridad → Abrir igualmente** y confirma la apertura de Folio.
[Instrucciones de Apple](https://support.apple.com/102445).

También se incluye una copia de la aplicación en un ZIP creado con `ditto`,
conservando permisos y enlaces del bundle. La instalación habitual utiliza el DMG.

La fuente correspondiente está en `folio-{version}-fuente.zip`. Para compilar
en otro Mac: instala Node.js 22+, Rust y Xcode Command Line Tools, ejecuta
`npm ci` y después `npm run desktop:macos`. Lee `SOURCE-BUILD.txt` para conocer
las dependencias y sus licencias.

Las comprobaciones de esta entrega están en `evidence` y `docs`. Las pruebas de
Windows no se presentan como validación de macOS; el informe Mac identifica las
comprobaciones realizadas. Impresora física, Gatekeeper tras una descarga y
pruebas completas en ambos tipos de Mac requieren su validación correspondiente.
'''


def source_archive(destination, output, instructions, readme):
    files = []
    private_name = re.compile(r'(^|[./_-])(credentials|secrets|id_rsa|id_ed25519)([./_-]|$)', re.I)
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for directory, dirs, names in os.walk(ROOT):
            dirs[:] = sorted(name for name in dirs if name not in EXCLUDED and
                             not (Path(directory) / name).is_symlink() and
                             (Path(directory) / name).resolve() != output)
            for name in sorted(names):
                path = Path(directory) / name
                if name.endswith('.tsbuildinfo') or name == '.DS_Store':
                    continue
                require(not path.is_symlink(), f'La fuente contiene un enlace simbólico no revisado: {path.relative_to(ROOT)}')
                require(not (name.lower().startswith('.env') or path.suffix.lower() in
                             {'.pfx', '.p12', '.pem', '.key', '.bak', '.backup', '.log'} or private_name.search(name)),
                        f'No se incluye material privado en la fuente: {path.relative_to(ROOT)}')
                relative = path.relative_to(ROOT).as_posix()
                if relative == 'SOURCE-BUILD.txt':
                    archive.writestr('folio-pdf/' + relative, instructions)
                elif relative == 'README_Mac.md':
                    archive.writestr('folio-pdf/' + relative, readme)
                else:
                    archive.write(path, 'folio-pdf/' + relative)
                files.append(relative)
        if 'README_Mac.md' not in files:
            archive.writestr('folio-pdf/README_Mac.md', readme)
            files.append('README_Mac.md')
    return sorted(files)


def main():
    parser = argparse.ArgumentParser(description='Empaquetar la entrega universal de Folio en un Mac.')
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--build-dir', type=Path, default=ROOT / 'src-tauri/target/universal-apple-darwin/release')
    parser.add_argument('--mupdf-source', required=True, type=Path)
    parser.add_argument('--build-logs', type=Path, default=ROOT / 'test-results')
    args = parser.parse_args()
    require(sys.platform == 'darwin', 'La entrega Mac debe verificarse y empaquetarse en macOS. Este script no genera un DMG desde Windows.')
    output, build, logs, upstream = args.out.resolve(), args.build_dir.resolve(), args.build_logs.resolve(), args.mupdf_source.resolve()
    require(not output.exists() or output.is_dir() and not any(output.iterdir()),
            'La carpeta de entrega debe estar vacía. Elige una carpeta nueva para evitar incluir archivos o evidencias anteriores.')
    version = read_json(ROOT / 'package.json')['version']
    require(version == read_json(ROOT / 'src-tauri/tauri.conf.json')['version'], 'La versión de Tauri no coincide con la fuente.')
    app = build / 'bundle/macos/Folio.app'
    require(app.is_dir(), 'Falta bundle/macos/Folio.app. Compila la versión universal antes de empaquetar.')
    try:
        with (app / 'Contents/Info.plist').open('rb') as stream:
            info = plistlib.load(stream)
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        raise PackageError(f'No se pudo leer el Info.plist de Folio: {error}') from error
    require(info.get('CFBundleShortVersionString') == version and info.get('CFBundleVersion') == version,
            'El bundle Mac no corresponde a la versión de la fuente.')
    require(info.get('CFBundleIdentifier') == 'org.folio.pdf', 'El bundle usa un identificador de pruebas; no se entrega como versión de producción.')
    executable_name = info.get('CFBundleExecutable', '')
    require(executable_name and Path(executable_name).name == executable_name, 'CFBundleExecutable no es un nombre de archivo válido.')
    executable = app / 'Contents/MacOS' / executable_name
    require(executable.is_file(), 'Falta el ejecutable dentro de Folio.app.')
    require(b'FOLIO_NATIVE_QA_BUILD' not in executable.read_bytes(),
            'La aplicación contiene instrumentación QA. Recompila sin --features native-qa antes de empaquetar.')
    architectures = command(['lipo', '-archs', str(executable)]).split()
    require(set(architectures) == {'arm64', 'x86_64'}, 'Folio.app no contiene ambas arquitecturas: Intel y Apple Silicon.')
    command(['codesign', '--verify', '--deep', '--strict', '--verbose=2', str(app)])
    signature = command(['codesign', '--display', '--verbose=4', str(app)])
    require('Signature=adhoc' in signature or re.search(r'flags=.*\badhoc\b', signature),
            'El flujo de entrega requiere una firma ad hoc verificada.')
    candidates = sorted(path for path in (build / 'bundle/dmg').glob('*.dmg')
                        if version in path.name and 'universal' in path.name.lower())
    require(len(candidates) == 1, 'Debe existir un único DMG universal de esta versión en bundle/dmg.')
    dmg = candidates[0]
    command(['hdiutil', 'verify', str(dmg)])
    verify_dmg_application(dmg, app, executable_name)
    require(upstream.is_file() and sha256(upstream) == MUPDF_SHA, 'La fuente completa de MuPDF falta o no coincide con su SHA-256 fijado.')
    smoke = read_json(logs / 'native-smoke-macos.json')
    passed_report(smoke, 'native-smoke-macos.json', native=True)
    require(smoke.get('version') == version, 'La evidencia nativa Mac corresponde a otra versión.')
    if smoke.get('applicationExecutableSha256'):
        require(smoke['applicationExecutableSha256'] == sha256(executable),
                'El ejecutable final cambió después de la prueba nativa. No se empaqueta una aplicación diferente a la verificada.')
    if smoke.get('platform'):
        require(str(smoke['platform']).lower().startswith(('darwin', 'macos')), 'La evidencia nativa corresponde a otro sistema operativo.')
    notices = read_json(ROOT / 'dependency-licenses.json')
    cargo_names = {item.get('name') for item in notices.get('cargo', [])}
    require({'objc2-app-kit', 'objc2-web-kit'}.issubset(cargo_names),
            'Los avisos de dependencias corresponden a Windows. Regenera los avisos con Cargo metadata de macOS antes de compilar y empaquetar.')
    for filename in ('LICENSE', 'THIRD-PARTY-NOTICES.txt', 'SOURCE-BUILD.txt'):
        require((ROOT / filename).is_file(), f'Falta {filename} en la fuente.')
    for name in MAC_EVIDENCE:
        evidence = logs / name
        if evidence.is_file() and evidence.suffix == '.json':
            passed_report(read_json(evidence), name, native=name == 'native-smoke-macos.json')

    output.mkdir(parents=True, exist_ok=True)
    app_zip = output / f'Folio-{version}-macos-universal.app.zip'
    command(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(app_zip)])
    with zipfile.ZipFile(app_zip) as archive:
        require(archive.testzip() is None, 'El ZIP de Folio.app falló su comprobación CRC.')
        binary = archive.getinfo(f'Folio.app/Contents/MacOS/{executable_name}')
        require((binary.external_attr >> 16) & 0o111, 'El ZIP de Folio.app perdió el permiso de ejecución.')
        require(hashlib.sha256(archive.read(binary)).hexdigest() == sha256(executable), 'El ejecutable del ZIP no coincide con el bundle verificado.')
    shutil.copy2(dmg, output / dmg.name)
    for filename in ('LICENSE', 'THIRD-PARTY-NOTICES.txt', 'dependency-licenses.json'):
        shutil.copy2(ROOT / filename, output / filename)
    instructions, readme = source_build(version), mac_readme(version)
    (output / 'SOURCE-BUILD.txt').write_text(instructions, encoding='utf-8')
    (output / 'README_Mac.md').write_text(readme, encoding='utf-8')
    source = output / f'folio-{version}-fuente.zip'
    source_files = source_archive(source, output, instructions, readme)
    with zipfile.ZipFile(source) as archive:
        require(archive.testzip() is None, 'El ZIP de la fuente falló su comprobación CRC.')
    (output / 'sources').mkdir()
    shutil.copy2(upstream, output / 'sources/mupdf-1.28.1-source.tar.gz')
    (output / 'evidence').mkdir()
    for name in MAC_EVIDENCE:
        if (logs / name).is_file():
            shutil.copy2(logs / name, output / 'evidence' / name)
    (output / 'docs').mkdir()
    for name in ('acceptance-macos.md', 'build-macos.md', 'security.md'):
        if (ROOT / 'docs' / name).is_file():
            shutil.copy2(ROOT / 'docs' / name, output / 'docs' / name)
    if not (output / 'docs/acceptance-macos.md').exists():
        (output / 'docs/acceptance-macos.md').write_text(
            f'# Aceptación Mac de Folio {version}\n\n'
            'El empaquetador verificó versión, identificador de producción, ambas arquitecturas, '
            'firma ad hoc, integridad del DMG y conservación del ejecutable en el ZIP de la aplicación. '
            'El informe nativo `evidence/native-smoke-macos.json` pasó. '
            'Este resultado no certifica todas las funciones en ambos tipos de Mac ni una impresora física.\n', encoding='utf-8')
    environment = {'platform': 'darwin', 'macOS': command(['sw_vers', '-productVersion']),
                   'sdk': command(['xcrun', '--sdk', 'macosx', '--show-sdk-version']),
                   'rust': command(['rustc', '-V']), 'node': command(['node', '-v']),
                   'python': sys.version.split()[0], 'architectures': architectures,
                   'signing': 'ad-hoc', 'notarized': False}
    (output / 'docs/build-environment-macos.json').write_text(json.dumps(environment, indent=2), encoding='utf-8')
    prefix = f'folio-{version}-macos'
    complete = output / f'{prefix}-entrega.zip'
    records = [{'path': path.relative_to(output).as_posix(), 'bytes': path.stat().st_size, 'sha256': sha256(path)}
               for path in sorted(output.rglob('*')) if path.is_file()]
    (output / 'SHA256SUMS.txt').write_text(''.join(f"{record['sha256']}  {record['path']}\n" for record in records), encoding='utf-8')
    manifest = {'version': version, 'platform': 'macOS', 'architectures': architectures,
                'identifier': 'org.folio.pdf', 'adHocSigned': True, 'notarized': False,
                'macOSFullAcceptanceComplete': False, 'nativeSmokePassed': True,
                'dmgVerified': True, 'dmgPayloadMatchesApplication': True, 'applicationExecutableSha256': sha256(executable),
                'sourceFileCount': len(source_files), 'sourceFiles': source_files,
                'artifacts': records, 'buildEnvironment': environment}
    (output / 'entrega-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    with zipfile.ZipFile(complete, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(output.rglob('*')):
            if path.is_file() and path != complete:
                archive.write(path, prefix + '/' + path.relative_to(output).as_posix())
    with zipfile.ZipFile(complete) as archive:
        require(archive.testzip() is None, 'La entrega completa falló su comprobación CRC.')
    print(json.dumps({'version': version, 'platform': 'macOS', 'architectures': architectures,
                      'sourceFiles': len(source_files), 'completeBundleMiB': round(complete.stat().st_size / 1024**2, 2),
                      'completeBundleSha256': sha256(complete)}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (PackageError, OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f'Folio: {error}', file=sys.stderr)
        sys.exit(1)
