// Starter code per language, and a library of example problems so a room can start in one click.
// Every example reads stdin and prints to stdout, so it runs in the browser runner. The expected outputs
// are checked against reference solutions in test/examples.test.ts.
import type { Language, TestCase } from '@duet/ot';

export const STARTERS: Record<Language, string> = {
  python: '# Read input with input() and print the answer.\n',
  javascript: '// Read input with readline() and print the answer with console.log().\n',
  cpp: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    // Read input with cin and print the answer with cout.\n}\n',
};

export type Example = { id: string; title: string; problem: string; tests: TestCase[]; starters: Record<Language, string> };

const cpp = (body: string) => `#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n${body}\n}\n`;

export const EXAMPLES: Example[] = [
  {
    id: 'pair-sum',
    title: 'Pair with target sum',
    problem: `# Pair with target sum

You get n integers and a target. Print the positions (counting from 0) of the two numbers that add up to the target, smaller position first. Exactly one pair works.

Input
- Line 1: n
- Line 2: the n integers, separated by spaces
- Line 3: the target

Output
- The two positions, separated by a space

Example input

\`\`\`
4
2 7 11 15
9
\`\`\`

prints \`0 1\`.
`,
    tests: [
      { input: '4\n2 7 11 15\n9', expected: '0 1' },
      { input: '3\n3 2 4\n6', expected: '1 2' },
      { input: '2\n3 3\n6', expected: '0 1' },
      { input: '5\n-1 -2 -3 -4 -5\n-8', expected: '2 4' },
    ],
    starters: {
      python: 'n = int(input())\nnums = list(map(int, input().split()))\ntarget = int(input())\n\n# Print the two positions here.\n',
      javascript: "const n = Number(readline());\nconst nums = readline().split(' ').map(Number);\nconst target = Number(readline());\n\n// Print the two positions here.\n",
      cpp: cpp('    int n; cin >> n;\n    vector<int> nums(n);\n    for (auto &x : nums) cin >> x;\n    int target; cin >> target;\n    // Print the two positions here.'),
    },
  },
  {
    id: 'brackets',
    title: 'Balanced brackets',
    problem: `# Balanced brackets

A line contains only the characters \`( ) [ ] { }\`. Print \`YES\` if every bracket is closed by the matching kind, in the right order, and \`NO\` otherwise.

Input
- Line 1: the brackets, with no spaces

Output
- \`YES\` or \`NO\`

\`([]){}\` is balanced. \`([)]\` is not: the \`(\` is closed by a \`]\`.
`,
    tests: [
      { input: '([]){}', expected: 'YES' },
      { input: '([)]', expected: 'NO' },
      { input: '((', expected: 'NO' },
      { input: '{[()()]}', expected: 'YES' },
      { input: ')(', expected: 'NO' },
    ],
    starters: {
      python: 's = input().strip()\n\n# Print YES or NO.\n',
      javascript: "const s = readline().trim();\n\n// Print YES or NO.\n",
      cpp: cpp('    string s; cin >> s;\n    // Print YES or NO.'),
    },
  },
  {
    id: 'binary-search',
    title: 'Binary search',
    problem: `# Binary search

You get n integers in increasing order and a target. Print the position (counting from 0) of the target, or \`-1\` if it is not there. Aim for O(log n).

Input
- Line 1: n
- Line 2: the n integers, increasing, separated by spaces
- Line 3: the target

Output
- The position, or \`-1\`
`,
    tests: [
      { input: '5\n1 3 5 7 9\n7', expected: '3' },
      { input: '5\n1 3 5 7 9\n4', expected: '-1' },
      { input: '1\n10\n10', expected: '0' },
      { input: '6\n-5 -2 0 3 8 13\n-5', expected: '0' },
    ],
    starters: {
      python: 'n = int(input())\nnums = list(map(int, input().split()))\ntarget = int(input())\n\n# Print the position or -1.\n',
      javascript: "const n = Number(readline());\nconst nums = readline().split(' ').map(Number);\nconst target = Number(readline());\n\n// Print the position or -1.\n",
      cpp: cpp('    int n; cin >> n;\n    vector<int> nums(n);\n    for (auto &x : nums) cin >> x;\n    int target; cin >> target;\n    // Print the position or -1.'),
    },
  },
  {
    id: 'longest-unique',
    title: 'Longest run without repeats',
    problem: `# Longest run without repeats

Given a string of lowercase letters, print the length of the longest stretch of consecutive characters in which no letter appears twice.

Input
- Line 1: the string

Output
- The length

In \`abcabcbb\` the longest such stretch is \`abc\`, so the answer is \`3\`.
`,
    tests: [
      { input: 'abcabcbb', expected: '3' },
      { input: 'bbbbb', expected: '1' },
      { input: 'pwwkew', expected: '3' },
      { input: 'dvdf', expected: '3' },
    ],
    starters: {
      python: 's = input().strip()\n\n# Print the length.\n',
      javascript: "const s = readline().trim();\n\n// Print the length.\n",
      cpp: cpp('    string s; cin >> s;\n    // Print the length.'),
    },
  },
  {
    id: 'merge-intervals',
    title: 'Merge meeting times',
    problem: `# Merge meeting times

You get n meetings as \`start end\` pairs, in any order. Merge every set of meetings that overlap or touch (one ends exactly when another starts), and print the merged meetings sorted by start, one per line.

Input
- Line 1: n
- Next n lines: \`start end\`

Output
- One merged meeting per line: \`start end\`

\`1 3\`, \`2 6\`, \`8 10\` become \`1 6\` and \`8 10\`.
`,
    tests: [
      { input: '4\n1 3\n2 6\n8 10\n15 18', expected: '1 6\n8 10\n15 18' },
      { input: '2\n1 4\n4 5', expected: '1 5' },
      { input: '3\n5 7\n1 2\n3 4', expected: '1 2\n3 4\n5 7' },
      { input: '3\n1 10\n2 3\n4 5', expected: '1 10' },
    ],
    starters: {
      python: 'n = int(input())\nmeetings = [tuple(map(int, input().split())) for _ in range(n)]\n\n# Print one merged meeting per line.\n',
      javascript: "const n = Number(readline());\nconst meetings = Array.from({ length: n }, () => readline().split(' ').map(Number));\n\n// Print one merged meeting per line.\n",
      cpp: cpp('    int n; cin >> n;\n    vector<pair<int, int>> meetings(n);\n    for (auto &[s, e] : meetings) cin >> s >> e;\n    // Print one merged meeting per line.'),
    },
  },
  {
    id: 'islands',
    title: 'Count the islands',
    problem: `# Count the islands

A map is a grid of \`1\` (land) and \`0\` (water). Land cells that touch up, down, left or right belong to the same island. Print how many islands there are.

Input
- Line 1: rows and columns
- Next lines: one row each, as a string of \`0\` and \`1\`

Output
- The number of islands
`,
    tests: [
      { input: '4 5\n11110\n11010\n11000\n00000', expected: '1' },
      { input: '4 5\n11000\n11000\n00100\n00011', expected: '3' },
      { input: '1 1\n0', expected: '0' },
      { input: '3 3\n101\n010\n101', expected: '5' },
    ],
    starters: {
      python: 'r, c = map(int, input().split())\ngrid = [input().strip() for _ in range(r)]\n\n# Print the number of islands.\n',
      javascript: "const [r, c] = readline().split(' ').map(Number);\nconst grid = Array.from({ length: r }, () => readline().trim());\n\n// Print the number of islands.\n",
      cpp: cpp('    int r, c; cin >> r >> c;\n    vector<string> grid(r);\n    for (auto &row : grid) cin >> row;\n    // Print the number of islands.'),
    },
  },
  {
    id: 'dijkstra',
    title: 'Shortest routes (Dijkstra)',
    problem: `# Shortest routes

A city has n junctions (numbered 1 to n) and m two-way roads, each with a length of 0 or more. From a starting junction s, print the length of the shortest route to every junction, in order from 1 to n. Print \`-1\` for a junction you cannot reach.

Input
- Line 1: n and m
- Next m lines: \`u v w\`, a road between u and v of length w
- Last line: s

Output
- n numbers separated by spaces

This is the classic case for Dijkstra's algorithm with a priority queue.
`,
    tests: [
      { input: '4 4\n1 2 1\n2 3 2\n1 3 5\n3 4 1\n1', expected: '0 1 3 4' },
      { input: '3 1\n1 2 7\n3', expected: '-1 -1 0' },
      { input: '5 6\n1 2 2\n1 3 4\n2 3 1\n2 4 7\n3 5 3\n4 5 1\n1', expected: '0 2 3 7 6' },
      { input: '2 1\n1 2 0\n2', expected: '0 0' },
    ],
    starters: {
      python: 'n, m = map(int, input().split())\nroads = [tuple(map(int, input().split())) for _ in range(m)]\ns = int(input())\n\n# Print the n shortest distances, -1 if unreachable.\n',
      javascript: "const [n, m] = readline().split(' ').map(Number);\nconst roads = Array.from({ length: m }, () => readline().split(' ').map(Number));\nconst s = Number(readline());\n\n// Print the n shortest distances, -1 if unreachable.\n",
      cpp: cpp('    int n, m; cin >> n >> m;\n    vector<array<int, 3>> roads(m);\n    for (auto &[u, v, w] : roads) cin >> u >> v >> w;\n    int s; cin >> s;\n    // Print the n shortest distances, -1 if unreachable.'),
    },
  },
  {
    id: 'strong-password',
    title: 'Strong password',
    problem: `# Strong password

A password is strong when it has at least 8 characters and contains at least one lowercase letter, one uppercase letter, one digit, and one of \`!@#$%^&*\`. Given a password, print the fewest characters you would have to add to make it strong.

Input
- Line 1: the password (no spaces)

Output
- The number of characters to add

\`password\` has 8 characters but no uppercase letter, digit or symbol, so the answer is \`3\`.
`,
    tests: [
      { input: 'Ab1!', expected: '4' },
      { input: 'password', expected: '3' },
      { input: 'Passw0rd!', expected: '0' },
      { input: 'aaaaaaaaaaaa', expected: '3' },
      { input: 'A1', expected: '6' },
    ],
    starters: {
      python: 'password = input().strip()\n\n# Print how many characters to add.\n',
      javascript: "const password = readline().trim();\n\n// Print how many characters to add.\n",
      cpp: cpp('    string password; cin >> password;\n    // Print how many characters to add.'),
    },
  },
];

/** True if the code is still an untouched starter, so switching language or example may replace it. */
export const isStarter = (code: string) => {
  const all = [...Object.values(STARTERS), ...EXAMPLES.flatMap(e => Object.values(e.starters))];
  return code.trim() === '' || all.some(s => s.trim() === code.trim());
};
