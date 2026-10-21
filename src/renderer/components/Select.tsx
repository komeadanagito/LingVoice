import { useState, useRef, useEffect } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface Props {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function Select({ id, value, options, onChange, disabled, className = '', 'aria-label': ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const currentOption = options.find(opt => opt.value === value);
  const currentLabel = currentOption?.label ?? value;

  const handleSelect = (val: string, optDisabled?: boolean) => {
    if (optDisabled) return;
    setOpen(false);
    onChange(val);
  };

  return (
    <div className={`custom-select-wrapper ${className}${open ? ' is-open' : ''}`} ref={containerRef}>
      <button
        id={id ? `${id}-trigger` : undefined}
        type="button"
        className="custom-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(prev => !prev)}
      >
        <span className="current-value">{currentLabel}</span>
        <svg
          className={`chevron-icon${open ? ' rotated' : ''}`}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul className="custom-select-dropdown" role="listbox">
          {options.map(opt => {
            const selected = opt.value === value;
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={selected}
                aria-disabled={opt.disabled}
                className={`custom-select-option${selected ? ' selected' : ''}${opt.disabled ? ' disabled' : ''}`}
                onClick={() => handleSelect(opt.value, opt.disabled)}
              >
                <span>{opt.label}</span>
                {selected && (
                  <svg className="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Hidden native select for accessibility & automation testing */}
      <select
        id={id}
        className="sr-only"
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        tabIndex={-1}
        aria-hidden="true"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
