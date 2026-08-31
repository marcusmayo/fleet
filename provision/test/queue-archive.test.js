'use strict';
// Clearing an item from the review queue. The file, its .flags.json sidecar and its
// extracted text all belong to the same item and all have to travel together.
//
// Left behind, the extraction becomes an unowned copy of the item's text sitting in the
// directory an agent reads first. When the item is later re-read by a better extractor
// the corrected text lands in the archive, while the stale one stays in the queue -- two
// texts answering one question, with nothing on either saying which is current. That is
// how a sideways, garbled read survived a fix that had already been applied.
//
// A name collision renames the item on the way in, so the sidecar's pointer at its
// extraction has to be rewritten or the record names a file that is not there.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('../../core/queue.js');

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-archive-'));
  fs.mkdirSync(path.join(root, 'review', '.text'), { recursive: true });
  fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
  // readSpec reads system/agent.yaml under a `queue:` key -- read out of the
  // parser, not assumed.
  fs.mkdirSync(path.join(root, 'system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'system', 'agent.yaml'),
    'queue:\n  - dir: review\n    label: review\n    archive: archive\n');
  return root;
}

function item(root, name, textFile) {
  fs.writeFileSync(path.join(root, 'review', name), 'content of ' + name);
  fs.writeFileSync(path.join(root, 'review', name + '.flags.json'), JSON.stringify({
    file: name,
    extraction: { extractor: 'tesseract', scan_state: 'scanned', text_file: textFile },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'review', '.text', name + '.txt'), 'extracted text of ' + name);
}

test('clearing an item takes its extraction with it', () => {
  const root = workspace();
  item(root, 'note.png', '.text/note.png.txt');
  const moved = queue.archiveItems(root, '--all');
  assert.strictEqual(moved.length, 1);
  assert.strictEqual(moved[0].text, true, 'the clear did not report moving an extraction');

  assert.ok(!fs.existsSync(path.join(root, 'review', '.text', 'note.png.txt')),
    'the extraction stayed in the queue -- an unowned copy of the item text');
  assert.ok(fs.existsSync(path.join(root, 'archive', '.text', 'note.png.txt')),
    'the extraction did not arrive beside its item');
  assert.strictEqual(fs.readFileSync(path.join(root, 'archive', '.text', 'note.png.txt'), 'utf8'),
    'extracted text of note.png');
});

test('a collision renames the item, and the record still points at its own extraction', () => {
  const root = workspace();
  // Something of this name is already archived, so the clear will rename.
  fs.writeFileSync(path.join(root, 'archive', 'note.png'), 'an older copy');
  item(root, 'note.png', '.text/note.png.txt');

  queue.archiveItems(root, '--all');

  const renamed = fs.readdirSync(path.join(root, 'archive')).filter(f => /^\d{13}-note\.png$/.test(f));
  assert.strictEqual(renamed.length, 1, 'expected exactly one renamed item, saw ' + renamed.length);
  const dest = renamed[0];

  const fl = JSON.parse(fs.readFileSync(path.join(root, 'archive', dest + '.flags.json'), 'utf8'));
  assert.strictEqual(fl.extraction.text_file, '.text/' + dest + '.txt',
    'the record still points at the pre-rename name -- a pointer at a file that is not there');
  assert.ok(fs.existsSync(path.join(root, 'archive', fl.extraction.text_file)),
    'the record names an extraction that does not exist');
});

test('an item with no extraction clears without inventing one', () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'review', 'plain.txt'), 'body');
  const moved = queue.archiveItems(root, '--all');
  assert.strictEqual(moved.length, 1);
  assert.strictEqual(moved[0].text, false);
  assert.ok(!fs.existsSync(path.join(root, 'archive', '.text')),
    'a .text directory was created for an item that has no extraction');
});

test('a sidecar that will not parse is moved untouched rather than rewritten', () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'archive', 'bad.png'), 'older');
  fs.writeFileSync(path.join(root, 'review', 'bad.png'), 'content');
  fs.writeFileSync(path.join(root, 'review', 'bad.png.flags.json'), '{ this is not json');
  fs.writeFileSync(path.join(root, 'review', '.text', 'bad.png.txt'), 'text');

  queue.archiveItems(root, '--all');
  const dest = fs.readdirSync(path.join(root, 'archive')).find(f => /^\d{13}-bad\.png$/.test(f));
  assert.ok(dest, 'the item was not archived');
  assert.strictEqual(fs.readFileSync(path.join(root, 'archive', dest + '.flags.json'), 'utf8'),
    '{ this is not json', 'an unparseable sidecar must survive as it was, not be guessed at');
});
