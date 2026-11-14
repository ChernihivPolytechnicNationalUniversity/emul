import { shortcutSections } from "@/lib/shortcut-list"
import { currentPlatform } from "@/lib/platform"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

const KEYCAP = "inline-flex h-5 min-w-5 items-center justify-center rounded border border-b-2 bg-background px-1 font-mono text-[11px] leading-none text-muted-foreground"

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const sections = shortcutSections(currentPlatform())
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="shortcuts-dialog" className="max-h-[min(44rem,85svh)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Every key is also a button or a menu item: the toolbar prints each tool's key on it.</DialogDescription>
        </DialogHeader>
        <div className="columns-1 gap-8 sm:columns-2">
          {sections.map((section) => (
            <section key={section.title} className="mb-5 break-inside-avoid">
              <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{section.title}</h3>
              <dl className="space-y-1 text-sm">
                {section.rows.map((row) => (
                  <div key={row.name} className="flex items-baseline justify-between gap-3">
                    <dt>{row.name}</dt>
                    <dd className="flex shrink-0 flex-wrap justify-end gap-1">
                      {row.keys.map((key) => (
                        <kbd key={key} className={KEYCAP}>
                          {key}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
