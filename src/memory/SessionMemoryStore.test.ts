import { describe, it, expect, beforeEach } from 'vitest';
import { SessionMemoryStore } from './SessionMemoryStore';

describe('SessionMemoryStore', () => {
  let store: SessionMemoryStore;

  beforeEach(() => {
    store = new SessionMemoryStore();
  });

  it('starts a new session with initial metadata', () => {
    const session = store.startSession('/workspace/previs', 'Implement movable viewport for video mapping');
    expect(session.sessionId).toMatch(/^session_\d+_[a-z0-9]+/);
    expect(session.status).toBe('active');
    expect(session.observations).toEqual([]);
    expect(session.notes).toEqual([]);
    expect(store.count()).toBe(1);
  });

  it('records observations in an active session', () => {
    const session = store.startSession('/workspace/previs', 'Test prompt');
    const obs = store.observe(session.sessionId, 'Modified ProductionViewport.ts', 'Unlocked rotation in plan mode');
    expect(obs.action).toBe('Modified ProductionViewport.ts');
    expect(obs.details).toBe('Unlocked rotation in plan mode');
    expect(session.observations.length).toBe(1);
  });

  it('saves and searches structured notes (ADRs, decisions)', () => {
    const session = store.startSession('/workspace/previs', 'Setup memory system');
    store.saveNote(
      session.sessionId,
      'User asked for vector memory and agent memory',
      'Implemented ChromaDB and local VectorMemoryStore',
      'Decision: Zero external paid APIs; why: budget constraints and offline resilience',
      ['adr', 'memory', 'offline']
    );

    const notes = store.searchNotes('budget constraints');
    expect(notes.length).toBe(1);
    expect(notes[0].annotation).toContain('offline resilience');
    expect(notes[0].tags).toContain('memory');
  });

  it('ends session and updates status', () => {
    const session = store.startSession('/workspace/previs', 'Completed task');
    const ended = store.endSession(session.sessionId);
    expect(ended).not.toBeNull();
    expect(ended?.status).toBe('completed');
    expect(ended?.endTime).toBeDefined();
  });

  it('serializes and deserializes cleanly via JSON', () => {
    const session = store.startSession('/workspace/previs', 'Persistence test');
    store.observe(session.sessionId, 'Created files', 'Added memory classes');
    const json = store.toJSON();

    const newStore = new SessionMemoryStore();
    newStore.fromJSON(json);
    expect(newStore.count()).toBe(1);
    const loaded = newStore.getSession(session.sessionId);
    expect(loaded?.userPrompt).toBe('Persistence test');
    expect(loaded?.observations.length).toBe(1);
  });
});
