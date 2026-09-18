/**
 * Model Context Protocol (MCP) JSON-RPC 2.0 API Gateway
 *
 * Implements an Express router providing the model-neutral MCP gateway
 * specified in v3_07_mcp_gemini_connected_app_gateway.md (Drive Source S14/S20).
 *
 * Methods:
 * - previs/getSceneGraph
 * - previs/snapAsset
 * - previs/triggerDMXCue
 * - previs/getElectricalStatus
 * - previs/memorySearch
 * - previs/memoryContext
 */

import { type Request, type Response, Router } from 'express';
import { VectorMemoryStore } from '../memory/VectorMemoryStore';
import { SessionMemoryStore } from '../memory/SessionMemoryStore';
import { SocketSnappingEngine } from '../engine/SocketSnappingEngine';
import { Vector3 } from 'three';

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class McpGateway {
  private vectorStore: VectorMemoryStore;
  private sessionStore: SessionMemoryStore;
  private snappingEngine: SocketSnappingEngine;

  constructor(
    vectorStore?: VectorMemoryStore,
    sessionStore?: SessionMemoryStore,
    snappingEngine?: SocketSnappingEngine
  ) {
    this.vectorStore = vectorStore || new VectorMemoryStore(true);
    this.sessionStore = sessionStore || new SessionMemoryStore();
    this.snappingEngine = snappingEngine || new SocketSnappingEngine();
  }

  getSnappingEngine(): SocketSnappingEngine {
    return this.snappingEngine;
  }

  /**
   * Process a parsed JSON-RPC 2.0 request
   */
  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id !== undefined ? req.id : null;

    if (req.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' }
      };
    }

    if (!req.method || typeof req.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid Request: method is required' }
      };
    }

    const params = req.params || {};

    try {
      switch (req.method) {
        case 'previs/getSceneGraph': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              anchor: {
                name: 'Point State Park Pittsburgh',
                latitude: 40.4418,
                longitude: -80.0076,
                ellipsoidalHeight: 184.963,
                datum: 'WGS84'
              },
              stage: {
                dimensions: { width: 18.0, depth: 12.0, height: 1.5 },
                deckType: 'Eurotruss Modular 2x1m',
                units: 'meters'
              },
              fixtures: {
                totalCount: 24,
                activeUniverses: [1, 2],
                profiles: ['Chauvet COLORado 1 Solo', 'Robe Robin MegaPointe']
              },
              surfaces: [
                {
                  id: 'surface:led_wall_upstage',
                  name: 'Upstage LED Video Wall',
                  width: 4.0,
                  height: 2.5,
                  rasterResolution: { width: 1024, height: 640 }
                }
              ]
            }
          };
        }

        case 'previs/snapAsset': {
          const sourcePos = (params.sourcePosition as [number, number, number]) || [0, 0, 0];
          const targetPos = (params.targetPosition as [number, number, number]) || [2, 0, 0];

          // Compute snap vector using three.js math
          const sPos = new Vector3(...sourcePos);
          const tPos = new Vector3(...targetPos);
          const distance = sPos.distanceTo(tPos);
          const snapped = distance < 1.0;

          return {
            jsonrpc: '2.0',
            id,
            result: {
              snapped,
              distance: Math.round(distance * 1000) / 1000,
              finalPosition: snapped ? [tPos.x, tPos.y, tPos.z] : [sPos.x, sPos.y, sPos.z],
              rotation: [0, 0, 0, 1]
            }
          };
        }

        case 'previs/triggerDMXCue': {
          const universe = Number(params.universe || 1);
          const cueName = String(params.cueName || 'Snapshot Cue 1');
          const channels = (params.channels as number[]) || [255, 255, 255];

          return {
            jsonrpc: '2.0',
            id,
            result: {
              status: 'triggered',
              universe,
              cueName,
              activeChannels: channels.length,
              timestamp: new Date().toISOString()
            }
          };
        }

        case 'previs/getElectricalStatus': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              system: '3-Phase 120/208V Y',
              breakers: [
                { id: 'CB-1', phase: 'A', currentAmps: 34.5, limitAmps: 50.0, loadPercent: 69.0 },
                { id: 'CB-2', phase: 'B', currentAmps: 32.1, limitAmps: 50.0, loadPercent: 64.2 },
                { id: 'CB-3', phase: 'C', currentAmps: 35.8, limitAmps: 50.0, loadPercent: 71.6 }
              ],
              neutralCurrentAmps: 3.4,
              maxVoltageDropPercent: 1.8,
              status: 'nominal'
            }
          };
        }

        case 'previs/memorySearch': {
          const query = String(params.query || '');
          const limit = Number(params.limit || 5);
          const category = params.category ? String(params.category) : undefined;
          const hits = this.vectorStore.search(query, { limit, category });

          return {
            jsonrpc: '2.0',
            id,
            result: {
              query,
              category,
              count: hits.length,
              results: hits.map(h => ({
                id: h.document.id,
                score: h.score,
                category: h.document.metadata.category,
                tags: h.document.metadata.tags,
                path: h.document.metadata.path,
                text: h.document.text
              }))
            }
          };
        }

        case 'previs/memoryContext': {
          const limit = Number(params.limit || 5);
          const sessions = this.sessionStore.listSessions(limit);

          return {
            jsonrpc: '2.0',
            id,
            result: {
              sessionCount: sessions.length,
              recentSessions: sessions.map(s => ({
                sessionId: s.sessionId,
                prompt: s.userPrompt,
                startTime: s.startTime,
                status: s.status,
                notesCount: s.notes.length,
                observationsCount: s.observations.length
              }))
            }
          };
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method '${req.method}' not found` }
          };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Internal error: ${message}` }
      };
    }
  }
}

/**
 * Creates an Express Router handling POST /mcp
 */
export function createMcpRouter(gateway?: McpGateway): Router {
  const router = Router();
  const mcpGateway = gateway || new McpGateway();

  router.post('/', async (req: Request, res: Response) => {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' }
      });
      return;
    }

    const result = await mcpGateway.handleRequest(payload as JsonRpcRequest);
    res.json(result);
  });

  return router;
}
