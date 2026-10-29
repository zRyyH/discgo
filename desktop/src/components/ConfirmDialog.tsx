import * as Dialog from '@radix-ui/react-dialog';
import { Button } from './ui';

export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  text: string;
  confirm: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg-2 p-6 shadow-popover">
          <Dialog.Title className="text-title font-semibold">{props.title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-body text-text-2">{props.text}</Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost">Cancelar</Button>
            </Dialog.Close>
            <Button
              variant="danger"
              onClick={() => {
                props.onConfirm();
                props.onOpenChange(false);
              }}
            >
              {props.confirm}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
