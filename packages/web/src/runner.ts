// Runs the room's code in the browser of whoever presses Run, inside a Web Worker: no page access,
// a time limit (the worker is killed), and capped output. JavaScript gets a fresh worker per run;
// Python runs on Pyodide (CPython compiled to WebAssembly) in a worker kept warm between runs.
// C++ needs the server-side Docker runner (Week 2), so it is not run here.
import type { Language, RunStatus, TestCase, TestResult } from '@duet/ot';

const TIME_LIMIT_MS = 5000;
const OUTPUT_LIMIT = 64 * 1024;
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';

type Outcome = { output: string; error: string; ms: number; timedOut: boolean };

// Each worker answers { output, error, ms } for one { code, input }. `readline()` and `input` give the
// program its stdin, one line per call, like a judge would.
const JS_WORKER = `
const LIMIT = ${OUTPUT_LIMIT};
self.onmessage = e => {
  const { code, input } = e.data;
  let output = '';
  const show = v => typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  const write = (...args) => {
    output += args.map(show).join(' ') + '\\n';
    if (output.length > LIMIT) throw new Error('Output limit (64 KB) exceeded');
  };
  const lines = input.split('\\n');
  let next = 0;
  const readline = () => (next < lines.length ? lines[next++] : null);
  const console = { log: write, info: write, warn: write, error: write };
  const start = performance.now();
  try {
    new Function('console', 'readline', 'input', code)(console, readline, input);
    postMessage({ output, error: '', ms: performance.now() - start });
  } catch (err) {
    postMessage({ output, error: String(err && err.stack ? err.stack.split('\\n').slice(0, 3).join('\\n') : err), ms: performance.now() - start });
  }
};`;

const PY_WORKER = `
importScripts('${PYODIDE}pyodide.js');
const LIMIT = ${OUTPUT_LIMIT};
const ready = loadPyodide({ indexURL: '${PYODIDE}' });
ready.then(() => postMessage({ ready: true }));
self.onmessage = async e => {
  const py = await ready;
  const { code, input } = e.data;
  let output = '';
  const write = s => { if (output.length < LIMIT) output += s + '\\n'; };
  py.setStdout({ batched: write });
  py.setStderr({ batched: write });
  const lines = input.split('\\n');
  let next = 0;
  py.setStdin({ stdin: () => (next < lines.length ? lines[next++] : undefined) });
  const start = performance.now();
  try {
    py.runPython(code, { globals: py.toPy({}) }); // a fresh namespace for every run
    postMessage({ output, error: '', ms: performance.now() - start });
  } catch (err) {
    const message = String(err.message || err).trim().split('\\n');
    postMessage({ output, error: message.slice(-4).join('\\n'), ms: performance.now() - start });
  }
};`;

const urls = new Map<string, string>();
const workerFrom = (source: string) => {
  if (!urls.has(source)) urls.set(source, URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  return new Worker(urls.get(source)!);
};

let python: Worker | null = null;
let pythonReady: Promise<void> | null = null;
/** The warm Python worker. The first call downloads Pyodide (about 10 MB, cached after that). */
function pythonWorker(onLoading: () => void) {
  if (!python) {
    python = workerFrom(PY_WORKER);
    onLoading();
    pythonReady = new Promise(resolve => python!.addEventListener('message', e => e.data?.ready && resolve()));
  }
  return { worker: python, ready: pythonReady! };
}

async function runOnce(language: Language, code: string, input: string, onLoading: () => void): Promise<Outcome> {
  let worker: Worker;
  if (language === 'javascript') worker = workerFrom(JS_WORKER);
  else {
    const p = pythonWorker(onLoading);
    await p.ready;
    worker = p.worker;
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      // Killing the worker is the only way to stop an infinite loop. Python then reloads on the next run.
      worker.terminate();
      if (worker === python) python = null;
      resolve({ output: '', error: `Stopped after ${TIME_LIMIT_MS / 1000} s (time limit)`, ms: TIME_LIMIT_MS, timedOut: true });
    }, TIME_LIMIT_MS);
    const done = (e: MessageEvent) => {
      if (e.data?.ready) return;
      clearTimeout(timer);
      worker.removeEventListener('message', done);
      if (language === 'javascript') worker.terminate();
      resolve({ ...e.data, timedOut: false });
    };
    worker.addEventListener('message', done);
    worker.postMessage({ code, input });
  });
}

const sameOutput = (a: string, b: string) => {
  const norm = (s: string) => s.replace(/\r/g, '').split('\n').map(l => l.trimEnd()).join('\n').trim();
  return norm(a) === norm(b);
};

/**
 * Runs the code once per test case (or once with empty input when there are none) and grades each
 * run by comparing its output with the expected output, ignoring trailing spaces and blank lines.
 */
export async function runTests(language: Language, code: string, tests: TestCase[], onLoading: () => void): Promise<TestResult[]> {
  if (language === 'cpp') {
    return [{ input: '', expected: null, output: '', error: 'C++ needs the server-side runner, which is not deployed yet. JavaScript and Python run in your browser.', ms: 0, status: 'error' }];
  }
  const cases = tests.length ? tests : [{ input: '', expected: null as string | null }];
  const results: TestResult[] = [];
  for (const test of cases) {
    const { output, error, ms, timedOut } = await runOnce(language, code, test.input, onLoading);
    const status: RunStatus = timedOut ? 'timeout' : error ? 'error'
      : test.expected === null ? 'ran' : sameOutput(output, test.expected) ? 'passed' : 'failed';
    results.push({ input: test.input, expected: test.expected, output: output.slice(0, OUTPUT_LIMIT), error, ms: Math.round(ms), status });
  }
  return results;
}
