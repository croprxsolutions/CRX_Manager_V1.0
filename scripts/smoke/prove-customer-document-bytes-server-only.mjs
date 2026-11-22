#!/usr/bin/env node
// Proves PR #635's customer-document byte boundary against a REAL local
// Supabase stack (Postgres + Storage + Auth + the customer-document-files Edge
// Function). It creates users and rows, so it refuses any non-local URL.
//
// Setup (KI-113 rebuilt it on the real schema; the original hand-made fixture is gone):
//   node scripts/local-app/doc-bytes.mjs rebuild      once; own Docker stack, loopback only, baseline + EVERY migration
//   node scripts/smoke/run-customer-document-bytes-proof.mjs [--negative-control]
//     serves today's customer-document-files function next to that stack and runs --phase=after
//     (--negative-control also re-adds a browser read policy on the bucket and requires this proof to fail).
//   node scripts/local-app/doc-bytes.mjs stop         when finished
// To point it at another local stack by hand, export LOCAL_SUPABASE_URL (one origin that serves auth, rest,
// storage and /functions/v1), LOCAL_SUPABASE_ANON_KEY, LOCAL_SUPABASE_SERVICE_ROLE_KEY and the seeded admin's
// LOCAL_SUPABASE_ADMIN_EMAIL / LOCAL_SUPABASE_ADMIN_PASSWORD.
//
//   --phase=after   Asserts browser users cannot read or sign at all, the Edge Function upload/download flow
//     works, a soft-deleted document stops downloading for reps (admins keep it, KI-07), and no look-alike path
//     can be registered to reach its bytes. Runs on today's full chain. Three assertions follow later decisions:
//     any active rep works any customer (2026-10-13, 20261013220000) and an admin may still download a removed
//     document (KI-07, 20261222100000); the byte-boundary assertions are unchanged.
//   --phase=before  HISTORICAL. It proved the pre-20260914100700 hole (a rep's one-year signed URL survives soft
//     delete) and needs the chain stopped just before that migration with the old storage policies. Today's chain
//     is already past that migration, so it is not wired to the runner and is not
//     expected to pass on a full chain; it is kept as the record of how the hole was shown to be real.

import { createClient } from '@supabase/supabase-js';

const BUCKET = 'customer-documents';
const FUNCTION = 'customer-document-files';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

const phaseArg = process.argv.find((arg) => arg.startsWith('--phase='));
const phase = phaseArg?.slice('--phase='.length);
if (phase !== 'before' && phase !== 'after') {
  console.error('Usage: --phase=before | --phase=after');
  process.exit(2);
}

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error('Set LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, LOCAL_SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}
const host = new URL(url).hostname;
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.error(`Refusing to run against non-local Supabase host ${host}.`);
  process.exit(2);
}

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const service = createClient(url, serviceKey, { auth: { persistSession: false } });
const runId = Date.now().toString(36);
const password = `Proof-${runId}-pw!`;

// A seeded admin (scripts/local-app/doc-bytes.mjs rebuild creates one) who assigns roles to the proof's users.
const adminEmail = process.env.LOCAL_SUPABASE_ADMIN_EMAIL;
const adminPassword = process.env.LOCAL_SUPABASE_ADMIN_PASSWORD;
if (!adminEmail || !adminPassword) {
  console.error('Set LOCAL_SUPABASE_ADMIN_EMAIL and LOCAL_SUPABASE_ADMIN_PASSWORD (the seeded admin who assigns roles).');
  process.exit(2);
}
const provisioner = { client: createClient(url, anonKey, { auth: { persistSession: false } }) };
{
  const { error } = await provisioner.client.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (error) throw error;
}

async function makeUser(label, role) {
  const email = `${label}-${runId}@proof.local`;
  // On the real schema Auth-created users arrive as inactive drivers and only an admin session may assign a
  // role (handle_new_user + the profile role lock), so a seeded admin account promotes each new user, the way
  // the create-user flow does in the app.
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const { data: promoted, error: profileError } = await provisioner.client
    .from('profiles').update({ role, is_active: true }).eq('id', data.user.id).select('role, is_active');
  if (profileError) throw profileError;
  if (promoted?.[0]?.role !== role || !promoted[0].is_active) throw new Error(`could not make ${label} an active ${role}`);
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, client };
}

