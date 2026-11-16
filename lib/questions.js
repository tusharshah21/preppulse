'use strict';

// Loads and validates a question file (format documented in questions/README.md).
const fs = require('fs');

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const str = (x) => typeof x === 'string' && x.trim().length > 0;

function validateQuestions(doc) {
  if (doc?.format !== 'preppulse-questions/1') throw new Error('format must be "preppulse-questions/1"');
  if (!str(doc.title)) throw new Error('title is missing');
  const qs = doc.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 200) throw new Error('questions must be an array of 1 to 200 items');
  const ids = new Set();
  qs.forEach((q, i) => {
    const where = `question ${i + 1}`;
    if (!str(q?.id) || ids.has(q.id)) throw new Error(`${where}: id missing or repeated`);
    ids.add(q.id);
    if (!str(q.subject)) throw new Error(`${where}: subject missing`);
    if (!DIFFICULTIES.has(q.difficulty)) throw new Error(`${where}: difficulty must be easy, medium or hard`);
    if (!str(q.text)) throw new Error(`${where}: text missing`);
    if (!Array.isArray(q.options) || q.options.length !== 4 || !q.options.every(str)) throw new Error(`${where}: needs exactly 4 options`);
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) throw new Error(`${where}: answer must be 0 to 3`);
  });
  return doc;
}

const loadQuestions = (file) => validateQuestions(JSON.parse(fs.readFileSync(file, 'utf8')));

// What the window gets: everything except the answers.
const publicView = (doc) => ({
  title: doc.title,
  questions: doc.questions.map(({ id, subject, difficulty, text, options }) => ({ id, subject, difficulty, text, options })),
});

module.exports = { validateQuestions, loadQuestions, publicView };
