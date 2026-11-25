import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Each worktree gets stable Docker resources, so parallel feature work cannot share its test data.
if (process.env.CRX_LOCAL_APP_PROFILE && process.env.CRX_LOCAL_APP_PROFILE !== 'screen-walk') {
  throw new Error('LOCAL_APP_REFUSED: Unknown local test profile.');
}
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url))).toLowerCase();
process.env.CRX_LOCAL_APP_LANE = createHash('sha256').update(root).digest('hex').slice(0, 8);
process.env.CRX_LOCAL_APP_PROFILE = 'screen-walk';
await import('./app.mjs');
