import {
  CalendarClock, ClipboardCheck, FileText, LayoutGrid, MoreHorizontal, Navigation, Receipt, Sprout, Truck, Users, Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { hasPageAccess } from '../../lib/pagePermissions';
import type { UserRole } from '../../types';

interface MobileBottomNavProps {
  onMoreClick: () => void;
  moreOpen: boolean;
}

interface BottomNavItem {
  label: string;
  path: string;
  pageKey: string;
  icon: LucideIcon;
}

// Each role gets the screens it opens all day; everything else stays one tap away under More.
// Labels are the role's own side-menu names (Sidebar.tsx), shortened where a phone button is narrow.
const OFFICE_NAV_ITEMS: BottomNavItem[] = [
  { label: 'Today', path: '/office-cockpit', pageKey: 'office-cockpit', icon: LayoutGrid },
  { label: 'Jobs', path: '/jobs', pageKey: 'jobs', icon: CalendarClock },
  { label: 'Inventory', path: '/inventory', pageKey: 'inventory', icon: Warehouse },
  { label: 'Field Invoices', path: '/field-invoices', pageKey: 'field-invoices', icon: Receipt },
];

const SALES_REP_NAV_ITEMS: BottomNavItem[] = [
  { label: 'Today', path: '/office-cockpit', pageKey: 'office-cockpit', icon: LayoutGrid },
  { label: 'Quotes', path: '/quotes', pageKey: 'quotes', icon: FileText },
  { label: 'Customers', path: '/customers', pageKey: 'customers', icon: Users },
];

const APPLICATOR_NAV_ITEMS: BottomNavItem[] = [
  { label: 'My Day', path: '/field', pageKey: 'field', icon: Sprout },
  { label: 'My Jobs', path: '/jobs', pageKey: 'jobs', icon: CalendarClock },
  { label: 'Record Book', path: '/application-records', pageKey: 'application-records', icon: ClipboardCheck },
];

const DRIVER_NAV_ITEMS: BottomNavItem[] = [
  { label: 'My Route', path: '/my-route', pageKey: 'my-route', icon: Navigation },
  { label: 'Deliveries', path: '/deliveries', pageKey: 'deliveries', icon: Truck },
];

function navItemsForRole(role: UserRole | null): BottomNavItem[] {
  if (role === 'driver') return DRIVER_NAV_ITEMS;
  if (role === 'applicator') return APPLICATOR_NAV_ITEMS;
  if (role === 'sales_rep') return SALES_REP_NAV_ITEMS;
  return OFFICE_NAV_ITEMS;
}

function isRouteActive(pathname: string, path: string, pageKey: string): boolean {
  if (pageKey === 'field-invoices' && pathname.startsWith('/invoices/field-app')) return true;
  return pathname === path || pathname.startsWith(`${path}/`);
}

export default function MobileBottomNav({ onMoreClick, moreOpen }: MobileBottomNavProps) {
  const { profile, deniedPages } = useAuth();
  const location = useLocation();
  const role = profile?.role ?? null;
  const visibleItems = navItemsForRole(role).filter((item) => hasPageAccess(role, deniedPages, item.pageKey));

  return (
    <nav
      aria-label="Mobile primary navigation"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-gray-200 bg-cream/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_4px_rgba(0,0,0,0.08)] backdrop-blur md:hidden"
    >
      {visibleItems.map(({ label, path, pageKey, icon: Icon }) => {
        const active = isRouteActive(location.pathname, path, pageKey);

        return (
          <Link
            key={path}
            to={path}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition-colors ${
              active ? 'text-crx-green' : 'text-secondary hover:text-nav-dark'
            }`}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMoreClick}
        aria-label="Open navigation menu"
        aria-expanded={moreOpen}
        aria-controls="mobile-navigation-drawer"
        className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition-colors ${
          moreOpen ? 'text-crx-green' : 'text-secondary hover:text-nav-dark'
        }`}
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
        <span>More</span>
      </button>
    </nav>
  );
}
