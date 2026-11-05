import test from 'node:test';
import assert from 'node:assert/strict';
import { pointerMoved } from '../../web/js/util.js';

test('hover only counts when the pointer really moved: a repeated position (a list scrolling under a resting mouse) does not', () => {
  assert.equal(pointerMoved({ clientX: 10, clientY: 20 }), true, 'the first position is a move');
  assert.equal(pointerMoved({ clientX: 10, clientY: 20 }), false, 'the same spot again is not');
  assert.equal(pointerMoved({ clientX: 10, clientY: 20 }), false);
  assert.equal(pointerMoved({ clientX: 11, clientY: 20 }), true, 'one pixel sideways is');
  assert.equal(pointerMoved({ clientX: 11, clientY: 21 }), true, 'one pixel down is');
  assert.equal(pointerMoved({ clientX: 10, clientY: 20 }), true, 'going back is a move too');
});
