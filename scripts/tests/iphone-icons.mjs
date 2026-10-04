import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { syncIosIcons } from '../build-ios.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-iphone-icons-'));
const original = path.join(root, 'src-tauri/icons/ios');
const source = path.join(temporary, 'src-tauri/icons/ios');
const project = path.join(temporary, 'src-tauri/gen/apple');
const staged = path.join(project, 'Assets.xcassets/AppIcon.appiconset');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  fs.mkdirSync(source, { recursive: true });
  fs.cpSync(original, source, { recursive: true });
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, 'Contents.json'), '{"images":[{"filename":"Tauri.png"}]}');
  fs.writeFileSync(path.join(staged, 'AppIcon-60x60@2x.png'), 'incorrect template artwork');
  const report = syncIosIcons(temporary, project);
  assert.equal(report.verified, true);
  assert.equal(report.icons.length, 18);
  assert.equal(sha(path.join(staged, 'Contents.json')), sha(path.join(original, 'Contents.json')));
  for (const icon of report.icons) assert.equal(sha(path.join(staged, icon.filename)), sha(path.join(original, icon.filename)));
  fs.writeFileSync(path.join(staged, 'AppIcon-60x60@2x.png'), 'a later init replaced this');
  syncIosIcons(temporary, project);
  assert.equal(sha(path.join(staged, 'AppIcon-60x60@2x.png')), sha(path.join(original, 'AppIcon-60x60@2x.png')));
  const catalog = JSON.parse(fs.readFileSync(path.join(source, 'Contents.json')));
  catalog.images.pop();
  fs.writeFileSync(path.join(source, 'Contents.json'), JSON.stringify(catalog));
  const stagedHash = sha(path.join(staged, 'Contents.json'));
  assert.throws(() => syncIosIcons(temporary, project), /18 tamaños/);
  assert.equal(sha(path.join(staged, 'Contents.json')), stagedHash);
  console.log('PASS: Tauri catalog replaced by all 18 original Folio assets, resync restores artwork, incomplete source rejected before staging.');
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith('folio-iphone-icons-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
