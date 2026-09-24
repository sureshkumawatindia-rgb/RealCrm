const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    picture: { type: String, default: '' },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('User', userSchema);