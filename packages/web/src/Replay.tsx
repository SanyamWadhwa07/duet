// Plays back a saved session from its op log: the problem and the code as they were typed, and who typed what.
import { useEffect, useMemo, useRef, useState } from 'react';
import { apply, type History, type Op } from '@duet/ot';
import { monaco } from './monaco';
import { EDITOR, renderMarkdown } from './Room';
import { colorClass, opToEdits, roomHistory } from './session';
import { Mark } from './Mark';

/** A pause longer than this plays as this long, so the replay doesn't sit still while someone thinks. */
const MAX_PAUSE_MS = 2000;
const SPEEDS = [1, 4, 16];
/** People get the room's colours in the order they first typed. */
const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599'];
/** A jump longer than this rebuilds the text instead of replaying each edit in the editor. */
const MAX_STEPWISE = 200;

/** One edit on the shared timeline. `t` is its playback time in ms, with long pauses shortened. */
type Step = { doc: 'code' | 'problem'; at: number; by: string; op: Op; t: number };

/** Both documents' ops on one timeline in time order. Each document keeps its own order exactly. */
function timeline(h: History): Step[] {
  const merged: Omit<Step, 't'>[] = [];
  let i = 0, j = 0;
  while (i < h.code.length || j < h.problem.length) {
    const code = j >= h.problem.length || (i < h.code.length && h.code[i].at <= h.problem[j].at);
    merged.push(code ? { doc: 'code', ...h.code[i++] } : { doc: 'problem', ...h.problem[j++] });
  }
  let t = 0;
  return merged.map((s, k) => {
    if (k > 0) t += Math.min(MAX_PAUSE_MS, Math.max(0, s.at - merged[k - 1].at));
    return { ...s, t };
  });
}

