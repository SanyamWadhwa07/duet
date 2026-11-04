// Connects the browser to a Duet room: the code and the problem statement are two Monaco models kept
// in sync with OT; presence (who is here, where their cursor is), settings and run reports ride along.
import {
  OpBuilder, OTClient, transformIndex,
  type ClientMsg, type Op, type Peer, type RoomSettings, type RunReport, type Selection, type ServerMsg, type SyncMode,
} from '@duet/ot';
import { monaco } from './monaco';

export type Status = 'connecting' | 'waking' | 'connected' | 'reconnecting' | 'full';
export type RoomState = {
  status: Status;
  you: string;
  peers: Peer[];
  settings: RoomSettings | null;
  lastRun: RunReport | null;
  notice: string | null;
};
type Listener = (patch: Partial<RoomState>) => void;

// In production the front end (Vercel) and the WebSocket server (Render) are on different hosts,
// so the build is given the server's address. In development Vite proxies /ws on the same origin.
const WS_URL: string = import.meta.env.VITE_WS_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const serverHttp = (path: string) => WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, path);

/** Starts waking a sleeping server (free hosting tiers) while the visitor is still typing their name. */
export function wakeServer() {
  fetch(serverHttp('/health'), { mode: 'no-cors' }).catch(() => {});
}

/** A random id for this browser, kept in localStorage, so the server can list "Your rooms" without an account. */
export function browserId() {
  let id = localStorage.getItem('duet:user');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('duet:user', id);
  }
  return id;
}

export type RecentRoom = { room: string; title: string; lastSeen: string };
/** The rooms this browser has been in, newest first. Empty if the server keeps no history. */
export async function recentRooms(): Promise<RecentRoom[]> {
  const res = await fetch(serverHttp(`/api/recent?user=${encodeURIComponent(browserId())}`));
  return res.ok ? res.json() : [];
}

/** Keeps one Monaco model in sync with one server document. */
class DocBinding {
  client: OTClient | null = null;
  /** Called with every op applied to the model, local or remote. */
  onOp: (op: Op) => void = () => {};
  /** Naive baseline mode: send the whole text instead of an op. */
  sendWhole: ((text: string) => void) | null = null;
  private applyingRemote = false;
  private listener: monaco.IDisposable;

  constructor(readonly model: monaco.editor.ITextModel, private send: (rev: number, op: Op) => void) {
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    this.listener = model.onDidChangeContent(e => this.onLocalChange(e));
  }

  get synced() { return this.client?.synced ?? false; }
  /** True if an edit was sent and not yet acknowledged. */
  get pending() { return this.client !== null && !this.client.synced; }

  /** Starts over from the server's copy (on join, and again after a reconnect). */
  reset(revision: number, text: string) {
    this.replaceAll(text);
    this.client = new OTClient(revision, this.send, op => this.applyRemote(op));
  }

  replaceAll(text: string) {
    this.withRemote(() => this.model.applyEdits([{ range: this.model.getFullModelRange(), text }]));
  }

  dispose() { this.listener.dispose(); }

  private onLocalChange(e: monaco.editor.IModelContentChangedEvent) {
    if (this.applyingRemote || !this.client) return;
    if (this.sendWhole) return this.sendWhole(this.model.getValue());
    const op = changesToOp(e.changes, this.model.getValueLength());
    this.onOp(op);
    this.client.local(op);
  }

  /** Applies a remote op to Monaco as one batch of edits, all positioned against the current text. */
  private applyRemote(op: Op) {
    const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
    let index = 0;
    for (let i = 0; i < op.length; i++) {
      const c = op[i];
      if (typeof c === 'number' && c > 0) { index += c; continue; }
      let text = '', del = 0;
      if (typeof c === 'string') {
        text = c;
        const next = op[i + 1];
        if (typeof next === 'number' && next < 0) { del = -next; i++; } // insert + delete here = one replace
      } else del = -c;
      edits.push({ range: rangeOf(this.model, index, index + del), text });
      index += del;
    }
    this.withRemote(() => this.model.applyEdits(edits));
    this.onOp(op);
  }

