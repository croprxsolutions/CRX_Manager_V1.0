import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

interface ComboboxProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  className?: string;
}

export default function Combobox({
  label,
  value,
  onChange,
  options,
  placeholder = '',
  disabled = false,
  error = '',
  className = '',
}: ComboboxProps) {
  const generatedId = useId();
  const inputId = label?.toLowerCase().replace(/\s+/g, '-') || `combobox-${generatedId}`;
  const listboxId = `${inputId}-listbox`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [scrollVersion, setScrollVersion] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const valueBeforeTypingRef = useRef<string | null>(null);
  const pendingScrollIndexRef = useRef<number | null>(null);

  const filtered = query === null
    ? options
    : options.filter((option) => option.toLowerCase().includes(query.toLowerCase()));
  const listIsRendered = open && filtered.length > 0 && !disabled;

  const requestScroll = useCallback((index: number) => {
    pendingScrollIndexRef.current = index;
    setScrollVersion((version) => version + 1);
  }, []);

  const openDropdown = useCallback(() => {
    if (disabled) return;

    const savedIndex = options.findIndex(
      (option) => option.toLowerCase() === value.toLowerCase()
    );
    valueBeforeTypingRef.current = null;
    setQuery(null);
    setHighlightIndex(savedIndex);
    setOpen(true);
    if (savedIndex >= 0) {
      requestScroll(savedIndex);
    } else {
      pendingScrollIndexRef.current = null;
    }
  }, [disabled, options, requestScroll, value]);

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setQuery(null);
    setHighlightIndex(-1);
    valueBeforeTypingRef.current = null;
    pendingScrollIndexRef.current = null;
  }, []);

  // Close on outside click.
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [closeDropdown]);

  // Scroll only for opening and keyboard movement, after the option is rendered.
  useLayoutEffect(() => {
    if (!listIsRendered || pendingScrollIndexRef.current === null) return;
    const item = listRef.current?.children[pendingScrollIndexRef.current] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
    pendingScrollIndexRef.current = null;
  }, [listIsRendered, scrollVersion]);

  const selectOption = useCallback(
    (option: string) => {
      onChange(option);
      closeDropdown();
    },
    [closeDropdown, onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      openDropdown();
      return;
    }
    if (!open) return;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        if (filtered.length === 0) break;
        const nextIndex = highlightIndex < filtered.length - 1 ? highlightIndex + 1 : 0;
        setHighlightIndex(nextIndex);
        requestScroll(nextIndex);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        if (filtered.length === 0) break;
        const nextIndex = highlightIndex > 0 ? highlightIndex - 1 : filtered.length - 1;
        setHighlightIndex(nextIndex);
        requestScroll(nextIndex);
        break;
      }
      case 'Enter':
        e.preventDefault();
        if (highlightIndex >= 0 && highlightIndex < filtered.length) {
          selectOption(filtered[highlightIndex]);
        } else {
          closeDropdown();
        }
        break;
      case 'Escape': {
        e.preventDefault();
        e.stopPropagation();
        const valueToRestore = valueBeforeTypingRef.current;
        const shouldRestoreValue = query !== null;
        closeDropdown();
        if (shouldRestoreValue && valueToRestore !== null) {
          onChange(valueToRestore);
        }
        break;
      }
      case 'Tab':
        closeDropdown();
        break;
    }
  };

  return (
    <div className="w-full" ref={wrapperRef}>
      {label && (
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-secondary mb-1"
        >
          {label}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(e) => {
            if (disabled) return;
            if (!open) openDropdown();
            if (query === null) valueBeforeTypingRef.current = value;
            setQuery(e.target.value);
            setHighlightIndex(-1);
            onChange(e.target.value);
          }}
          onFocus={() => {
            if (!disabled && !open) openDropdown();
          }}
          onClick={() => {
            if (!disabled && !open) openDropdown();
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          className={`
            w-full px-3 py-2 text-sm text-nav-dark bg-white
            border border-gray-200 rounded-lg
            placeholder:text-gray-400
            focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green
            disabled:opacity-50 disabled:bg-gray-50
            transition-colors duration-150
            ${error ? 'border-red-400 focus:ring-red-200 focus:border-red-400' : ''}
            ${className}
          `}
          role="combobox"
          aria-expanded={listIsRendered}
          aria-autocomplete="list"
          aria-controls={listIsRendered ? listboxId : undefined}
          aria-activedescendant={
            listIsRendered && highlightIndex >= 0 && highlightIndex < filtered.length
              ? `${inputId}-option-${highlightIndex}`
              : undefined
          }
        />

        {/* Dropdown chevron */}
        <svg
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>

        {listIsRendered && (
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            className="absolute z-30 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto"
          >
            {filtered.map((option, index) => {
              const isSavedOption = option.toLowerCase() === value.toLowerCase();
              const isHighlighted = index === highlightIndex;

              return (
                <li
                  key={option}
                  id={`${inputId}-option-${index}`}
                  role="option"
                  aria-selected={isSavedOption}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent blur before selection
                    selectOption(option);
                  }}
                  onMouseEnter={() => setHighlightIndex(index)}
                  className={`
                    w-full text-left px-3 py-2 text-sm cursor-pointer
                    ${isHighlighted
                      ? 'bg-crx-green/10 text-crx-green font-medium'
                      : 'text-nav-dark hover:bg-gray-50'}
                    ${isSavedOption ? 'font-medium' : ''}
                  `}
                >
                  {option}
                  {isSavedOption && <Check className="inline-block h-4 w-4 ml-2" aria-hidden="true" />}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
