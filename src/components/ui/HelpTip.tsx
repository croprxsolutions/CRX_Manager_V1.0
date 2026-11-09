import { DialogTrigger, Button, Popover, Dialog } from 'react-aria-components';
import { Info } from 'lucide-react';

interface HelpTipProps {
  text: string;
  className?: string;
}

export default function HelpTip({ text, className = '' }: HelpTipProps) {
  return (
    <span className={`inline-flex items-center ${className}`}>
      <DialogTrigger>
        <Button
          aria-label="More info"
          className="relative inline-flex h-7 w-7 items-center justify-center rounded-full text-secondary transition-colors hover:text-crx-green data-[focus-visible]:text-crx-green outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-crx-green data-[focus-visible]:ring-offset-2 after:absolute after:-inset-2 after:content-['']"
        >
          <Info size={16} aria-hidden="true" />
        </Button>
        <Popover
          offset={8}
          className="bg-nav-dark text-white text-sm leading-relaxed max-w-xs rounded-lg px-3 py-2.5 shadow-lg"
        >
          <Dialog aria-label="Help" className="outline-none">
            {text}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </span>
  );
}
