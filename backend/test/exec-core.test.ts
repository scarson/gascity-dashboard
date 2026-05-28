import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ALIAS_RE, ExecError } from '../src/exec-core.js';

describe('exec core primitives', () => {
  test('keeps subprocess errors and agent alias validation outside command wrappers', () => {
    const err = new ExecError('spawn failed: ENOENT', 'spawn');
    assert.equal(err.name, 'ExecError');
    assert.equal(err.kind, 'spawn');
    assert.match('hello-world/gastown.mayor', AGENT_ALIAS_RE);
    assert.doesNotMatch('../mayor', AGENT_ALIAS_RE);
  });
});
