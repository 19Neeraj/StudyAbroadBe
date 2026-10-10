import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

export const DIMENSIONS = ['source', 'medium', 'campaign'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/**
 * Primary → Secondary → Tertiary masters per dimension (spec §7, plan §2.5). Level 2/3 nodes must
 * hang under a node of the same dimension one level up. Keys are stable; labels can change.
 */
const nodeSchema = new Schema(
  {
    ...tenantField,
    dimension: { type: String, enum: DIMENSIONS, required: true },
    level: { type: Number, enum: [1, 2, 3], required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'AttributionNode' },
    key: { type: String, required: true, trim: true, immutable: true },
    label: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
nodeSchema.index({ organizationId: 1, dimension: 1, key: 1 }, { unique: true });
nodeSchema.index({ organizationId: 1, dimension: 1, level: 1, parentId: 1, order: 1 });
nodeSchema.plugin(tenantPlugin);

export type AttributionNode = InferSchemaType<typeof nodeSchema> & { _id: Types.ObjectId };
export const AttributionNodeModel = model('AttributionNode', nodeSchema);

/** { l1, l2, l3 } node IDs for one dimension; lower levels may be unknown. */
export const hierarchyField = { l1: { type: Schema.Types.ObjectId, ref: 'AttributionNode' }, l2: { type: Schema.Types.ObjectId, ref: 'AttributionNode' }, l3: { type: Schema.Types.ObjectId, ref: 'AttributionNode' } };
export const attributionField = { source: hierarchyField, medium: hierarchyField, campaign: hierarchyField };
export type Hierarchy = { l1?: Types.ObjectId | null; l2?: Types.ObjectId | null; l3?: Types.ObjectId | null };
export type AttributionSnapshot = Partial<Record<Dimension, Hierarchy>>;
