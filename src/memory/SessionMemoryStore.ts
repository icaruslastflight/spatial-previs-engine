/**
 * In-Engine Agent Session & Knowledge Management Store
 *
 * Implements persistent tracking of agent sessions, implementation observations,
 * and structured architecture/debugging notes (ADRs, gotchas, patterns).
 */

export interface SessionObservation {
  timestamp: string;
  action: string;
  details: string;
}

export interface SessionNote {
  noteId: string;
  timestamp: string;
  userPrompt: string;
  aiResponse: string;
  annotation: string;
  tags?: string[];
}

export interface AgentSession {
  sessionId: string;
  projectPath: string;
  userPrompt: string;
  startTime: string;
  endTime: string | null;
  status: 'active' | 'completed' | 'abandoned';
  observations: SessionObservation[];
  notes: SessionNote[];
}

export class SessionMemoryStore {
  private sessions: Map<string, AgentSession> = new Map();

  constructor() {}

  /**
   * Start a new agent session
   */
  startSession(projectPath: string, userPrompt: string): AgentSession {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const session: AgentSession = {
      sessionId,
      projectPath,
      userPrompt,
      startTime: new Date().toISOString(),
      endTime: null,
      status: 'active',
      observations: [],
      notes: []
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Record an action observation within a session
   */
  observe(sessionId: string, action: string, details: string): SessionObservation {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        projectPath: '',
        userPrompt: '',
        startTime: new Date().toISOString(),
        endTime: null,
        status: 'active',
        observations: [],
        notes: []
      };
      this.sessions.set(sessionId, session);
    }
    const observation: SessionObservation = {
      timestamp: new Date().toISOString(),
      action,
      details
    };
    session.observations.push(observation);
    return observation;
  }

  /**
   * Save a rich architecture, debugging, or convention note
   */
  saveNote(
    sessionId: string,
    userPrompt: string,
    aiResponse: string,
    annotation: string,
    tags?: string[]
  ): SessionNote {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        projectPath: '',
        userPrompt,
        startTime: new Date().toISOString(),
        endTime: null,
        status: 'active',
        observations: [],
        notes: []
      };
      this.sessions.set(sessionId, session);
    }
    const note: SessionNote = {
      noteId: `note_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      userPrompt,
      aiResponse,
      annotation,
      tags
    };
    session.notes.push(note);
    return note;
  }

  /**
   * End an active session
   */
  endSession(sessionId: string): AgentSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.endTime = new Date().toISOString();
    session.status = 'completed';
    return session;
  }

  /**
   * Get active or previous session by ID
   */
  getSession(sessionId: string): AgentSession | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * List sessions sorted by most recent
   */
  listSessions(limit: number = 10): AgentSession[] {
    const all = Array.from(this.sessions.values());
    all.sort((a, b) => b.startTime.localeCompare(a.startTime));
    return all.slice(0, limit);
  }

  /**
   * Search all notes across sessions for keyword matches
   */
  searchNotes(keyword: string): SessionNote[] {
    const lower = keyword.toLowerCase();
    const matches: SessionNote[] = [];
    for (const s of this.sessions.values()) {
      for (const n of s.notes) {
        if (
          n.annotation.toLowerCase().includes(lower) ||
          n.userPrompt.toLowerCase().includes(lower) ||
          n.aiResponse.toLowerCase().includes(lower) ||
          n.tags?.some(t => t.toLowerCase().includes(lower))
        ) {
          matches.push(n);
        }
      }
    }
    return matches;
  }

  /**
   * Total number of tracked sessions
   */
  count(): number {
    return this.sessions.size;
  }

  /**
   * Serialize all sessions to JSON
   */
  toJSON(): string {
    const list = Array.from(this.sessions.values());
    return JSON.stringify({ sessions: list }, null, 2);
  }

  /**
   * Load sessions from JSON
   */
  fromJSON(jsonStr: string): void {
    const data = JSON.parse(jsonStr);
    if (Array.isArray(data.sessions)) {
      this.sessions.clear();
      for (const s of data.sessions) {
        this.sessions.set(s.sessionId, s);
      }
    }
  }
}
