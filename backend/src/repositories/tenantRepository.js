const { toPage, paginationMeta } = require('../utils/pagination');

// Wraps a model so every query is limited to one organization. The organizationId is always
// applied last, so a filter or document from the client can never override it.
function tenantRepository(Model, organizationId) {
  const scope = (filter = {}) => ({ ...filter, organizationId });

  return {
    find: (filter, projection, options) => Model.find(scope(filter), projection, options),
    findOne: (filter, projection, options) => Model.findOne(scope(filter), projection, options),
    findById: (id, projection, options) => Model.findOne(scope({ _id: id }), projection, options),
    count: (filter) => Model.countDocuments(scope(filter)),
    exists: (filter) => Model.exists(scope(filter)),
    async create(doc, options = {}) {
      const [created] = await Model.create([{ ...doc, organizationId }], options);
      return created;
    },
    update: (filter, update, options = {}) => Model.findOneAndUpdate(scope(filter), update, { returnDocument: 'after', runValidators: true, ...options }),
    async paginate(filter, pageQuery, { sort = { createdAt: -1 }, projection, populate } = {}) {
      const page = toPage(pageQuery);
      let query = Model.find(scope(filter), projection).sort(sort).skip(page.skip).limit(page.limit);
      if (populate) query = query.populate(populate);
      const [items, total] = await Promise.all([query, Model.countDocuments(scope(filter))]);
      return { items, pagination: paginationMeta(page, total) };
    },
  };
}

module.exports = tenantRepository;
