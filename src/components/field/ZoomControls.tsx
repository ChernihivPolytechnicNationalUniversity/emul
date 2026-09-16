import { MinusIcon, PlusIcon, MaximizeIcon } from "lucide-react"
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
      <Badge variant="secondary" className="tabular-nums">
        {Math.round(scale * 100)}%
      </Badge>
      <ButtonGroup>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon" onClick={onZoomOut} />}>
            <MinusIcon />
          </TooltipTrigger>
          <TooltipContent>Zoom out (Ctrl −)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon" onClick={onZoomIn} />}>
            <PlusIcon />
          </TooltipTrigger>
          <TooltipContent>Zoom in (Ctrl +)</TooltipContent>
        </Tooltip>
        <ButtonGroupSeparator />
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon" onClick={onReset} />}>
            <MaximizeIcon />
          </TooltipTrigger>
          <TooltipContent>Reset view (Ctrl 0)</TooltipContent>
        </Tooltip>
      </ButtonGroup>
    </div>
  )
}
