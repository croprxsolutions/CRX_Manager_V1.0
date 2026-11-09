import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DatePicker as RacDatePicker,
  Label,
  Group,
  DateInput,
  DateSegment,
  Button,
  Popover,
  Dialog,
  Calendar,
  CalendarGrid,
  CalendarGridHeader,
  CalendarHeaderCell,
  CalendarGridBody,
  CalendarCell,
  Heading,
  Text,
  I18nProvider,
} from 'react-aria-components';
import { parseDate, today, type CalendarDate } from '@internationalized/date';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';

interface DatePreset {
  label: string;
  value: string; // 'YYYY-MM-DD'
}

interface DatePickerProps {
  label?: string;
  'aria-label'?: string;
  value: string | null; // 'YYYY-MM-DD'
  onChange: (value: string | null) => void;
  minValue?: string;
  helper?: ReactNode;
  error?: string;
  disabled?: boolean;
  presets?: DatePreset[];
}

// The business runs on Chicago time. Plain calendar days only: no JS Date ever touches the value.
const BUSINESS_TZ = 'America/Chicago';

// Anything that is not a plain YYYY-MM-DD day (empty, ISO timestamp, garbage) reads as no date instead of crashing.
function safeParse(v: string | null | undefined): CalendarDate | null {
  if (!v) return null;
  try {
    return parseDate(v);
  } catch {
    return null;
  }
}

const navBtn =
  'h-11 w-11 md:h-10 md:w-10 flex items-center justify-center rounded-full text-gray-500 hover:bg-crx-green-tint hover:text-nav-dark outline-none focus-visible:ring-2 focus-visible:ring-crx-green focus-visible:ring-offset-2';

export default function DatePicker({
  label,
  'aria-label': ariaLabel,
  value,
  onChange,
  minValue,
  helper,
  error,
  disabled,
  presets,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  // RAC's Group drops aria-invalid (it only sets data-invalid), so set it directly like Dropdown does.
  const groupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) groupRef.current?.setAttribute('aria-invalid', 'true');
    else groupRef.current?.removeAttribute('aria-invalid');
  }, [error]);

  const date = safeParse(value);
  const min = safeParse(minValue);
  const todayChicago = today(BUSINESS_TZ);
  const activePreset = presets?.find((p) => p.value === value);

  return (
    <I18nProvider locale="en-US">
    <RacDatePicker
      value={date}
      onChange={(d) => onChange(d ? d.toString() : null)}
      minValue={min ?? undefined}
      placeholderValue={todayChicago}
      granularity="day"
      isOpen={open}
      onOpenChange={setOpen}
      isDisabled={disabled}
      isInvalid={!!error}
      aria-label={label ? undefined : ariaLabel}
      className="w-full"
    >
      {label && <Label className="block text-sm font-medium text-secondary mb-1">{label}</Label>}
      <Group
        ref={groupRef}
        className={`
          h-11 md:h-10 w-full flex items-center gap-2 px-3 text-sm text-nav-dark bg-white
          border rounded-lg transition-colors duration-150
          focus-within:ring-2
          data-[disabled]:opacity-50 data-[disabled]:bg-gray-50
          ${error ? 'border-red-600 focus-within:ring-red-200 focus-within:border-red-600' : 'border-gray-300 focus-within:ring-crx-green/20 focus-within:border-crx-green'}
        `}
      >
        <Button
          className="shrink-0 -ml-1 h-11 w-11 md:h-8 md:w-8 flex items-center justify-center rounded-md text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green focus-visible:ring-offset-2"
        >
          <CalendarIcon className="h-4 w-4" aria-hidden="true" />
        </Button>
        <DateInput className="flex-1 min-w-0 flex items-center">
          {(segment) => (
            <DateSegment
              segment={segment}
              className="px-0.5 rounded outline-none tabular-nums data-[placeholder]:text-gray-500 data-[focused]:bg-crx-green data-[focused]:text-white"
            />
          )}
        </DateInput>
        {activePreset && (
          <span className="shrink-0 rounded-full bg-crx-green-light text-crx-green text-xs font-medium px-2">
            {activePreset.label}
          </span>
        )}
      </Group>
      <div className="min-h-5 mt-1 text-xs">
        {error ? (
          <Text slot="errorMessage" className="text-red-600">{error}</Text>
        ) : (
          helper && <Text slot="description" className="text-gray-500">{helper}</Text>
        )}
      </div>
      <Popover className="bg-white rounded-xl border border-gray-200 shadow-lg p-2 md:p-3 outline-none">
        <Dialog className="outline-none">
          {presets && presets.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {presets.map((p) => {
                const pd = safeParse(p.value);
                const blocked = !pd || !!(min && pd.compare(min) < 0);
                return (
                <button
                  key={p.value}
                  type="button"
                  disabled={blocked}
                  onClick={() => {
                    onChange(p.value);
                    setOpen(false);
                  }}
                  className={`h-11 md:h-10 px-2.5 rounded-full border text-xs font-medium outline-none disabled:text-gray-300 disabled:line-through disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green focus-visible:ring-offset-2 ${
                    p.value === value
                      ? 'border-crx-green bg-crx-green-light text-crx-green'
                      : 'border-gray-300 bg-white text-nav-dark'
                  }`}
                >
                  {p.label}
                </button>
                );
              })}
            </div>
          )}
          <Calendar>
            <header className="flex items-center justify-between mb-2">
              <Button slot="previous" aria-label="Previous month" className={navBtn}>
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Heading className="text-sm font-semibold text-nav-dark" />
              <Button slot="next" aria-label="Next month" className={navBtn}>
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </header>
            <CalendarGrid className="border-separate border-spacing-0.5">
              <CalendarGridHeader>
                {(day) => (
                  <CalendarHeaderCell className="text-xs font-normal text-secondary pb-1">{day}</CalendarHeaderCell>
                )}
              </CalendarGridHeader>
              <CalendarGridBody>
                {(d) => (
                  <CalendarCell
                    date={d}
                    className={`
                      h-11 w-11 md:h-10 md:w-10 flex items-center justify-center rounded-full text-sm text-nav-dark
                      cursor-pointer outline-none
                      data-[outside-month]:hidden
                      data-[hovered]:bg-crx-green-tint
                      data-[focus-visible]:ring-2 data-[focus-visible]:ring-crx-green data-[focus-visible]:ring-offset-1
                      data-[selected]:bg-crx-green data-[selected]:text-white data-[selected]:font-semibold
                      data-[disabled]:text-gray-300 data-[disabled]:line-through data-[disabled]:cursor-not-allowed data-[disabled]:hover:bg-transparent
                      ${d.compare(todayChicago) === 0 ? 'ring-1 ring-gray-400' : ''}
                    `}
                  />
                )}
              </CalendarGridBody>
            </CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </RacDatePicker>
    </I18nProvider>
  );
}
