import { useEffect, useRef, useState } from 'react';
import type { Peer } from '@duet/ot';
import { monaco } from './monaco';
import { RoomSession, wakeServer } from './session';

const roomFromPath = () => location.pathname.match(/^\/r\/([\w-]{1,64})$/)?.[1] ?? null;

export function App() {
  const room = roomFromPath();
  const [name, setName] = useState(() => localStorage.getItem('duet:name') ?? '');
  const [entered, setEntered] = useState(false);
  useEffect(wakeServer, []);

  if (room && entered) return <RoomPage room={room} name={name} />;

  const enter = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('duet:name', name);
    if (room) setEntered(true);
    else location.href = `/r/${Math.random().toString(36).slice(2, 10)}`;
  };

  return (
    <main className="landing">
      <h1>Duet</h1>
      <p>A live coding-interview room. Share the link, write code together.</p>
      <form onSubmit={enter}>
        <input autoFocus required maxLength={32} placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
        <button>{room ? `Join room ${room}` : 'Create a room'}</button>
      </form>
    </main>
  );
}

function RoomPage({ room, name }: { room: string; name: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [status, setStatus] = useState('connecting…');

  useEffect(() => {
    const editor = monaco.editor.create(host.current!, {
      language: 'javascript',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
    });
    const session = new RoomSession(editor, room, name, { peers: setPeers, status: setStatus });
    if (import.meta.env.DEV) Object.assign(window, { duet: { editor, session } }); // used by the e2e test
    return () => { session.close(); editor.dispose(); };
  }, [room, name]);

  return (
    <div className="room">
      <header>
        <strong>Duet</strong>
        <span className="room-id">room {room}</span>
        <button onClick={() => navigator.clipboard.writeText(location.href)}>Copy link</button>
        <span className="peers">
          <span className="peer">{name} (you)</span>
          {peers.map(p => <span key={p.id} className="peer" style={{ borderColor: p.color }}>{p.name}</span>)}
        </span>
        <span className="status">{status}</span>
      </header>
      <div className="editor" ref={host} />
    </div>
  );
}
