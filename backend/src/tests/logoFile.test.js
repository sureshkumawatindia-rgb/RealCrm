const { validateLogoFile } = require('../utils/logoFile');

describe('Logo file validation', () => {
  it('accepts a PNG with a matching signature', () => {
    expect(() => validateLogoFile({ originalname: 'logo.png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) })).not.toThrow();
  });

  it('rejects a browser-spoofed MIME/extension with invalid content', () => {
    expect(() => validateLogoFile({ originalname: 'logo.png', buffer: Buffer.from('not a png') })).toThrow('content does not match');
  });

  it('accepts an SVG with an SVG root element', () => {
    expect(() => validateLogoFile({ originalname: 'logo.svg', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') })).not.toThrow();
  });
});