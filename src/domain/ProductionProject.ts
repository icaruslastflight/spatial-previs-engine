/**
 * R0 / CORE-01: renderer-independent, JSON-only production records.
 * Experimental contract: UE5 conformance is an OPEN checkpoint (docs/r0/README.md).
 * No runtime scene, socket, device or approval behavior is changed by this module.
 */
export const PROJECT_SCHEMA_VERSION = 1 as const;

export type Provenance = 'placeholder' | 'user' | 'manufacturer' | 'measured' | 'checked';
export type Quantity =
  | { status: 'unknown'; unit: string }
  | { status: 'known'; unit: string; value: number; provenance: Provenance; source: string };

/** Right-handed, Y-up scene coordinates in metres; rotations are XYZW quaternions. */
export interface Transform {
  position: [number, number, number];
  rotation: [number, number, number, number];
}

interface RecordBase {
  id: string;
  label: string;
  locked: boolean;
}

export interface AssetDefinition extends RecordBase {
  kind: 'asset_definition';
  /** Original public/assets/manifest.json ID; never inferred from the display label. */
  catalogId: string;
  category: string;
  specifications: Record<string, Quantity>;
}

export interface InventoryItem extends RecordBase {
  kind: 'inventory_item';
  definitionId: string;
  serialNumber: string | null;
  serviceStatus: 'available' | 'prepped' | 'outbound' | 'show' | 'returning' | 'maintenance' | 'missing' | 'unavailable' | 'unknown';
  ownership: 'owned' | 'subrented';
  vendorId: string | null;
  containerId: string | null;
}

export interface Container extends RecordBase {
  kind: 'container';
  containerType: 'roadcase' | 'meatrack' | 'trunk' | 'bag';
  weightKg: number | null;
  dimensionsMm: [number, number, number] | null;
}

export interface Personnel extends RecordBase {
  kind: 'personnel';
  personnelType: 'in-house' | 'overhire';
  name: string;
  roles: string[];
  skills: string[];
  email: string | null;
  phone: string | null;
  dayRate: number | null;
}

export interface Vendor extends RecordBase {
  kind: 'vendor';
  vendorType: 'rental' | 'supplier' | 'freelance_agency';
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
}

export interface StockPool extends RecordBase {
  kind: 'stock_pool';
  definitionId: string;
  quantity: number;
}

export interface AssetInstance extends RecordBase {
  kind: 'asset_instance';
  definitionId: string;
  inventoryItemId: string | null;
  transform: Transform;
}

export interface Assembly extends RecordBase {
  kind: 'assembly';
  /** Ordered instance IDs; the assembly is not an additional piece of stock. */
  instanceIds: string[];
}

export interface Surface extends RecordBase {
  kind: 'surface';
  shape: 'plane';
  transform: Transform;
  width: Quantity;
  height: Quantity;
}

export interface Zone extends RecordBase {
  kind: 'zone';
  role: 'audience' | 'keep_out' | 'listening' | 'target' | 'termination' | 'routing';
  shape: 'box';
  transform: Transform;
  sizeMeters: [number, number, number];
}

export interface Port extends RecordBase {
  kind: 'port';
  instanceId: string;
  domain: 'power' | 'dmx' | 'video' | 'audio' | 'network' | 'laser' | 'comms' | 'structural' | 'optical';
  direction: 'input' | 'output' | 'bidirectional';
  connector: string | null;
  protocol: string | null;
}

export interface Connection extends RecordBase {
  kind: 'connection';
  domain: Port['domain'];
  sourcePortId: string;
  targetPortId: string;
}

export interface MechanicalAttachment extends RecordBase {
  kind: 'mechanical_attachment';
  parentInstanceId: string;
  childInstanceId: string;
  parentSocketId: string;
  childSocketId: string;
}

/** Exact snapshot identity only. Issuing and immutable storage belong to CORE-03/RPT-01. */
export interface DocumentSnapshot extends RecordBase {
  kind: 'document_snapshot';
  projectRevision: number;
  templateId: string;
  templateVersion: string;
  status: 'draft' | 'issued';
  includedRecordIds: string[];
}

export interface RasterMapping extends RecordBase {
  kind: 'raster_mapping';
  surfaceId: string;
  width: number;
  height: number;
}

export type ProductionRecord = AssetDefinition | InventoryItem | StockPool | AssetInstance
  | Assembly | Surface | Zone | Port | Connection | MechanicalAttachment | DocumentSnapshot | RasterMapping
  | Container | Personnel | Vendor;

export interface ProductionProject {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  projectId: string;
  revision: number;
  coordinateFrame: 'right_handed_y_up_meters';
  records: ProductionRecord[];
}

/** Collision-resistant, injectable identity generation; no counter reset on reopening. */
export function createRecordId(kind: ProductionRecord['kind'], uuid: () => string = () => crypto.randomUUID()): string {
  const value = uuid();
  if (!value.trim()) throw new Error('ID generator returned an empty value');
  return `${kind}:${value}`;
}

export function createProject(projectId: string): ProductionProject {
  if (!projectId.trim()) throw new Error('Project ID must not be empty');
  return { schemaVersion: PROJECT_SCHEMA_VERSION, projectId, revision: 0,
    coordinateFrame: 'right_handed_y_up_meters', records: [] };
}
