import type { Cite, ComponentDef, Datasheet, NoDatasheet } from "./types"

/**
 * The documents parts cite, by key: one entry however many parts share it (twelve PIC16F62x, a
 * family of WS28xx). The PDF itself is never copied here or into the site (makers' terms, TI's
 * non-commercial ones): the card links out to the maker's copy at the cited page, with an archived
 * copy beside it for the day the link moves. `checked` is when the URL was last seen to serve it.
 */
export type DocRecord = { maker: string; id: string; title: string; rev?: string; url: string; archive?: string; checked: string }

export const DOCS: Record<string, DocRecord> = {}

/** The maker's URL opened at a page: url#page=N, which every PDF viewer honours. */
export function docUrl(doc: DocRecord, page?: number): string {
  return page && doc.url.toLowerCase().includes(".pdf") ? `${doc.url}#page=${page}` : doc.url
}

/** A citation as the card prints it, small and grey: "p. 4", "§7.3", "p. 6 · Table 9". */
export const citeLabel = (cite: Cite | undefined) => (cite ? [cite.page && `p. ${cite.page}`, cite.at].filter(Boolean).join(" · ") : "")

export const hasDatasheet = (record: Datasheet | NoDatasheet | undefined): record is Datasheet => !!record && "docs" in record

/** A part's record, or none: what the card and the Part tab read. */
export const datasheetOf = (def: ComponentDef) => def.datasheet

/** The document a citation points into: its own doc key, else the record's first document. */
export function citedDoc(record: Datasheet, cite: Cite | undefined): DocRecord | undefined {
  return DOCS[cite?.doc ?? record.docs[0]]
}
