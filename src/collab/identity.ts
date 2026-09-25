export const ANIMALS = ["Bird", "Beetle", "Cat", "Dog", "Fish", "Panda", "Rabbit", "Rat", "Shrimp", "Snail", "Squirrel", "Turtle", "Worm"] as const
export type Animal = (typeof ANIMALS)[number]

export type Identity = { name: string; animal: Animal; color: string; anonymous: boolean }

const COLORS = ["#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#c026d3"]

const KEY = "emul-identity"

const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]

export function withAnimal(me: Identity, taken: ReadonlySet<string>): Identity {
  const free = ANIMALS.filter((a) => !taken.has(a))
  const animal = free.length ? pick(free) : pick(ANIMALS)
  const next: Identity = { ...me, animal, name: `Anonymous ${animal}` }
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ animal, color: me.color }))
  } catch {
    return next
  }
  return next
}

export function anonymousIdentity(): Identity {
  let saved: { animal?: string; color?: string } = {}
  try {
    saved = JSON.parse(sessionStorage.getItem(KEY) ?? "{}")
  } catch {
    saved = {}
  }
  const animal = ANIMALS.find((a) => a === saved.animal) ?? pick(ANIMALS)
  const color = saved.color && COLORS.includes(saved.color) ? saved.color : pick(COLORS)
  const me: Identity = { name: `Anonymous ${animal}`, animal, color, anonymous: true }
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ animal, color }))
  } catch {
    return me
  }
  return me
}
