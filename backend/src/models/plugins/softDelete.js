// Soft delete: adds deletedAt and hides deleted documents from queries by default.
// To include deleted documents, mention deletedAt in the filter (e.g. { deletedAt: { $ne: null } }).
const QUERY_OPERATIONS = [
  'find', 'findOne', 'countDocuments', 'findOneAndUpdate', 'updateOne', 'updateMany', 'exists',
];

function softDelete(schema) {
  schema.add({ deletedAt: { type: Date, default: null } });

  function excludeDeleted() {
    if (Object.prototype.hasOwnProperty.call(this.getFilter(), 'deletedAt')) return;
    this.where({ deletedAt: null });
  }
  QUERY_OPERATIONS.forEach((operation) => schema.pre(operation, excludeDeleted));

  schema.pre('aggregate', function excludeDeletedFromAggregate() {
    const [first] = this.pipeline();
    if (first?.$match && Object.prototype.hasOwnProperty.call(first.$match, 'deletedAt')) return;
    this.pipeline().unshift({ $match: { deletedAt: null } });
  });

  schema.methods.softDelete = function markDeleted(options = {}) {
    this.deletedAt = new Date();
    return this.save(options);
  };
}

module.exports = softDelete;
