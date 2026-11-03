#!/usr/bin/env node
// Credential blob decoding, with fake values only: UTF-8, UTF-16LE and go-keyring forms decode;
// a non-token is refused without echoing its value.
import assert from 'node:assert/strict';
import { decodeTokenBlob } from './supabase-credential.mjs';

const token = `sbp_${'a1_'.repeat(10)}`;
const b64 = (text, enc = 'utf8') => Buffer.from(text, enc).toString('base64');
assert.equal(decodeTokenBlob(b64(token)), token);
assert.equal(decodeTokenBlob(b64(token, 'utf16le')), token);
assert.equal(decodeTokenBlob(b64(`${token}\0\0`, 'utf16le')), token);
assert.equal(decodeTokenBlob(b64(`go-keyring-base64:${b64(token)}`)), token);
assert.throws(() => decodeTokenBlob(b64('secret-not-a-token')), (error) => !error.message.includes('secret'));
assert.throws(() => decodeTokenBlob(b64('sbp_short')), /not a Supabase access token/);

console.log('supabase-credential.test.mjs: ok');
