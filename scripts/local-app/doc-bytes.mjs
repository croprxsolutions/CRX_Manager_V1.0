// A third, separate test stack (crx-doc-bytes-proof, API 54831, database 54832) for the customer-document
// byte proof, scripts/smoke/run-customer-document-bytes-proof.mjs. It never touches the shared or sales stacks.
if (process.env.CRX_LOCAL_APP_PROFILE && process.env.CRX_LOCAL_APP_PROFILE !== 'doc-bytes') {
  throw new Error('LOCAL_APP_REFUSED: Unknown local test profile.');
}
process.env.CRX_LOCAL_APP_PROFILE = 'doc-bytes';
await import('./app.mjs');
