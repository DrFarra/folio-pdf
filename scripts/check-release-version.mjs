import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const json = name => JSON.parse(read(name));
const version = json('package.json').version;
const versions = {
  npmLock: json('package-lock.json').version,
  npmPackage: json('package-lock.json').packages[''].version,
  rust: read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  rustLock: read('src-tauri/Cargo.lock').match(/name = "folio-pdf"\r?\nversion = "([^"]+)"/)?.[1],
  windows: json('src-tauri/tauri.conf.json').version,
};
for (const platform of ['android', 'ios', 'macos']) {
  const config = json(`src-tauri/tauri.${platform}.conf.json`);
  versions[platform] = config.version ?? versions.windows;
}
for (const [name, value] of Object.entries(versions)) {
  assert.equal(value, version, `${name}: version differs from package.json in ${fileURLToPath(root)}`);
}
console.log(`Folio ${version}: Windows, macOS, iOS and Android versions match.`);
