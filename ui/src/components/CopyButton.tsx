import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

/** Copies `text` and shows a check for a moment; `label` says what is copied. */
export function CopyButton({ text, label = 'Sao chép', size = 'icon-sm' }: { text: string; label?: string; size?: 'icon-sm' | 'sm' }) {
  const [done, setDone] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); };
  const icon = done ? <Check className="text-success" /> : <Copy />;
  return size === 'sm' ? <Button size="sm" onClick={copy}>{icon}{done ? 'Đã chép' : label}</Button>
    : <Tooltip label={done ? 'Đã chép' : label}><Button variant="ghost" size="icon-sm" aria-label={label} onClick={copy}>{icon}</Button></Tooltip>;
}
