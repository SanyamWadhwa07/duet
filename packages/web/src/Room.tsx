import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { Language, RunReport, TestCase, TestResult } from '@duet/ot';
import { monaco } from './monaco';
import { RoomSession, type RoomState } from './session';
import { runTests } from './runner';
import { EXAMPLE, isStarter, STARTERS } from './example';
import { Mark } from './Mark';

const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'python', label: 'Python' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'cpp', label: 'C++' },
];
const STATUS_TEXT: Record<RoomState['status'], string> = {
  connecting: 'Connecting',
  waking: 'Waking the server. Free hosting can take up to a minute.',
  connected: 'Connected',
  reconnecting: 'Connection lost. Reconnecting.',
  full: 'This room already has 4 people. Ask for a new link.',
};
const RESULT_TEXT: Record<TestResult['status'], string> = {
  passed: 'Passed', failed: 'Wrong answer', error: 'Error', timeout: 'Time limit', ran: 'Ran',
};

const EDITOR: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: 'duet', automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
  fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 14, padding: { top: 14 },
};
monaco.editor.defineTheme('duet', {
  base: 'vs-dark', inherit: true, rules: [],
  colors: { 'editor.background': '#1E2024', 'editor.lineHighlightBackground': '#25282E', 'editorLineNumber.foreground': '#5B616B' },
});

/** Problem statements are Markdown written by anyone in the room, so the HTML is sanitised. */
const renderMarkdown = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
const MAX_UPLOAD_BYTES = 100_000;

/** Replaces a model's text as a normal edit, so it is sent to the room like typing. */
const setText = (model: monaco.editor.ITextModel, text: string) =>
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);

