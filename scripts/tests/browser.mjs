import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// One place to find the Chromium-based browser for UI tests: CHROME_PATH
// wins, otherwise the first installed Chrome, Edge or Chromium.
export const chromeCandidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  path.join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
export function findChrome() { return process.env.CHROME_PATH || chromeCandidates.find(file => fs.existsSync(file)); }
