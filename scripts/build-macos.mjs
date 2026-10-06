import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const minimumMacOS = '14.0';
const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];

class BuildError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}
function fail(message) { throw new BuildError(message); }
function readJSON(filename) {
  try { return JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8')); }
  catch { fail(`No se pudo leer ${filename}. Ejecuta este script desde una copia completa de la fuente de Folio.`); }
}
function command(name, args, explanation, inherit = false) {
  const result = spawnSync(name, args, { cwd: root, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', env: process.env });
  if (result.error) fail(`${explanation}\nNo se pudo ejecutar ${name}: ${result.error.message}`);
  if (result.status !== 0) throw new BuildError(`${explanation}${result.stderr?.trim() ? `\n${result.stderr.trim()}` : ''}`, result.status || 1);
  return result.stdout?.trim() || '';
}
function windowsEnvironment() {
  const contaminated = [];
  const windowsPathOrTool = /(?:^[a-z]:[\\/]|\\|\b(?:clang-cl|lld-link|llvm-lib)(?:\.exe)?\b|\.exe(?:\s|$)|windows-msvc)/i;
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/^CARGO_TARGET_.*_WINDOWS_MSVC_(LINKER|AR|RUSTFLAGS)$/.test(name)) contaminated.push(name);
    else if (/^(CC|CXX|AR|RC|RUSTC|RUSTC_WRAPPER|CARGO_BUILD_RUSTC|CARGO_BUILD_RUSTC_WRAPPER|CARGO_BUILD_TARGET|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_HOME|RUSTUP_HOME)$/.test(name) || /^CARGO_TARGET_.*_LINKER$/.test(name)) {
      if (windowsPathOrTool.test(value)) contaminated.push(name);
    }
  }
  const targetDir = process.env.CARGO_TARGET_DIR;
  if (targetDir && (windowsPathOrTool.test(targetDir) || fs.existsSync(path.resolve(root, targetDir, 'release/folio-pdf.exe')) || fs.existsSync(path.resolve(root, targetDir, 'release/bundle/nsis')))) contaminated.push('CARGO_TARGET_DIR');
  if (contaminated.length) fail(`El entorno conserva configuración de compilación Windows: ${[...new Set(contaminated)].join(', ')}.\nAbre una terminal nueva en el Mac y elimina esas variables antes de ejecutar npm run desktop:macos. No reutilices scripts/windows-env.ps1.`);
}
function validateIcon(relative) {
  const filename = path.resolve(root, 'src-tauri', relative);
  let bytes;
  try { bytes = fs.readFileSync(filename); } catch { fail(`Falta el icono Mac ${relative}. Conserva src-tauri/icons/icon.icns al copiar la fuente.`); }
  if (bytes.length < 8 || bytes.length > 16 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'icns' || bytes.readUInt32BE(4) !== bytes.length) fail(`El icono ${relative} no es un archivo ICNS válido.`);
  let offset = 8, chunks = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail(`El icono ${relative} contiene una cabecera ICNS incompleta.`);
    const size = bytes.readUInt32BE(offset + 4);
    if (size < 8 || offset + size > bytes.length) fail(`El icono ${relative} contiene una imagen ICNS incompleta.`);
    offset += size; chunks++;
  }
  if (!chunks) fail(`El icono ${relative} no contiene imágenes.`);
}
function configuration() {
  const pkg = readJSON('package.json'), lock = readJSON('package-lock.json');
  const common = readJSON('src-tauri/tauri.conf.json');
  const platform = readJSON('src-tauri/tauri.macos.conf.json');
  let cargo;
  try { cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8').split('[package]')[1]?.split(/\r?\n\[/)[0]; }
  catch { fail('Falta src-tauri/Cargo.toml. Conserva también la carpeta crates al copiar la fuente.'); }
  const cargoVersion = cargo?.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!pkg.version || common.version !== pkg.version || cargoVersion !== pkg.version || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version || platform.version && platform.version !== pkg.version) fail('Las versiones de package.json, package-lock.json, Cargo.toml y la configuración Tauri no coinciden. Usa la misma entrega de fuente para todos.');
  const mac = { ...common.bundle?.macOS, ...platform.bundle?.macOS };
  if (mac.minimumSystemVersion !== minimumMacOS) fail(`La configuración Mac debe declarar bundle.macOS.minimumSystemVersion "${minimumMacOS}", igual que MACOSX_DEPLOYMENT_TARGET de este script.`);
  if (mac.signingIdentity !== '-') fail('Deja bundle.macOS.signingIdentity como "-" (firma ad hoc). Para firmar con Developer ID, define APPLE_SIGNING_IDENTITY al compilar.');
  const icons = platform.bundle?.icon || common.bundle?.icon || [];
  const icns = icons.filter(icon => typeof icon === 'string' && icon.toLowerCase().endsWith('.icns'));
  if (!icns.length) fail('La configuración Mac debe incluir icons/icon.icns en bundle.icon. Los iconos ICO de Windows no bastan.');
  icns.forEach(validateIcon);
  return pkg.version;
}

