#!/usr/bin/env node
import assert from 'node:assert/strict';
import { blockedTahaRefs, pusherIsTaha } from './check-taha-branch-push.mjs';

const Z = '0'.repeat(40);
const line = (remote) => `refs/heads/x ${'a'.repeat(40)} refs/heads/${remote} ${Z}`;

assert.deepEqual(blockedTahaRefs(line('taha/chem-sale-splits')), ['taha/chem-sale-splits']);
assert.deepEqual(blockedTahaRefs(line('Taha/Anything')), ['Taha/Anything']);
// A deletion is a push too.
assert.deepEqual(blockedTahaRefs(`(delete) ${Z} refs/heads/taha/x ${'b'.repeat(40)}`), ['taha/x']);
// His PR on a branch not named taha/.
assert.deepEqual(blockedTahaRefs(line('fix-billing'), ['fix-billing']), ['fix-billing']);
// Ours pass, including a name that merely contains "taha".
assert.deepEqual(blockedTahaRefs(`${line('claude/taha-pr-no-push-rule')}\n${line('main')}`, ['fix-billing']), []);
assert.deepEqual(blockedTahaRefs(''), []);

assert.equal(pusherIsTaha('TahaKhanAbdalli@gmail.com'), true);
assert.equal(pusherIsTaha('12345+TahaKhanAbdalli@users.noreply.github.com'), true);
assert.equal(pusherIsTaha('masonwells1@users.noreply.github.com'), false);
assert.equal(pusherIsTaha(''), false);

console.log('check-taha-branch-push: ok');
