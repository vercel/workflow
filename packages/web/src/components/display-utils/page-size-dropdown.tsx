import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface PageSizeDropdownProps {
  value: number;
  onChange: (value: number) => void;
  options?: number[];
}

export function PageSizeDropdown({
  value,
  onChange,
  options = [5, 10, 20, 50, 100],
}: PageSizeDropdownProps) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="h-9">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={String(option)}>
            <span className="pr-2">{option} / page</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
