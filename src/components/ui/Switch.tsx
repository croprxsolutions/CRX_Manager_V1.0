import { Switch as RACSwitch, Text } from 'react-aria-components';

interface SwitchProps {
  label: string;
  description?: string;
  isSelected: boolean;
  onChange: (value: boolean) => void;
  isDisabled?: boolean;
}

export default function Switch({ label, description, isSelected, onChange, isDisabled }: SwitchProps) {
  return (
    <RACSwitch
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
      className="group flex items-start gap-3 min-h-11 py-2 cursor-pointer outline-none data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
    >
      <span
        aria-hidden="true"
        className={`
          mt-0.5 flex h-6.5 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150
          group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-crx-green group-data-[focus-visible]:ring-offset-2
          ${isSelected ? 'bg-crx-green' : 'bg-gray-300'}
        `}
      >
        <span
          className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-150 ${
            isSelected ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </span>
      <span className="flex flex-col min-w-0">
        <Text slot="label" className="text-sm font-medium text-nav-dark">{label}</Text>
        {description && <Text slot="description" className="text-sm text-secondary">{description}</Text>}
      </span>
    </RACSwitch>
  );
}
