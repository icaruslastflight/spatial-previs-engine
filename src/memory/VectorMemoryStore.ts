/**
 * In-Engine Vector & Semantic Memory Store
 *
 * Lightweight, zero-external-dependency vector memory store operating in
 * browser, Web Worker, and Node.js environments. Implements TF-IDF token
 * vectorization, cosine similarity ranking, category filtering, and JSON
 * serialization.
 */

export interface MemoryDocument {
  id: string;
  text: string;
  metadata: {
    path?: string;
    category?: 'code' | 'docs' | 'context' | 'standards' | 'safety_manual' | 'planning' | 'general';
    origin?: 'repo' | 'drive' | 'runtime';
    tags?: string[];
    startLine?: number;
    endLine?: number;
    sourceId?: string;
    [key: string]: unknown;
  };
}

export interface SearchOptions {
  limit?: number;
  category?: string;
  tags?: string[];
  minScore?: number;
}

export interface SearchResult {
  document: MemoryDocument;
  score: number; // 0 to 1, higher is closer
}

/**
 * Standard festival previs domain knowledge chunks seeded into memory
 */
export const CORE_DOMAIN_KNOWLEDGE: MemoryDocument[] = [
  {
    id: 'kb_wgs84_anchor',
    text: 'Point State Park Pittsburgh WGS84 spatial anchor: latitude 40.4418 N, longitude -80.0076 W, ellipsoidal height 184.963 m. The 220m elevation figure is orthometric height, distinguishing ellipsoidal vs geoid elevation (SPE-CTX-003 C02).',
    metadata: {
      category: 'context',
      sourceId: 'S25',
      tags: ['geodesy', 'wgs84', 'anchor', 'point_state_park'],
      path: 'Knowledge Base/02_Geospatial_and_Rendering/Point_State_Park_WGS84_Spatial_Anchor_Spec.md'
    }
  },
  {
    id: 'kb_gdtf_mvr_units',
    text: 'GDTF and MVR DIN SPEC 15800 fixture specifications: all spatial dimensions and position offsets are in meters (m), all rotation angles are in degrees. Geometries define parent-child joint transforms for pan and tilt axes.',
    metadata: {
      category: 'standards',
      sourceId: 'S19',
      tags: ['gdtf', 'mvr', 'units', 'fixtures'],
      path: 'Knowledge Base/01_Standards_and_Protocols/GDTF_MVR_DIN_SPEC_Technical_Manual.md'
    }
  },
  {
    id: 'kb_dmx_telemetry_512ch',
    text: 'DMX telemetry and protocol merge engine: Art-Net 4 and sACN (E1.31) manage 512 channels per universe. HTP (highest takes precedence) and LTP (latest takes precedence) merge policies resolve multi-source console conflicts.',
    metadata: {
      category: 'standards',
      sourceId: 'S23',
      tags: ['dmx', 'artnet', 'sacn', 'htp', 'ltp'],
      path: 'Knowledge Base/01_Standards_and_Protocols/ArtNet4_sACN_OSC_Network_Specification.md'
    }
  },
  {
    id: 'kb_laser_safety_mpe',
    text: 'Class 4 laser safety and Maximum Permissible Exposure (MPE): ANSI Z136.1 and IEC 60825 standards require nominal ocular hazard distance (NOHD) calculations and physical hardware scan-fail interlocks. AI visualizer provides simulation, not engineering compliance certification.',
    metadata: {
      category: 'safety_manual',
      sourceId: 'S21',
      tags: ['laser', 'safety', 'mpe', 'class4'],
      path: 'Knowledge Base/01_Standards_and_Protocols/Class4_Laser_Safety_and_MPE_Compliance_Manual.md'
    }
  },
  {
    id: 'kb_rigging_deflection',
    text: 'ESTA ANSI E1.21 temporary structures and truss deflection math: allowable vertical deflection limit is span / 180 under full dead load and dynamic wind load. Bridle junction forces and apex angles calculated via vector trigonometry.',
    metadata: {
      category: 'standards',
      sourceId: 'S26',
      tags: ['rigging', 'truss', 'deflection', 'esta', 'safety'],
      path: 'Knowledge Base/03_Electrical_and_Rigging/ESTA_ANSI_E121_Rigging_and_Deflection_Math.md'
    }
  },
  {
    id: 'kb_electrical_phase_balance',
    text: 'NEC electrical load distribution and phase balancing: 3-phase 120/208V power distros require balanced amperage across Phase A, Phase B, Phase C to minimize neutral current. Voltage drop must remain below 3% on feeder runs.',
    metadata: {
      category: 'standards',
      sourceId: 'S27',
      tags: ['electrical', 'nec', 'phase_balance', 'voltage_drop'],
      path: 'Knowledge Base/03_Electrical_and_Rigging/NEC_Electrical_Load_and_Phase_Balancing_Guide.md'
    }
  },
  {
    id: 'kb_mcp_jsonrpc_gateway',
    text: 'Model Context Protocol JSON-RPC 2.0 API gateway: Express endpoint at POST /mcp exposing previs/getSceneGraph, previs/snapAsset, previs/triggerDMXCue, previs/getElectricalStatus, previs/memorySearch.',
    metadata: {
      category: 'planning',
      sourceId: 'S14',
      tags: ['mcp', 'jsonrpc', 'api', 'gemini'],
      path: '05_AI_Prompts_and_Code/v3_07_mcp_gemini_connected_app_gateway.md'
    }
  }
];

