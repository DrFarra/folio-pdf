"""Assemble current Windows/macOS/iPhone releases and matching source on any host.

Apple bundles must first pass their native package scripts on macOS. This script
checks the downloaded packages, versions, production executables and source;
it does not replace Apple signing or claim a physical-device installation test.
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
MUPDF_SHA = 'dc94c60b2537e2ac9a2d379dd3801545f84a3a302d15c9da358362a1270707c3'
EXCLUDED = {'node_modules', 'dist', 'target', '.git', '.tools', '.openai', '.fixtures',
            'test-results', 'release', 'artifacts', '__pycache__', '.migration',
            'entrega-original', 'Frameworks'}
GENERATED_LEGAL = {'SOURCE-BUILD.txt', 'THIRD-PARTY-NOTICES.txt', 'dependency-licenses.json'}
SOURCE_DIRS = {'src', 'src-tauri', 'scripts', 'docs', 'crates', 'public', 'assets', '.github'}
PRIVATE = re.compile(r'(^|[./_-])(credentials|secrets|id_rsa|id_ed25519)([./_-]|$)', re.I)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def git(*arguments):
    return subprocess.check_output(['git', *arguments], cwd=ROOT).decode('utf-8')


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def source_files():
    tracked = set(filter(None, git('ls-files', '-z').split('\0')))
    candidates = set(filter(None, git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0')))
    result = []
    for name in sorted(candidates):
        path = PurePosixPath(name)
        if any(part in EXCLUDED for part in path.parts) or name.startswith('src-tauri/gen/apple/'):
            continue
        if name not in tracked and path.parts[0] not in SOURCE_DIRS:
            continue
        if path.name.endswith(('.tsbuildinfo', '.pyc')) or path.name == '.DS_Store':
            continue
        require(not path.name.lower().startswith('.env') and path.suffix.lower() not in
                {'.p12', '.pfx', '.pem', '.key', '.bak', '.backup', '.log'} and not PRIVATE.search(name),
                f'La fuente contiene un archivo privado o temporal: {name}')
        local = ROOT / name
        require(not local.is_symlink(), f'Enlace simbólico de fuente no revisado: {name}')
        if local.is_file():
            result.append(name)
    for name in ['src/App.tsx', 'src/components/DocumentLibrary.tsx', 'src/components/DocumentOutline.tsx',
                 'src/desktop.css', 'src/mobile.css', 'scripts/tests/mobile-architecture.mjs',
                 'package-lock.json', 'src-tauri/Cargo.lock', 'crates/folio-core/Cargo.lock', 'LICENSE']:
        require(name in result, f'Falta una fuente necesaria: {name}')
    return result


def zip_members(archive):
    require(archive.testzip() is None, 'El ZIP no supera la comprobación CRC.')
    result = {}
    for item in archive.infolist():
        if item.is_dir():
            continue
        name = PurePosixPath(item.filename)
        require(not name.is_absolute() and '..' not in name.parts and '\\' not in item.filename,
                'El ZIP contiene una ruta no segura.')
        require(item.filename not in result, 'El ZIP contiene rutas duplicadas.')
        result[item.filename] = item
    return result


def compare_source(archive_path, files):
    with zipfile.ZipFile(archive_path) as archive:
        members = zip_members(archive)
        prefix = 'folio-pdf/' if 'folio-pdf/package.json' in members else ''
        for name in files:
            # Native runners regenerate these three notices for their platform.
            if name in GENERATED_LEGAL:
                continue
            if (PurePosixPath(name).parts[0] not in SOURCE_DIRS and name not in
                    {'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'LICENSE'}):
                continue
            member = prefix + name
            require(member in members, f'La fuente remota omite {name}.')
            require(hashlib.sha256(archive.read(member)).hexdigest() == sha(ROOT / name),
                    f'La fuente remota no corresponde al estado actual: {name}.')


def manifest_artifact(manifest, artifact):
    records = manifest.get('artifacts', [])
    if isinstance(records, dict):
        records = list(records.values())
    matches = [record for record in records if Path(record.get('path', '')).name == artifact.name]
    require(len(matches) == 1, f'El manifiesto no identifica {artifact.name}.')
    record = matches[0]
    require(record.get('bytes') == artifact.stat().st_size and record.get('sha256') == sha(artifact),
            f'El artefacto cambió después de verificarse: {artifact.name}.')


def production_binary(data):
    for marker in ['FOLIO_NATIVE_QA_BUILD', 'org.folio.pdf.qa', '--remote-debugging-port=9367']:
        require(all(marker.encode(encoding) not in data for encoding in ['utf-8', 'utf-16-le']),
                f'El ejecutable contiene configuración QA: {marker}.')


def one(directory, pattern):
    matches = list(directory.glob(pattern))
    require(len(matches) == 1, f'Se esperaba un único {pattern} en {directory.name}.')
    return matches[0]


def verify_windows(directory, version, commit):
    installer = directory / f'Folio_{version}_x64-setup.exe'
    report = read_json(directory / 'native-build-windows.json')
    require(report.get('version') == version and report.get('gitCommit') == commit,
            'La compilación Windows no corresponde a la versión y commit actuales.')
    require(all(report.get(flag) is True for flag in ['productionBuild', 'nativeQaFeatureAbsent', 'qaIdentifierAbsent', 'qaDebugPortAbsent']),
            'El informe Windows no acredita producción sin instrumentación QA.')
    require(installer.is_file() and installer.open('rb').read(2) == b'MZ', 'Falta el instalador Windows real.')
    artifacts = report['artifacts']
    for kind in ['installer', 'application']:
        record = artifacts[kind]
        recorded = Path(record['path'])
        candidate = recorded if recorded.is_absolute() else ROOT / recorded
        artifact = installer if kind == 'installer' else candidate if candidate.is_file() else directory / recorded.name
        require(artifact.is_file() and record['bytes'] == artifact.stat().st_size and record['sha256'] == sha(artifact),
                f'La evidencia Windows no coincide con {kind}.')
        if kind == 'application':
            production_binary(artifact.read_bytes())
    return installer, report, 'native-build-windows.json'


def verify_mac(directory, version, commit, runner_commit, files):
    manifest = read_json(directory / 'entrega-manifest.json')
    require(manifest.get('version') == version and manifest.get('platform') == 'macOS', 'El paquete Mac es de otra versión.')
    require((manifest.get('gitCommit') or runner_commit) == commit, 'El job de Mac es de otro commit.')
    require(set(manifest.get('architectures', [])) == {'arm64', 'x86_64'} and manifest.get('identifier') == 'org.folio.pdf',
            'La aplicación Mac no es universal de producción.')
    require(all(manifest.get(flag) is True for flag in ['adHocSigned', 'nativeSmokePassed', 'dmgVerified', 'dmgPayloadMatchesApplication']),
            'Faltan verificaciones nativas del paquete Mac.')
    dmg = one(directory, f'*{version}*universal*.dmg')
    manifest_artifact(manifest, dmg)
    with dmg.open('rb') as stream:
        stream.seek(-512, 2)
        require(stream.read(4) == b'koly', 'El instalador Mac no tiene un contenedor DMG UDIF válido.')
    app_zip = directory / f'Folio-{version}-macos-universal.app.zip'
    manifest_artifact(manifest, app_zip)
    with zipfile.ZipFile(app_zip) as archive:
        zip_members(archive)
        info = plistlib.loads(archive.read('Folio.app/Contents/Info.plist'))
        require(info.get('CFBundleShortVersionString') == version and info.get('CFBundleVersion') == version and
                info.get('CFBundleIdentifier') == 'org.folio.pdf', 'La aplicación del ZIP Mac no corresponde a esta entrega.')
        executable = archive.read('Folio.app/Contents/MacOS/' + info['CFBundleExecutable'])
        production_binary(executable)
        require(hashlib.sha256(executable).hexdigest() == manifest['applicationExecutableSha256'],
                'El ejecutable Mac no coincide con el verificado por el runner.')
    compare_source(directory / f'folio-{version}-fuente.zip', files)
    return dmg, manifest, 'entrega-manifest.json'


def verify_ios(directory, version, commit, files):
    manifest = read_json(directory / 'release-manifest.json')
    require(manifest.get('version') == version and manifest.get('platform') == 'iOS' and manifest.get('gitCommit') == commit,
            'La entrega iPhone no corresponde a la versión y commit actuales.')
    require(manifest.get('AppleCertificateIncluded') is False and manifest.get('ProvisioningProfileIncluded') is False and
            manifest.get('nativeSimulatorProduction') is True, 'La entrega iPhone no acredita una IPA de producción sin claves privadas.')
    ipa = directory / f'Folio_{version}_iphone_arm64_unsigned.ipa'
    manifest_artifact(manifest, ipa)
    with zipfile.ZipFile(ipa) as archive:
        members = zip_members(archive)
        require(all(name.startswith('Payload/') for name in members), 'La IPA contiene archivos fuera de Payload.')
        infos = [name for name in members if re.fullmatch(r'Payload/[^/]+\.app/Info\.plist', name)]
        require(len(infos) == 1, 'La IPA no contiene una única aplicación de dispositivo.')
        info = plistlib.loads(archive.read(infos[0])); prefix = str(PurePosixPath(infos[0]).parent) + '/'
        require(info.get('CFBundleShortVersionString') == version and info.get('CFBundleVersion') == version and
                info.get('CFBundleIdentifier') == 'org.folio.pdf' and info.get('MinimumOSVersion') == '17.0',
                'La IPA declara versión, identificador o sistema operativo incorrectos.')
        require(not any(name.endswith('embedded.mobileprovision') or PurePosixPath(name).suffix.lower() in
                        {'.p12', '.pfx', '.pem', '.key'} for name in members), 'La IPA contiene material de firma privado.')
        member = members[prefix + info['CFBundleExecutable']]
        require((member.external_attr >> 16) & 0o111, 'La IPA perdió permisos de ejecución.')
        executable = archive.read(member)
        production_binary(executable)
        require(hashlib.sha256(executable).hexdigest() == manifest['device']['executableSha256'], 'La IPA no coincide con el ejecutable verificado.')
        require(executable[:4] == b'\xcf\xfa\xed\xfe' and struct.unpack_from('<I', executable, 4)[0] == 0x0100000c,
                'La IPA no contiene un ejecutable Mach-O arm64.')
        offset, platforms = 32, []
        for _ in range(struct.unpack_from('<I', executable, 16)[0]):
            command, size = struct.unpack_from('<II', executable, offset)
            require(size >= 8 and offset + size <= len(executable), 'Comando Mach-O inválido.')
            if command == 0x32:
                platforms.append(struct.unpack_from('<I', executable, offset + 8)[0])
            offset += size
        require(platforms and set(platforms) == {2}, 'La IPA contiene un ejecutable de simulador, no de iPhone.')
    compare_source(directory / f'folio-{version}-fuente.zip', files)
    return ipa, manifest, 'release-manifest.json'


def instructions(version):
    return f'''FOLIO {version} — INSTALACIÓN

Windows (x64)
Abre Windows/Folio_{version}_x64-setup.exe y sigue el instalador.
WebView2 se descarga de Microsoft si falta. La copia no tiene firma Authenticode.

Mac (Intel y Apple Silicon; macOS 14 o posterior)
Abre el DMG de la carpeta Mac y arrastra Folio a Aplicaciones.
La copia tiene firma ad hoc y no está notarizada. Si macOS impide abrirla,
intenta abrir Folio y luego usa Ajustes del Sistema > Privacidad y seguridad >
Abrir igualmente. Comprueba que el archivo procede de esta entrega.

iPhone/iPad (iOS 17 o posterior)
Importa iPhone/Folio_{version}_iphone_arm64_unsigned.ipa en Feather.
Selecciona tu certificado y perfil de aprovisionamiento válidos, firma e instala.
La IPA no incluye certificado ni perfil. Conserva el mismo identificador al
actualizar para mantener los datos. Un bundle de simulador no sirve para iPhone.

Uso: abre Folio, elige Importar PDF y selecciona tus documentos. Documentos
conserva la biblioteca; el lector ofrece Páginas, Buscar, Anotar y Compartir.

Fuente y licencias
fuentes/folio-{version}-fuente.zip contiene la fuente de esta entrega y sus locks.
fuentes/mupdf-1.28.1-source.tar.gz contiene la fuente oficial correspondiente.
Cada plataforma incluye sus avisos de dependencias y las instrucciones de build.
Folio: AGPL-3.0-or-later. Fuentes tipográficas: public/fonts/OFL.txt en la fuente.

Integridad
SHA256SUMS.txt registra SHA-256 de todos los archivos. En PowerShell:
  Get-FileHash -Algorithm SHA256 -LiteralPath "ruta-del-archivo"
En macOS:
  shasum -a 256 "ruta-del-archivo"
Compara el resultado con la línea correspondiente de SHA256SUMS.txt.

Alcance de verificación
Los manifiestos y evidencia describen las pruebas ejecutadas por plataforma.
Las pruebas de simulador no certifican instalación física con Feather o AirPrint.
No se declara una prueba de instalación Windows cuando no se ejecutó.
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--mupdf-source', required=True, type=Path)
    parser.add_argument('--windows', type=Path)
    parser.add_argument('--macos', type=Path)
    parser.add_argument('--ios', type=Path)
    parser.add_argument('--macos-commit', help='headSha del job GitHub que verificó el paquete Mac')
    parser.add_argument('--source-only', action='store_true')
    args = parser.parse_args()
    version = read_json(ROOT / 'package.json')['version']; commit = git('rev-parse', 'HEAD').strip()
    require(version == read_json(ROOT / 'src-tauri/tauri.conf.json')['version'], 'Las versiones de npm y Tauri no coinciden.')
    require(args.mupdf_source.is_file() and sha(args.mupdf_source) == MUPDF_SHA, 'La fuente oficial MuPDF no conserva su SHA-256.')
    files = source_files()
    packages = []
    if not args.source_only:
        require(args.windows and args.macos and args.ios, 'Se requieren los tres paquetes reales antes de cerrar la entrega.')
        packages = [('Windows', args.windows, verify_windows(args.windows, version, commit)),
                    ('Mac', args.macos, verify_mac(args.macos, version, commit, args.macos_commit, files)),
                    ('iPhone', args.ios, verify_ios(args.ios, version, commit, files))]
        for platform, directory, _ in packages:
            for name in ['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'SOURCE-BUILD.txt', 'dependency-licenses.json']:
                require((directory / name).is_file(), f'Falta {platform}/{name}.')
    output = args.out.resolve()
    require((ROOT / 'release') in output.parents, 'La entrega debe guardarse dentro de release/.')
    output.mkdir(parents=True, exist_ok=True)
    for platform, _, _ in packages:
        require(not (output / platform).exists(), f'La carpeta {platform} ya existe; no se mezclan entregas anteriores.')
    sources = output / 'fuentes'; sources.mkdir(exist_ok=True)
    source = sources / f'folio-{version}-fuente.zip'
    with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED, compresslevel=7) as archive:
        for name in files:
            archive.write(ROOT / name, 'folio-pdf/' + name)
    with zipfile.ZipFile(source) as archive:
        zip_members(archive)
    upstream = sources / 'mupdf-1.28.1-source.tar.gz'
    shutil.copy2(args.mupdf_source, upstream)
    shutil.copy2(ROOT / 'LICENSE', output / 'LICENSE')
    (output / 'INSTRUCCIONES.txt').write_text(instructions(version), encoding='utf-8')
    proof = output / 'evidencia'; proof.mkdir(exist_ok=True)
    receipts = []
    for platform, directory, (installer, manifest, manifest_name) in packages:
        destination = output / platform; destination.mkdir()
        shutil.copy2(installer, destination / installer.name)
        for name in ['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'SOURCE-BUILD.txt', 'dependency-licenses.json']:
            require((directory / name).is_file(), f'Falta {platform}/{name}.')
            shutil.copy2(directory / name, destination / name)
        for name in ['SwiftRs-LICENSE-MIT.txt', 'SwiftRs-LICENSE-APACHE.txt']:
            if (directory / name).is_file():
                shutil.copy2(directory / name, destination / name)
        shutil.copy2(directory / manifest_name, destination / manifest_name)
        receipts.append({'platform': platform, 'installer': f'{platform}/{installer.name}', 'sha256': sha(installer),
                         'bytes': installer.stat().st_size, 'nativePackageManifest': f'{platform}/{manifest_name}'})
    for folder in ['mobile-architecture', 'reader-ergonomics', 'search-navigation', 'library-storage']:
        report = ROOT / 'test-results' / folder / 'results.json'
        if report.is_file():
            shutil.copy2(report, proof / f'{folder}-results.json')
    metadata = {'product': 'Folio', 'version': version, 'gitCommit': commit, 'complete': not args.source_only,
                'sourceFiles': [{'path': name, 'sha256': sha(ROOT / name)} for name in files],
                'sourceArchive': f'fuentes/{source.name}', 'sourceSha256': sha(source),
                'correspondingMuPDFSourceSha256': MUPDF_SHA, 'installers': receipts,
                'sourceWorkingTreeDirty': bool(git('status', '--porcelain').strip())}
    (output / 'entrega-manifest.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    records = [path for path in sorted(output.rglob('*')) if path.is_file() and path.name != 'SHA256SUMS.txt']
    (output / 'SHA256SUMS.txt').write_text(''.join(f'{sha(path)}  {path.relative_to(output).as_posix()}\n' for path in records), encoding='utf-8')
    print(json.dumps({'passed': True, 'complete': metadata['complete'], 'version': version, 'out': str(output),
                      'sourceFiles': len(files), 'installers': receipts}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        print(f'Folio: {error}', file=sys.stderr)
        sys.exit(1)
