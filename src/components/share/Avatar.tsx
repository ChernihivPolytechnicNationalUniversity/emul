import { BirdIcon, BugIcon, CatIcon, DogIcon, FishIcon, PandaIcon, PawPrintIcon, RabbitIcon, RatIcon, ShrimpIcon, SnailIcon, SquirrelIcon, TurtleIcon, WormIcon, type LucideIcon } from "lucide-react"
import type { Animal, Identity } from "@/collab/identity"
import { cn } from "@/lib/utils"

const ICONS: Record<Animal, LucideIcon> = {
  Bird: BirdIcon,
  Beetle: BugIcon,
  Cat: CatIcon,
  Dog: DogIcon,
  Fish: FishIcon,
  Panda: PandaIcon,
  Rabbit: RabbitIcon,
  Rat: RatIcon,
  Shrimp: ShrimpIcon,
  Snail: SnailIcon,
  Squirrel: SquirrelIcon,
  Turtle: TurtleIcon,
  Worm: WormIcon,
}

export function AnimalIcon({ animal, className }: { animal: string; className?: string }) {
  const Icon = ICONS[animal as Animal] ?? PawPrintIcon
  return <Icon className={className} />
}

export function Avatar({ who, className }: { who: Identity; className?: string }) {
  return (
    <span
      title={who.name}
      className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full text-white ring-2 ring-background [&_svg]:size-[60%]", className)}
      style={{ backgroundColor: who.color }}
    >
      <AnimalIcon animal={who.animal} />
    </span>
  )
}
