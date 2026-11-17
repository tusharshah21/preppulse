'use strict';

// The optional "How did that test feel?" check-in, and the one rule that
// decides whether the support screen appears.
//
// HARD RULE: the support screen is triggered ONLY by what the student says.
// needsSupportScreen() takes the student's answer and nothing else. Pulse,
// breathing, HRV or any other measured signal must never be passed to it or
// used to show support content (see CLAUDE.md and test/checkin.test.js).

const FEELINGS = {
  fine: 'Fine',
  a_bit_tough: 'A bit tough',
  really_overwhelming: 'Really overwhelming',
  skipped: 'Skip',
};

const isFeeling = (x) => typeof x === 'string' && Object.prototype.hasOwnProperty.call(FEELINGS, x);

function needsSupportScreen(feeling) {
  return feeling === 'really_overwhelming';
}

// What is stored in the session file (local, deleted with the session).
function selfReport(feeling, now = new Date()) {
  if (!isFeeling(feeling)) return null;
  return { feeling, answeredAt: now.toISOString() };
}

// "You said: a bit tough" on the report; nothing for skipped or missing.
function saidText(feeling) {
  if (!isFeeling(feeling) || feeling === 'skipped') return null;
  return FEELINGS[feeling].toLowerCase();
}

module.exports = { FEELINGS, isFeeling, needsSupportScreen, selfReport, saidText };
