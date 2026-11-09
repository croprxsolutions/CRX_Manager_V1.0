import type { ReactNode } from 'react';
import {
  MenuTrigger,
  Menu,
  MenuItem,
  MenuSection,
  Header,
  Separator,
  Popover,
  Button,
  Text,
} from 'react-aria-components';
import { MoreHorizontal, ChevronDown } from 'lucide-react';

export type ActionMenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  onAction: () => void;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  group?: string;
};

interface ActionMenuProps {
  label: string;
  items: ActionMenuItem[];
  trigger?: 'icon' | { text: string; variant: 'primary' | 'secondary'; icon?: ReactNode };
}

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green focus-visible:ring-offset-2';

function Item({ item }: { item: ActionMenuItem }) {
  return (
    <MenuItem
      id={item.id}
      textValue={item.label}
      isDisabled={item.disabled}
      onAction={item.onAction}
      className={`flex items-center gap-2.5 px-2.5 py-3 md:py-2.5 rounded-md text-sm cursor-pointer outline-none data-[hovered]:bg-crx-green-tint data-[focused]:bg-crx-green-tint data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed ${
        item.danger ? 'text-red-700 font-medium' : 'text-nav-dark'
      }`}
    >
      {item.icon && <span className="h-4 w-4 shrink-0 flex items-center justify-center" aria-hidden="true">{item.icon}</span>}
      <span className="flex flex-col min-w-0">
        <Text slot="label">{item.label}</Text>
        {item.disabled && item.disabledReason && (
          <Text slot="description" className="text-xs font-normal text-secondary">{item.disabledReason}</Text>
        )}
      </span>
    </MenuItem>
  );
}

export default function ActionMenu({ label, items, trigger = 'icon' }: ActionMenuProps) {
  const plain = items.filter((i) => !i.danger && !i.group);
  const danger = items.filter((i) => i.danger);
  const groups = new Map<string, ActionMenuItem[]>();
  for (const i of items) {
    if (i.danger || !i.group) continue;
    groups.set(i.group, [...(groups.get(i.group) ?? []), i]);
  }

  return (
    <MenuTrigger>
      {trigger === 'icon' ? (
        <Button
          aria-label={label}
          className={`h-11 w-11 md:h-10 md:w-10 inline-flex items-center justify-center rounded-lg bg-white text-nav-dark border border-gray-300 hover:bg-gray-50 data-[pressed]:bg-gray-100 transition-colors duration-150 ${focusRing}`}
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </Button>
      ) : (
        <Button
          aria-label={label}
          className={`h-11 md:h-10 inline-flex items-center justify-center gap-2 px-4 text-sm font-medium rounded-lg transition-colors duration-150 ${focusRing} ${
            trigger.variant === 'primary'
              ? 'bg-crx-green text-white hover:bg-crx-green-hover data-[pressed]:bg-crx-green-hover shadow-sm'
              : 'bg-white text-nav-dark border border-gray-300 hover:bg-gray-50 data-[pressed]:bg-gray-100'
          }`}
        >
          {trigger.icon}
          <span>{trigger.text}</span>
          <span className="h-5 w-px bg-current opacity-30" aria-hidden="true" />
          <ChevronDown size={16} aria-hidden="true" />
        </Button>
      )}
      <Popover
        placement="bottom end"
        className="min-w-60 bg-white rounded-xl border border-gray-200 shadow-lg p-1.5 outline-none"
      >
        <Menu className="outline-none max-h-80 overflow-auto">
          {plain.map((i) => <Item key={i.id} item={i} />)}
          {[...groups].map(([name, list]) => (
            <MenuSection key={name}>
              <Header className="px-2.5 pt-2 pb-1 text-xs text-secondary">{name}</Header>
              {list.map((i) => <Item key={i.id} item={i} />)}
            </MenuSection>
          ))}
          {danger.length > 0 && (plain.length > 0 || groups.size > 0) && (
            <Separator className="h-px bg-gray-100 my-1.5" />
          )}
          {danger.map((i) => <Item key={i.id} item={i} />)}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
