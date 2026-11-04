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

/** A claim is read at a glance: one sentence, this many words at most. */
export const CLAIM_WORDS = 5

/**
 * A revision as the document list prints it, version and year: "5 (July 2025)" is "5 · 2025",
 * "V1.4 (2018-07-19)" is "V1.4 · 2018"; nothing for an undated one. The whole string stays in the tip.
 */
export function shortRev(rev: string | undefined): string {
  if (!rev || /^undated/i.test(rev.trim())) return ""
  const year = rev.match(/\b(19|20)\d\d\b/)?.[0]
  const head = rev.trim().replace(/^(ision|revision|rev[._ ]?|version)\s*/i, "")
  const version = head.match(/^(V\.?\d[\w.]*|v\d[\w.]*|\d+(?:\.\d+)*[A-Z]?|[A-Z]{1,2})(?=$|[\s,(])/)?.[1]
  const v = version && version !== year ? version : undefined
  return [v, year].filter(Boolean).join(" · ") || head.split(/[\s,(]/)[0]
}
