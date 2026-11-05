import { MinusIcon, PlusIcon, MaximizeIcon } from "lucide-react"
import { KEYMAP, labelFor } from "@/lib/keymap"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type ZoomControlsProps = React.ComponentProps<"div"> & {
  scale: number
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
}

export function ZoomControls({
  scale,
  onZoomIn,
  onZoomOut,
  onReset,
  className,
  ...props
}: ZoomControlsProps) {
  return (
    <div
      data-slot="zoom-controls"
      className={cn("flex items-center gap-2", className)}
      {...props}
    >
      <Badge variant="secondary" className="tabular-nums max-md:hidden">
        {Math.round(scale * 100)}%
      </Badge>
      {/* A phone zooms with a pinch: the steps would only crowd the run controls, so the view reset stands alone. */}
      <Button variant="outline" size="icon" className="md:hidden" onClick={onReset} aria-label="Reset view">
        <MaximizeIcon />
      </Button>
      <ButtonGroup className="max-md:hidden">
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon" onClick={onZoomOut} />}>
            <MinusIcon />
          </TooltipTrigger>
          <TooltipContent>Zoom out ({labelFor(KEYMAP.zoomOut)})</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon" onClick={onZoomIn} />}>
            <PlusIcon />
          </TooltipTrigger>
          <TooltipContent>Zoom in ({labelFor(KEYMAP.zoomIn)})</TooltipContent>
        </Tooltip>
        <ButtonGroupSeparator />
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon" onClick={onReset} />}>
            <MaximizeIcon />
          </TooltipTrigger>
          <TooltipContent>Reset view ({labelFor(KEYMAP.zoomReset)})</TooltipContent>
        </Tooltip>
      </ButtonGroup>
    </div>
  )
}