async function makeCustomer(name, repId) {
  const { data, error } = await service
    .from('customers')
    .insert({ farm_name: `${name} ${runId}`, assigned_sales_rep: repId })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function invoke(user, body) {
  const { data, error } = await user.client.functions.invoke(FUNCTION, { body });
  const status = error?.context instanceof Response ? error.context.status : error ? 0 : 200;
  return { data, error, status };
}

async function saveMetadata(user, customerId, storagePath, bytes) {
  return user.client
    .from('customer_documents')
    .insert({
      customer_id: customerId,
      document_type: 'permit',
      storage_path: storagePath,
      filename: 'permit.pdf',
      mime_type: 'application/pdf',
      size_bytes: bytes.byteLength,
      uploaded_by: user.id,
      source: 'rep',
    })
    .select('id')
    .single();
}

async function softDelete(user, documentId) {
  return user.client
    .from('customer_documents')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
    .eq('id', documentId)
    .is('deleted_at', null)
    .select('id');
}

function pdfBytes(label) {
  return new TextEncoder().encode(`%PDF-1.4\n% ${label} ${runId}\n%%EOF\n`);
}

async function runBefore(admin, rep, customerA) {
  const bytes = pdfBytes('before');
  const path = `${customerA}/${crypto.randomUUID()}-permit.pdf`;
  const upload = await rep.client.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf' });
  check('old policies: rep uploads directly to Storage', !upload.error, upload.error?.message);
  const saved = await saveMetadata(rep, customerA, path, bytes);
  check('old policies: rep saves the document row', !saved.error, saved.error?.message);

  const signed = await rep.client.storage.from(BUCKET).createSignedUrl(path, ONE_YEAR_SECONDS);
  check('old policies: rep mints a one-year signed URL while the document is live', Boolean(signed.data?.signedUrl), signed.error?.message);

  const deleted = await softDelete(admin, saved.data?.id);
  check('old policies: admin soft-deletes the document', !deleted.error && deleted.data?.length === 1, deleted.error?.message);

  const fetched = signed.data?.signedUrl ? await fetch(signed.data.signedUrl) : null;
  const body = fetched?.ok ? new Uint8Array(await fetched.arrayBuffer()) : null;
  check(
    'P1 HOLE REPRODUCED: the pre-delete signed URL still serves the bytes after soft delete',
    Boolean(body) && Buffer.from(body).equals(Buffer.from(bytes)),
    `HTTP ${fetched?.status}`,
  );
}

async function runAfter(admin, rep, otherRep, driver, customerA) {
  const bytes = pdfBytes('after');

  const directPath = `${customerA}/${crypto.randomUUID()}-direct.pdf`;
  const direct = await rep.client.storage.from(BUCKET).upload(directPath, bytes, { contentType: 'application/pdf' });
  check('rep cannot upload directly to Storage', Boolean(direct.error), direct.error?.message);

  const otherRepUpload = await invoke(otherRep, {
    action: 'prepare_upload', customer_id: customerA, filename: 'x.pdf', mime_type: 'application/pdf', size_bytes: 10,
  });
  // Mason, 2026-10-13 (20261013220000): reps work any customer, so assignment no longer gates documents.
  check('any active rep may prepare an upload for any customer (2026-10-13 decision)', otherRepUpload.status === 200, `HTTP ${otherRepUpload.status}`);

  const driverRefused = await invoke(driver, {
    action: 'prepare_upload', customer_id: customerA, filename: 'x.pdf', mime_type: 'application/pdf', size_bytes: 10,
  });
  check('a driver cannot use the document function', driverRefused.status === 403, `HTTP ${driverRefused.status}`);

  const anonymous = createClient(url, anonKey, { auth: { persistSession: false } });
  const anonResult = await anonymous.functions.invoke(FUNCTION, { body: { action: 'download', document_id: crypto.randomUUID() } });
  const anonStatus = anonResult.error?.context instanceof Response ? anonResult.error.context.status : 0;
  check('a signed-out caller is refused', anonStatus === 401, `HTTP ${anonStatus}`);

  const prepared = await invoke(rep, {
    action: 'prepare_upload', customer_id: customerA, filename: 'permit.pdf', mime_type: 'application/pdf', size_bytes: bytes.byteLength,
  });
  const path = prepared.data?.storage_path;
  check('assigned rep gets a server-chosen upload path in the customer folder',
    prepared.status === 200 && typeof path === 'string' && path.startsWith(`${customerA}/`), `HTTP ${prepared.status}`);

  const uploaded = await rep.client.storage.from(BUCKET).uploadToSignedUrl(path, prepared.data?.token, bytes, { contentType: 'application/pdf' });
  check('rep uploads with the single-path token', !uploaded.error, uploaded.error?.message);

  const saved = await saveMetadata(rep, customerA, path, bytes);
  check('rep saves the document row', !saved.error, saved.error?.message);
  const documentId = saved.data?.id;

  const repSign = await rep.client.storage.from(BUCKET).createSignedUrl(path, ONE_YEAR_SECONDS);
  check('P1 CLOSED: rep cannot mint a signed URL for a live document', !repSign.data?.signedUrl, repSign.error?.message);
  const adminSign = await admin.client.storage.from(BUCKET).createSignedUrl(path, ONE_YEAR_SECONDS);
  check('P1 CLOSED: admin cannot mint a signed URL either', !adminSign.data?.signedUrl, adminSign.error?.message);
  const repDirect = await rep.client.storage.from(BUCKET).download(path);
  check('rep cannot download directly from Storage', !repDirect.data, repDirect.error?.message);
  const repList = await rep.client.storage.from(BUCKET).list(customerA);
  check('rep cannot list the customer folder', (repList.data ?? []).length === 0, repList.error?.message);

  const downloaded = await invoke(rep, { action: 'download', document_id: documentId });
  const downloadedBytes = downloaded.data instanceof Blob ? new Uint8Array(await downloaded.data.arrayBuffer()) : null;
  check('assigned rep downloads the exact bytes through the function',
    downloaded.status === 200 && Boolean(downloadedBytes) && Buffer.from(downloadedBytes).equals(Buffer.from(bytes)),
    `HTTP ${downloaded.status}`);

  const adminDownload = await invoke(admin, { action: 'download', document_id: documentId });
  check('admin downloads through the function', adminDownload.status === 200, `HTTP ${adminDownload.status}`);

  const otherDownload = await invoke(otherRep, { action: 'download', document_id: documentId });
  check('any active rep downloads a live document of any customer through the function (2026-10-13 decision)', otherDownload.status === 200, `HTTP ${otherDownload.status}`);

  const overwrite = await rep.client.storage.from(BUCKET)
    .uploadToSignedUrl(path, prepared.data?.token, pdfBytes('overwrite'), { contentType: 'application/pdf', upsert: true });
  const afterOverwrite = await invoke(rep, { action: 'download', document_id: documentId });
  const afterOverwriteBytes = afterOverwrite.data instanceof Blob ? new Uint8Array(await afterOverwrite.data.arrayBuffer()) : null;
  check('the upload token cannot overwrite the saved file',
    Boolean(overwrite.error) && Boolean(afterOverwriteBytes) && Buffer.from(afterOverwriteBytes).equals(Buffer.from(bytes)),
    overwrite.error?.message ?? 'overwrite accepted');

  const adminRemove = await admin.client.storage.from(BUCKET).remove([path]);
  const afterRemove = await service.storage.from(BUCKET).list(customerA, { search: path.split('/')[1] });
  check('an admin cannot delete document bytes from the browser',
    (adminRemove.data ?? []).length === 0 && (afterRemove.data ?? []).length === 1, adminRemove.error?.message ?? '');

  // Separate pre-existing bug (not this PR): customer_documents_rep_select hides
  // deleted rows, and PostgreSQL applies SELECT USING to an UPDATE's new row, so
  // a rep's soft delete is refused. Reported, not asserted; the admin removes it.
  const repDelete = await softDelete(rep, documentId);
  console.log(`INFO  rep soft delete (separate known bug): ${repDelete.error ? `refused — ${repDelete.error.message}` : 'allowed'}`);

  // Once that bug is fixed the rep's delete lands and the admin's would match
  // no row, so only fall back to the admin when the rep's did not delete it.
  const deleted = !repDelete.error && repDelete.data?.length === 1
    ? repDelete
    : await softDelete(admin, documentId);
  check('the document is soft-deleted', !deleted.error && deleted.data?.length === 1, deleted.error?.message);

  const afterDeleteRep = await invoke(rep, { action: 'download', document_id: documentId });
  check('SOFT DELETE REVOKES: rep download is refused after delete', afterDeleteRep.status === 404, `HTTP ${afterDeleteRep.status}`);
  const afterDeleteAdmin = await invoke(admin, { action: 'download', document_id: documentId });
  // KI-07 (20261222100000): a removed document stays downloadable for admins only, so they can check it before restoring.
  const afterDeleteAdminBytes = afterDeleteAdmin.data instanceof Blob ? new Uint8Array(await afterDeleteAdmin.data.arrayBuffer()) : null;
  check('SOFT DELETE KEEPS ADMIN-ONLY ACCESS (KI-07): admin still downloads the exact bytes after delete',
    afterDeleteAdmin.status === 200 && Boolean(afterDeleteAdminBytes) && Buffer.from(afterDeleteAdminBytes).equals(Buffer.from(bytes)), `HTTP ${afterDeleteAdmin.status}`);

  const stillStored = await service.storage.from(BUCKET).list(customerA, { search: path.split('/')[1] });
  check('the soft-deleted bytes remain in Storage as the record', (stillStored.data ?? []).length === 1, stillStored.error?.message);

  // Security review H1: a new live row naming a look-alike of the removed
  // document's path, which Storage could resolve to the same object.
  for (const lookAlike of [`${path}#a`, `${path}?a`, path.replace('.pdf', '%2Epdf')]) {
    for (const [label, actor] of [['rep', rep], ['admin', admin]]) {
      const attempt = await saveMetadata(actor, customerA, lookAlike, bytes);
      check(`LOOK-ALIKE REFUSED: ${label} cannot register ${lookAlike.slice(path.length - 4)}`,
        Boolean(attempt.error), attempt.error?.message ?? 'row accepted');
    }
  }

  const missingPrepared = await invoke(rep, {
    action: 'prepare_upload', customer_id: customerA, filename: 'missing.pdf', mime_type: 'application/pdf', size_bytes: bytes.byteLength,
  });
  const missingPath = missingPrepared.data?.storage_path;
  await rep.client.storage.from(BUCKET).uploadToSignedUrl(missingPath, missingPrepared.data?.token, bytes, { contentType: 'application/pdf' });
  const missingSaved = await saveMetadata(rep, customerA, missingPath, bytes);
  await service.storage.from(BUCKET).remove([missingPath]);
  const missingDownload = await invoke(rep, { action: 'download', document_id: missingSaved.data?.id });
  check('a live row whose file is gone answers 404, not 500', missingDownload.status === 404, `HTTP ${missingDownload.status}`);

  const discard = await invoke(rep, { action: 'discard_upload', customer_id: customerA, storage_path: missingPath });
  check('the removed discard action is refused', discard.status === 400, `HTTP ${discard.status}`);

  const wrongType = await invoke(rep, {
    action: 'prepare_upload', customer_id: customerA, filename: 'x.html', mime_type: 'text/html', size_bytes: 10,
  });
  check('a disallowed file type is refused', wrongType.status === 400, `HTTP ${wrongType.status}`);

  // A chunked body carries no Content-Length, so only the streaming cap can stop it.
  const { data: session } = await rep.client.auth.getSession();
  const oversized = new TextEncoder().encode(`{"action":"download","pad":"${'x'.repeat(64 * 1024)}"}`);
  const chunked = await fetch(`${url}/functions/v1/${FUNCTION}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.session.access_token}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: new ReadableStream({
      start(controller) {
        for (let i = 0; i < oversized.byteLength; i += 1024) controller.enqueue(oversized.subarray(i, i + 1024));
        controller.close();
      },
    }),
    duplex: 'half',
  });
  check('an oversized chunked request is refused', chunked.status === 413, `HTTP ${chunked.status}`);
}

async function main() {
  const admin = await makeUser('admin', 'admin');
  const rep = await makeUser('rep', 'sales_rep');
  const otherRep = await makeUser('other-rep', 'sales_rep');
  const driver = await makeUser('driver', 'driver');
  const customerA = await makeCustomer('Proof Farm A', rep.id);
  await makeCustomer('Proof Farm B', otherRep.id);

  if (phase === 'before') await runBefore(admin, rep, customerA);
  else await runAfter(admin, rep, otherRep, driver, customerA);

  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (phase ${phase}).`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Proof crashed:', error);
  process.exit(1);
});
