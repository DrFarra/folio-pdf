// Runs a Python 3 script with the interpreter each system provides: macOS and
// Linux call it python3 and the python.org installer for Windows calls it python.
// PYTHON chooses another interpreter.
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), process.argv.slice(2), { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
