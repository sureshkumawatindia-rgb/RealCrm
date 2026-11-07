jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const appFiles = require('../services/appFilesService');
const { api, bearer, login } = require('./helpers/api');

// The phone app (100 phases, phase 7, D119, docs/PHONE_APP.md): the service worker the server
// serves carries the CRM's files with their revisions; pages, texts and the API's answers travel
// compressed; the app's two descriptions (English, Hindi) and its icons; the logo every page loads.
const FRONTEND = appFiles.FRONTEND_DIR;
const BUILD = /const BUILD = (\{.*?\});\r?\n/;

describe('The phone app\'s files (D119)', () => {
  it('the service worker carries every file with its revision, and the pages the phone keeps first', async () => {
    const res = await api().get('/crm/frontend/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('no-cache');
    const build = JSON.parse(BUILD.exec(res.text)[1]);
    expect(build.version).toMatch(/^[0-9a-f]{12}$/);
    expect(build.files['Inbox.html']).toMatch(/^[0-9a-f]{12}$/);
    expect(build.files['i18n/hi.json']).toMatch(/^[0-9a-f]{12}$/);
    expect(build.files['sw.js']).toBeUndefined();
    // The Inbox and everything it loads, the texts, the help box, the no-network page.
    expect(build.precache).toEqual(expect.arrayContaining(['Inbox.html', 'js/boot.js', 'js/app.js', 'js/inbox.js', 'css/style.css', 'css/inbox.css', 'img/logo/logo.png', 'i18n/en.json', 'i18n/hi.json', 'js/help.js', 'offline.html', 'login.html', 'manifest-hi.webmanifest']));
    expect(build.precache.every((name) => build.files[name])).toBe(true);
    // The large icons are the browser's to fetch at install, not part of the first download.
    expect(build.precache).not.toContain('img/icons/icon-512.png');
    // The same files, the same service worker (the browser only updates on a change).
    expect((await api().get('/crm/frontend/sw.js')).text).toBe(res.text);
  });

  it('a changed file is a new revision and a new version; the rest stay as they were', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-app-files-'));
    try {
      fs.mkdirSync(path.join(dir, 'js'));
      fs.writeFileSync(path.join(dir, 'Inbox.html'), '<script src="js/boot.js"></script><link rel="stylesheet" href="https://cdn.example/x.css"><script src="./js/app.js"></script><a href="dashboard.html">x</a>');
      fs.writeFileSync(path.join(dir, 'js', 'boot.js'), 'boot();');
      fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'app(1);');
      fs.writeFileSync(path.join(dir, 'README.md'), 'not a served file');
      fs.writeFileSync(path.join(dir, 'sw.js'), 'const BUILD = /*BUILD*/ null;\n');
      const first = appFiles.build(dir);
      expect(Object.keys(first.files)).toEqual(['Inbox.html', 'js/app.js', 'js/boot.js']);
      expect(first.precache).toEqual(['Inbox.html', 'js/app.js', 'js/boot.js']);
      expect(appFiles.build(dir)).toEqual(first);

      fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'app(2);');
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(dir, 'js', 'app.js'), later, later);
      const second = appFiles.build(dir);
      expect(second.files['js/app.js']).not.toBe(first.files['js/app.js']);
      expect(second.files['js/boot.js']).toBe(first.files['js/boot.js']);
      expect(second.version).not.toBe(first.version);
      expect(appFiles.serviceWorker(dir)).toBe(`const BUILD = ${JSON.stringify(second)};\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pages, texts and the API\'s answers travel compressed; small answers do not', async () => {
    const texts = await api().get('/crm/frontend/i18n/hi.json').set('Accept-Encoding', 'gzip');
    expect(texts.status).toBe(200);
    expect(texts.headers['content-encoding']).toBe('gzip');
    expect(texts.headers.vary).toMatch(/Accept-Encoding/i);
    expect(texts.body['nav.inbox']).toBe('इनबॉक्स');
    // Brotli where the browser takes it (every phone browser today; the test's client unpacks it).
    const page = await api().get('/crm/frontend/Inbox.html').set('Accept-Encoding', 'br');
    expect(page.headers['content-encoding']).toBe('br');
    expect(page.text).toContain('id="conversationList"');
    expect(Number(page.headers['content-length'] || 0)).toBeLessThan(fs.statSync(path.join(FRONTEND, 'Inbox.html')).size);

    const owner = await login('phone-app-owner@example.com');
    const kits = await api().get('/api/v1/organization/business-kits?language=hi').set(bearer(owner.token)).set('Accept-Encoding', 'gzip');
    expect(kits.status).toBe(200);
    expect(kits.headers['content-encoding']).toBe('gzip');
    const health = await api().get('/api/v1/health').set('Accept-Encoding', 'gzip');
    expect(health.headers['content-encoding']).toBeUndefined(); // under 1 KB
    // Sign-in answers carry tokens and secrets: never compressed, whatever their size (the
    // authenticator app's set-up, with its secret and QR code, is well over 1 KB).
    const setup = await api().post('/api/v1/auth/totp/setup').set(bearer(owner.token)).set('Accept-Encoding', 'gzip');
    expect(setup.status).toBe(200);
    expect(setup.text.length).toBeGreaterThan(1024);
    expect(setup.body.data.secret).toBeTruthy();
    expect(setup.headers['content-encoding']).toBeUndefined();
  });

  it('the app\'s descriptions in English and Hindi name the same app, its icons and shortcuts', () => {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(FRONTEND, name), 'utf8'));
    const en = read('manifest.webmanifest');
    const hi = read('manifest-hi.webmanifest');
    for (const manifest of [en, hi]) {
      expect(manifest).toMatchObject({ id: '/crm/frontend/', start_url: 'Inbox.html', scope: './', display: 'standalone', theme_color: '#ffde59' });
      expect(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(['192x192 any', '512x512 any', '192x192 maskable', '512x512 maskable']);
      manifest.icons.forEach((icon) => expect(fs.existsSync(path.join(FRONTEND, icon.src))).toBe(true));
      expect(manifest.shortcuts).toHaveLength(4);
      manifest.shortcuts.forEach((shortcut) => expect(fs.existsSync(path.join(FRONTEND, shortcut.url.split('?')[0]))).toBe(true));
    }
    expect(hi.shortcuts.map((s) => s.url)).toEqual(en.shortcuts.map((s) => s.url));
    expect(hi.lang).toBe('hi-IN');
    expect(hi.shortcuts.every((s) => /[ऀ-ॿ]/.test(s.name))).toBe(true);
  });

  it('the logo every page loads is small (it was 837 KB), and the no-network page leads to the Inbox', () => {
    expect(fs.statSync(path.join(FRONTEND, 'img', 'logo', 'logo.png')).size).toBeLessThan(40 * 1024);
    const offline = fs.readFileSync(path.join(FRONTEND, 'offline.html'), 'utf8');
    expect(offline).toContain('href="Inbox.html"');
    // Every text on it has its Hindi.
    const texts = [...offline.matchAll(/<(h1|p|button|a)\b([^>]*)>/g)];
    expect(texts.length).toBeGreaterThanOrEqual(4);
    texts.forEach(([, , attributes]) => expect(attributes).toMatch(/data-hi="[^"]*[ऀ-ॿ]/));
  });
});
