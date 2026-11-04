import { hasDatasheet } from "@/schematic/datasheets"
import type { ComponentDef } from "@/schematic/types"
import { Details, DocLinks, ModelClaims, Pinout, SpecList, SymbolPreview } from "./PartFacts"
import { hasPinout } from "./pinout"

/** Old free-text notes that say what the model does and leaves out, and where it comes from: shown in the record's places until the record is written. */
const NOTE_MODELLED = "Modelled"
const NOTE_NOT_MODELLED = "Not modelled"
const NOTE_SOURCE = ["Source", "Datasheet"]

/** A part still without its record, laid out as one with: its own notes on what is modelled and not, and its source at the foot. */
function pendingRecord(info: Record<string, string> | undefined) {
  const split = (text: string | undefined) => (text ? [{ what: text }] : [])
  return {
    modelled: split(info?.[NOTE_MODELLED]),
    notModelled: split(info?.[NOTE_NOT_MODELLED]),
    source: NOTE_SOURCE.map((k) => info?.[k]).filter((v): v is string => !!v),
  }
}

const NOTES_SHOWN_ELSEWHERE = new Set([NOTE_MODELLED, NOTE_NOT_MODELLED, ...NOTE_SOURCE])

/** The inspector's Part tab: who makes it, the pinout, the numbers with their pages, what is modelled and what is not, the documents. */
export function PartTab({ def }: { def: ComponentDef }) {
  const record = def.datasheet
  const sheet = hasDatasheet(record) ? record : undefined
  const pending = record ? undefined : pendingRecord(def.info)
  return (
    <div data-slot="part-tab" className="flex flex-col gap-3.5">
      {def.description && <p className="text-[12.5px] leading-normal text-muted-foreground">{def.description}</p>}
      <div className="flex gap-3">
        {/* The package's pins where they can be drawn as a DIP; the part as the field draws it otherwise. */}
        {hasPinout(def) ? <Pinout def={def} /> : <SymbolPreview def={def} size={104} />}
        {sheet && <SpecList record={sheet} className="content-start" />}
      </div>
      {record ? <ModelClaims record={record} /> : pending && (pending.modelled.length > 0 || pending.notModelled.length > 0) && <ModelClaims record={{ none: "", ...pending }} />}
      {record && !sheet && "none" in record && <p className="text-xs text-muted-foreground">{record.none}</p>}
      {def.info && <Details info={def.info} skip={record ? undefined : NOTES_SHOWN_ELSEWHERE} />}
      {sheet && <DocLinks docs={sheet.docs} />}
      {record && "none" in record && record.sources && <DocLinks docs={record.sources} label="Defaults and behaviour taken from" />}
      {pending && pending.source.length > 0 && (
        <p className="border-t pt-2.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Source:</span> {pending.source.join("; ")}
        </p>
      )}
    </div>
  )
}
