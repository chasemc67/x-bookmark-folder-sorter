import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBatchRequest, buildFolderOptions, KEEP_UNFILED, SKIP, trimText } from '../src/sorter/questions.js';

test('folder options are sorted deterministically and avoid reserved/duplicate keys', () => {
  const options = buildFolderOptions([
    { id: '3', name: 'skip' },
    { id: '2', name: 'Recipes' },
    { id: '1', name: 'Recipes' },
    { id: '4', name: 'AI' },
  ]);
  assert.deepEqual(options.map(o => [o.key, o.folder.id]), [
    ['AI', '4'],
    ['Recipes', '1'],
    ['Recipes (2)', '2'],
    ['skip (2)', '3'],
  ]);
});

test('batch request shares one trimmed state and asks one choice per bookmark', () => {
  const options = buildFolderOptions([{ id: '1', name: 'AI' }]);
  const request = buildBatchRequest(
    [
      { bookmark: { id: '11', text: 'a  b\n c', authorUsername: 'someone' }, currentFolders: [] },
      { bookmark: { id: '12', text: 'x'.repeat(100) }, currentFolders: ['AI'] },
    ],
    options,
    { maxTextChars: 50, folderDescriptions: { AI: 'machine learning' } },
  );
  const state = request.state as { folders: string[]; bookmarks: { author: string | null; text: string; current_folders: string[] }[] };
  assert.deepEqual(state.folders, ['AI']);
  assert.deepEqual(state.bookmarks[0], { author: '@someone', text: 'a b c', current_folders: [] });
  assert.equal(state.bookmarks[1]!.text.length, 50);
  assert.deepEqual(Object.keys(request.questions), ['bookmark_11', 'bookmark_12']);
  assert.deepEqual(request.questionTweetIds, { bookmark_11: '11', bookmark_12: '12' });
  const question = request.questions.bookmark_12!;
  assert.equal(question.type, 'choice');
  assert.deepEqual(Object.keys(question.criteria), ['AI', KEEP_UNFILED, SKIP]);
  assert.match(String(question.criteria.AI), /machine learning/);
  assert.match(String(question.instructions), /`bookmarks\[1\]`/);
  assert.match(String(question.instructions), /already in "AI"/);
});

test('trimText collapses whitespace and caps length', () => {
  assert.equal(trimText('  hello \n world ', 100), 'hello world');
  assert.equal(trimText('abcdef', 4), 'abc…');
});
