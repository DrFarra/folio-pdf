// Builds MuPDF and Folio's native reader (FolioMuPDF.c, shared with iOS) as static
// libraries for Android arm64. Rust links them (src-tauri/build.rs) for the
// large-PDF reader: the PDF stays in its file and MuPDF reads it on demand.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = '1.28.1';
const archiveName = `mupdf-${version}-source.tar.gz`;
const sourceHash = 'dc94c60b2537e2ac9a2d379dd3801545f84a3a302d15c9da358362a1270707c3';
const work = path.join(root, 'test-results/mupdf-android');
const out = path.join(work, 'out');
const native = path.join(root, 'src-tauri/plugins/folio-ios/ios/NativeExport');
const patches = path.join(root, 'scripts/mupdf-patches');
const api = 26; // minSdk in src-tauri/gen/android/app/build.gradle.kts
const features = [
  'build=release',
  'USE_SYSTEM_LIBS=no',
  'HAVE_LIBCRYPTO=no',
  'HAVE_X11=no',
  'HAVE_GLUT=no',
  'HAVE_GLFW=no',
  'HAVE_PTHREAD=no',
  'html=no',
  'xps=no',
  'svg=no',
  'extract=no',
  'barcode=no',
  'tesseract=no',
  'brotli=no',
  'tofu_cjk=yes',
  'mujs=no',
];

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit' });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message || result.status}`);
}
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

try {
  if (!process.env.NDK_HOME) throw new Error('Configura NDK_HOME.');
  const host = { linux: 'linux-x86_64', darwin: 'darwin-x86_64' }[process.platform];
  if (!host) throw new Error('MuPDF para Android se compila con make en Linux o macOS (en Windows, usa WSL).');
  const bin = path.join(process.env.NDK_HOME, 'toolchains/llvm/prebuilt', host, 'bin');
  const cc = path.join(bin, `aarch64-linux-android${api}-clang`);
  if (!fs.existsSync(cc)) throw new Error(`No se encontró el compilador del NDK: ${cc}`);
  const patchFiles = fs
    .readdirSync(patches)
    .filter(name => name.endsWith('.patch'))
    .sort();
  const inputs = {
    version,
    sourceHash,
    api,
    features,
    ndk: path.basename(process.env.NDK_HOME),
    script: hash(fileURLToPath(import.meta.url)),
    patches: Object.fromEntries(patchFiles.map(name => [name, hash(path.join(patches, name))])),
    wrapper: ['FolioMuPDF.c', 'include/FolioMuPDF.h'].map(file => hash(path.join(native, file))),
  };
  const key = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const stamp = path.join(out, 'build.json');
  const libraries = ['libfoliomupdf.a', 'libmupdf.a', 'libmupdf-third.a'].map(name => path.join(out, name));
  if (
    fs.existsSync(stamp) &&
    JSON.parse(fs.readFileSync(stamp, 'utf8')).key === key &&
    libraries.every(fs.existsSync)
  ) {
    console.log('MuPDF Android: cached libraries are current.');
    process.exit(0);
  }
  fs.mkdirSync(work, { recursive: true });
  const archive = path.join(root, 'test-results', archiveName);
  if (!fs.existsSync(archive))
    run('curl', [
      '--fail',
      '--location',
      '--retry',
      '3',
      `https://mupdf.com/downloads/archive/${archiveName}`,
      '-o',
      archive,
    ]);
  if (hash(archive) !== sourceHash) throw new Error('The MuPDF source archive does not match the pinned SHA-256.');
  const stage = fs.mkdtempSync(path.join(work, 'stage-'));
  run('python3', [
    '-c',
    'import sys,tarfile; a=tarfile.open(sys.argv[1]); a.extractall(sys.argv[2],filter="data")',
    archive,
    stage,
  ]);
  const source = path.join(stage, `mupdf-${version}-source`);
  // Folio's changes to MuPDF are kept as patches beside this script (AGPL source).
  for (const name of patchFiles) run('patch', ['-p1', '--forward', '-i', path.join(patches, name)], source);
  const jobs = String(Math.max(1, Math.min(8, os.availableParallelism())));
  run('make', ['-j', jobs, ...features, 'generate'], source);
  run(
    'make',
    [
      '-j',
      jobs,
      ...features,
      'OUT=build/folio-android',
      `CC=${cc}`,
      `CXX=${cc}++`,
      // Fonts are compiled from generated C, not wrapped by the host's `ld -r -b binary`.
      'HAVE_OBJCOPY=no',
      `AR=${path.join(bin, 'llvm-ar')}`,
      `RANLIB=${path.join(bin, 'llvm-ranlib')}`,
      'XCFLAGS=-fPIC -ffunction-sections -fdata-sections',
      'libs',
    ],
    source,
  );
  const build = path.join(source, 'build/folio-android');
  const object = path.join(build, 'FolioMuPDF.o');
  run(cc, [
    '-O2',
    '-fPIC',
    '-std=c11',
    '-I',
    path.join(source, 'include'),
    '-I',
    path.join(native, 'include'),
    '-c',
    path.join(native, 'FolioMuPDF.c'),
    '-o',
    object,
  ]);
  fs.mkdirSync(out, { recursive: true });
  for (const file of libraries) fs.rmSync(file, { force: true });
  run(path.join(bin, 'llvm-ar'), ['rcs', libraries[0], object]);
  fs.copyFileSync(path.join(build, 'libmupdf.a'), libraries[1]);
  fs.copyFileSync(path.join(build, 'libmupdf-third.a'), libraries[2]);
  fs.writeFileSync(
    stamp,
    JSON.stringify({ key, ...inputs, outputs: libraries.map(file => ({ file, sha256: hash(file) })) }, null, 2),
  );
  fs.rmSync(stage, { recursive: true, force: true });
  console.log('MuPDF Android: built arm64 static libraries.');
} catch (error) {
  console.error(`Folio MuPDF Android: ${error.message}`);
  process.exitCode = 1;
}
