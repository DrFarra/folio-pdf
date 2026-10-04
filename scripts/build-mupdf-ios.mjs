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
const work = path.join(root, 'test-results/mupdf-ios');
const plugin = path.join(root, 'src-tauri/plugins/folio-ios/ios');
const framework = path.join(plugin, 'Frameworks/FolioMuPDF.xcframework');
const stamp = path.join(work, 'build.json');
const features = ['build=release', 'OS=Darwin', 'USE_SYSTEM_LIBS=no', 'HAVE_LIBCRYPTO=no',
  'HAVE_X11=no', 'HAVE_GLUT=no', 'HAVE_GLFW=no', 'html=no', 'xps=no', 'svg=no',
  'extract=no', 'barcode=no', 'tesseract=no', 'tofu_cjk=yes'];

function run(command, args, cwd = root, quiet = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout?.trim() || '';
}
function hash(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function shellWord(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
function owned(target) {
  const relative = path.relative(root, path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Build output must remain within the project.');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Build output must not traverse a symlink: ${current}`);
  }
  return path.resolve(target);
}

try {
  if (process.platform !== 'darwin') throw new Error('MuPDF for iPhone requires macOS and the full Xcode SDKs.');
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--source')) throw new Error('Usage: node scripts/build-mupdf-ios.mjs [--source archive.tar.gz]');
  const archive = args.length ? path.resolve(args[1]) : path.join(root, 'test-results', archiveName);
  fs.mkdirSync(owned(work), { recursive: true });
  if (!fs.existsSync(archive)) {
    if (args.length) throw new Error(`Source archive does not exist: ${archive}`);
    run('curl', ['--fail', '--location', '--retry', '3', `https://mupdf.com/downloads/archive/${archiveName}`, '-o', archive]);
  }
  if (hash(archive) !== sourceHash) throw new Error('The MuPDF source archive does not match the pinned SHA-256.');
  const nativeFiles = ['NativeExport/FolioMuPDF.c', 'NativeExport/include/FolioMuPDF.h', 'NativeExport/include/module.modulemap'];
  const compiler = run('xcrun', ['--find', 'clang'], root, true);
  const ar = run('xcrun', ['--find', 'ar'], root, true);
  const ranlib = run('xcrun', ['--find', 'ranlib'], root, true);
  const compilerVersion = run(compiler, ['--version'], root, true);
  const sdks = Object.fromEntries(['iphoneos', 'iphonesimulator', 'macosx'].map(sdk => [sdk, run('xcrun', ['--sdk', sdk, '--show-sdk-path'], root, true)]));
  const inputs = { version, sourceHash, compilerVersion, sdks, features, minimumIOS: '17.0', buildScriptSha256: hash(fileURLToPath(import.meta.url)),
    wrapper: Object.fromEntries(nativeFiles.map(file => [file, hash(path.join(plugin, file))])) };
  const key = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  if (fs.existsSync(stamp) && fs.existsSync(framework)) {
    const cached = JSON.parse(fs.readFileSync(stamp, 'utf8'));
    if (cached.key === key && cached.outputs.every(file => fs.existsSync(file.path) && hash(file.path) === file.sha256)) {
      fs.mkdirSync(path.join(root, 'test-results/ios'), { recursive: true });
      fs.copyFileSync(stamp, path.join(root, 'test-results/ios/mupdf-ios-build.json'));
      console.log('MuPDF iOS: verified cached device/simulator libraries.');
      process.exit(0);
    }
  }
  const stage = fs.mkdtempSync(path.join(work, 'stage-'));
  // The verified upstream archive is extracted only beneath this fresh build
  // directory. Python's data filter also rejects unsafe archive members.
  run('python3', ['-c', 'import sys,tarfile; a=tarfile.open(sys.argv[1]); a.extractall(sys.argv[2],filter="data")', archive, stage]);
  const source = path.join(stage, `mupdf-${version}-source`);
  const jobs = String(Math.max(1, Math.min(6, os.availableParallelism())));
  run('make', ['-j', jobs, ...features, 'mujs=yes', 'generate'], source);
  const libraries = [];
  for (const [sdk, triple] of [['iphoneos', 'arm64-apple-ios17.0'], ['iphonesimulator', 'arm64-apple-ios17.0-simulator']]) {
    const relativeOutput = `build/folio-${sdk}`;
    const output = path.join(source, relativeOutput);
    const flags = ['-target', triple, '-isysroot', sdks[sdk]];
    run('make', ['-j', jobs, ...features, 'mujs=no', `OUT=${relativeOutput}`, `CC=${shellWord(compiler)}`, `AR=${shellWord(ar)}`, `RANLIB=${shellWord(ranlib)}`, `XCFLAGS=${flags.map(shellWord).join(' ')}`, 'libs'], source);
    const wrapper = path.join(output, 'FolioMuPDF.o');
    run(compiler, [...flags, '-O2', '-std=c11', '-I', path.join(source, 'include'), '-I', path.join(plugin, 'NativeExport/include'),
      '-c', path.join(plugin, 'NativeExport/FolioMuPDF.c'), '-o', wrapper]);
    const library = path.join(output, 'libFolioMuPDF.a');
    run('xcrun', ['libtool', '-static', '-o', library, wrapper, path.join(output, 'libmupdf.a'), path.join(output, 'libmupdf-third.a')]);
    if (run('xcrun', ['lipo', '-archs', library], root, true) !== 'arm64') throw new Error(`Incorrect MuPDF architecture: ${sdk}`);
    libraries.push({ sdk, triple, path: library, sha256: hash(library), bytes: fs.statSync(library).size });
  }
  // Host mutool independently validates exported PDFs at 64-bit file offsets;
  // it is a test tool and is never included in the device application.
  const relativeHostOut = 'build/folio-host';
  const hostOut = path.join(source, relativeHostOut);
  const hostTriple = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`;
  const hostFlags = ['-target', hostTriple, '-isysroot', sdks.macosx].map(shellWord).join(' ');
  run('make', ['-j', jobs, ...features, 'mujs=yes', `OUT=${relativeHostOut}`, `CC=${shellWord(compiler)}`, `AR=${shellWord(ar)}`, `RANLIB=${shellWord(ranlib)}`,
    `XCFLAGS=${hostFlags}`, `XLDFLAGS=${hostFlags}`, `${relativeHostOut}/mutool`], source);
  const hostTool = path.join(hostOut, 'mutool');
  run(hostTool, ['-v'], root, true);
  fs.mkdirSync(owned(path.dirname(framework)), { recursive: true });
  const generated = path.join(stage, 'FolioMuPDF.xcframework');
  run('xcodebuild', ['-create-xcframework', ...libraries.flatMap(lib => ['-library', lib.path, '-headers', path.join(plugin, 'NativeExport/include')]), '-output', generated]);
  // Both paths are fixed generated outputs within this workspace, checked
  // above. Retain the previous framework instead of deleting a checkout.
  if (fs.existsSync(owned(framework))) fs.renameSync(framework, path.join(stage, 'previous-FolioMuPDF.xcframework'));
  fs.renameSync(generated, framework);
  const outputs = [];
  function record(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) record(file);
      else if (item.isFile()) outputs.push({ path: file, sha256: hash(file), bytes: fs.statSync(file).size });
      else throw new Error('Unexpected link in generated MuPDF framework.');
    }
  }
  record(framework);
  outputs.push({ path: hostTool, sha256: hash(hostTool), bytes: fs.statSync(hostTool).size });
  const report = { passed: true, key, ...inputs, libraries, framework, hostMutool: hostTool,
    hostMutoolSha256: hash(hostTool), sourceModified: false, outputs };
  fs.writeFileSync(stamp, JSON.stringify(report, null, 2));
  fs.mkdirSync(path.join(root, 'test-results/ios'), { recursive: true });
  fs.copyFileSync(stamp, path.join(root, 'test-results/ios/mupdf-ios-build.json'));
  console.log('MuPDF iOS: built separate arm64 device/simulator libraries and host validator.');
} catch (error) { console.error(`Folio MuPDF iOS: ${error.message}`); process.exitCode = 1; }
