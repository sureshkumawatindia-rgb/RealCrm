// Standard list/get/create/update/remove handlers for a resource service.
function crudController(service, label) {
  return {
    async list(req, res) {
      const { items, pagination } = await service.list(req, req.valid.query);
      res.json({ success: true, data: items, pagination });
    },
    async get(req, res) {
      res.json({ success: true, data: await service.get(req, req.valid.params.id) });
    },
    async create(req, res) {
      res.status(201).json({ success: true, data: await service.create(req, req.body), message: `${label} created` });
    },
    async update(req, res) {
      res.json({ success: true, data: await service.update(req, req.valid.params.id, req.body), message: `${label} updated` });
    },
    async remove(req, res) {
      await service.remove(req, req.valid.params.id);
      res.json({ success: true, data: { deleted: true }, message: `${label} deleted` });
    },
  };
}

module.exports = crudController;