  private withRemote(fn: () => void) {
    this.applyingRemote = true;
    try { fn(); } finally { this.applyingRemote = false; }
  }
}

export class RoomSession {
  mode: SyncMode = 'ot';
  readonly code: DocBinding;
  readonly problem: DocBinding;
  private ws: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private peers = new Map<string, Peer>();
  private cursors = new Map<string, Selection>(); // remote selections, as offsets into *our* copy of the code
  private decorations: monaco.editor.IEditorDecorationsCollection;
  private selListener: monaco.IDisposable;
  private selTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSel = '';

  constructor(
    private editor: monaco.editor.IStandaloneCodeEditor,
    private problemEditor: monaco.editor.IStandaloneCodeEditor,
    private room: string,
    private name: string,
    private on: Listener,
  ) {
    this.code = new DocBinding(editor.getModel()!, (rev, op) => this.send({ t: 'op', rev, op }));
    this.problem = new DocBinding(problemEditor.getModel()!, (rev, op) => this.send({ t: 'op', doc: 'problem', rev, op }));
    this.code.onOp = op => this.shiftCursors(op);
    this.decorations = editor.createDecorationsCollection();
    this.selListener = editor.onDidChangeCursorSelection(() => this.scheduleSelection());
    this.connect();
  }

  /** True when every local edit has been acknowledged by the server. */
  get synced() { return this.mode === 'naive' || (this.code.synced && this.problem.synced); }

  updateSettings(settings: Partial<RoomSettings>) { this.send({ t: 'settings', settings }); }
  shareRun(report: Pick<RunReport, 'language' | 'results'>) { this.send({ t: 'run', report }); }

  close() {
    this.closed = true;
    this.ws?.close();
    clearTimeout(this.selTimer);
    clearTimeout(this.wakeTimer);
    this.selListener.dispose();
    this.code.dispose();
    this.problem.dispose();
  }