export class VectorMemoryStore {
  private documents: Map<string, MemoryDocument> = new Map();
  private docFrequencies: Map<string, number> = new Map();

  constructor(seedDefaults: boolean = true) {
    if (seedDefaults) {
      this.addDocuments(CORE_DOMAIN_KNOWLEDGE);
    }
  }

  /**
   * Tokenize text into lowercase alpha-numeric terms, filtering short noise tokens
   */
  private tokenize(text: string): string[] {
    const rawTokens = text.toLowerCase().match(/[a-z0-9_.-]{2,}/g) || [];
    const stopWords = new Set([
      'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
      'were', 'all', 'any', 'not', 'can', 'has', 'have', 'had', 'per', 'via'
    ]);
    return rawTokens.filter(t => !stopWords.has(t));
  }

  /**
   * Build term frequency map for a document
   */
  private getTermFrequencies(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    return tf;
  }

  /**
   * Add a single document to the store
   */
  addDocument(doc: MemoryDocument): void {
    this.documents.set(doc.id, doc);
    const tokens = new Set(this.tokenize(doc.text + ' ' + (doc.metadata.tags?.join(' ') || '')));
    for (const t of tokens) {
      this.docFrequencies.set(t, (this.docFrequencies.get(t) || 0) + 1);
    }
  }

  /**
   * Add multiple documents
   */
  addDocuments(docs: MemoryDocument[]): void {
    for (const d of docs) {
      this.addDocument(d);
    }
  }

  /**
   * Perform TF-IDF cosine similarity search over documents
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = options.limit ?? 5;
    const minScore = options.minScore ?? 0.05;
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];

    const queryTf = this.getTermFrequencies(queryTokens);
    const totalDocs = Math.max(1, this.documents.size);

    // Calculate query vector weights
    const queryWeights = new Map<string, number>();
    let queryNormSq = 0;
    for (const [term, count] of queryTf.entries()) {
      const df = this.docFrequencies.get(term) || 0;
      const idf = Math.log(1 + (totalDocs / (1 + df)));
      const weight = count * idf;
      queryWeights.set(term, weight);
      queryNormSq += weight * weight;
    }
    const queryNorm = Math.sqrt(queryNormSq);
    if (queryNorm === 0) return [];

    const results: SearchResult[] = [];

    for (const doc of this.documents.values()) {
      // Apply category filter
      if (options.category && doc.metadata.category !== options.category) {
        continue;
      }
      // Apply tag filter
      if (options.tags && options.tags.length > 0) {
        const docTags = new Set(doc.metadata.tags || []);
        const hasTag = options.tags.some(t => docTags.has(t));
        if (!hasTag) continue;
      }

      const docTextTokens = this.tokenize(doc.text + ' ' + (doc.metadata.tags?.join(' ') || ''));
      const docTf = this.getTermFrequencies(docTextTokens);

      let dotProduct = 0;
      let docNormSq = 0;

      for (const [term, count] of docTf.entries()) {
        const df = this.docFrequencies.get(term) || 0;
        const idf = Math.log(1 + (totalDocs / (1 + df)));
        const docWeight = count * idf;
        docNormSq += docWeight * docWeight;

        if (queryWeights.has(term)) {
          dotProduct += (queryWeights.get(term) || 0) * docWeight;
        }
      }

      const docNorm = Math.sqrt(docNormSq);
      if (docNorm > 0) {
        let score = dotProduct / (queryNorm * docNorm);

        // Substring / exact token boost
        const lowerQuery = query.toLowerCase();
        if (doc.text.toLowerCase().includes(lowerQuery)) {
          score = Math.min(1.0, score * 1.35 + 0.1);
        }

        if (score >= minScore) {
          results.push({ document: doc, score: Math.round(score * 10000) / 10000 });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Filter documents by metadata
   */
  filter(category?: string, tag?: string): MemoryDocument[] {
    const list: MemoryDocument[] = [];
    for (const doc of this.documents.values()) {
      if (category && doc.metadata.category !== category) continue;
      if (tag && !(doc.metadata.tags?.includes(tag))) continue;
      list.push(doc);
    }
    return list;
  }

  /**
   * Retrieve total number of indexed documents
   */
  count(): number {
    return this.documents.size;
  }

  /**
   * Clear all stored documents
   */
  clear(): void {
    this.documents.clear();
    this.docFrequencies.clear();
  }

  /**
   * Serialize store to JSON string
   */
  toJSON(): string {
    const docs = Array.from(this.documents.values());
    return JSON.stringify({ documents: docs }, null, 2);
  }

  /**
   * Populate store from JSON string
   */
  fromJSON(jsonStr: string): void {
    const data = JSON.parse(jsonStr);
    if (Array.isArray(data.documents)) {
      this.clear();
      this.addDocuments(data.documents);
    }
  }
}
