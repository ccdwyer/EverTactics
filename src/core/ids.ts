/**
 * Durable campaign progression is keyed by authored world-map nodes.
 *
 * Keep this nominal instead of using a bare string: scenario ids are also
 * strings, and treating the two spaces as interchangeable caused victories to
 * complete whichever value happened to be written last.
 */
declare const WORLD_NODE_ID: unique symbol;

export type WorldNodeId = string & {
  readonly [WORLD_NODE_ID]: 'WorldNodeId';
};

/**
 * Brand an authored or deserialized world-node id.
 *
 * This is intentionally the only cast into the durable progression id space.
 * Callers should obtain ids from WorldNode records whenever possible.
 */
export function worldNodeId(value: string): WorldNodeId {
  return value as WorldNodeId;
}
