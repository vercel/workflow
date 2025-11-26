import { SiX } from '@icons-pack/react-simple-icons';
import { Button } from '../ui/button';

export const XButton = () => {
  return (
    <Button asChild size="icon-sm" type="button" variant="ghost">
      <a href="https://x.com/workflowdevkit" rel="noopener" target="_blank">
        <SiX className="size-4" />
      </a>
    </Button>
  );
};
