import React, { useMemo, useState } from 'react';
import type {
  CameraSlot, MoveProgress, MoveStep, RecallMode, Seat, ShotMove, ShotRecalled, ShotRef, ShotSet, StudioShots,
} from '../hooks/useBridge.ts';
import type { CameraTally } from '../types.ts';

/**
 * Studio shots: shot sets (several cameras, one button, one move time), a
 * seating chart (a click takes the best free camera) and moves (shots of one
 * camera in a row). Each tab has one main action — the recall buttons —
 * and an optional editor behind "Edit". Nothing is mandatory: an empty
 * set, an empty seat or a move without steps is simply not recalled.
 *
 * Cut moves at the camera's top speed; fade is a timed move with ease-in/out.
 * A camera on programme is locked (per camera, default on) — the bridge
 * holds the recall back and the banner offers "Move anyway".
 */

type Tab = 'sets' | 'seats' | 'moves';
const TABS: { id: Tab; label: string }[] = [
  { id: 'sets', label: 'Shot sets' },
  { id: 'seats', label: 'Seats' },
  { id: 'moves', label: 'Moves' },
];

interface Props {
  shots: StudioShots;
  cameras: Record<number, CameraSlot>;
  cameraTally: CameraTally;
  moveProgress: Record<string, MoveProgress>;
  lastRecall: ShotRecalled | null;
  onChange: (shots: StudioShots) => void;
  onRecallSet: (id: string) => void;
  onRecallSeat: (id: string) => void;
  onPlayMove: (id: string) => void;
  onStopMove: (cameraNumber: number) => void;
  onSetCameraConfig: (cameraNumber: number, config: { tallyProtect: boolean }) => void;
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const sec = (ms: number | undefined) => (ms === undefined ? '' : String(Math.round(ms / 100) / 10));
const toMs = (text: string): number | undefined => {
  const n = Number(text.replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : undefined;
};

export function StudioShotsPanel(p: Props) {
  const [tab, setTab] = useState<Tab>('sets');
  const [editing, setEditing] = useState(false);
  const camNums = useMemo(() => Object.keys(p.cameras).map(Number).sort((a, b) => a - b), [p.cameras]);
  const onAir = (n: number) => p.cameraTally[n] === 'program';
  const camName = (n: number) => p.cameras[n]?.plan?.label ?? p.cameras[n]?.config.label ?? `CAM ${n}`;
  const { shots } = p;

  return (
    <div className="stack">
      <div className="headline">
        <span className="headline__kicker">Shots</span>
        <span className="headline__title">{TABS.find((t) => t.id === tab)?.label}</span>
        <span className="headline__meta">
          <ModeSwitch
            mode={shots.defaultMode}
            timeMs={shots.defaultTimeMs}
            onChange={(defaultMode, defaultTimeMs) => p.onChange({ ...shots, defaultMode, defaultTimeMs })}
          />
          <button className={`btn btn--sm ${editing ? 'btn--on' : ''}`} onClick={() => setEditing((e) => !e)} aria-pressed={editing}>
            {editing ? 'Done' : 'Edit'}
          </button>
        </span>
      </div>

      <div className="mode-tabs" role="tablist" style={{ gridTemplateColumns: `repeat(${TABS.length}, 1fr)` }}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`mode-tab ${tab === t.id ? 'mode-tab--active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {p.lastRecall?.note && Date.now() - p.lastRecall.at < 15000 && (
        <p className="hint">{camName(p.lastRecall.cameraNumber)}: {p.lastRecall.note}</p>
      )}

      {camNums.length === 0 && <div className="empty">No cameras yet. Shots refer to cameras on the bridge — add one first.</div>}

      {camNums.length > 0 && tab === 'sets' && (
        <SetsTab {...p} editing={editing} camNums={camNums} onAir={onAir} camName={camName} />
      )}
      {camNums.length > 0 && tab === 'seats' && (
        <SeatsTab {...p} editing={editing} camNums={camNums} camName={camName} />
      )}
      {camNums.length > 0 && tab === 'moves' && (
        <MovesTab {...p} editing={editing} camNums={camNums} onAir={onAir} camName={camName} />
      )}

      {camNums.length > 0 && (
        <div className="panel">
          <h2 className="panel__title">On-air lock</h2>
          <p className="hint" style={{ marginBottom: 8 }}>
            A locked camera does not move on a shot recall while it is on programme. The recall waits for “Move anyway”.
          </p>
          <div className="row">
            {camNums.map((n) => {
              const locked = p.cameras[n].config.tallyProtect !== false;
              return (
                <button
                  key={n}
                  className={`btn btn--sm ${locked ? 'btn--on' : ''}`}
                  aria-pressed={locked}
                  onClick={() => p.onSetCameraConfig(n, { tallyProtect: !locked })}
                  title={locked ? 'Locked while on air — click to unlock' : 'Moves even on air — click to lock'}
                >
                  {camName(n)} · {locked ? 'locked' : 'free'}
                  {onAir(n) && <span className="tile__tally tile__tally--program">PGM</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cut / fade ─────────────────────────────────────────────────────────────────

function ModeSwitch({ mode, timeMs, onChange }: { mode: RecallMode; timeMs: number; onChange: (m: RecallMode, t: number) => void }) {
  const [text, setText] = useState(sec(timeMs));
  return (
    <span className="row" role="group" aria-label="Recall mode">
      <button className={`btn btn--sm ${mode === 'cut' ? 'btn--on' : ''}`} aria-pressed={mode === 'cut'} onClick={() => onChange('cut', timeMs)} title="Move at the camera's top speed">
        Cut
      </button>
      <button className={`btn btn--sm ${mode === 'fade' ? 'btn--on' : ''}`} aria-pressed={mode === 'fade'} onClick={() => onChange('fade', timeMs)} title="Timed move with ease-in and ease-out">
        Fade
      </button>
      {mode === 'fade' && (
        <input
          className="select-group__select" style={{ width: 64, minHeight: 'var(--ziel)' }}
          value={text}
          inputMode="decimal"
          aria-label="Move time in seconds"
          title="Move time in seconds"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => { const ms = toMs(text); if (ms !== undefined) onChange(mode, ms); else setText(sec(timeMs)); }}
        />
      )}
      {mode === 'fade' && <span>s</span>}
    </span>
  );
}

// ── One shot reference: camera, head preset or planned shot, number ───────────

function ShotRefEditor({ value, camNums, cameras, camName, onChange, onRemove, lead, extra }: {
  value: ShotRef;
  camNums: number[];
  cameras: Record<number, CameraSlot>;
  camName: (n: number) => string;
  onChange: (v: ShotRef) => void;
  onRemove: () => void;
  /** Replaces the camera picker (a move has one camera for all steps). */
  lead?: React.ReactNode;
  /** More fields before "Remove". */
  extra?: React.ReactNode;
}) {
  const planned = cameras[value.cameraNumber]?.plan?.presets ?? [];
  const source = value.source ?? 'head';
  return (
    <div className={`shot-ref ${extra ? 'shot-ref--step' : ''}`}>
      {lead ?? (
        <select className="select-group__select" aria-label="Camera" value={value.cameraNumber} onChange={(e) => onChange({ ...value, cameraNumber: Number(e.target.value) })}>
          {camNums.map((n) => <option key={n} value={n}>{camName(n)}</option>)}
        </select>
      )}
      <select className="select-group__select" aria-label="Shot source" value={source} onChange={(e) => onChange({ ...value, source: e.target.value === 'plan' ? 'plan' : undefined })}>
        <option value="head">Head preset</option>
        <option value="plan" disabled={planned.length === 0}>Planned shot</option>
      </select>
      {source === 'plan' ? (
        <select className="select-group__select" aria-label="Planned shot" value={value.preset} onChange={(e) => onChange({ ...value, preset: Number(e.target.value) })}>
          {!planned.some((s) => s.number === value.preset) && <option value={value.preset}>—</option>}
          {planned.map((s) => <option key={s.number} value={s.number}>{s.number} · {s.name || `Shot ${s.number}`}</option>)}
        </select>
      ) : (
        <input
          className="select-group__select"
          aria-label="Preset number"
          inputMode="numeric"
          value={value.preset}
          onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0) onChange({ ...value, preset: n }); }}
        />
      )}
      {extra}
      <button className="btn btn--sm" onClick={onRemove} aria-label="Remove shot">Remove</button>
    </div>
  );
}

const firstShot = (camNums: number[]): ShotRef => ({ cameraNumber: camNums[0], preset: 1 });

// ── Shot sets ──────────────────────────────────────────────────────────────────

type TabProps = Props & { editing: boolean; camNums: number[]; camName: (n: number) => string; onAir?: (n: number) => boolean };

function SetsTab({ shots, cameras, editing, camNums, camName, onAir, onChange, onRecallSet }: TabProps) {
  const [editId, setEditId] = useState<string | null>(null);
  const edit = shots.sets.find((s) => s.id === editId) ?? null;
  const update = (set: ShotSet) => onChange({ ...shots, sets: shots.sets.map((s) => (s.id === set.id ? set : s)) });
  const add = () => {
    const set: ShotSet = { id: newId('set'), name: `Set ${shots.sets.length + 1}`, shots: [firstShot(camNums)] };
    onChange({ ...shots, sets: [...shots.sets, set] });
    setEditId(set.id);
  };

  return (
    <>
      {shots.sets.length === 0 && !editing && <div className="empty">No shot sets yet. “Edit” → “+ Set” puts several cameras on one button.</div>}
      <div className="shot-grid">
        {shots.sets.map((s) => {
          const live = s.shots.filter((r) => onAir?.(r.cameraNumber)).length;
          return (
            <button
              key={s.id}
              className={`shot-btn ${editing && editId === s.id ? 'shot-btn--edit' : ''}`}
              disabled={!editing && s.shots.length === 0}
              onClick={() => (editing ? setEditId(s.id) : onRecallSet(s.id))}
            >
              <span className="shot-btn__name">{s.name}</span>
              <span className="shot-btn__meta">
                {s.shots.map((r) => camName(r.cameraNumber)).join(' · ') || 'no shots'}
                {' · '}{(s.mode ?? shots.defaultMode) === 'cut' ? 'cut' : `${sec(s.timeMs ?? shots.defaultTimeMs)} s`}
                {live > 0 && <span className="tile__tally tile__tally--program">PGM</span>}
              </span>
            </button>
          );
        })}
        {editing && <button className="shot-btn" onClick={add}><span className="shot-btn__name">+ Set</span><span className="shot-btn__meta">several cameras, one button</span></button>}
      </div>

      {editing && edit && (
        <div className="panel stack">
          <div className="connection-row">
            <div className="field">
              <label htmlFor="set-name">Name</label>
              <input id="set-name" value={edit.name} onChange={(e) => update({ ...edit, name: e.target.value })} />
            </div>
            <div className="field field--sm">
              <label htmlFor="set-mode">Mode</label>
              <select id="set-mode" className="select-group__select" value={edit.mode ?? ''} onChange={(e) => update({ ...edit, mode: (e.target.value || undefined) as RecallMode | undefined })}>
                <option value="">Default</option>
                <option value="cut">Cut</option>
                <option value="fade">Fade</option>
              </select>
            </div>
            <div className="field field--sm">
              <label htmlFor="set-time">Time (s)</label>
              <input id="set-time" inputMode="decimal" placeholder={sec(shots.defaultTimeMs)} defaultValue={sec(edit.timeMs)} key={edit.id}
                onBlur={(e) => update({ ...edit, timeMs: toMs(e.target.value) })} />
            </div>
          </div>
          {edit.shots.map((r, i) => (
            <ShotRefEditor key={i} value={r} camNums={camNums} cameras={cameras} camName={camName}
              onChange={(v) => update({ ...edit, shots: edit.shots.map((x, j) => (j === i ? v : x)) })}
              onRemove={() => update({ ...edit, shots: edit.shots.filter((_, j) => j !== i) })} />
          ))}
          <div className="row">
            <button className="btn btn--sm" onClick={() => update({ ...edit, shots: [...edit.shots, firstShot(camNums.filter((n) => !edit.shots.some((r) => r.cameraNumber === n)).concat(camNums))] })}>+ Camera</button>
            <span style={{ flex: 1 }} />
            <button className="btn btn--sm btn--danger" onClick={() => { onChange({ ...shots, sets: shots.sets.filter((s) => s.id !== edit.id) }); setEditId(null); }}>Delete set</button>
          </div>
          <p className="hint">All cameras of a set start together and arrive together after the move time.</p>
        </div>
      )}
    </>
  );
}

// ── Seating chart ──────────────────────────────────────────────────────────────

function SeatsTab({ shots, cameras, editing, camNums, camName, onChange, onRecallSeat }: TabProps) {
  const [editKey, setEditKey] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const { rows, cols, seats } = shots.seats;
  const at = (r: number, c: number) => seats.find((s) => s.row === r && s.col === c);
  const edit = editKey ? seats.find((s) => s.id === editKey) ?? null : null;
  const setChart = (next: Partial<StudioShots['seats']>) => {
    const chart = { ...shots.seats, ...next };
    chart.seats = chart.seats.filter((s) => s.row < chart.rows && s.col < chart.cols);
    onChange({ ...shots, seats: chart });
  };
  const updateSeat = (seat: Seat) => setChart({ seats: seats.map((s) => (s.id === seat.id ? seat : s)) });
  const clickSeat = (r: number, c: number) => {
    const seat = at(r, c);
    if (!editing) {
      if (seat && seat.shots.length) { onRecallSeat(seat.id); setLast(seat.id); }
      return;
    }
    if (seat) { setEditKey(seat.id); return; }
    const fresh: Seat = { id: `r${r + 1}s${c + 1}`, row: r, col: c, shots: [firstShot(camNums)] };
    setChart({ seats: [...seats, fresh] });
    setEditKey(fresh.id);
  };

  return (
    <>
      {editing && (
        <div className="connection-row">
          <div className="field field--sm">
            <label htmlFor="seat-rows">Rows</label>
            <input id="seat-rows" type="number" min={0} max={40} value={rows} onChange={(e) => setChart({ rows: Math.max(0, Math.min(40, Number(e.target.value) || 0)) })} />
          </div>
          <div className="field field--sm">
            <label htmlFor="seat-cols">Seats per row</label>
            <input id="seat-cols" type="number" min={0} max={60} value={cols} onChange={(e) => setChart({ cols: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })} />
          </div>
        </div>
      )}
      {rows * cols === 0 ? (
        <div className="empty">No seating chart yet. “Edit” → rows and seats, then tap a seat to give it a shot per camera.</div>
      ) : (
        <div className="panel">
          <div className="stage-mark">Stage</div>
          <div className="seat-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(var(--ziel), 1fr))` }}>
            {Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
              const seat = at(r, c);
              const usable = Boolean(seat?.shots.length);
              const cls = ['seat', !usable && 'seat--empty', editing && seat && seat.id === editKey && 'seat--edit', !editing && seat && seat.id === last && 'seat--last'].filter(Boolean).join(' ');
              return (
                <button key={`${r}:${c}`} className={cls} onClick={() => clickSeat(r, c)} disabled={!editing && !usable}
                  title={seat ? `${seat.label ?? `Row ${r + 1}, seat ${c + 1}`}: ${seat.shots.map((s) => camName(s.cameraNumber)).join(', ') || 'no shot'}` : `Row ${r + 1}, seat ${c + 1}`}>
                  {seat?.label ?? `${r + 1}·${c + 1}`}
                </button>
              );
            }))}
          </div>
        </div>
      )}
      {editing && edit && (
        <div className="panel stack">
          <div className="connection-row">
            <div className="field">
              <label htmlFor="seat-label">Name (optional)</label>
              <input id="seat-label" value={edit.label ?? ''} placeholder={`Row ${edit.row + 1}, seat ${edit.col + 1}`} onChange={(e) => updateSeat({ ...edit, label: e.target.value || undefined })} />
            </div>
          </div>
          <p className="hint">Best camera first. A tap takes the first one that is connected and not on air.</p>
          {edit.shots.map((r, i) => (
            <ShotRefEditor key={i} value={r} camNums={camNums} cameras={cameras} camName={camName}
              onChange={(v) => updateSeat({ ...edit, shots: edit.shots.map((x, j) => (j === i ? v : x)) })}
              onRemove={() => updateSeat({ ...edit, shots: edit.shots.filter((_, j) => j !== i) })} />
          ))}
          <div className="row">
            <button className="btn btn--sm" onClick={() => updateSeat({ ...edit, shots: [...edit.shots, firstShot(camNums.filter((n) => !edit.shots.some((r) => r.cameraNumber === n)).concat(camNums))] })}>+ Camera</button>
            <span style={{ flex: 1 }} />
            <button className="btn btn--sm btn--danger" onClick={() => { setChart({ seats: seats.filter((s) => s.id !== edit.id) }); setEditKey(null); }}>Clear seat</button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Moves: shots of one camera in a row ────────────────────────────────────────

function MovesTab({ shots, cameras, editing, camNums, camName, onAir, moveProgress, onChange, onPlayMove, onStopMove }: TabProps) {
  const [editId, setEditId] = useState<string | null>(null);
  const edit = shots.moves.find((m) => m.id === editId) ?? null;
  const update = (m: ShotMove) => onChange({ ...shots, moves: shots.moves.map((x) => (x.id === m.id ? m : x)) });
  const add = () => {
    const m: ShotMove = { id: newId('move'), name: `Move ${shots.moves.length + 1}`, cameraNumber: camNums[0], steps: [{ preset: 1 }, { preset: 2 }] };
    onChange({ ...shots, moves: [...shots.moves, m] });
    setEditId(m.id);
  };
  const setStep = (m: ShotMove, i: number, s: MoveStep) => update({ ...m, steps: m.steps.map((x, j) => (j === i ? s : x)) });

  return (
    <>
      {shots.moves.length === 0 && !editing && <div className="empty">No moves yet. A move plays shots of one camera in a row, each with its own time — “Edit” → “+ Move”.</div>}
      <div className="shot-grid">
        {shots.moves.map((m) => {
          const prog = moveProgress[m.id];
          const playing = prog?.state === 'playing';
          return (
            <button
              key={m.id}
              className={`shot-btn ${editing && editId === m.id ? 'shot-btn--edit' : ''}`}
              disabled={!editing && m.steps.length === 0}
              onClick={() => (editing ? setEditId(m.id) : playing ? onStopMove(m.cameraNumber) : onPlayMove(m.id))}
            >
              <span className="shot-btn__name">{playing ? `Stop · ${m.name}` : m.name}</span>
              <span className="shot-btn__meta">
                {camName(m.cameraNumber)} · {m.steps.length} steps
                {prog && <span> · {prog.state === 'playing' ? `step ${prog.step}/${prog.of}` : prog.state}</span>}
                {onAir?.(m.cameraNumber) && <span className="tile__tally tile__tally--program">PGM</span>}
              </span>
            </button>
          );
        })}
        {editing && <button className="shot-btn" onClick={add}><span className="shot-btn__name">+ Move</span><span className="shot-btn__meta">shots of one camera in a row</span></button>}
      </div>

      {editing && edit && (
        <div className="panel stack">
          <div className="connection-row">
            <div className="field">
              <label htmlFor="move-name">Name</label>
              <input id="move-name" value={edit.name} onChange={(e) => update({ ...edit, name: e.target.value })} />
            </div>
            <div className="field field--sm">
              <label htmlFor="move-cam">Camera</label>
              <select id="move-cam" className="select-group__select" value={edit.cameraNumber} onChange={(e) => update({ ...edit, cameraNumber: Number(e.target.value) })}>
                {camNums.map((n) => <option key={n} value={n}>{camName(n)}</option>)}
              </select>
            </div>
          </div>
          {edit.steps.map((s, i) => (
            <ShotRefEditor
              key={`${edit.id}:${i}`}
              value={{ cameraNumber: edit.cameraNumber, preset: s.preset, source: s.source }}
              camNums={camNums} cameras={cameras} camName={camName}
              lead={<span className="site-item__num shot-ref__lead">Step {i + 1}</span>}
              extra={<>
                <input className="select-group__select" inputMode="decimal" aria-label={`Move time of step ${i + 1} in seconds`} title="Move time (s)"
                  placeholder={`${sec(shots.defaultTimeMs)} s`} defaultValue={sec(s.timeMs)} onBlur={(e) => setStep(edit, i, { ...s, timeMs: toMs(e.target.value) })} />
                <input className="select-group__select" inputMode="decimal" aria-label={`Hold after step ${i + 1} in seconds`} title="Hold (s)"
                  placeholder="hold s" defaultValue={sec(s.holdMs)} onBlur={(e) => setStep(edit, i, { ...s, holdMs: toMs(e.target.value) || undefined })} />
              </>}
              onChange={(v) => setStep(edit, i, { ...s, preset: v.preset, source: v.source })}
              onRemove={() => update({ ...edit, steps: edit.steps.filter((_, j) => j !== i) })}
            />
          ))}
          <div className="row">
            <button className="btn btn--sm" onClick={() => update({ ...edit, steps: [...edit.steps, { preset: (edit.steps.at(-1)?.preset ?? 0) + 1, source: edit.steps.at(-1)?.source }] })}>+ Step</button>
            <span style={{ flex: 1 }} />
            <button className="btn btn--sm btn--danger" onClick={() => { onChange({ ...shots, moves: shots.moves.filter((m) => m.id !== edit.id) }); setEditId(null); }}>Delete move</button>
          </div>
          <p className="hint">Each step: the shot, its move time and an optional hold, in seconds. Each step is an eased move from wherever the camera is to that shot. Any joystick touch stops the move.</p>
        </div>
      )}
    </>
  );
}
