## LZ Camera Bridge

Bitfocus Companion module for LZ Camera Bridge: paint, PTZ and robotic heads,
soft presets, studio shots (cut/fade, shot sets, seats, moves, on-air lock),
panorama aim and the switcher.

### Connection

Start the bridge first. The module holds two connections:

| Setting | Default | Carries |
|---|---|---|
| HTTP port | 9702 | paint commands (relative +/- buttons), global tally |
| WebSocket port | 9701 | paint state, global tally |
| Control port | 9700 | the panel's own port: camera list, presets, head moves, studio shots, moves, aim, switcher |

Without the control port the studio, preset, head and aim buttons do nothing
and the log says so. The feedback *Bridge control link connected* shows it on a
button.

Camera dropdowns list the cameras on the bridge (with their labels). Until the
bridge has sent its list, *Camera Targets* from the configuration is used.
Shot sets, seats and moves are dropdowns from the bridge's studio shots; set
them up in the panel (view *Shots*) — the module follows when they change.

### Actions

- **Paint** — Iris/Gain/Black/Gamma/Saturation/ND +/- (relative: the bridge
  trims from the value it read and refuses when it has none), Detail +/-,
  *Paint: set value* (absolute), *white / black balance (R, G, B)*, one-shot
  functions (AWB, ABB, auto focus, home …), auto iris / recording on/off,
  bars and power.
- **Head** — pan/tilt in eight directions (press; stop on release), zoom,
  focus and elevation column as speed moves with a stop, zoom to a position,
  read pose.
- **Presets** — recall with move time (0 = stored) and *ignore on-air lock*;
  store (on a head that reports its pose the bridge keeps the pose for the
  soft recall); move time and *Soft* on/off/toggle per preset.
- **Studio** — recall shot (preset in the head or planned shot; cut, fade or
  the default; move time), recall shot set, recall seat, play move, stop move
  (one camera or every running move), *move anyway* (resends the recall the
  on-air lock held back, with force), dismiss held recall, on-air lock
  on/off/toggle per camera, default move time (set/+/-) and mode (cut/fade/toggle).
- **Aim** — go to a region of the panorama map (percent of the map), scan
  panorama, measure field of view, cancel.
- **Mixer** — preview / take / cut on a switcher of the bridge.
- **Tally** — global program/preview/clear (as before).

A toggle needs a confirmed state: when the bridge has not reported it, the
toggle does nothing and logs why — use On/Off.

### Feedbacks

Bridge reachable, control link connected, camera connected (any / this one),
camera on programme / preview (mixer tally), on-air lock on, recall held by
the on-air lock (any camera or one), move running (any or one), shot set
active (every camera of the set was last recalled to its shot), shot / preset
active, panorama scan / FOV measurement running, global tally and *tally state
unconfirmed*.

### Variables

Per camera on the bridge (`camN_…`): `label`, `connected`, `tally`
(program/preview/off/unknown), `on_air_lock`, `shot` (last recalled; `P` =
planned shot), `shot_mode`, `move_time`, `pan`, `tilt`, `zoom`, `job`.
Global: `control_connected`, `default_move_time`, `default_mode`,
`held_label`, `held_cameras`, `active_set`, `move_running`, `last_error`, the
paint values of the default camera and the global tally.

Pan/tilt/zoom are filled by *Head: read pose*, by aim moves, or — with *Pose
Poll Interval* above 0 — by reading every connected camera that often.

### Presets (button pages)

- *Studio: shot sets / seats / moves* — one button per set, seat and move on
  the bridge, with active/held/running feedbacks; *Studio: control* — move
  anyway, dismiss, default move time +/-, mode toggle.
- Per camera: *head* (pan/tilt, zoom, focus, column, AF, home, pose, stop
  move), *presets* (recall 1–8 with the default mode, cut 1–8), *store
  presets*, *on air* (lock toggle, mixer tally), *aim* (scan, measure, cancel,
  centre region).
- *Paint (default camera)*, *Tally*, *Mixer*, *Status*.

The pages are built from the bridge's lists: after adding cameras, sets,
seats or moves, open the presets again.

### Not verified

Loaded in Companion 5.0.5 against a bridge with demo cameras (connection,
dropdowns, variables and button pages); the actions themselves are tested
against the bridge outside Companion. Not tried on real heads.

If the connection to the bridge drops while a pan/tilt, zoom, focus or column
button is held, the bridge stops that axis itself.
