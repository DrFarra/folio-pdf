import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd(), android = path.join(root, 'src-tauri/gen/android');
if (!process.env.JAVA_HOME || !process.env.ANDROID_HOME || !process.env.NDK_HOME) throw new Error('Configura JAVA_HOME, ANDROID_HOME y NDK_HOME. En esta estación: . ./scripts/android-env.ps1');
const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
if (!fs.existsSync(android)) {
  const init = spawnSync(process.execPath, [cli, 'android', 'init', '--ci'], { stdio:'inherit' });
  if (init.status !== 0) process.exit(init.status || 1);
}
const result = spawnSync(process.execPath, [cli, 'android', 'build', '--debug', '--apk', '--target', 'aarch64', '--ci'], { encoding:'utf8', maxBuffer:32 * 1024 * 1024 });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
if (result.status !== 0) {
  // Tauri requires symbolic links on Windows. Copy the successfully compiled
  // library and let Gradle package it when Developer Mode is unavailable.
  if (process.platform !== 'win32' || !`${result.stderr}${result.stdout}`.includes('Creation symbolic link is not allowed')) process.exit(result.status || 1);
  const native = path.join(android, 'app/src/main/jniLibs/arm64-v8a'); fs.mkdirSync(native,{recursive:true});
  const library = path.join(native,'libfolio_desktop.so');
  fs.copyFileSync(path.join(root,'src-tauri/target/aarch64-linux-android/debug/libfolio_desktop.so'),library);
  const strip = spawnSync(path.join(process.env.NDK_HOME,'toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-strip.exe'), ['--strip-debug',library], {stdio:'inherit'});
  if(strip.status !== 0) process.exit(strip.status || 1);
  const gradle = spawnSync('cmd.exe',['/d','/s','/c','gradlew.bat assembleArm64Debug -x rustBuildArm64Debug'],{cwd:android,stdio:'inherit'});
  if(gradle.status !== 0) process.exit(gradle.status || 1);
}
const output = path.join(root,'release/android'); fs.mkdirSync(output,{recursive:true});
const version = JSON.parse(fs.readFileSync(path.join(root,'src-tauri/tauri.android.conf.json'),'utf8')).version;
const apk = path.join(output,`Folio-Android-${version}-tablet-telefono.apk`);
const work = path.join(android,'app/build/outputs/apk/arm64/debug');
const unsigned = path.join(work,'compact-unsigned.apk'), aligned = path.join(work,'compact-aligned.apk');
const buildTools = path.join(process.env.ANDROID_HOME,'build-tools/36.0.0');
const python = process.platform === 'win32' ? path.join(process.env.NDK_HOME,'toolchains/llvm/prebuilt/windows-x86_64/python3/python.exe') : 'python3';
function checked(command,args) {
  const run=spawnSync(command,args,{stdio:'inherit'});
  if(run.error) throw run.error;
  if(run.status !== 0) process.exit(run.status || 1);
}
checked(python,[path.join(root,'scripts/compact-apk.py'),path.join(work,'app-arm64-debug.apk'),unsigned]);
checked(path.join(buildTools,process.platform==='win32'?'zipalign.exe':'zipalign'),['-P','16','-f','4',unsigned,aligned]);
const keystore=path.join(process.env.USERPROFILE || process.env.HOME,'.android/debug.keystore');
function sign(args) {
  checked(path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'),['-Xmx1024M','-jar',path.join(buildTools,'lib/apksigner.jar'),...args]);
}
sign(['sign','--ks',keystore,'--ks-pass','pass:android','--key-pass','pass:android','--out',apk,aligned]);
sign(['verify','--verbose',apk]);
console.log(`APK de prueba, firmado con clave de desarrollo: ${apk}`);