  /**
   * Opens the socket and joins. If it drops, rejoins with backoff (1, 2, 4, 8, 10 s...) and starts again
   * from the server's copy. A free-tier server can take up to a minute to wake, so after 3 s without an
   * answer the status says so instead of a bare "connecting".
   */
  private connect() {
    this.setEditable(false);
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    this.wakeTimer = setTimeout(() => this.on({ status: 'waking' }), 3000);
    ws.onopen = () => this.send({ t: 'join', room: this.room, name: this.name, user: browserId() });
    ws.onmessage = e => this.receive(JSON.parse(e.data));
    ws.onclose = () => {
      clearTimeout(this.wakeTimer);
      if (this.closed) return;
      this.setEditable(false);
      this.on({ status: 'reconnecting' });
      setTimeout(() => this.connect(), Math.min(10_000, 1000 * 2 ** this.attempts++));
    };
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private receive(msg: ServerMsg) {
    switch (msg.t) {
      case 'init': {
        const lost = this.code.pending || this.problem.pending;
        clearTimeout(this.wakeTimer);
        this.attempts = 0;
        this.mode = msg.mode;
        this.code.sendWhole = msg.mode === 'naive' ? doc => this.send({ t: 'file', doc }) : null;
        this.code.reset(msg.rev, msg.doc);
        this.problem.reset(msg.problem.rev, msg.problem.doc);
        this.peers = new Map(msg.peers.map(p => [p.id, p]));
        this.cursors.clear();
        this.renderCursors();
        this.setEditable(true);
        this.on({
          status: 'connected', you: msg.you, peers: [...this.peers.values()], settings: msg.settings, lastRun: msg.lastRun,
          notice: lost ? 'Reconnected. Your last few keystrokes before the connection dropped were not saved.' : null,
        });
        return;
      }
      case 'ack': return (msg.doc === 'problem' ? this.problem : this.code).client!.ack();
      case 'op': return (msg.doc === 'problem' ? this.problem : this.code).client!.remote(msg.op);
      case 'file': return this.code.replaceAll(msg.doc);
      case 'settings': return this.on({ settings: msg.settings });
      case 'run': return this.on({ lastRun: msg.report });
      case 'sel':
        this.cursors.set(msg.id, msg.sel);
        return this.renderCursors();
      case 'join':
        this.peers.set(msg.peer.id, msg.peer);
        return this.on({ peers: [...this.peers.values()] });
      case 'leave':
        this.peers.delete(msg.id);
        this.cursors.delete(msg.id);
        this.renderCursors();
        return this.on({ peers: [...this.peers.values()] });
      case 'error':
        // A full room is final; any other error means our copy went wrong, and the reconnect fixes it.
        if (/full/.test(msg.message)) { this.closed = true; this.on({ status: 'full' }); }
        return;
    }
  }

  private setEditable(editable: boolean) {
    this.editor.updateOptions({ readOnly: !editable });
    this.problemEditor.updateOptions({ readOnly: !editable });
  }

  // --- presence (code editor only) ---------------------------------------------------------------

  /** Sends our selection at most every 50 ms, and only when it changed. */
  private scheduleSelection() {
    if (this.selTimer) return;
    this.selTimer = setTimeout(() => {
      this.selTimer = undefined;
      const s = this.editor.getSelection();
      if (!s) return;
      const model = this.code.model;
      // getSelectionStart() is the anchor (where the drag began); getPosition() is the caret.
      const sel: Selection = [model.getOffsetAt(s.getSelectionStart()), model.getOffsetAt(s.getPosition())];
      const key = sel.join();
      if (key !== this.lastSel) { this.lastSel = key; this.send({ t: 'sel', sel }); }
    }, 50);
  }

  /** Keeps remote cursors on the same text when the document changes under them. */
  private shiftCursors(op: Op) {
    for (const [id, [anchor, head]] of this.cursors) {
      this.cursors.set(id, [transformIndex(anchor, op), transformIndex(head, op)]);
    }
    this.renderCursors();
  }

  private renderCursors() {
    const model = this.code.model;
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const len = model.getValueLength();
    for (const [id, [anchor, head]] of this.cursors) {
      const peer = this.peers.get(id);
      if (!peer) continue;
      const cls = colorClass(peer.color);
      const at = Math.min(head, len);
      if (anchor !== head) {
        decorations.push({ range: rangeOf(model, Math.min(anchor, head, len), Math.min(Math.max(anchor, head), len)), options: { className: `${cls}-sel` } });
      }
      decorations.push({
        range: rangeOf(model, at, at),
        options: { beforeContentClassName: `${cls}-caret`, hoverMessage: { value: peer.name }, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      });
    }
    this.decorations.set(decorations);
  }
}

const rangeOf = (model: monaco.editor.ITextModel, from: number, to: number) =>
  monaco.Range.fromPositions(model.getPositionAt(from), model.getPositionAt(to));

/**
 * Turns one Monaco change event into one op. All ranges in an event refer to the text *before*
 * the event (Monaco lists multi-cursor changes so they can be applied end-to-start).
 */
export function changesToOp(changes: readonly monaco.editor.IModelContentChange[], newLength: number): Op {
  const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
  let oldLength = newLength;
  for (const c of sorted) oldLength += c.rangeLength - c.text.length;
  const b = new OpBuilder();
  let pos = 0;
  for (const c of sorted) {
    b.retain(c.rangeOffset - pos).insert(c.text).delete(c.rangeLength);
    pos = c.rangeOffset + c.rangeLength;
  }
  return b.retain(oldLength - pos).op;
}

/** One CSS class per peer colour, created the first time the colour is seen. */
const styled = new Set<string>();
function colorClass(color: string) {
  const cls = `peer-${color.replace(/[^\w]/g, '')}`;
  if (!styled.has(cls)) {
    styled.add(cls);
    const style = document.createElement('style');
    style.textContent = `.${cls}-caret{border-left:2px solid ${color};margin-left:-1px}.${cls}-sel{background:${color}33}`;
    document.head.appendChild(style);
  }
  return cls;
}
