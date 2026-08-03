import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createChatSessionManager } from '../chat-sessions.mjs';

test('chat sessions stream through an existing MoA agent and persist privately without affecting runs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moa-chat-sessions-'));
  const requests = [];
  const manager = createChatSessionManager({
    directory,
    listAgents: async () => [{ id: 'codex', label: 'Codex', mark: 'C' }],
    executeAgent: async ({ agentId, messages, attachments, onDelta }) => {
      requests.push({ agentId, messages, attachments });
      onDelta('Hello');
      onDelta(' from Codex.');
      return 'Hello from Codex.';
    },
  });

  try {
    assert.deepEqual(await manager.agents(), [{ id: 'codex', label: 'Codex', mark: 'C' }]);
    const events = [];
    const created = await manager.streamMessage({
      agent: 'codex',
      content: 'Explain the current plan.',
      attachments: [{
        name: 'notes.txt',
        type: 'text/plain',
        size: 12,
        path: '/private/tmp/notes.txt',
      }],
      emit: (event) => events.push(event),
    });

    assert.equal(created.status, 'ready');
    assert.equal(created.agent, 'codex');
    assert.deepEqual(created.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'Explain the current plan.' },
      { role: 'assistant', content: 'Hello from Codex.' },
    ]);
    assert.deepEqual(created.messages[0].attachments, [{ name: 'notes.txt', type: 'text/plain', size: 12 }]);
    assert.deepEqual(events.filter(({ type }) => type === 'delta').map(({ text }) => text), ['Hello', ' from Codex.']);
    assert.equal(events.at(-1).type, 'done');
    assert.deepEqual(requests.at(-1), {
      agentId: 'codex',
      messages: [{
        role: 'user',
        content: 'Explain the current plan.',
        attachments: [{ name: 'notes.txt', type: 'text/plain', size: 12 }],
      }],
      attachments: [{
        name: 'notes.txt',
        type: 'text/plain',
        size: 12,
        path: '/private/tmp/notes.txt',
      }],
    });

    const summaries = await manager.list();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].title, 'Explain the current plan.');
    assert.equal(summaries[0].messageCount, 2);
    assert.deepEqual((await manager.get(created.id)).messages, created.messages);

    const mode = (await stat(path.join(directory, `${created.id}.json`))).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.match(await readFile(path.join(directory, `${created.id}.json`), 'utf8'), /Hello from Codex/);
    assert.equal(await manager.remove(created.id), true);
    assert.deepEqual(await manager.list(), []);
    await assert.rejects(manager.get('../outside'), /Invalid chat session identifier/);
  } finally {
    manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
