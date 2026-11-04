import { useEffect, useState } from 'react';
import { Landing } from './Landing';
import { Room } from './Room';
import { wakeServer } from './session';

const roomFromPath = () => location.pathname.match(/^\/r\/([\w-]{1,64})$/)?.[1] ?? null;

// The interviewer key for a room lives in this browser's localStorage. The browser that creates a room
// makes one; an interviewer link (/r/<room>#host=<key>) hands it to a co-interviewer.
const keyName = (room: string) => `duet:key:${room}`;
function takeKeyFromLink(room: string | null) {
  const key = location.hash.match(/^#host=([\w-]{16,64})$/)?.[1];
  if (room && key) {
    localStorage.setItem(keyName(room), key);
    history.replaceState(null, '', location.pathname); // keep the key out of the address bar
  }
}

export function App() {
  const [room, setRoom] = useState(() => { const r = roomFromPath(); takeKeyFromLink(r); return r; });
  const [name, setName] = useState(() => localStorage.getItem('duet:name') ?? '');
  const [entered, setEntered] = useState(false);
  const [asCandidate, setAsCandidate] = useState(false);
  useEffect(wakeServer, []);

  // Joining as a candidate simply leaves the interviewer key at home.
  const hostKey = room && !asCandidate ? localStorage.getItem(keyName(room)) : null;
  if (room && entered) return <Room room={room} name={name.trim()} hostKey={hostKey} />;

  const enter = (e: React.FormEvent, candidate = false) => {
    e.preventDefault();
    setAsCandidate(candidate);
    localStorage.setItem('duet:name', name);
    // Creating a room goes straight in, as its interviewer: change the URL without reloading.
    if (!room) {
      const id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem(keyName(id), crypto.randomUUID().replace(/-/g, ''));
      history.pushState(null, '', `/r/${id}`);
      setRoom(id);
    }
    setEntered(true);
  };
  const isHost = !!room && !!localStorage.getItem(keyName(room));
  return <Landing room={room} isHost={isHost} name={name} setName={setName} onEnter={enter} />;
}
