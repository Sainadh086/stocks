import assert from 'node:assert/strict';
import poll from '../shared/assets/poll.js';

let scheduled;
let cancelled = 0;
const events = [];
globalThis.window = {
    setTimeout: (callback, delay) => {
        assert.equal(delay, 2000);
        scheduled = callback;
        return 1;
    },
    clearTimeout: id => { assert.equal(id, 1); cancelled++; },
};
const dialog = { isConnected: true, getClientRects: () => [1] };
const host = { closest: () => dialog };
const parentElement = {
    isConnected: true,
    closest: () => null,
    getRootNode: () => ({ host }),
};
const render = () => poll({ parentElement, setTriggerValue: (...event) => events.push(event) });

const cleanup = render();
scheduled();
assert.equal(events.length, 1);
assert.equal(events[0][0], 'tick');
cleanup();
assert.equal(cancelled, 1);

// Hidden, removed, or non-dialog components must not refresh the page.
dialog.getClientRects = () => [];
render(); scheduled();
assert.equal(events.length, 1);
dialog.getClientRects = () => [1];
parentElement.isConnected = false;
render(); scheduled();
assert.equal(events.length, 1);
parentElement.isConnected = true;
host.closest = () => null;
render(); scheduled();
assert.equal(events.length, 1);
assert.equal('location' in window, false);
console.log('Dialog polling tests passed.');
