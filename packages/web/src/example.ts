// Starter code per language, and one example problem so a first visit has something to run.
import type { Language, TestCase } from '@duet/ot';

export const STARTERS: Record<Language, string> = {
  python: '# Read input with input() and print the answer.\n',
  javascript: '// Read input with readline() and print the answer with console.log().\n',
  cpp: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    // Read input with cin and print the answer with cout.\n}\n',
};

const PROBLEM = `# Pair with target sum

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
`;

const TESTS: TestCase[] = [
  { input: '4\n2 7 11 15\n9', expected: '0 1' },
  { input: '3\n3 2 4\n6', expected: '1 2' },
  { input: '2\n3 3\n6', expected: '0 1' },
  { input: '5\n-1 -2 -3 -4 -5\n-8', expected: '2 4' },
];

const READ_INPUT: Record<Language, string> = {
  python: `n = int(input())
nums = list(map(int, input().split()))
target = int(input())

# Print the two positions here.
`,
  javascript: `const n = Number(readline());
const nums = readline().split(' ').map(Number);
const target = Number(readline());

// Print the two positions here.
`,
  cpp: `#include <bits/stdc++.h>
using namespace std;

int main() {
    int n; cin >> n;
    vector<int> nums(n);
    for (auto &x : nums) cin >> x;
    int target; cin >> target;
    // Print the two positions here.
}
`,
};

export const EXAMPLE = { problem: PROBLEM, tests: TESTS, starters: READ_INPUT };

/** True if the code is still an untouched starter, so switching language may replace it. */
export const isStarter = (code: string) =>
  code.trim() === '' || Object.values(STARTERS).concat(Object.values(READ_INPUT)).some(s => s.trim() === code.trim());
