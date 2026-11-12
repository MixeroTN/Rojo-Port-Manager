import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareProjectFiles,
  isProjectFileName,
  parseProjectFile,
  projectLabel,
  stripJsonComments,
} from '../../src/model/projectFile.ts';

test('reads the name, servePort and servePlaceIds', () => {
  const text = JSON.stringify({
    name: 'Fixture Game',
    servePort: 34874,
    servePlaceIds: [1818, '4567890123456', 'x', 1.5],
    tree: { $className: 'DataModel' },
  });

  assert.deepEqual(parseProjectFile(text), {
    name: 'Fixture Game',
    servePort: 34874,
    servePlaceIds: ['1818', '4567890123456'],
  });
});

test('ignores a servePort that is not a port', () => {
  assert.equal(parseProjectFile('{"name":"A","servePort":"34874"}')?.servePort, undefined);
  assert.equal(parseProjectFile('{"name":"A","servePort":0}')?.servePort, undefined);
  assert.equal(parseProjectFile('{"name":"A","servePort":70000}')?.servePort, undefined);
});

test('reads files with a BOM, comments and trailing commas', () => {
  const text =
    String.fromCharCode(0xfeff) +
    '{\n  // the game\n  "name": "A // not a comment",\n  /* port */ "servePort": 34880,\n  "tree": {},\n}\n';

  assert.deepEqual(parseProjectFile(text), { name: 'A // not a comment', servePort: 34880, servePlaceIds: [] });
});

test('keeps commas and slashes inside strings', () => {
  assert.equal(stripJsonComments('{"a": "x, }", "b": [1,],}'), '{"a": "x, }", "b": [1]}');
  assert.equal(stripJsonComments('{"a": "say \\"hi\\" // ok"}'), '{"a": "say \\"hi\\" // ok"}');
});

test('a file that is not a JSON object gives nothing', () => {
  assert.equal(parseProjectFile('{"name": '), undefined);
  assert.equal(parseProjectFile('[1, 2]'), undefined);
  assert.equal(parseProjectFile('"text"'), undefined);
});

test('names and orders project files', () => {
  assert.equal(isProjectFileName('default.project.json'), true);
  assert.equal(isProjectFileName('Game.PROJECT.JSON'), true);
  assert.equal(isProjectFileName('.project.json'), false);
  assert.equal(isProjectFileName('project.json'), false);
  assert.equal(projectLabel('lobby.project.json'), 'lobby');
  assert.deepEqual(
    ['tower.project.json', 'default.project.json', 'Arena10.project.json', 'arena2.project.json'].sort(
      compareProjectFiles,
    ),
    ['default.project.json', 'arena2.project.json', 'Arena10.project.json', 'tower.project.json'],
  );
});
