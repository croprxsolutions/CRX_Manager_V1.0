import { useEffect, useRef, type ReactNode } from 'react';
import {
  Select,
  Label,
  Button,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
  Text,
} from 'react-aria-components';
import { ChevronDown, Check } from 'lucide-react';

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface DropdownProps {
  label?: string;
  'aria-label'?: string;
  value: string | null;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  helper?: ReactNode;
  error?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export default function Dropdown({
  label,
  'aria-label': ariaLabel,
  value,
  onChange,
  options,
  placeholder = 'Select...',
  helper,
  error,
  disabled,
  size = 'md',
  className = '',
}: DropdownProps) {
  // RAC's Button drops aria-invalid (it only sets data-invalid on the Select root), so set it directly.
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (error) triggerRef.current?.setAttribute('aria-invalid', 'true');
    else triggerRef.current?.removeAttribute('aria-invalid');
  }, [error]);
  const height = size === 'sm' ? 'h-9' : 'h-11 md:h-10';
  return (
    <Select
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
      placeholder={placeholder}
      isDisabled={disabled}
      isInvalid={!!error}
      aria-label={label ? undefined : ariaLabel}
      disabledKeys={options.filter((o) => o.disabled).map((o) => o.value)}
      className={`w-full ${className}`}
    >
      {label && (
        <Label className="block text-sm font-medium text-secondary mb-1">{label}</Label>
      )}
      <Button
        ref={triggerRef}
        className={`
          ${height} w-full flex items-center justify-between gap-2 px-3 text-sm text-nav-dark bg-white
          border rounded-lg text-left focus:outline-none focus-visible:ring-2
          disabled:opacity-50 disabled:bg-gray-50
          transition-colors duration-150
          ${error ? 'border-red-600 focus-visible:ring-red-200 focus-visible:border-red-600 data-[pressed]:border-red-600' : 'border-gray-300 focus-visible:ring-crx-green/20 focus-visible:border-crx-green data-[pressed]:border-crx-green'}
        `}
      >
        <SelectValue className="truncate data-[placeholder]:text-gray-500" />
        <ChevronDown className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
      </Button>
      <div className="min-h-5 mt-1 text-xs">
        {error ? (
          <Text slot="errorMessage" className="text-red-600">{error}</Text>
        ) : (
          helper && <Text slot="description" className="text-gray-500">{helper}</Text>
        )}
      </div>
      <Popover className="min-w-(--trigger-width) bg-white rounded-xl border border-gray-200 shadow-lg p-1.5 outline-none">
        <ListBox className="outline-none max-h-72 overflow-auto">
          {options.map((o) => (
            <ListBoxItem
              key={o.value}
              id={o.value}
              textValue={o.label}
              className="group flex items-center justify-between gap-3 px-2.5 py-3 md:py-2.5 rounded-md text-sm text-nav-dark cursor-pointer outline-none data-[hovered]:bg-crx-green-tint data-[focused]:bg-crx-green-tint data-[selected]:text-crx-green data-[selected]:font-medium data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
            >
              <span className="flex flex-col min-w-0">
                <Text slot="label" className="truncate">{o.label}</Text>
                {o.description && (
                  <Text slot="description" className="text-xs font-normal text-gray-500">{o.description}</Text>
                )}
              </span>
              <Check className="h-4 w-4 shrink-0 hidden group-data-[selected]:block" aria-hidden="true" />
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}
