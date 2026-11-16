// A distinct entry point fails safely on older checkouts instead of rebuilding their shared stack.
if (process.env.CRX_LOCAL_APP_PROFILE && process.env.CRX_LOCAL_APP_PROFILE !== 'sales-gauntlet') {
  throw new Error('LOCAL_APP_REFUSED: Unknown local test profile.');
}
process.env.CRX_LOCAL_APP_PROFILE = 'sales-gauntlet';
await import('./app.mjs');
