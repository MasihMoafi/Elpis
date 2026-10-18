/**
 * One conflict order for the store and both editors. A newer live version can
 * deliberately undo a delete; at the same version a stale live edit cannot.
 * @param {{ version: number, versionNonce: number, isDeleted?: boolean }} incoming
 * @param {{ version: number, versionNonce: number, isDeleted?: boolean }} current
 */
function newer(incoming, current) {
  if (incoming.version !== current.version) return incoming.version > current.version;
  if (!!incoming.isDeleted !== !!current.isDeleted) return !!incoming.isDeleted;
  return incoming.versionNonce < current.versionNonce;
}

module.exports = { newer };
