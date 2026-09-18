import { describe, it, expect, beforeEach } from 'vitest';
import { McpGateway } from './server';
import { VectorMemoryStore } from '../memory/VectorMemoryStore';
import { SessionMemoryStore } from '../memory/SessionMemoryStore';

describe('McpGateway (JSON-RPC 2.0 API)', () => {
  let gateway: McpGateway;
  let vectorStore: VectorMemoryStore;
  let sessionStore: SessionMemoryStore;

  beforeEach(() => {
    vectorStore = new VectorMemoryStore(true);
    sessionStore = new SessionMemoryStore();
    gateway = new McpGateway(vectorStore, sessionStore);
  });

  it('rejects requests with invalid jsonrpc version', async () => {
    const res = await gateway.handleRequest({
      jsonrpc: '1.0',
      id: 1,
      method: 'previs/getSceneGraph'
    });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32600);
  });

  it('returns -32601 for unknown method', async () => {
    const res = await gateway.handleRequest({
      jsonrpc: '2.0',
      id: 'abc',
      method: 'unknown/method'
    });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32601);
  });

  it('executes previs/getSceneGraph returning WGS84 anchor and fixtures', async () => {
    const res = await gateway.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'previs/getSceneGraph'
    });
    expect(res.error).toBeUndefined();
    const result = res.result as Record<string, any>;
    expect(result.anchor.ellipsoidalHeight).toBe(184.963);
    expect(result.anchor.datum).toBe('WGS84');
    expect(result.stage.units).toBe('meters');
    expect(result.fixtures.totalCount).toBe(24);
  });

  it('executes previs/snapAsset for socket alignment', async () => {
    const res = await gateway.handleRequest({
      jsonrpc: '2.0',
      id: 20,
      method: 'previs/snapAsset',
      params: {
        sourcePosition: [0, 0, 0],
        targetPosition: [0.2, 0, 0]
      }
    });
    expect(res.error).toBeUndefined();
    const result = res.result as Record<string, any>;
    expect(result.snapped).toBe(true);
    expect(result.distance).toBe(0.2);
  });

  it('executes previs/triggerDMXCue', async () => {
    const res = await gateway.handleRequest({
      jsonrpc: '2.0',
      id: 30,
      method: 'previs/triggerDMXCue',
      params: {
        universe: 1,
        cueName: 'Festival Headline Drop',
        channels: [255, 128, 0, 255]
      }
    });
    expect(res.error).toBeUndefined();
    const result = res.result as Record<string, any>;
    expect(result.status).toBe('triggered');
    expect(result.universe).toBe(1);
    expect(result.activeChannels).toBe(4);
  });

  it('executes previs/getElectricalStatus returning 3-phase load balance', async () => {
    const res = await gateway.handleRequest({
      jsonrpc: '2.0',
      id: 40,
      method: 'previs/getElectricalStatus'
    });
    expect(res.error).toBeUndefined();
    const result = res.result as Record<string, any>;
    expect(result.breakers.length).toBe(3);
    expect(result.neutralCurrentAmps).toBe(3.4);
    expect(result.status).toBe('nominal');
  });

  it('executes previs/memorySearch through vector store', async () => {
    const res = await gateway.handleRequest({
      jsonrpc: '2.0',
      id: 50,
      method: 'previs/memorySearch',
      params: {
        query: 'Point State Park anchor'
      }
    });
    expect(res.error).toBeUndefined();
    const result = res.result as Record<string, any>;
    expect(result.count).toBeGreaterThan(0);
    expect(result.results[0].text).toContain('Point State Park');
  });

  it('executes previs/memoryContext returning active sessions', async () => {
    sessionStore.startSession('/test/project', 'Test session via MCP');
    const res = await gateway.handleRequest({
      jsonrpc: '2.0',
      id: 60,
      method: 'previs/memoryContext'
    });
    expect(res.error).toBeUndefined();
    const result = res.result as Record<string, any>;
    expect(result.sessionCount).toBe(1);
    expect(result.recentSessions[0].prompt).toBe('Test session via MCP');
  });
});
