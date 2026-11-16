import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import Tabs, { type TabItem } from './Tabs';

const tabs: TabItem[] = [
  { key: 'inventory', label: 'Inventory', content: <p>Inventory content</p>, count: 12 },
  { key: 'forecast', label: 'Forecast', content: <p>Forecast content</p>, count: 0 },
  { key: 'orders', label: 'Orders', content: <p>Orders content</p> },
];

function ControlledTabs() {
  const [activeKey, setActiveKey] = useState('inventory');

  return (
    <Tabs
      tabs={tabs}
      activeKey={activeKey}
      onChange={setActiveKey}
      ariaLabel="Inventory views"
    />
  );
}

describe('Tabs', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  });

  it('renders an accessible tab list and the active panel', () => {
    render(<ControlledTabs />);

    expect(screen.getByRole('tablist', { name: 'Inventory views' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: /Inventory/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Forecast/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Inventory content');
    expect(screen.queryByText('Forecast content')).not.toBeInTheDocument();
  });

  it('switches the selected tab and panel when clicked', () => {
    render(<ControlledTabs />);

    fireEvent.click(screen.getByRole('tab', { name: /Forecast/ }));

    expect(screen.getByRole('tab', { name: /Forecast/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Forecast content');
    expect(screen.queryByText('Inventory content')).not.toBeInTheDocument();
  });

  it('supports arrow keys plus Home and End with wrapping navigation', () => {
    render(<ControlledTabs />);

    const inventoryTab = screen.getByRole('tab', { name: /Inventory/ });
    inventoryTab.focus();

    fireEvent.keyDown(inventoryTab, { key: 'ArrowRight' });
    const forecastTab = screen.getByRole('tab', { name: /Forecast/ });
    expect(forecastTab).toHaveFocus();
    expect(forecastTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(forecastTab, { key: 'End' });
    const ordersTab = screen.getByRole('tab', { name: 'Orders' });
    expect(ordersTab).toHaveFocus();
    expect(ordersTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(ordersTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /Inventory/ })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('tab', { name: /Inventory/ }), { key: 'End' });
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Orders' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: /Inventory/ })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Inventory content');

    fireEvent.keyDown(screen.getByRole('tab', { name: /Inventory/ }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Orders' })).toHaveFocus();
  });

  it('renders optional count badges, including zero counts', () => {
    render(<ControlledTabs />);

    expect(within(screen.getByRole('tab', { name: /Inventory/ })).getByText('12')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /Forecast/ })).getByText('0')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: 'Orders' })).queryByText(/\d/)).not.toBeInTheDocument();
  });

  it('keeps mobile tabs on one touch-scrollable row with an edge-fade hint', () => {
    render(<ControlledTabs />);

    const tabList = screen.getByRole('tablist', { name: 'Inventory views' });
    expect(tabList).toHaveClass('flex-nowrap', 'overflow-x-auto', '[-webkit-overflow-scrolling:touch]');
    expect(tabList.parentElement).toHaveClass('relative');
    expect(tabList.parentElement?.querySelector('[aria-hidden="true"]')).toHaveClass(
      'bg-gradient-to-l',
      'md:hidden'
    );
  });

  describe('keeping the active tab in view', () => {
    const geometry = { offsetLeft: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft'), offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'), clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth') };
    const originalScrollTo = Element.prototype.scrollTo;
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    afterEach(() => {
      Element.prototype.scrollTo = originalScrollTo;
      Element.prototype.scrollIntoView = originalScrollIntoView;
      vi.unstubAllGlobals();
      for (const [name, proto] of [['offsetLeft', HTMLElement.prototype], ['offsetWidth', HTMLElement.prototype], ['clientWidth', Element.prototype]] as const) {
        const original = geometry[name];
        if (original) Object.defineProperty(proto, name, original); else delete (proto as unknown as Record<string, unknown>)[name];
      }
    });

    it('scrolls only the tab bar, sideways, and not again on a re-render with the same active tab', () => {
      // Three 200 px tabs in a 300 px bar.
      Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get() { return Array.from((this as HTMLElement).parentElement?.children ?? []).indexOf(this as HTMLElement) * 200; } });
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 200; } });
      Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get() { return 300; } });
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      const windowScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
      const barScroll = vi.fn();
      Element.prototype.scrollTo = barScroll;

      const { rerender } = render(<Tabs tabs={tabs} activeKey="inventory" onChange={() => {}} />);
      expect(barScroll).not.toHaveBeenCalled(); // already in view

      rerender(<Tabs tabs={tabs} activeKey="orders" onChange={() => {}} />);
      expect(barScroll).toHaveBeenCalledTimes(1);
      expect(barScroll).toHaveBeenLastCalledWith({ left: 316, behavior: 'smooth' });

      // A caller that builds a fresh tabs array on every render must not re-scroll.
      rerender(<Tabs tabs={[...tabs]} activeKey="orders" onChange={() => {}} />);
      rerender(<Tabs tabs={tabs.map((t) => ({ ...t }))} activeKey="orders" onChange={() => {}} />);
      expect(barScroll).toHaveBeenCalledTimes(1);

      // Never the page.
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(windowScroll).not.toHaveBeenCalled();
      windowScroll.mockRestore();
    });

    it('brings the active tab back into view when the bar shrinks without the tab changing', () => {
      let width = 700;
      Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get() { return Array.from((this as HTMLElement).parentElement?.children ?? []).indexOf(this as HTMLElement) * 200; } });
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 200; } });
      Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get() { return width; } });
      const barScroll = vi.fn();
      Element.prototype.scrollTo = barScroll;

      render(<Tabs tabs={tabs} activeKey="orders" onChange={() => {}} />);
      expect(barScroll).not.toHaveBeenCalled();
      width = 300;
      fireEvent(window, new Event('resize'));
      expect(barScroll).toHaveBeenCalledWith({ left: 316, behavior: 'smooth' });
    });

    it('brings the active tab back into view when only the bar shrinks (no window resize)', () => {
      let width = 700;
      Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get() { return Array.from((this as HTMLElement).parentElement?.children ?? []).indexOf(this as HTMLElement) * 200; } });
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 200; } });
      Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get() { return width; } });
      const barScroll = vi.fn();
      Element.prototype.scrollTo = barScroll;
      let onResize: (() => void) | undefined;
      const disconnect = vi.fn();
      vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { onResize = cb; } observe() {} disconnect() { disconnect(); } });

      const { unmount } = render(<Tabs tabs={tabs} activeKey="orders" onChange={() => {}} />);
      expect(barScroll).not.toHaveBeenCalled();
      width = 300; // e.g. a sidebar opened; the window did not resize
      onResize?.();
      expect(barScroll).toHaveBeenCalledWith({ left: 316, behavior: 'smooth' });
      unmount();
      expect(disconnect).toHaveBeenCalled();
    });
  });
});
