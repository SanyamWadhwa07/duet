// Connects one Monaco editor to a Duet room: local edits become ops, remote ops become editor edits,
// and remote cursors are drawn as decorations.
import { OpBuilder, OTClient, transformIndex, type ClientMsg, type Op, type Peer, type Selection, type ServerMsg, type SyncMode } from '@duet/ot';
import { monaco } from './monaco';

type Listeners = { peers(peers: Peer[]): void; status(status: string): void };

export class RoomSession {
  mode: SyncMode = 'ot';
  client: OTClient | null = null;
  private ws: WebSocket;
  private model: monaco.editor.ITextModel;
  private applyingRemote = false;
  private peers = new Map<string, Peer>();
  private cursors = new Map<string, Selection>(); // remote selections, as offsets into *our* copy
  private decorations: monaco.editor.IEditorDecorationsCollection;
  private disposables: monaco.IDisposable[] = [];
  private selTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSel = '';

  constructor(private editor: monaco.editor.IStandaloneCodeEditor, room: string, name: string, private on: Listeners) {
    this.model = editor.getModel()!;
    this.model.setEOL(monaco.editor.EndOfLineSequence.LF);
    this.decorations = editor.createDecorationsCollection();
    editor.updateOptions({ readOnly: true }); // until we have the server's copy

    this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws.onopen = () => this.send({ t: 'join', room, name });
    this.ws.onmessage = e => this.receive(JSON.parse(e.data));
    this.ws.onclose = () => { editor.updateOptions({ readOnly: true }); on.status('disconnected (reload to rejoin)'); };

    this.disposables.push(
      this.model.onDidChangeContent(e => this.onLocalChange(e)),
      editor.onDidChangeCursorSelection(() => this.scheduleSelection()),
    );
  }

  /** True when every local edit has been acknowledged by the server. */
  get synced() { return this.mode === 'naive' || (this.client?.synced ?? false); }

  close() {
    this.ws.close();
    clearTimeout(this.selTimer);
    this.disposables.forEach(d => d.dispose());
  }

  private send(msg: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private receive(msg: ServerMsg) {
    switch (msg.t) {
      case 'init':
        this.mode = msg.mode;
        this.replaceAll(msg.doc);
        this.client = new OTClient(msg.rev, (rev, op) => this.send({ t: 'op', rev, op }), op => this.applyRemote(op));
        msg.peers.forEach(p => this.peers.set(p.id, p));
        this.editor.updateOptions({ readOnly: false });
        this.on.peers([...this.peers.values()]);
        this.on.status(msg.mode === 'naive' ? 'connected (naive baseline mode)' : 'connected');
        return;
      case 'ack': return this.client!.ack();
      case 'op': return this.client!.remote(msg.op);
      case 'file': return this.replaceAll(msg.doc);
      case 'sel':
        this.cursors.set(msg.id, msg.sel);
        return this.renderCursors();
      case 'join':
        this.peers.set(msg.peer.id, msg.peer);
        return this.on.peers([...this.peers.values()]);
      case 'leave':
        this.peers.delete(msg.id);
        this.cursors.delete(msg.id);
        this.renderCursors();
        return this.on.peers([...this.peers.values()]);
      case 'error':
        return this.on.status(`error: ${msg.message}`);
    }
  }

  private onLocalChange(e: monaco.editor.IModelContentChangedEvent) {
    if (this.applyingRemote) return;
    if (this.mode === 'naive') return this.send({ t: 'file', doc: this.model.getValue() });
    const op = changesToOp(e.changes, this.model.getValueLength());
    this.shiftCursors(op);
    this.client!.local(op);
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
      edits.push({ range: this.range(index, index + del), text });
      index += del;
    }
    this.withRemote(() => this.model.applyEdits(edits));
    this.shiftCursors(op);
  }

  private replaceAll(text: string) {
    this.withRemote(() => this.model.applyEdits([{ range: this.model.getFullModelRange(), text }]));
  }

  private withRemote(fn: () => void) {
    this.applyingRemote = true;
    try { fn(); } finally { this.applyingRemote = false; }
  }

  private range(from: number, to: number) {
    return monaco.Range.fromPositions(this.model.getPositionAt(from), this.model.getPositionAt(to));
  }

  // --- presence -------------------------------------------------------------------------------

  /** Sends our selection at most every 50 ms, and only when it changed. */
  private scheduleSelection() {
    if (this.selTimer) return;
    this.selTimer = setTimeout(() => {
      this.selTimer = undefined;
      const s = this.editor.getSelection();
      if (!s) return;
      // getSelectionStart() is the anchor (where the drag began); getPosition() is the caret.
      const sel: Selection = [this.model.getOffsetAt(s.getSelectionStart()), this.model.getOffsetAt(s.getPosition())];
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
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const len = this.model.getValueLength();
    for (const [id, [anchor, head]] of this.cursors) {
      const peer = this.peers.get(id);
      if (!peer) continue;
      const cls = colorClass(peer.color);
      const at = Math.min(head, len);
      if (anchor !== head) {
        decorations.push({ range: this.range(Math.min(anchor, head, len), Math.min(Math.max(anchor, head), len)), options: { className: `${cls}-sel` } });
      }
      decorations.push({
        range: this.range(at, at),
        options: { beforeContentClassName: `${cls}-caret`, hoverMessage: { value: peer.name }, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      });
    }
    this.decorations.set(decorations);
  }
}

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