/** Where an op leaves the typing position: after its last insert, or where its last delete was. */
function editEnd(op: Op) {
  let index = 0, end = 0;
  for (const c of op) {
    if (typeof c === 'string') { index += c.length; end = index; }
    else if (c > 0) index += c;
    else end = index;
  }
  return end;
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

export function Replay({ room }: { room: string }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const caret = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const [history, setHistory] = useState<History | null | undefined>(undefined); // undefined while loading
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState(0); // steps[0..pos) are shown
  const [problem, setProblem] = useState('');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const steps = useMemo(() => (history ? timeline(history) : []), [history]);
  const colorOf = useMemo(() => {
    const people = [...new Set(steps.map(s => s.by))];
    return (name: string) => COLORS[people.indexOf(name) % COLORS.length];
  }, [steps]);
  const shown = useRef({ pos: 0, problem: '' });
  const playClock = useRef(0);

  useEffect(() => {
    const ed = monaco.editor.create(host.current!, { ...EDITOR, readOnly: true, renderLineHighlight: 'none' });
    ed.getModel()!.setEOL(monaco.editor.EndOfLineSequence.LF); // offsets in ops count a newline as one character
    editor.current = ed;
    caret.current = ed.createDecorationsCollection();
    roomHistory(room).then(setHistory, e => setError((e as Error).message));
    if (import.meta.env.DEV) Object.assign(window, { duet: { editor: ed } }); // used by the e2e test
    return () => ed.dispose();
  }, [room]);

  useEffect(() => {
    if (history) monaco.editor.setModelLanguage(editor.current!.getModel()!, history.language);
    document.title = `Replay: ${history?.name || history?.title || 'session'}: Duet`;
  }, [history]);

  /** Shows the session after its first k edits. Small steps forward edit the editor; jumps rebuild the text. */
  const seek = (k: number) => {
    k = Math.max(0, Math.min(steps.length, k));
    const model = editor.current!.getModel()!;
    const from = shown.current;
    if (k >= from.pos && k - from.pos <= MAX_STEPWISE) {
      for (const s of steps.slice(from.pos, k)) {
        if (s.doc === 'code') model.applyEdits(opToEdits(model, s.op));
        else from.problem = apply(from.problem, s.op);
      }
    } else {
      const start = k >= from.pos ? from.pos : 0;
      let code = start ? model.getValue() : '';
      if (!start) from.problem = '';
      for (const s of steps.slice(start, k)) {
        if (s.doc === 'code') code = apply(code, s.op);
        else from.problem = apply(from.problem, s.op);
      }
      // Not setValue: on an empty text it resets the model to the platform's line ending (\r\n on Windows).
      model.applyEdits([{ range: model.getFullModelRange(), text: code }]);
    }
    from.pos = k;
    setProblem(from.problem);
    setPos(k);

    // A caret in the typist's colour where the code was last edited.
    let last = k - 1;
    while (last >= 0 && steps[last].doc !== 'code') last--;
    if (last < 0) return caret.current!.set([]);
    const at = model.getPositionAt(editEnd(steps[last].op));
    caret.current!.set([{
      range: monaco.Range.fromPositions(at, at),
      options: { beforeContentClassName: `${colorClass(colorOf(steps[last].by))}-caret`, hoverMessage: { value: steps[last].by } },
    }]);
    editor.current!.revealPositionInCenterIfOutsideViewport(at);
  };
  const seekRef = useRef(seek);
  seekRef.current = seek;

  /** Moves to edit k and puts the playback clock there. */
  const jump = (k: number) => {
    k = Math.max(0, Math.min(steps.length, k));
    seek(k);
    playClock.current = k > 0 ? steps[k - 1].t : 0;
  };
  // Opens on the finished session; Play starts from the beginning.
  useEffect(() => { if (steps.length) jump(steps.length); }, [steps]);

  const toggle = () => {
    if (playing) return setPlaying(false);
    if (pos >= steps.length) jump(0);
    setPlaying(true);
  };

  // Playback: a clock runs at `speed` and every edit whose time has come is shown.
  useEffect(() => {
    if (!playing) return;
    let frame = 0, last = performance.now();
    const tick = (now: number) => {
      playClock.current += (now - last) * speed;
      last = now;
      let k = shown.current.pos;
      while (k < steps.length && steps[k].t <= playClock.current) k++;
      if (k !== shown.current.pos) seekRef.current(k);
      if (k >= steps.length) return setPlaying(false);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, steps]);

  // Space plays and pauses; Home, End and the arrow keys move, as in a video player.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('select, textarea, button, .monaco-editor, input:not([type=range])')) return;
      if (e.key === ' ') { e.preventDefault(); return toggle(); }
      if (el.matches('input[type=range]')) return; // the scrubber handles its own keys
      const to = { Home: 0, End: steps.length, ArrowLeft: pos - 1, ArrowRight: pos + 1 }[e.key];
      if (to !== undefined) { e.preventDefault(); jump(to); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const problemHtml = useMemo(() => renderMarkdown(problem), [problem]);
  const message = error ? `Could not load this session: ${error}.`
    : history === undefined ? 'Loading the session.'
    : history === null ? "This session wasn't saved, so there is nothing to replay. Rooms are saved when the server has a database."
    : steps.length === 0 ? 'Nothing has been typed in this session yet.'
    : null;
  const ready = steps.length > 0;
  const current = pos > 0 ? steps[pos - 1] : null;
  const elapsed = current ? current.at - steps[0].at : 0;
  const total = ready ? steps[steps.length - 1].at - steps[0].at : 0;

  return (
    <div className="room replay">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Duet home"><Mark /> Duet</a>
        <span className="session-name">{history?.name || history?.title || 'Untitled session'}</span>
        <span className="badge neutral">Replay</span>
        <a className="ghost" href={`/r/${room}`}>Open the room</a>
      </header>

      <main className="panes">
        <section className="pane problem-pane" aria-label="Problem">
          <div className="pane-head"><h2>Problem</h2></div>
          <div className="editor-wrap">
            {problem
              ? <article className="markdown" dangerouslySetInnerHTML={{ __html: problemHtml }} />
              : <p className="placeholder">{ready ? 'No problem statement at this point in the session.' : ''}</p>}
          </div>
        </section>
        <section className="pane code-pane" aria-label="Code">
          <div className="editor-wrap">
            <div className="editor-host" ref={host} />
            {message && <p className="placeholder code">{message}</p>}
          </div>
        </section>
      </main>

      <footer className="player">
        <button className="run" onClick={toggle} disabled={!ready} title="Space">
          {playing ? 'Pause' : ready && pos >= steps.length ? 'Play from the start' : 'Play'}
        </button>
        <input type="range" aria-label="Position in the session" min={0} max={steps.length} value={pos}
          disabled={!ready} onChange={e => jump(Number(e.target.value))} />
        <span className="clock" aria-label="Time in the session">{clock(elapsed)} / {clock(total)}</span>
        <span className="typist">
          {current && <><span className="dot" style={{ background: colorOf(current.by) }} />{current.by}</>}
        </span>
        <div className="speeds" role="group" aria-label="Playback speed">
          {SPEEDS.map(s => (
            <button key={s} className="ghost" aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>
          ))}
        </div>
      </footer>
    </div>
  );
}
