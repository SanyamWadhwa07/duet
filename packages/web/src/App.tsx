import { useEffect, useState } from 'react';
import { Landing } from './Landing';
import { Room } from './Room';
import { wakeServer } from './session';

const roomFromPath = () => location.pathname.match(/^\/r\/([\w-]{1,64})$/)?.[1] ?? null;

export function App() {
  const [room, setRoom] = useState(roomFromPath);
  const [name, setName] = useState(() => localStorage.getItem('duet:name') ?? '');
  const [entered, setEntered] = useState(false);
  useEffect(wakeServer, []);

  if (room && entered) return <Room room={room} name={name.trim()} />;

  const enter = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('duet:name', name);
    // Creating a room goes straight in: change the URL without reloading, so the name isn't asked twice.
    if (!room) {
      const id = Math.random().toString(36).slice(2, 10);
      history.pushState(null, '', `/r/${id}`);
      setRoom(id);
    }
    setEntered(true);
  };
  return <Landing room={room} name={name} setName={setName} onEnter={enter} />;
}
