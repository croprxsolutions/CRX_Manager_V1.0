import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Pin, PinOff } from 'lucide-react';

interface SidebarLinkRowProps {
  to: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  /** Tailwind padding for the row, e.g. 'px-4 py-2 pl-10' for a link inside a group. */
  paddingClass: string;
  /** Icon-only rail: centred icon with a hover tooltip, no pin control. */
  collapsed?: boolean;
  onClick?: () => void;
  /** Shows the pin-to-top control beside the link. */
  pin?: { pinned: boolean; onToggle: () => void };
}

/**
 * One desktop sidebar link. The pin control is a sibling of the link, not inside
 * it, so it is its own tab stop: it appears on hover, or when the link or the
 * control has keyboard focus, and stays faintly visible on a pinned link.
 */
export default function SidebarLinkRow({ to, label, icon, active, paddingClass, collapsed, onClick, pin }: SidebarLinkRowProps) {
  const showPin = pin && !collapsed;
  return (
    <div className="group/row relative">
      <NavLink
        to={to}
        onClick={onClick}
        className={`group relative block transition-colors ${active ? 'text-white bg-white/5' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
      >
        <div className={`relative flex items-center gap-3 ${collapsed ? 'px-0 py-2.5 justify-center' : paddingClass} ${showPin ? 'pr-10' : ''}`}>
          {active && <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-crx-green-on-dark rounded-r" />}
          <span className={active ? 'text-crx-green-on-dark' : 'text-gray-400'}>{icon}</span>
          {!collapsed && <span className="text-sm font-medium whitespace-nowrap truncate">{label}</span>}
        </div>
        {collapsed && (
          <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 bg-gray-900 text-white text-xs rounded shadow-lg whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-[60]">
            {label}
          </div>
        )}
      </NavLink>
      {showPin && (
        <button
          type="button"
          onClick={pin.onToggle}
          aria-pressed={pin.pinned}
          aria-label={pin.pinned ? `Unpin ${label}` : `Pin ${label} to top`}
          title={pin.pinned ? 'Unpin' : 'Pin to top'}
          className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-gray-400 hover:text-white hover:bg-white/10 transition-opacity
            group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-crx-green-on-dark
            ${pin.pinned ? 'opacity-60' : 'opacity-0'}`}
        >
          {pin.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
        </button>
      )}
    </div>
  );
}
