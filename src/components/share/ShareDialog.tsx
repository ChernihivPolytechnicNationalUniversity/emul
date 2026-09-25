import * as React from "react"
import { CopyIcon, ImageIcon, LinkIcon, PlayIcon, SquareIcon, UsersIcon } from "lucide-react"
import type { Live } from "@/collab/use-live"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Avatar } from "./Avatar"

type ShareDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  live: Live
  empty: boolean
  onStart: () => void
  onCopyLink: () => void
  onExportPng: () => void
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
        {icon}
        {title}
      </div>
      {children}
    </div>
  )
}

export function ShareDialog({ open, onOpenChange, live, empty, onStart, onCopyLink, onExportPng }: ShareDialogProps) {
  const copy = () => {
    if (live.link) void navigator.clipboard.writeText(live.link)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share</DialogTitle>
          <DialogDescription>Work on this bench together, or send a copy of it.</DialogDescription>
        </DialogHeader>
        {live.room ? (
          <Section icon={<UsersIcon />} title={live.status === "live" ? "Live session" : live.status === "offline" ? "Live session: reconnecting…" : "Live session: connecting…"}>
            <div className="flex gap-2">
              <Input readOnly value={live.link ?? ""} className="h-8 text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button size="sm" onClick={copy}>
                <CopyIcon />
                Copy
              </Button>
            </div>
            <ul className="flex flex-col gap-1.5 py-1">
              <li className="flex items-center gap-2 text-sm">
                <Avatar who={live.me} />
                {live.me.name}
                <span className="text-xs text-muted-foreground">(you{live.host ? ", host" : ""})</span>
              </li>
              {live.peers.map((p) => (
                <li key={p.clientId} className="flex items-center gap-2 text-sm">
                  <Avatar who={p} />
                  {p.name}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Everyone with the link edits this bench with you. The simulation runs on each computer on its own.
            </p>
            <Button variant="outline" size="sm" className="self-start text-destructive" onClick={live.leave}>
              <SquareIcon />
              {live.host ? "Stop session" : "Leave session"}
            </Button>
          </Section>
        ) : (
          <Section icon={<UsersIcon />} title="Live session">
            <p className="text-xs text-muted-foreground">
              Invite people to edit this bench with you. Everyone with the link joins; you appear to them as {live.me.name}.
            </p>
            <Button size="sm" className="self-start" disabled={empty} onClick={onStart}>
              <PlayIcon />
              Start session
            </Button>
          </Section>
        )}
        <div className="h-px bg-border" />
        <Section icon={<LinkIcon />} title="Link to a copy">
          <p className="text-xs text-muted-foreground">A snapshot to look at: it does not follow your later changes.</p>
          <Button variant="outline" size="sm" className="self-start" disabled={empty} onClick={onCopyLink}>
            <CopyIcon />
            Copy link
          </Button>
        </Section>
        <Section icon={<ImageIcon />} title="Image">
          <Button variant="outline" size="sm" className="self-start" disabled={empty} onClick={onExportPng}>
            <ImageIcon />
            Export PNG
          </Button>
        </Section>
      </DialogContent>
    </Dialog>
  )
}
