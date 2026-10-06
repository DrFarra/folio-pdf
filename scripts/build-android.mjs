import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd(), android = path.join(root, 'src-tauri/gen/android');
if (!process.env.JAVA_HOME || !process.env.ANDROID_HOME || !process.env.NDK_HOME) throw new Error('Configura JAVA_HOME, ANDROID_HOME y NDK_HOME. En Windows puedes cargarlos con . ./scripts/android-env.ps1');
// A release keystore builds the signed AAB and APK for publication; without one
// the script keeps building the debug test APK signed with the development key.
const keystore = process.env.FOLIO_ANDROID_KEYSTORE && path.resolve(process.env.FOLIO_ANDROID_KEYSTORE), release = !!keystore, profile = release ? 'release' : 'debug';
if (release) process.env.FOLIO_ANDROID_KEYSTORE = keystore; // Gradle resolves paths from src-tauri/gen/android.
if (release && (!process.env.FOLIO_ANDROID_KEYSTORE_PASSWORD || !process.env.FOLIO_ANDROID_KEY_ALIAS)) throw new Error('Configura FOLIO_ANDROID_KEYSTORE_PASSWORD y FOLIO_ANDROID_KEY_ALIAS para firmar la versión de publicación.');
const targets = (process.env.FOLIO_ANDROID_TARGETS || 'aarch64').split(/[\s,]+/).filter(Boolean);
const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
if (!fs.existsSync(android)) {
  const init = spawnSync(process.execPath, [cli, 'android', 'init', '--ci'], { stdio:'inherit' });
  if (init.status !== 0) process.exit(init.status || 1);
}
const result = spawnSync(process.execPath, [cli, 'android', 'build', release ? '--aab' : '--debug', '--apk', '--target', ...targets, '--ci'], { encoding:'utf8', maxBuffer:32 * 1024 * 1024 });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
const Profile = profile[0].toUpperCase() + profile.slice(1);
if (result.status !== 0) {
  // Tauri requires symbolic links on Windows. Copy the successfully compiled
  // library and let Gradle package it when Developer Mode is unavailable.
  if (process.platform !== 'win32' || targets.join() !== 'aarch64' || !`${result.stderr}${result.stdout}`.includes('Creation symbolic link is not allowed')) process.exit(result.status || 1);
  const native = path.join(android, 'app/src/main/jniLibs/arm64-v8a'); fs.mkdirSync(native,{recursive:true});
  const library = path.join(native,'libfolio_desktop.so');
  fs.copyFileSync(path.join(root,`src-tauri/target/aarch64-linux-android/${profile}/libfolio_desktop.so`),library);
  const strip = spawnSync(path.join(process.env.NDK_HOME,'toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-strip.exe'), ['--strip-debug',library], {stdio:'inherit'});
  if(strip.status !== 0) process.exit(strip.status || 1);
  const gradle = spawnSync('cmd.exe',['/d','/s','/c',`gradlew.bat assembleArm64${Profile}${release ? ` bundleArm64${Profile}` : ''} -x rustBuildArm64${Profile}`],{cwd:android,stdio:'inherit'});
  if(gradle.status !== 0) process.exit(gradle.status || 1);
}
const output = path.join(root,'release/android'); fs.mkdirSync(output,{recursive:true});
const version = JSON.parse(fs.readFileSync(path.join(root,'src-tauri/tauri.android.conf.json'),'utf8')).version;
const name = release ? `Folio-Android-${version}` : `Folio-Android-${version}-tablet-telefono`, apk = path.join(output,`${name}.apk`);
// Tauri builds the universal flavor; the Windows fallback above builds arm64.
const newest = files => files.filter(file => fs.existsSync(file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const built = newest(['universal', 'arm64'].map(flavor => path.join(android,'app/build/outputs/apk',flavor,profile,`app-${flavor}-${profile}.apk`)));
if (!built) throw new Error('Gradle no generó el APK.');
const work = path.dirname(built);
const unsigned = path.join(work,'compact-unsigned.apk'), aligned = path.join(work,'compact-aligned.apk');
const buildTools = path.join(process.env.ANDROID_HOME,'build-tools/36.0.0');
const python = process.platform === 'win32' ? path.join(process.env.NDK_HOME,'toolchains/llvm/prebuilt/windows-x86_64/python3/python.exe') : 'python3';
function checked(command,args) {
  const run=spawnSync(command,args,{stdio:'inherit'});
  if(run.error) throw run.error;
  if(run.status !== 0) process.exit(run.status || 1);
}
checked(python,[path.join(root,'scripts/compact-apk.py'),built,unsigned]);
checked(path.join(buildTools,process.platform==='win32'?'zipalign.exe':'zipalign'),['-P','16','-f','4',unsigned,aligned]);
// apksigner reads the passwords from the environment, never from the command line.
const signer = release
  ? ['--ks',keystore,'--ks-pass','env:FOLIO_ANDROID_KEYSTORE_PASSWORD','--ks-key-alias',process.env.FOLIO_ANDROID_KEY_ALIAS,...(process.env.FOLIO_ANDROID_KEY_PASSWORD ? ['--key-pass','env:FOLIO_ANDROID_KEY_PASSWORD'] : [])]
  : ['--ks',path.join(process.env.USERPROFILE || process.env.HOME,'.android/debug.keystore'),'--ks-pass','pass:android','--key-pass','pass:android'];
function sign(args) {
  checked(path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'),['-Xmx1024M','-jar',path.join(buildTools,'lib/apksigner.jar'),...args]);
}
sign(['sign',...signer,'--out',apk,aligned]);
sign(['verify','--verbose',apk]);
if (!release) { console.log(`APK de prueba, firmado con clave de desarrollo: ${apk}`); process.exit(0); }
// Gradle signs the bundle with the same keystore (app/build.gradle.kts).
const bundle = newest(['universal', 'arm64'].map(flavor => path.join(android,'app/build/outputs/bundle',`${flavor}Release`,`app-${flavor}-release.aab`)));
if (!bundle) throw new Error('Gradle no generó el AAB.');
const aab = path.join(output,`${name}.aab`); fs.copyFileSync(bundle,aab);
console.log(`Versión de publicación firmada:\n${apk}\n${aab}`);
