import React, { useEffect, useState } from 'react';
import type { CameraSlot, PlannedProgress, Pose } from '../hooks/useBridge.ts';

/**
 * The shots the plan knows for this camera, and the three things the room
 * does with them: drive one, store them all into the head, and tell the
 * bridge "the head is on this shot now" so the mounting error becomes an
 * offset. Numbers here are the plan's; the head's pose is what the bridge
 * last read, never assumed.
 */

interface Props {
  cam: CameraSlot;
  connected: boolean;
  pose?: Pose;
  progress?: PlannedProgress;
  onDrive: (presetNumber: number) => void;
  onStoreAll: () => void;
  onCalibrate: (presetNumber: number) => void;
  onClearOffset: () => void;
  onReadPose: () => void;
}

export function PlannedShots({ cam, connected, pose, progress, onDrive, onStoreAll, onCalibrate, onClearOffset, onReadPose }: Props) {
  const shots = cam.plan?.presets ?? [];
  const [calibrateFor, setCalibrateFor] = useState<number | null>(null);
  const [storeArmed, setStoreArmed] = useState(false);
  useEffect(() => {
    if (!storeArmed) return;
    const t = setTimeout(() => setStoreArmed(false), 5000);
    return () => clearTimeout(t);
  }, [storeArmed]);

  if (!cam.plan) return null;
  const offset = cam.config.poseOffset;
  const heading = cam.config.homeHeading ?? cam.plan.pan;
  const busy = progress && progress.step === 'driving' && Date.now() - progress.at < 10000;

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="headline" style={{ marginBottom: 8 }}>
        <span className="headline__kicker">Planned shots</span>
        <span className="headline__title">{cam.plan.label}</span>
        <span className="headline__meta">
          {heading !== undefined && <span>home heading {heading}°</span>}
          <span className={`chip ${offset ? 'chip--on' : ''}`} title="Mounting error measured on site">
            {offset ? `offset ${offset.pan}° / ${offset.tilt}°` : 'not calibrated'}
          </span>
        </span>
      </div>

      {shots.length === 0 && <p className="hint">The plan has no shots for this camera. Save some in the MultiCam Planner and export the camera list again.</p>}

      {shots.length > 0 && (
        <div className="site-list">
          {shots.map((s) => (
            <div key={s.number} className="site-item" style={{ gridTemplateColumns: '48px 1fr auto' }}>
              <span className="site-item__num">{s.number}</span>
              <span>
                <span className="site-item__name">{s.name || `Shot ${s.number}`}</span>
                <span className="site-item__meta"> · pan {s.pan}° · tilt {s.tilt}°{s.focalMm !== undefined ? ` · ${s.focalMm} mm` : ''}</span>
                {progress?.presetNumber === s.number && progress.step !== 'done' && (
                  <span className="site-item__meta"> · {progress.step}{progress.fit === 'linear' ? ' (zoom estimated)' : ''}</span>
                )}
              </span>
              <span className="row">
                <button className="btn btn--sm" disabled={!connected || !!busy} onClick={() => onDrive(s.number)} title="Drive the head to this planned shot">Drive</button>
                <button
                  className={`btn btn--sm ${calibrateFor === s.number ? 'armed' : ''}`}
                  disabled={!connected}
                  onClick={() => {
                    if (calibrateFor === s.number) { onCalibrate(s.number); setCalibrateFor(null); }
                    else setCalibrateFor(s.number);
                  }}
                  title="Steer the head onto this shot by hand, then click twice: the difference to the plan becomes the offset for every shot"
                >
                  {calibrateFor === s.number ? 'Head is here — confirm' : 'Head is here'}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className={`btn btn--sm ${storeArmed ? 'btn--primary' : ''}`}
          disabled={!connected || shots.length === 0 || !!busy}
          onClick={() => { if (storeArmed) { onStoreAll(); setStoreArmed(false); } else setStoreArmed(true); }}
          title="Drive every shot and store it in the head's preset memory, one after the other"
        >
          {storeArmed ? 'Store all in head — click again' : 'Store all in head'}
        </button>
        <button className="btn btn--sm" disabled={!connected} onClick={onReadPose}>Read pose</button>
        {offset && <button className="btn btn--sm" onClick={onClearOffset}>Clear offset</button>}
        <span style={{ flex: 1 }} />
        {pose && <span className="hint">head: pan {pose.pan}° · tilt {pose.tilt}°{pose.zoom !== undefined ? ` · zoom ${Math.round(pose.zoom * 100)} %` : ''}</span>}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        Shots are planned in the room frame; the bridge turns them into head angles using the home heading and the
        offset. Zoom from a focal length is exact at the ends of the range and estimated in between unless a zoom
        table was measured for this model. Once stored, any panel or Companion recalls them by number.
      </p>
    </div>
  );
}
