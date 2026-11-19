import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";

export function ComputerStopMenu({
  botId,
  visible,
  disabled,
  onStopped,
}: {
  botId: string;
  visible: boolean;
  disabled: boolean;
  onStopped: (status: ComputerStatus) => void;
}) {
  const { t } = useLingui();
  const [confirming, setConfirming] = useState(false);
  const queries = useSpaceQueries();
  const stop = useSave({
    save: (_input: undefined, rpc) => rpc.computer.stop({ botId }),
    stale: [queries.computer.status.queryKey({ input: { botId } })],
    onSaved: (status) => {
      setConfirming(false);
      onStopped(status);
    },
  });

  return (
    <>
      {visible ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t`Computer actions`}
              />
            }
          >
            <MoreHorizontal size={16} strokeWidth={1.8} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              disabled={disabled || stop.pending}
              onClick={() => {
                stop.reset();
                setConfirming(true);
              }}
            >
              <Trans>Stop computer</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        title={<Trans>Stop computer?</Trans>}
        description={<Trans>The workspace will be saved. Running programs will close.</Trans>}
        error={stop.error ? errorText(stop.error, t`Could not stop computer`) : null}
        busy={stop.pending}
        confirmDisabled={disabled || !visible}
        onConfirm={() => stop.run(undefined)}
        confirmLabel={stop.pending ? <Trans>Stopping…</Trans> : <Trans>Stop computer</Trans>}
      />
    </>
  );
}
