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
  useEffect(wakeServer, []);

  if (room && entered) return <Room room={room} name={name.trim()} hostKey={localStorage.getItem(keyName(room))} />;

  const enter = (e: React.FormEvent) => {
    e.preventDefault();
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
  return <Landing room={room} name={name} setName={setName} onEnter={enter} />;
}