export function Room({ room, name, hostKey }: { room: string; name: string; hostKey: string | null }) {
  const codeHost = useRef<HTMLDivElement>(null);
  const problemHost = useRef<HTMLDivElement>(null);
  const session = useRef<RoomSession | null>(null);
  const [state, setState] = useState<RoomState>({ status: 'connecting', you: '', role: null, peers: [], settings: null, lastRun: null, notice: null });
  const [empty, setEmpty] = useState({ code: true, problem: true });
  const [problemText, setProblemText] = useState('');
  const [preview, setPreview] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'tests' | 'output'>('tests');
  const [running, setRunning] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const settings = state.settings;

  useEffect(() => {
    const code = monaco.editor.create(codeHost.current!, { ...EDITOR, language: 'python' });
    const problem = monaco.editor.create(problemHost.current!, {
      ...EDITOR, language: 'markdown', lineNumbers: 'off', wordWrap: 'on', folding: false,
      glyphMargin: false, lineDecorationsWidth: 18, renderLineHighlight: 'none',
    });
    const s = new RoomSession(code, problem, room, name, patch => setState(prev => ({ ...prev, ...patch })), hostKey);
    session.current = s;
    const track = () => {
      setEmpty({ code: s.code.model.getValueLength() === 0, problem: s.problem.model.getValueLength() === 0 });
      setProblemText(s.problem.model.getValue());
    };
    const listeners = [s.code.model.onDidChangeContent(track), s.problem.model.onDidChangeContent(track)];
    code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    document.fonts.ready.then(() => monaco.editor.remeasureFonts());
    if (import.meta.env.DEV) Object.assign(window, { duet: { editor: code, problem, session: s } }); // used by the e2e test
    return () => { listeners.forEach(l => l.dispose()); s.close(); code.dispose(); problem.dispose(); };
  }, [room, name, hostKey]);

  // Everyone's editor follows the room's language.
  useEffect(() => {
    if (settings && session.current) monaco.editor.setModelLanguage(session.current.code.model, settings.language === 'cpp' ? 'cpp' : settings.language);
  }, [settings?.language]);

  // The candidate always reads the problem rendered. The interviewer gets the rendered problem when there is
  // one, and the editor when the room is new.
  const isInterviewer = state.role === 'interviewer';
  useEffect(() => {
    if (state.status === 'connected') setPreview(!isInterviewer || session.current!.problem.model.getValueLength() > 0);
  }, [state.status, isInterviewer]);
  const problemHtml = useMemo(() => (preview ? renderMarkdown(problemText) : ''), [preview, problemText]);

  // A new run (yours or someone else's) opens the output.
  useEffect(() => { if (state.lastRun) setTab('output'); }, [state.lastRun?.at]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  const run = async () => {
    const s = session.current;
    if (!s || !settings || running) return;
    setRunning('Running');
    setTab('output');
    try {
      const results = await runTests(settings.language, s.code.model.getValue(), settings.tests,
        () => setRunning('Loading Python, first run only'));
      setState(prev => ({ ...prev, lastRun: { by: name, at: Date.now(), language: settings.language, results } }));
      s.shareRun({ language: settings.language, results });
    } finally {
      setRunning(null);
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  const changeLanguage = (language: Language) => {
    const s = session.current!;
    s.updateSettings({ language });
    if (isStarter(s.code.model.getValue())) setText(s.code.model, STARTERS[language]);
  };

  const loadExample = () => {
    const s = session.current!;
    if (s.problem.model.getValueLength() === 0) setText(s.problem.model, EXAMPLE.problem);
    setPreview(true);
    s.updateSettings({ tests: EXAMPLE.tests });
    if (settings && isStarter(s.code.model.getValue())) setText(s.code.model, EXAMPLE.starters[settings.language]);
  };

  const uploadProblem = async (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) return setToast('That file is over 100 KB. Upload just the problem statement.');
    setText(session.current!.problem.model, (await file.text()).replace(/\r\n/g, '\n'));
    setPreview(true);
    setToast(`Loaded ${file.name}. Ctrl+Z in the editor undoes it.`);
  };

  const copy = async (link: string, message: string) => {
    await navigator.clipboard.writeText(link);
    setToast(message);
  };
  const roomLink = `${location.origin}/r/${room}`;

  const connected = state.status === 'connected';
  return (
    <div className="room">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Duet home"><Mark /> Duet</a>
        {state.role && <span className={`badge ${state.role}`}>{state.role === 'interviewer' ? "You're the interviewer" : "You're a candidate"}</span>}
        <button className="ghost" onClick={() => copy(roomLink, 'Candidate link copied')}>
          {isInterviewer ? 'Invite candidate' : 'Copy room link'}
        </button>
        {isInterviewer && hostKey && (
          <button className="ghost" onClick={() => copy(`${roomLink}#host=${hostKey}`, 'Interviewer link copied. Share it only with co-interviewers.')}>
            Invite interviewer
          </button>
        )}
        <ul className="people" aria-label="People in this room">
          <li><span className="dot you" />{name} (you){state.role && <span className="role">{state.role}</span>}</li>
          {state.peers.map(p => (
            <li key={p.id}><span className="dot" style={{ background: p.color }} />{p.name}<span className="role">{p.role}</span></li>
          ))}
        </ul>
        <span className={`status ${state.status}`} role="status">{STATUS_TEXT[state.status]}</span>
        <div className="controls">
          <select aria-label="Language" value={settings?.language ?? 'python'} disabled={!connected}
            onChange={e => changeLanguage(e.target.value as Language)}>
            {LANGUAGES.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          <Timer startedAt={settings?.timerStartedAt ?? null} now={now} disabled={!connected} canControl={isInterviewer}
            onChange={timerStartedAt => session.current?.updateSettings({ timerStartedAt })} />
          <button className="run" onClick={run} disabled={!connected || !!running} title="Ctrl+Enter">
            {running ?? (settings?.tests.length ? `Run ${settings.tests.length} tests` : 'Run')}
          </button>
        </div>
      </header>

      {state.notice && <div className="notice" role="alert">{state.notice}<button className="ghost" onClick={() => setState(s => ({ ...s, notice: null }))}>Dismiss</button></div>}

      <main className="panes">
        <section className="pane problem-pane" aria-label="Problem">
          <div className="pane-head">
            <h2>Problem</h2>
            {isInterviewer && (
              <div className="pane-actions">
                {!empty.problem && <button className="ghost" onClick={() => setPreview(p => !p)}>{preview ? 'Edit' : 'Preview'}</button>}
                <button className="ghost" disabled={!connected} onClick={() => upload.current?.click()}>Upload .md</button>
                <input ref={upload} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadProblem(f); e.target.value = ''; }} />
                {empty.problem && connected && <button className="ghost" onClick={loadExample}>Load an example</button>}
              </div>
            )}
          </div>
          <div className="editor-wrap">
            <div className="editor-host" ref={problemHost} style={{ visibility: preview && !empty.problem ? 'hidden' : 'visible' }} />
            {preview && !empty.problem && <article className="markdown" dangerouslySetInnerHTML={{ __html: problemHtml }} />}
            {empty.problem && (
              <p className="placeholder">
                {isInterviewer || !connected
                  ? 'Paste, write or upload (.md) the problem here. Only interviewers can edit it.'
                  : 'The interviewer has not added the problem yet. It appears here as soon as they do.'}
              </p>
            )}
          </div>
        </section>

        <section className="pane code-pane" aria-label="Code">
          <div className="editor-wrap">
            <div className="editor-host" ref={codeHost} />
            {empty.code && <p className="placeholder code">Write your solution here. It reads the test input from stdin.</p>}
          </div>
        </section>

        <section className="pane console" aria-label="Tests and output">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'tests'} onClick={() => setTab('tests')}>Tests{settings?.tests.length ? ` (${settings.tests.length})` : ''}</button>
            <button role="tab" aria-selected={tab === 'output'} onClick={() => setTab('output')}>Output</button>
          </div>
          {tab === 'tests'
            ? <Tests tests={settings?.tests ?? []} lastRun={state.lastRun} disabled={!connected} readOnly={!isInterviewer}
                onChange={tests => session.current?.updateSettings({ tests })} />
            : <Output report={state.lastRun} running={running} now={now} />}
        </section>
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Timer({ startedAt, now, disabled, canControl, onChange }:
  { startedAt: number | null; now: number; disabled: boolean; canControl: boolean; onChange(v: number | null): void }) {
  if (startedAt === null) {
    return canControl ? <button className="ghost" disabled={disabled} onClick={() => onChange(Date.now())}>Start timer</button> : null;
  }
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <span className="timer">
      <span aria-label="Interview time">{clock}</span>
      {canControl && <button className="ghost" disabled={disabled} onClick={() => onChange(null)}>Reset</button>}
    </span>
  );
}

function Tests({ tests, lastRun, disabled, readOnly, onChange }:
  { tests: TestCase[]; lastRun: RunReport | null; disabled: boolean; readOnly: boolean; onChange(t: TestCase[]): void }) {
  // Local draft while typing; saved to the room when a field loses focus. Remote changes replace it.
  const [draft, setDraft] = useState(tests);
  useEffect(() => setDraft(tests), [tests]);
  const edit = (i: number, field: keyof TestCase, value: string) => setDraft(d => d.map((t, k) => (k === i ? { ...t, [field]: value } : t)));
  const resultFor = (t: TestCase) => lastRun?.results.find(r => r.input === t.input && r.expected === t.expected);

  // The candidate sees the tests the interviewer wrote, and how each did on the last run.
  if (readOnly) {
    return (
      <div className="tests">
        {tests.length === 0 && <p className="empty">No tests yet. The interviewer adds them; Run still runs your code with no input.</p>}
        {tests.map((t, i) => {
          const r = resultFor(t);
          return (
            <div className="test read" key={i}>
              <Block label="Input" text={t.input || '(empty)'} />
              <Block label="Expected" text={t.expected || '(empty)'} />
              <div className="test-side">{r && <span className={`pill ${r.status}`}>{RESULT_TEXT[r.status]}</span>}</div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="tests">
      {draft.length === 0 && <p className="empty">No tests yet. Add one with an input and the output you expect, or load the example problem.</p>}
      {draft.map((t, i) => {
        const r = resultFor(t);
        return (
          <div className="test" key={i}>
            <label>Input<textarea value={t.input} disabled={disabled} rows={3} spellCheck={false}
              onChange={e => edit(i, 'input', e.target.value)} onBlur={() => onChange(draft)} /></label>
            <label>Expected output<textarea value={t.expected} disabled={disabled} rows={3} spellCheck={false}
              onChange={e => edit(i, 'expected', e.target.value)} onBlur={() => onChange(draft)} /></label>
            <div className="test-side">
              {r && <span className={`pill ${r.status}`}>{RESULT_TEXT[r.status]}</span>}
              <button className="ghost" disabled={disabled} onClick={() => onChange(draft.filter((_, k) => k !== i))}>Remove</button>
            </div>
          </div>
        );
      })}
      <button className="ghost add" disabled={disabled || draft.length >= 20} onClick={() => onChange([...draft, { input: '', expected: '' }])}>Add a test</button>
    </div>
  );
}

function Output({ report, running, now }: { report: RunReport | null; running: string | null; now: number }) {
  if (running) return <p className="empty">{running}…</p>;
  if (!report) return <p className="empty">Press Run (or Ctrl+Enter) to run the code. Everyone in the room sees the result.</p>;
  const graded = report.results.filter(r => r.expected !== null);
  const passed = graded.filter(r => r.status === 'passed').length;
  const label = LANGUAGES.find(l => l.id === report.language)?.label;
  const ago = Math.round((now - report.at) / 1000);
  const when = ago < 10 ? 'just now' : ago < 60 ? `${ago} s ago` : `${Math.round(ago / 60)} min ago`;
  return (
    <div className="output">
      <p className="summary">
        {report.by} ran the {label} code {when}.
        {graded.length > 0 && <strong className={passed === graded.length ? 'ok' : 'bad'}> {passed} of {graded.length} tests passed.</strong>}
      </p>
      {report.results.map((r, i) => (
        <div className="result" key={i}>
          {graded.length > 0 && <div className="result-head"><span className={`pill ${r.status}`}>{RESULT_TEXT[r.status]}</span><span>Test {i + 1}</span><span className="ms">{r.ms} ms</span></div>}
          {r.input && <Block label="Input" text={r.input} />}
          {r.expected !== null && r.status !== 'passed' && <Block label="Expected" text={r.expected} />}
          <Block label={r.expected === null ? 'Output' : 'Got'} text={r.output || (r.error ? '' : '(no output)')} />
          {r.error && <Block label="Error" text={r.error} error />}
        </div>
      ))}
    </div>
  );
}

const Block = ({ label, text, error }: { label: string; text: string; error?: boolean }) =>
  text ? <div className={`block${error ? ' error' : ''}`}><span>{label}</span><pre>{text}</pre></div> : null;
