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
  serviceWorker: read('public/sw.js').match(/^const VERSION = '([^']+)'/m)?.[1],
};
for (const platform of ['android', 'ios', 'macos']) {
  const config = json(`src-tauri/tauri.${platform}.conf.json`);
  versions[platform] = config.version ?? versions.windows;
}
for (const [name, value] of Object.entries(versions)) {
  assert.equal(value, version, `${name}: version differs from package.json in ${fileURLToPath(root)}`);
}
for (const name of ['README.md', 'docs/android.md', 'docs/ios.md']) {
  for (const [, cited] of read(name).matchAll(/Folio[ _](\d+\.\d+\.\d+)/g)) assert.equal(cited, version, `${name} names Folio ${cited} instead of ${version}.`);
}
// The installers ship SOURCE-BUILD.txt, which names the matching source package.
for (const [, cited] of read('SOURCE-BUILD.txt').matchAll(/(?:Folio |folio-)(\d+\.\d+\.\d+)/g)) assert.equal(cited, version, `SOURCE-BUILD.txt names ${cited} instead of ${version}.`);
console.log(`Folio ${version}: Windows, macOS, iOS, Android and web versions match.`);
