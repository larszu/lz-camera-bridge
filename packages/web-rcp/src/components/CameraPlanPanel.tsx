/**
 * Kamera-Plan aus dem MultiCam-Planner laden und gegen die Kameras am Bus
 * halten (B-41.1).
 *
 * Zwei Schritte, und der erste ist nicht optional: erst der Abgleich, dann das
 * Uebernehmen. Wer eine Kamera falsch beschriftet, schwenkt spaeter die
 * falsche — deshalb steht zu jeder Zuordnung, WOMIT sie belegt ist, und wo es
 * keinen Beleg gibt, steht der Grund statt einer Zuordnung.
 */
import React, { useState } from 'react';
import type { PlanMatchResult, PlanMatchedBy } from '../hooks/useBridge.ts';

interface Props {
  planMatch: PlanMatchResult | null;
  onMatch: (plan: string) => void;
  onApply: (plan: string) => void;
}

/** Wie stark ein Beleg ist, in Worten. Ein Vorschlag darf nicht wie ein Befund aussehen. */
const BELEG: Record<PlanMatchedBy, { text: string; klasse: string }> = {
  model: { text: 'Model measured', klasse: 'plan__badge--ok' },
  number: { text: 'Number in the name — proposal', klasse: 'plan__badge--weak' },
  manual: { text: 'By hand', klasse: 'plan__badge--manual' },
};

export function CameraPlanPanel({ planMatch, onMatch, onApply }: Props) {
  const [plan, setPlan] = useState<string | null>(null);
  const [dateiname, setDateiname] = useState('');
  const [uebernommen, setUebernommen] = useState(false);

  const waehlen = async (datei: File | undefined) => {
    if (!datei) return;
    setDateiname(datei.name);
    setUebernommen(false);
    setPlan(await datei.text());
  };

  const zugeordnet = planMatch?.matches.filter((m) => m.cameraNumber !== undefined) ?? [];
  const offen = planMatch?.matches.filter((m) => m.cameraNumber === undefined) ?? [];

  return (
    <div className="plan">
      <div className="plan__bar">
        <span className="plan__title">Kamera-Plan</span>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => void waehlen(e.target.files?.[0])}
        />
        {plan && (
          <button className="btn btn--sm" onClick={() => { setUebernommen(false); onMatch(plan); }}>
            Abgleichen
          </button>
        )}
        {/* Erst nach dem Abgleich, und nicht bloss ausgegraut: ein Knopf, der
            aussieht wie ein Knopf und nichts tut, ist die naechste Frage. */}
        {plan && planMatch && !uebernommen && (
          <button className="btn btn--sm btn--primary" onClick={() => { onApply(plan); setUebernommen(true); }}>
            Apply
          </button>
        )}
        {dateiname && <span className="plan__file">{dateiname}</span>}
      </div>

      {!planMatch && (
        <p className="plan__hint">
          Load the <code>camera-list</code> from the MultiCam planner. The match says which
          planned camera sits on which slot — and what the evidence for that is.
        </p>
      )}

      {planMatch && (
        <div className="plan__cols">
          <div>
            <h4 className="plan__h">Zugeordnet <span className="plan__count">{zugeordnet.length}</span></h4>
            {zugeordnet.length === 0 && <p className="plan__hint">None.</p>}
            <ul className="plan__list">
              {zugeordnet.map((m) => (
                <li key={m.planCameraId}>
                  <span className="plan__slot">Kamera {m.cameraNumber}</span>
                  <span className="plan__label">{m.label}</span>
                  {m.matchedBy && (
                    <span className={`plan__badge ${BELEG[m.matchedBy].klasse}`}>{BELEG[m.matchedBy].text}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="plan__h">Without evidence <span className="plan__count">{offen.length}</span></h4>
            {offen.length === 0 && <p className="plan__hint">None.</p>}
            <ul className="plan__list">
              {offen.map((m) => (
                <li key={m.planCameraId}>
                  <span className="plan__label">{m.label}</span>
                  <span className="plan__reason">{m.reason}</span>
                </li>
              ))}
            </ul>
            {planMatch.unmatchedSlots.length > 0 && (
              <p className="plan__hint">
                Ohne geplante Kamera am Bus: {planMatch.unmatchedSlots.map((n) => `Kamera ${n}`).join(', ')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
