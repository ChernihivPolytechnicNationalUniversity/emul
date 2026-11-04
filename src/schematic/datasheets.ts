import type { Cite, Datasheet, DocRecord, NoDatasheet } from "./types"

/** The maker's URL opened at a page: url#page=N, which every PDF viewer honours. */
export function docUrl(doc: DocRecord, page?: number): string {
  return page && doc.url.toLowerCase().includes(".pdf") ? `${doc.url}#page=${page}` : doc.url
}

/** A citation as the card prints it, small and grey: "p. 4", "§7.3", "p. 6 · Table 9". */
export const citeLabel = (cite: Cite | undefined) => (cite ? [cite.page && `p. ${cite.page}`, cite.at].filter(Boolean).join(" · ") : "")

export const hasDatasheet = (record: Datasheet | NoDatasheet | undefined): record is Datasheet => !!record && "docs" in record

/** The document a citation points into: its own doc key, else the record's first document. */
export function citedDoc(record: Datasheet, cite: Cite | undefined): DocRecord {
  return record.docs.find((d) => d.key === cite?.doc) ?? record.docs[0]
}
