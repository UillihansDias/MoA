import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_MESSAGE_LENGTH = 12_000;
const MAX_SESSION_MESSAGES = 200;
const SESSION_ID_PATTERN = /^[0-9A-Za-z-]{1,100}$/;

const titleFor = (content) => {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  return singleLine.length > 64 ? `${singleLine.slice(0, 61)}…` : singleLine || 'New chat';
};

const summaryFor = (session) => ({
  id: session.id,
  title: session.title,
  agent: session.agent,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  messageCount: session.messages.length,
  status: session.status,
});

export const createChatSessionManager = ({
  directory,
  listAgents,
  executeAgent,
}) => {
  if (typeof listAgents !== 'function' || typeof executeAgent !== 'function') {
    throw new TypeError('Chat sessions require agent discovery and execution functions.');
  }

  const active = new Map();

  const safeId = (id) => {
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
      throw Object.assign(new Error('Invalid chat session identifier.'), { statusCode: 400 });
    }
    return id;
  };

  const fileFor = (id) => path.join(directory, `${safeId(id)}.json`);

  const save = async (session) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = fileFor(session.id);
    const temporary = path.join(directory, `.${session.id}.${process.pid}.${crypto.randomUUID()}.tmp`);
    session.updatedAt = new Date().toISOString();
    try {
      await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, file);
      await fs.chmod(file, 0o600);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };

  const get = async (id) => {
    try {
      return JSON.parse(await fs.readFile(fileFor(id), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw Object.assign(new Error('Chat session not found.'), { statusCode: 404 });
      }
      throw error;
    }
  };

  const list = async (limit = 100) => {
    let names;
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const selected = names.filter((name) => name.endsWith('.json')).sort().reverse().slice(0, limit);
    const sessions = await Promise.all(selected.map(async (name) => {
      try {
        return JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      } catch {
        return null;
      }
    }));
    return sessions
      .filter(Boolean)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summaryFor);
  };

  const remove = async (id) => {
    const safe = safeId(id);
    if (active.has(safe)) {
      throw Object.assign(new Error('Stop the active response before deleting this chat.'), { statusCode: 409 });
    }
    try {
      await fs.unlink(fileFor(safe));
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };

  const streamMessage = async ({ sessionId, agent, content, attachments = [], signal, emit }) => {
    const message = typeof content === 'string' ? content.trim() : '';
    const selectedAttachments = Array.isArray(attachments)
      ? attachments
        .filter((attachment) => attachment
          && typeof attachment.name === 'string'
          && typeof attachment.path === 'string'
          && typeof attachment.size === 'number')
        .slice(0, 10)
      : [];
    if ((!message && !selectedAttachments.length) || message.length > MAX_MESSAGE_LENGTH) {
      throw Object.assign(new Error(`Enter a message or attach a file. Messages can contain up to ${MAX_MESSAGE_LENGTH} characters.`), { statusCode: 400 });
    }
    const attachmentSummary = selectedAttachments.map(({ name }) => name).join(', ');
    const storedContent = message || `Attached files: ${attachmentSummary}`;

    const availableAgents = await listAgents();
    const selectedAgent = availableAgents.find(({ id }) => id === agent);
    if (!selectedAgent) {
      throw Object.assign(new Error('Choose an available MoA agent.'), { statusCode: 400 });
    }

    let session;
    if (sessionId) {
      session = await get(sessionId);
      if (active.has(session.id)) {
        throw Object.assign(new Error('This chat is already generating a response.'), { statusCode: 409 });
      }
    } else {
      const now = new Date().toISOString();
      session = {
        id: crypto.randomUUID(),
        title: titleFor(message || selectedAttachments[0]?.name || 'Attachment'),
        agent: selectedAgent.id,
        agentLabel: selectedAgent.label,
        createdAt: now,
        updatedAt: now,
        status: 'ready',
        messages: [],
      };
    }

    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    active.set(session.id, controller);

    session.agent = selectedAgent.id;
    session.agentLabel = selectedAgent.label;
    session.status = 'streaming';
    session.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: storedContent,
      ...(selectedAttachments.length ? {
        attachments: selectedAttachments.map(({ name, type, size }) => ({ name, type, size })),
      } : {}),
      createdAt: new Date().toISOString(),
    });
    if (session.messages.length > MAX_SESSION_MESSAGES) {
      session.messages.splice(0, session.messages.length - MAX_SESSION_MESSAGES);
    }

    try {
      await save(session);
      emit({ type: 'session', session });
      const responseText = await executeAgent({
        agentId: selectedAgent.id,
        messages: session.messages.map(({ role, content: value, attachments: messageAttachments }) => ({
          role,
          content: value,
          ...(messageAttachments?.length ? { attachments: messageAttachments } : {}),
        })),
        attachments: selectedAttachments,
        signal: controller.signal,
        onDelta: (text) => emit({ type: 'delta', text }),
      });
      if (!responseText.trim()) throw new Error(`${selectedAgent.label} completed without returning a response.`);
      session.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: responseText,
        createdAt: new Date().toISOString(),
      });
      session.status = 'ready';
      await save(session);
      emit({ type: 'done', session });
      return session;
    } catch (error) {
      session.status = controller.signal.aborted ? 'stopped' : 'failed';
      await save(session).catch(() => {});
      if (controller.signal.aborted) {
        emit({ type: 'stopped', session });
        return session;
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (active.get(session.id) === controller) active.delete(session.id);
    }
  };

  return {
    agents: listAgents,
    get,
    list,
    remove,
    streamMessage,
    stop(id) {
      const controller = active.get(safeId(id));
      if (!controller) return false;
      controller.abort(new Error('Stopped by user.'));
      return true;
    },
    dispose() {
      for (const controller of active.values()) controller.abort(new Error('Service stopping.'));
      active.clear();
    },
  };
};
