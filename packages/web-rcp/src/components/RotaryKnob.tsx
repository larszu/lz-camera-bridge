import React, { useRef, useCallback, useState, useEffect } from 'react';

interface RotaryKnobProps {
  value: number;
  min?: number;
  max?: number;
  label: string;
  unit?: string;
  onChange: (value: number) => void;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  color?: 'default' | 'red' | 'green' | 'blue' | 'yellow';
  showValue?: boolean;
  detent?: number; // Center detent position
  editable?: boolean; // Allow clicking to edit value
  displayValue?: string; // Custom display value override
  /**
   * BEDARF 46 — dieser Wert wurde gesendet und nie zurueckgelesen.
   *
   * Der Regler bleibt bedienbar: er ist ja der einzige Weg, ihn zu setzen.
   * Nur die ANZEIGE sagt, dass die Zahl keine Auskunft ueber die Kamera ist.
   */
  unconfirmed?: boolean;
  /** Der Satz dazu, als Tooltip. Kommt aus `origin.ts`, nicht von hier. */
  unconfirmedTitle?: string;
  /**
   * BEDARF 102 — dieser Wert WAR bestaetigt und ist alt.
   *
   * Eine eigene, leisere Markierung neben `unconfirmed`: dort fehlt jede
   * Aussage ueber die Kamera, hier gab es eine. Beides gleich laut zu
   * zeichnen machte den Unterschied unsichtbar, um den es geht.
   */
  markClass?: string;
  markTitle?: string;
}

/**
 * Realistic Sony-style rotary potentiometer knob
 * Drag up/down or use scroll wheel to adjust
 */
export function RotaryKnob({
  value,
  min = 0,
  max = 255,
  label,
  unit = '',
  onChange,
  disabled = false,
  size = 'md',
  color = 'default',
  showValue = true,
  detent,
  editable = false,
  displayValue: displayValueProp,
  unconfirmed = false,
  unconfirmedTitle,
  markClass,
  markTitle,
}: RotaryKnobProps) {
  const knobRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const dragStartY = useRef(0);
  const dragStartValue = useRef(0);

  // Calculate rotation angle (270° range, from -135° to +135°)
  const range = max - min;
  const normalized = (value - min) / range;
  const angle = -135 + normalized * 270;

  // Size classes
  const sizeClass = {
    sm: 'rotary-knob--sm',
    md: 'rotary-knob--md',
    lg: 'rotary-knob--lg',
  }[size];

  // Handle mouse drag
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      setIsDragging(true);
      dragStartY.current = e.clientY;
      dragStartValue.current = value;
    },
    [disabled, value],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = dragStartY.current - e.clientY;
      const sensitivity = (max - min) / 150; // 150px = full range
      const newValue = Math.round(dragStartValue.current + deltaY * sensitivity);
      onChange(Math.max(min, Math.min(max, newValue)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, min, max, onChange]);

  // Handle scroll wheel
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (disabled) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -1 : 1;
      const step = Math.max(1, Math.round((max - min) / 100));
      const newValue = Math.max(min, Math.min(max, value + delta * step));
      onChange(newValue);
    },
    [disabled, value, min, max, onChange],
  );

  // Double-click to reset to center/detent
  const handleDoubleClick = useCallback(() => {
    if (disabled) return;
    if (detent !== undefined) {
      onChange(detent);
    } else {
      onChange(Math.round((min + max) / 2));
    }
  }, [disabled, detent, min, max, onChange]);

  // Format display value
  const displayValue = displayValueProp ?? (() => {
    if (detent !== undefined) {
      const delta = value - detent;
      if (delta === 0) return '0';
      return delta > 0 ? `+${delta}` : `${delta}`;
    }
    return `${value}${unit}`;
  })();

  // Handle click on value to edit
  const handleValueClick = useCallback(() => {
    if (disabled || !editable) return;
    setIsEditing(true);
    if (detent !== undefined) {
      setEditValue(String(value - detent));
    } else {
      setEditValue(String(value));
    }
    setTimeout(() => inputRef.current?.select(), 0);
  }, [disabled, editable, value, detent]);

  // Handle edit input change
  const handleEditChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  };

  // Handle edit submit
  const handleEditSubmit = () => {
    const parsed = parseInt(editValue, 10);
    if (!isNaN(parsed)) {
      let newValue: number;
      if (detent !== undefined) {
        newValue = detent + parsed;
      } else {
        newValue = parsed;
      }
      onChange(Math.max(min, Math.min(max, newValue)));
    }
    setIsEditing(false);
  };

  // Handle edit key events
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleEditSubmit();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  return (
    <div
      className={`rotary-knob ${sizeClass} rotary-knob--${color} ${disabled ? 'rotary-knob--disabled' : ''} ${isDragging ? 'rotary-knob--dragging' : ''}`}
    >
      <div className="rotary-knob__label">{label}</div>
      <div
        ref={knobRef}
        className="rotary-knob__body"
        onMouseDown={handleMouseDown}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
      >
        {/* Outer ring with scale marks */}
        <div className="rotary-knob__ring">
          {[...Array(11)].map((_, i) => (
            <div
              key={i}
              className="rotary-knob__tick"
              style={{ transform: `rotate(${-135 + i * 27}deg)` }}
            />
          ))}
        </div>
        {/* Knob cap */}
        <div
          className="rotary-knob__cap"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <div className="rotary-knob__indicator" />
          {/* Grip lines */}
          <div className="rotary-knob__grip">
            {[...Array(12)].map((_, i) => (
              <div key={i} className="rotary-knob__grip-line" />
            ))}
          </div>
        </div>
        {/* Center dot */}
        <div className="rotary-knob__center" />
      </div>
      {showValue && (
        isEditing ? (
          <input
            ref={inputRef}
            type="text"
            className="rotary-knob__input"
            value={editValue}
            onChange={handleEditChange}
            onBlur={handleEditSubmit}
            onKeyDown={handleEditKeyDown}
            autoFocus
          />
        ) : (
          <div 
            className={`rotary-knob__value ${editable ? 'rotary-knob__value--editable' : ''}${unconfirmed ? ' rcp-unconfirmed' : ''}${markClass ? ` ${markClass}` : ''}`}
            title={unconfirmed ? unconfirmedTitle : markTitle}
            onClick={handleValueClick}
          >
            {displayValue}
          </div>
        )
      )}
    </div>
  );
}
