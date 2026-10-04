import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const args = new Set(process.argv.slice(2));
function fail(message) { throw new Error(message); }
function run(command, parameters, inherit = true, env = process.env) {
  const result = spawnSync(command, parameters, { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: inherit ? 'inherit' : 'pipe' });
  if (result.error || result.status !== 0) fail(`${command} falló: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout?.trim() || '';
}
function json(name) { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }
function find(dir, extension) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.name.endsWith(extension)) return [full];
    return entry.isDirectory() ? find(full, extension) : [];
  });
}
function swiftLock() {
  const dependency = json('scripts/ios-swift-dependencies.json').SwiftRs;
  return { pins: [{ identity: 'swift-rs', kind: 'remoteSourceControl', location: dependency.url,
    state: { revision: dependency.revision, version: dependency.version } }], version: 2 };
}
function verifySwiftLocks(tauriRoot) {
  const expected = json('scripts/ios-swift-dependencies.json').SwiftRs;
  const reports = [];
  for (const [name, file] of [['Tauri API', path.join(tauriRoot, 'mobile/ios-api/Package.resolved')],
    ['Folio UIKit', path.join(root, 'src-tauri/plugins/folio-ios/ios/Package.resolved')]]) {
    if (!fs.existsSync(file)) fail(`Falta el lock SwiftPM de ${name}.`);
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pins = lock.pins || lock.object?.pins || [];
    const pin = pins.find(p => p.identity === 'swift-rs' || p.package === 'SwiftRs');
    if (pin?.state?.revision !== expected.revision || pin?.state?.version !== expected.version) fail(`SwiftRs de ${name} no coincide con la revisión bloqueada.`);
    reports.push({ package: name, swiftRsVersion: pin.state.version, swiftRsRevision: pin.state.revision });
  }
  fs.mkdirSync(path.join(root, 'test-results/ios'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test-results/ios/swift-package-locks.json'), JSON.stringify({ verified: true, packages: reports }, null, 2));
}
export function syncIosIcons(workspaceRoot = root, project = path.join(workspaceRoot, 'src-tauri/gen/apple')) {
  const source = path.join(workspaceRoot, 'src-tauri/icons/ios');
  const destination = path.join(project, 'Assets.xcassets/AppIcon.appiconset');
  const contents = fs.readFileSync(path.join(source, 'Contents.json'));
  const catalog = JSON.parse(contents);
  const requiredSlots = [
    ...['20x20', '29x29', '40x40', '60x60'].flatMap(size => ['2x', '3x'].map(scale => `iphone:${size}:${scale}`)),
    ...['20x20', '29x29', '40x40', '76x76'].flatMap(size => ['1x', '2x'].map(scale => `ipad:${size}:${scale}`)),
    'ipad:83.5x83.5:2x', 'ios-marketing:1024x1024:1x',
  ];
  const slots = catalog.images?.map(icon => `${icon.idiom}:${icon.size}:${icon.scale}`) || [];
  if (slots.length !== requiredSlots.length || new Set(slots).size !== slots.length || requiredSlots.some(slot => !slots.includes(slot))) {
    fail('El catálogo original no cubre los 18 tamaños de iconos de iPhone, iPad y App Store.');
  }
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  // ios init supplies Tauri's template icon. Replace its catalog after init and
  // before every build, using the existing Folio artwork without redrawing it.
  const originals = catalog.images.map(icon => {
    if (typeof icon.filename !== 'string' || path.basename(icon.filename) !== icon.filename || !icon.filename.endsWith('.png')) fail('Nombre de icono no válido.');
    const data = fs.readFileSync(path.join(source, icon.filename));
    const expected = Number(icon.size.split('x')[0]) * Number(icon.scale.slice(0, -1));
    if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
        data.toString('ascii', 12, 16) !== 'IHDR' || data.readUInt32BE(16) !== expected || data.readUInt32BE(20) !== expected ||
        data[24] !== 8 || data[25] !== 2) fail(`Icono iOS original inválido o con transparencia: ${icon.filename}`);
    return { icon, data, sha256: hash(data) };
  });
  fs.mkdirSync(destination, { recursive: true });
  for (const { icon, data, sha256 } of originals) {
    const staged = path.join(destination, icon.filename);
    fs.writeFileSync(staged, data);
    if (hash(fs.readFileSync(staged)) !== sha256) fail(`El icono copiado no coincide: ${icon.filename}`);
  }
  fs.writeFileSync(path.join(destination, 'Contents.json'), contents);
  const report = { verified: true, source: 'src-tauri/icons/ios', catalog: 'Assets.xcassets/AppIcon.appiconset',
    catalogSha256: hash(contents), icons: originals.map(({ icon, sha256 }) => ({ ...icon, sha256 })) };
  fs.mkdirSync(path.join(workspaceRoot, 'test-results/ios'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'test-results/ios/icon-catalog-sync.json'), JSON.stringify(report, null, 2));
  return report;
}
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) try {
  if (process.platform !== 'darwin') fail('La versión iPhone requiere macOS y Xcode completo. Este script no genera una IPA desde Windows. Usa el workflow privado ios.yml o un Mac.');
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Se necesita Node.js 22 o posterior.');
  if (!fs.existsSync(cli)) fail('Ejecuta npm ci antes de compilar.');
  for (const name of args) if (!['--init-only', '--device', '--simulator', '--qa'].includes(name)) fail(`Opción no admitida: ${name}`);
  const pkg = json('package.json'), lock = json('package-lock.json'), config = json('src-tauri/tauri.conf.json'), ios = json('src-tauri/tauri.ios.conf.json');
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if ([lock.version, lock.packages[''].version, config.version, cargo].some(v => v !== pkg.version)) fail('Las versiones npm, Cargo y Tauri no coinciden.');
  if (ios.bundle.iOS.minimumSystemVersion !== '17.0') fail('Este flujo requiere minimumSystemVersion 17.0.');
  run('xcodebuild', ['-version']);
  for (const sdk of ['iphoneos', 'iphonesimulator']) run('xcrun', ['--sdk', sdk, '--show-sdk-path'], false);
  const env = { ...process.env, IPHONEOS_DEPLOYMENT_TARGET: '17.0', CI: 'true' };
  // Feather signs the final IPA on the user's device. No developer identity,
  // provision, private key or paid distribution account is used in this build.
  for (const name of ['APPLE_DEVELOPMENT_TEAM', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH', 'APPLE_PROVISIONING_PROFILE']) delete env[name];
  run(process.execPath, [path.join(root, 'scripts/build-mupdf-ios.mjs')], true, env);
  run('rustup', ['target', 'add', 'aarch64-apple-ios', 'aarch64-apple-ios-sim'], true, env);
  // Tauri builds its Swift API as an independent package before our plugin.
  // Seed its SwiftPM resolution too, so neither package silently follows a
  // newly published upstream tag. This adds a generated lock, without changing
  // the locked Tauri SDK source or its Package.swift.
  const metadata = JSON.parse(run('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--filter-platform', 'aarch64-apple-ios', '--format-version', '1'], false, env));
  const tauriPackage = metadata.packages.find(p => p.name === 'tauri');
  if (!tauriPackage) fail('No se encontró el SDK Tauri bloqueado.');
  const tauriRoot = path.dirname(tauriPackage.manifest_path);
  fs.writeFileSync(path.join(tauriRoot, 'mobile/ios-api/Package.resolved'), JSON.stringify(swiftLock(), null, 2));
  fs.writeFileSync(path.join(root, 'src-tauri/plugins/folio-ios/ios/Package.resolved'), JSON.stringify(swiftLock(), null, 2));
  const project = path.join(root, 'src-tauri/gen/apple');
  if (!fs.existsSync(path.join(project, '.folio-scaffold-version'))) {
    // Invoke through the project's npm script. Tauri records this invocation
    // in XcodeBuildRustScript; invoking tauri.js directly would record the
    // invalid relative command `node tauri` inside gen/apple.
    run('npm', ['run', 'tauri', '--', 'ios', 'init', '--ci', '--skip-targets-install'], true, env);
    fs.writeFileSync(path.join(project, '.folio-scaffold-version'), `${pkg.version}\n`);
  } else if (fs.readFileSync(path.join(project, '.folio-scaffold-version'), 'utf8').trim() !== pkg.version) {
    fail('El scaffold iOS pertenece a otra versión. Usa una copia limpia de la fuente; no se borra un proyecto Xcode existente.');
  }
  syncIosIcons(root, project);
  if (args.has('--init-only')) process.exit(0);
  const qa = args.has('--qa');
  if (qa && args.has('--device')) fail('La IPA para Feather se compila sin native-qa. Usa --simulator --qa para diagnósticos.');
  const targets = args.has('--simulator') || qa ? ['aarch64-sim'] : args.has('--device') ? ['aarch64'] : ['aarch64-sim', 'aarch64'];
  const builds = path.join(root, 'test-results/ios-build');
  fs.mkdirSync(builds, { recursive: true });
  for (const target of targets) {
    syncIosIcons(root, project);
    run('npm', ['run', 'tauri', '--', 'ios', 'build', '--target', target, '--no-sign', '--ci', '--verbose', ...(qa ? ['--features', 'native-qa'] : []), '--', '--locked'], true, env);
    verifySwiftLocks(tauriRoot);
    const build = path.join(project, 'build');
    if (target === 'aarch64-sim') {
      const apps = find(path.join(build, 'arm64-sim'), '.app');
      if (apps.length !== 1) fail('No se encontró exactamente un bundle de simulador arm64.');
      const destination = path.join(builds, qa ? 'qa/Folio.app' : 'simulator/Folio.app');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(apps[0], destination, { recursive: true, force: true });
      console.log(`Simulador: ${destination}`);
    } else {
      const ipas = find(path.join(build, 'arm64'), '.ipa');
      if (ipas.length !== 1) fail('No se encontró exactamente una IPA de dispositivo arm64.');
      const destination = path.join(builds, `Folio_${pkg.version}_iphone_arm64_unsigned.ipa`);
      fs.copyFileSync(ipas[0], destination);
      console.log(`IPA para firmar con Feather: ${destination}`);
    }
  }
} catch (error) { console.error(`Folio iOS: ${error.message}`); process.exitCode = 1; }
