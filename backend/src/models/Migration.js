const mongoose = require('mongoose');

const migrationSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  appliedAt: { type: Date, required: true },
});

module.exports = mongoose.model('Migration', migrationSchema);
