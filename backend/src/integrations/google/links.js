// Google file links (Phase 9B, D90): a pasted Docs, Sheets, Slides or Drive address → its file
// id and kind, without asking Google (nothing is fetched).
const PATTERNS = [
  [/^https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{10,200})/, 'doc'],
  [/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{10,200})/, 'sheet'],
  [/^https:\/\/docs\.google\.com\/presentation\/d\/([A-Za-z0-9_-]{10,200})/, 'slides'],
  [/^https:\/\/docs\.google\.com\/forms\/d\/([A-Za-z0-9_-]{10,200})/, 'form'],
  [/^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,200})/, 'file'],
  [/^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,200})/, 'folder'],
];

function googleFileOf(url) {
  const text = String(url || '').trim();
  for (const [pattern, kind] of PATTERNS) {
    const match = text.match(pattern);
    if (match) return { fileId: match[1], kind };
  }
  const open = text.match(/^https:\/\/drive\.google\.com\/open\?(?:.*&)?id=([A-Za-z0-9_-]{10,200})/);
  return open ? { fileId: open[1], kind: 'file' } : null;
}

module.exports = { googleFileOf };
