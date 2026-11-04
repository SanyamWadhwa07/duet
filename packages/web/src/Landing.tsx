import { useEffect, useState } from 'react';
import { Mark } from './Mark';
import { recentRooms, type RecentRoom } from './session';

// The headline is typed by two carets taking turns, the way two people share a Duet room.
const LINES: [string, 'amber' | 'azure'][] = [['Two people, one editor,', 'amber'], [' every keystroke kept.', 'azure']];
const FULL = LINES.map(([t]) => t).join('');
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function TypedHeadline() {
  const [shown, setShown] = useState(() => (reducedMotion() ? FULL.length : 0));
  useEffect(() => {
    if (shown >= FULL.length) return;
    const timer = setTimeout(() => setShown(n => n + 1), shown === 0 ? 400 : 55);
    return () => clearTimeout(timer);
  }, [shown]);

  let used = 0;
  let caret: 'amber' | 'azure' = 'amber';
  const parts = LINES.map(([text, who]) => {
    const visible = text.slice(0, Math.max(0, shown - used));
    if (shown > used) caret = who;
    used += text.length;
    return visible;
  });
  // The invisible full line reserves the final height, so nothing below moves while it types.
  return (
    <h1 className="headline" aria-label={FULL}>
      <span className="reserve" aria-hidden="true">{LINES[0][0]}<br />{LINES[1][0].trim()}</span>
      <span className="typed" aria-hidden="true">
        {parts[0]}{parts[1] && <><br />{parts[1].trimStart()}</>}<span className={`caret ${caret}`} />
      </span>
    </h1>
  );
}

const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
};

/** Rooms this browser has been in, so a mock interview can be picked up again. Hidden when there are none. */
function YourRooms() {
  const [rooms, setRooms] = useState<RecentRoom[]>([]);
  useEffect(() => { recentRooms().then(setRooms, () => {}); }, []);
  if (!rooms.length) return null;
  return (
    <section className="your-rooms" aria-label="Your rooms">
      <h2>Your rooms</h2>
      <ul>
        {rooms.map(r => (
          <li key={r.room}>
            <a href={`/r/${r.room}`}>{r.title || 'Untitled room'}</a>
            <span>Room {r.room}, opened {ago(r.lastSeen)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Props = {
  room: string | null;
  /** True when this browser holds the room's interviewer key (it created the room, or got an interviewer link). */
  isHost: boolean;
  name: string;
  setName(n: string): void;
  onEnter(e: React.FormEvent, asCandidate?: boolean): void;
};

/** The front page, and the join screen when someone opens a room link. */
export function Landing({ room, isHost, name, setName, onEnter }: Props) {
  const form = (
    <form className="start" onSubmit={onEnter}>
      <label className="sr-only" htmlFor="name">Your name</label>
      <input id="name" autoFocus required maxLength={32} placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
      <button>{!room ? 'Start a room' : isHost ? 'Join as interviewer' : 'Join the room'}</button>
      {isHost && (
        <button type="button" className="secondary"
          onClick={e => { const f = e.currentTarget.form!; if (f.reportValidity()) onEnter(e, true); }}>
          Join as candidate
        </button>
      )}
    </form>
  );

  if (room) {
    return (
      <main className="paper join">
        <a className="brand" href="/"><Mark /> Duet</a>
        <h1 className="join-title">{isHost ? 'Rejoin your room.' : "You're invited to a coding room."}</h1>
        <p className="lede">
          {isHost
            ? "This browser created the room, so it joins as the interviewer. To see exactly what a candidate sees, join as a candidate instead."
            : "Enter your name so the others know who's typing."}
        </p>
        {form}
      </main>
    );
  }

  return (
    <main className="paper landing">
      <nav className="nav">
        <span className="brand"><Mark /> Duet</span>
        <a href="https://github.com/SanyamWadhwa07/duet">Source on GitHub</a>
      </nav>
      <TypedHeadline />
      <p className="lede">A free room for mock coding interviews. Share one link, write and run code together, and check it against test cases. No sign-up.</p>
      {form}
      <p className="hint">Joining someone else's room? Open the link they sent you.</p>
      <YourRooms />

      <ol className="steps">
        <li><strong>Start a room and send the link.</strong> Up to four people can join.</li>
        <li><strong>Write the problem and the code together.</strong> You see each other's cursor as you type.</li>
        <li><strong>Run it against test cases.</strong> JavaScript and Python run in the browser, and everyone sees the result.</li>
      </ol>

      <p className="proof">
        Duet keeps every keystroke because it syncs edits as small operations ordered by a server, not as whole-file copies.
        Measured over a real network with two people typing at once, sending the whole file lost 49% of keystrokes; Duet lost none.{' '}
        <a href="https://github.com/SanyamWadhwa07/duet/blob/main/docs/METRICS.md">How this was measured</a>
      </p>
    </main>
  );
}