function optionValues(args, longName, shortName) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index].startsWith(`${longName}=`)) values.push(args[index].slice(longName.length + 1));
    else if (args[index] === longName || args[index] === shortName) {
      while (args[index + 1] && !args[index + 1].startsWith('-')) values.push(args[++index]);
    }
  }
  return values.flatMap(value => value.split(/[\s,]+/)).filter(Boolean);
}
function verifiedProductionApplication(version, env) {
  const targetDirectory = env.CARGO_TARGET_DIR ? path.resolve(root, env.CARGO_TARGET_DIR) : path.join(root, 'src-tauri/target');
  const app = path.join(targetDirectory, 'universal-apple-darwin/release/bundle/macos/Folio.app');
  const plist = path.join(app, 'Contents/Info.plist');
  if (!fs.existsSync(plist)) fail('No hay una aplicación de producción para empaquetar. Compila primero con --bundles app.');
  const info = JSON.parse(command('plutil', ['-convert', 'json', '-o', '-', plist], 'No se pudo verificar el Info.plist de la aplicación existente.'));
  if (info.CFBundleIdentifier !== 'org.folio.pdf' || info.CFBundleShortVersionString !== version || info.CFBundleVersion !== version || info.LSMinimumSystemVersion !== minimumMacOS) fail('La aplicación existente no corresponde a la versión de producción esperada. No se reintenta el empaquetado.');
  if (!info.CFBundleExecutable || path.basename(info.CFBundleExecutable) !== info.CFBundleExecutable) fail('El ejecutable del bundle no tiene un nombre válido.');
  const executable = path.join(app, 'Contents/MacOS', info.CFBundleExecutable);
  if (!fs.existsSync(executable) || !(fs.statSync(executable).mode & 0o111) || fs.readFileSync(executable).includes(Buffer.from('FOLIO_NATIVE_QA_BUILD'))) fail('Falta una aplicación ejecutable de producción sin instrumentación QA. No se reintenta el empaquetado.');
  const architectures = command('lipo', ['-archs', executable], 'No se pudo comprobar la aplicación universal.').split(/\s+/).sort();
  if (architectures.join(',') !== 'arm64,x86_64') fail('La aplicación existente no contiene ambas arquitecturas.');
  command('codesign', ['--verify', '--deep', '--strict', app], 'La firma de la aplicación existente no es válida.');
  const signature = spawnSync('codesign', ['--display', '--verbose=4', app], { cwd: root, env, encoding: 'utf8' });
  const adHoc = env.APPLE_SIGNING_IDENTITY === '-';
  if (signature.error || signature.status !== 0 || !(adHoc ? /Signature=adhoc|flags=.*\badhoc\b/ : /Authority=Developer ID Application:/).test(`${signature.stdout}\n${signature.stderr}`)) fail(`La aplicación existente no tiene la firma ${adHoc ? 'ad hoc' : 'Developer ID'} esperada.`);
  return app;
}
async function runTauri(cli, args, env) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: ['inherit', 'pipe', 'pipe'] });
  let log = '';
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', data => { log = (log + data.toString()).slice(-64000); output.write(data); });
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGINT', interrupt);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', error => reject(new BuildError(`No se pudo iniciar Tauri: ${error.message}`)));
      child.once('exit', (status, signal) => resolve(status ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
    return { code, log };
  } finally { process.removeListener('SIGINT', interrupt); }
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Folio necesita Node.js 22 o posterior. Instala Node 24 y ejecuta npm ci antes de compilar.');
  if (process.platform !== 'darwin') fail('La versión Mac se compila en un equipo con macOS o en un runner macOS de GitHub Actions. Este entorno no puede generar ni verificar una aplicación .app o un instalador .dmg.\nEjecuta npm run desktop:macos en el Mac con la fuente de Folio; la versión Windows ya entregada continúa disponible.');
  windowsEnvironment();
  const version = configuration();
  for (const tool of ['clang', 'lipo', 'codesign']) command('xcrun', ['--find', tool], `No se encontró ${tool} de Apple. Instala Xcode Command Line Tools con xcode-select --install y vuelve a intentarlo.`);
  const sdk = command('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], 'No se encontró el SDK de macOS. Revisa xcode-select -p e instala Xcode Command Line Tools.');
  if (!fs.existsSync(sdk)) fail('La ruta del SDK de macOS no existe. Revisa la instalación de Xcode Command Line Tools.');
  const rust = command('rustc', ['-vV'], 'No se encontró Rust para macOS. Instálalo desde https://rustup.rs y abre una terminal nueva.');
  if (!/^host:\s+(?:aarch64|x86_64)-apple-darwin\s*$/m.test(rust)) fail('El compilador Rust activo no corresponde a macOS. Usa un toolchain Rust Apple Darwin en una terminal nueva.');
  const installed = new Set(command('rustup', ['target', 'list', '--installed'], 'No se pudo consultar rustup. Instala Rust desde https://rustup.rs.').split(/\s+/));
  const missing = targets.filter(target => !installed.has(target));
  if (missing.length) {
    console.log(`Instalando targets Rust para la aplicación universal: ${missing.join(', ')}.`);
    command('rustup', ['target', 'add', ...missing], 'No se pudieron instalar los targets Rust. Comprueba la conexión y ejecuta rustup target add aarch64-apple-darwin x86_64-apple-darwin.', true);
    const updated = new Set(command('rustup', ['target', 'list', '--installed'], 'No se pudieron verificar los targets instalados.').split(/\s+/));
    if (targets.some(target => !updated.has(target))) fail('Falta un target Rust requerido para Intel o Apple Silicon. La compilación universal no comenzó.');
  }
  const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  if (!fs.existsSync(cli)) fail('Falta la CLI de Tauri para este proyecto. Ejecuta npm ci en el Mac antes de compilar.');
  const bundleOnly = process.argv.slice(2).includes('--bundle-only');
  const args = process.argv.slice(2).filter(value => value !== '--bundle-only');
  const qa = optionValues(args, '--features', '-f').includes('native-qa') || args.includes('--all-features');
  if (bundleOnly && qa) fail('La variante QA no se utiliza para recuperar ni crear la entrega de producción.');
  // Ad hoc unless APPLE_SIGNING_IDENTITY names a Developer ID certificate. Tauri
  // then signs with the hardened runtime and notarizes with APPLE_API_* or
  // APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID. The QA variant is always ad hoc.
  const identity = !qa && process.env.APPLE_SIGNING_IDENTITY?.trim() || '-';
  const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: minimumMacOS, APPLE_SIGNING_IDENTITY: identity };
  // Ad-hoc builds never submit software to Apple's notarization service.
  for (const name of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD']) if (identity === '-' || !env[name]) delete env[name];
  const requestedBundles = optionValues(args, '--bundles', '-b');
  const hasBundlesOption = args.some(value => value === '--bundles' || value === '-b' || value.startsWith('--bundles='));
  const bundles = hasBundlesOption ? [] : ['--bundles', 'app,dmg'];
  const options = ['--target', 'universal-apple-darwin', '--ci', '--verbose', ...bundles, ...args];
  if (bundleOnly) verifiedProductionApplication(version, env);
  console.log(`Folio ${version}: ${bundleOnly ? 'empaquetado de la aplicación ya compilada' : 'compilación universal para Intel y Apple Silicon'}, con firma ${identity === '-' ? 'ad hoc' : identity}.`);
  let result = await runTauri(cli, [bundleOnly ? 'bundle' : 'build', ...options], env);
  const dmgRequested = !hasBundlesOption || requestedBundles.includes('dmg');
  if (result.code && !qa && result.code !== 130 && result.code !== 143 && dmgRequested &&
      (bundleOnly || /bundle_dmg\.sh|failed to bundle[^\n]*dmg/i.test(result.log))) {
    verifiedProductionApplication(version, env);
    console.error('Falló la creación del DMG. La aplicación universal de producción está verificada; se reintenta únicamente Tauri bundle una vez, sin recompilar Rust.');
    const attached = spawnSync('hdiutil', ['info'], { cwd: root, env, encoding: 'utf8' });
    console.error(`Diagnóstico de volúmenes montados:\n${attached.stdout || attached.stderr || 'No disponible.'}`);
    result = await runTauri(cli, ['bundle', ...options], env);
  }
  if (result.code) throw new BuildError('La compilación o el empaquetado Mac no terminó correctamente. Revisa el diagnóstico de Tauri; no se declara un DMG listo.', result.code);
  console.log('Compilación terminada. Los bundles están en src-tauri/target/universal-apple-darwin/release/bundle, o en CARGO_TARGET_DIR si lo configuraste.');
}

try { await main(); }
catch (error) { console.error(`Folio: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = error instanceof BuildError ? error.exitCode : 1; }
