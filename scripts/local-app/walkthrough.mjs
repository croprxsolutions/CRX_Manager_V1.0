import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Each worktree gets stable Docker resources, so parallel feature work cannot share its test data.
if (process.env.CRX_LOCAL_APP_PROFILE && process.env.CRX_LOCAL_APP_PROFILE !== 'screen-walk') {
  throw new Error('LOCAL_APP_REFUSED: Unknown local test profile.');
}
// The browser child always reads the canonical state folder, so the public command takes no alternate one.
if (process.env.CRX_LOCAL_APP_STATE_DIR) throw new Error('LOCAL_APP_REFUSED: walkthrough.mjs does not accept CRX_LOCAL_APP_STATE_DIR. Unset it.');
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const lanePath = process.platform === 'win32' ? root.toLowerCase() : root;
process.env.CRX_LOCAL_APP_LANE = createHash('sha256').update(lanePath).digest('hex').slice(0, 8);
process.env.CRX_LOCAL_APP_PROFILE = 'screen-walk';
await import('./app.mjs');
