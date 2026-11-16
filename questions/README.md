# Question files

A test is one JSON file in this folder. The app loads `sample-test.json`. The 12 sample questions are original, written for PrepPulse, and not taken from any real exam paper.

```json
{
  "format": "preppulse-questions/1",
  "title": "Sample practice test",
  "questions": [
    {
      "id": "phy-1",
      "subject": "Physics",
      "difficulty": "easy",
      "text": "A ball is thrown straight up at 20 m/s. ...",
      "options": ["10 m", "20 m", "40 m", "80 m"],
      "answer": 1
    }
  ]
}
```

Fields:

- `format`: must be `"preppulse-questions/1"`.
- `title`: shown on the "Before you begin" screen.
- `questions`: 1 to 200 questions, shown in this order.
- `id`: unique short string. Session files refer to questions by index and also store the id.
- `subject`: free text, shown as a small tag above the question.
- `difficulty`: `"easy"`, `"medium"` or `"hard"`.
- `text`: the question, plain text (no HTML; it is shown with `textContent`).
- `options`: exactly 4 non-empty strings.
- `answer`: index (0 to 3) of the correct option. It stays in the main process: the window never receives it, and correctness is computed only when the test ends.

`lib/questions.js` validates a file on load and refuses it with a message naming the first problem.
